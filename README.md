# BoltOPX API

Express + Prisma API (`boltopx-api`). Deploy target: **Vercel** (`vercel.json`).

## Ship checklist (run before every merge)

These commands are what **CI runs** (`.github/workflows/ci.yml`). If `verify` fails locally, the PR will fail too.

```bash
npm ci
npm run verify
npm run compile
```

| Script | What it does |
|--------|----------------|
| `npm run lint` | `tsc --noEmit` — **typecheck** (this is the real “green build” for TS) |
| `npm run test` | Vitest unit tests (`src/**/*.test.ts`) |
| `npm run verify` | **`lint` + `test`** — use this as the one pre-merge gate |
| `npm run compile` | `prisma generate` + `tsc` — emits `dist/` (gitignored); matches production compile |
| `npm run build` | Same as **`compile`** — use for platforms that expect `npm run build` (e.g. Vercel) |

**Important:** `compile` / `build` is not optional for catching TS errors if you only ran Prisma before — old `build` only ran `prisma generate`. Now `build` includes **`tsc`**.

## Database

Prisma schema is in `prisma/`. Examples:

```bash
npm run db:migrate   # prisma migrate deploy (production)
npm run db:studio
```

## Environment

Use a local `.env` for secrets (never commit `.env`; it is gitignored).
