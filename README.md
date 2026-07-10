# moosii-cms-backend

Internal CMS backend for AI image generation.

## Setup

```bash
npm install
cp .env.example .env   # fill in your values
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start with hot reload (development) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output (production / Render) |

## CORS

Browser origins allowed to call the API are configured via the
`ALLOWED_ORIGINS` env var (comma-separated; `CORS_ALLOWED_ORIGINS` is accepted as a
legacy alias). If unset, it defaults to `http://localhost:5173` (the local dev SPA).

```
ALLOWED_ORIGINS=http://localhost:5173,https://moosii-cms.onrender.com
```

On **Render**, set `ALLOWED_ORIGINS` to include every deployed CMS origin
(the local dev origin is only needed locally). Without it, the deployed backend
falls back to the dev origin and the production SPA will be blocked.

## Health check

```
GET /health  →  200 { "status": "ok" }
```
