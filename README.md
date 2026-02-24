# umami

A minimal Node.js CLI for exporting Umami metrics (no external runtime dependencies).

## Requirements

- Node.js 18+

## Install / Run

```bash
# direct run
node ./umami.mjs --help

# optional global command via npm link
npm install
npm link
umami --help
```

## Command

### `export-path-visitors`

Export JSON mapping: `normalizedPath -> visitors`.

Compatible core flags (kept for existing cron usage):
- `--baseUrl`
- `--shareId`
- `--startAt`
- `--endAt`
- `--out`

Example (share mode):

```bash
node ./umami.mjs export-path-visitors \
  --baseUrl https://analytics.example.com \
  --shareId YOUR_SHARE_ID \
  --startAt 1706745600000 \
  --endAt 1706832000000 \
  --out ./path-visitors.json
```

More auth options are available:
- `--token` + `--websiteId`
- `--username` + `--password` + `--websiteId`

Check full help:

```bash
node ./umami.mjs export-path-visitors --help
```

## Environment Variables (optional)

- `UMAMI_BASE_URL`
- `UMAMI_WEBSITE_ID`
- `UMAMI_SHARE_ID`
- `UMAMI_USERNAME`
- `UMAMI_PASSWORD`
- `UMAMI_TOKEN`

## Security Notes

- Do **not** commit real credentials, tokens, share IDs, or `.env` files.
- Prefer env vars or CI secret managers.
- If a secret is exposed, rotate it immediately.

## License

MIT
