#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_LIMIT = 500;

function printHelp({ exitCode = 0 } = {}) {
  const lines = [
    'Umami export CLI (no external deps)',
    '',
    'Usage:',
    '  umami.mjs <command> [options]',
    '',
    'Commands:',
    '  export-path-visitors   Export visitors aggregated by URL path',
    '',
    'Global options:',
    '  -h, --help             Show help',
    '',
    'Run:',
    '  umami.mjs export-path-visitors --help',
    '',
    'Env vars (optional defaults):',
    '  UMAMI_BASE_URL, UMAMI_WEBSITE_ID, UMAMI_SHARE_ID, UMAMI_USERNAME, UMAMI_PASSWORD, UMAMI_TOKEN',
  ];
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(exitCode);
}

function printExportHelp({ exitCode = 0 } = {}) {
  const lines = [
    'Usage:',
    '  umami.mjs export-path-visitors [options]',
    '',
    'Required:',
    '  --baseUrl <url>         Base URL, e.g. https://analytics.example.com (or env UMAMI_BASE_URL)',
    '  --startAt <ms>          Start time (epoch ms)',
    '  --endAt <ms>            End time (epoch ms)',
    '',
    'Website:',
    '  --websiteId <uuid>      Website ID (or env UMAMI_WEBSITE_ID)',
    '                          If using --shareId and websiteId is omitted, websiteId from share response is used.',
    '',
    'Auth (choose ONE):',
    '  --shareId <id>          Share ID (or env UMAMI_SHARE_ID)',
    '  --username <u>          Username (or env UMAMI_USERNAME) (requires --password / UMAMI_PASSWORD)',
    '  --password <p>          Password (or env UMAMI_PASSWORD)',
    '  --token <token>         Bearer token (or env UMAMI_TOKEN)',
    '',
    'Output:',
    '  --out <path>            Write JSON to file (default: stdout)',
    '',
    'Pagination:',
    `  --limit <n>             Page size (default: ${DEFAULT_LIMIT})`,
    '',
    'Other:',
    '  -h, --help              Show help',
  ];
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(exitCode);
}

function die(message, { exitCode = 1 } = {}) {
  process.stderr.write(String(message).replace(/\s+$/g, '') + '\n');
  process.exit(exitCode);
}

function toNumber(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) die(`Invalid ${name}: ${value}`);
  return n;
}

function normalizeBaseUrl(raw) {
  if (!raw) return raw;
  return String(raw).trim().replace(/\/+$/g, '');
}

function normalizePath(name) {
  if (name === undefined || name === null) return '/';
  let raw = String(name).trim();
  if (!raw) return '/';

  // If it's a full URL, use URL parsing to extract pathname.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    try {
      const u = new URL(raw);
      raw = u.pathname || '/';
    } catch {
      // Fall back to raw parsing below.
    }
  }

  // Strip query/hash from non-URL values (and from URL parse fallback cases).
  const q = raw.indexOf('?');
  const h = raw.indexOf('#');
  const cut = [q, h].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (cut !== undefined) raw = raw.slice(0, cut);

  raw = raw.replace(/\/{2,}/g, '/');
  if (!raw.startsWith('/')) raw = '/' + raw;
  if (raw.length > 1 && raw.endsWith('/')) {
    // ok
  } else if (raw !== '/') {
    raw += '/';
  }
  if (raw === '') raw = '/';
  return raw;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      args.help = true;
      continue;
    }
    if (a === '--') {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        args[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
      continue;
    }
    args._.push(a);
  }
  return args;
}

async function readJsonStrict(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    die(`Invalid JSON response (status ${response.status}): ${msg}\nBody:\n${text}`);
  }
}

