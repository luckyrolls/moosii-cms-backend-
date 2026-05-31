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

## Health check

```
GET /health  →  200 { "status": "ok" }
```