async function fetchOrDie(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    die(`Request failed: ${url}\n${msg}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    die(`HTTP ${res.status} ${res.statusText}\nURL: ${url}\nBody:\n${body}`);
  }
  return res;
}

function resolveAuthArgs(args) {
  const shareId = args.shareId ?? process.env.UMAMI_SHARE_ID;
  const username = args.username ?? process.env.UMAMI_USERNAME;
  const password = args.password ?? process.env.UMAMI_PASSWORD;
  const token = args.token ?? process.env.UMAMI_TOKEN;

  const modes = [
    shareId ? 'share' : null,
    token ? 'token' : null,
    username || password ? 'userpass' : null,
  ].filter(Boolean);

  if (modes.length === 0) die('Missing auth: provide --shareId OR --token OR --username/--password (or env vars).');
  if (modes.length > 1) die('Ambiguous auth: provide only one of --shareId, --token, or --username/--password (or env vars).');

  if (modes[0] === 'userpass' && (!username || !password)) {
    die('Missing auth: --username and --password are both required (or UMAMI_USERNAME/UMAMI_PASSWORD).');
  }

  return { mode: modes[0], shareId, username, password, token };
}

async function getAuthHeaders({ baseUrl, auth, websiteIdArg }) {
  if (auth.mode === 'share') {
    const shareUrl = `${baseUrl}/api/share/${encodeURIComponent(auth.shareId)}`;
    const res = await fetchOrDie(shareUrl, { method: 'GET' });
    const json = await readJsonStrict(res);
    const shareToken = json?.token;
    const shareWebsiteId = json?.websiteId;
    if (!shareToken) die(`Share response missing token: ${shareUrl}`);
    const websiteId = websiteIdArg ?? shareWebsiteId;
    if (!websiteId) die('Missing websiteId: provide --websiteId or use a shareId that returns websiteId.');
    return {
      websiteId,
      headers: {
        'x-umami-share-token': shareToken,
      },
    };
  }

  if (auth.mode === 'token') {
    if (!auth.token) die('Missing token: provide --token or UMAMI_TOKEN.');
    if (!websiteIdArg) die('Missing websiteId: provide --websiteId or UMAMI_WEBSITE_ID.');
    return {
      websiteId: websiteIdArg,
      headers: {
        authorization: `Bearer ${auth.token}`,
      },
    };
  }

  // username/password
  const loginUrl = `${baseUrl}/api/auth/login`;
  const res = await fetchOrDie(loginUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: auth.username, password: auth.password }),
  });
  const json = await readJsonStrict(res);
  const token = json?.token;
  if (!token) die(`Login response missing token: ${loginUrl}`);
  if (!websiteIdArg) die('Missing websiteId: provide --websiteId or UMAMI_WEBSITE_ID.');
  return {
    websiteId: websiteIdArg,
    headers: {
      authorization: `Bearer ${token}`,
    },
  };
}

function extractRows(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  if (json && Array.isArray(json.rows)) return json.rows;
  return null;
}

async function exportPathVisitors(args) {
  if (args.help || args.h) printExportHelp();

  const baseUrl = normalizeBaseUrl(args.baseUrl ?? process.env.UMAMI_BASE_URL);
  if (!baseUrl) die('Missing --baseUrl (or UMAMI_BASE_URL).');

  const websiteIdArg = args.websiteId ?? process.env.UMAMI_WEBSITE_ID;
  const startAt = toNumber(args.startAt, 'startAt');
  const endAt = toNumber(args.endAt, 'endAt');
  if (startAt === undefined) die('Missing --startAt <ms>.');
  if (endAt === undefined) die('Missing --endAt <ms>.');
  const limit = toNumber(args.limit ?? DEFAULT_LIMIT, 'limit') ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) die(`Invalid limit: ${limit}`);

  const auth = resolveAuthArgs(args);
  const { websiteId, headers: authHeaders } = await getAuthHeaders({ baseUrl, auth, websiteIdArg });

  const outPath = args.out;
  const totals = Object.create(null);

  for (let offset = 0; ; offset += limit) {
    const url =
      `${baseUrl}/api/websites/${encodeURIComponent(websiteId)}` +
      `/metrics/expanded?type=path&startAt=${encodeURIComponent(startAt)}` +
      `&endAt=${encodeURIComponent(endAt)}&limit=${encodeURIComponent(limit)}` +
      `&offset=${encodeURIComponent(offset)}`;

    const res = await fetchOrDie(url, { method: 'GET', headers: { ...authHeaders } });
    const json = await readJsonStrict(res);
    const rows = extractRows(json);
    if (!rows) die(`Unexpected response shape from metrics endpoint.\nURL: ${url}\nBody:\n${JSON.stringify(json, null, 2)}`);
    if (rows.length === 0) break;

    for (const row of rows) {
      const name = row?.name;
      const visitors = Number(row?.visitors ?? 0);
      if (!Number.isFinite(visitors)) continue;
      const path = normalizePath(name);
      totals[path] = (totals[path] ?? 0) + visitors;
    }
  }

  const jsonOut = JSON.stringify(totals, null, 2) + '\n';
  if (outPath) {
    const outAbs = path.resolve(process.cwd(), outPath);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, jsonOut, 'utf8');
  } else {
    process.stdout.write(jsonOut);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp({ exitCode: 0 });
  }

  if (cmd === 'export-path-visitors') {
    if (args.help) return exportPathVisitors({ help: true });
    return exportPathVisitors(parseArgs(process.argv.slice(3)));
  }

  if (args.help) printHelp({ exitCode: 0 });
  die(`Unknown command: ${cmd}\nRun: umami.mjs --help`);
}

await main();
