# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

VMP (Video Monetization Platform) is an npm workspaces monorepo with four packages:

| Package | Path | Runtime |
|---|---|---|
| `@vmp/api` | `packages/api` | Cloudflare Worker (JS) — REST API, auth, Stripe, push |
| `@vmp/web` | `packages/web` | Nuxt 4 / Vue 3 frontend (TypeScript) |
| `@vmp/shared` | `packages/shared` | Shared TS types |
| `@vmp/video-processor` | `packages/video-processor` | Cloudflare Pages admin for video upload |

### Running services locally

**API** (`packages/api`):
```
npm run dev --workspace=@vmp/api   # runs wrangler dev on port 8787
```
- Wrangler emulates D1, R2, KV, and Durable Objects locally — no external services needed.
- Local secrets must be in `packages/api/.dev.vars` (not committed). Required:
  - `JWT_SECRET` — any string >= 32 chars
  - `TOTP_ENCRYPTION_KEY` — any string >= 32 chars
- Without `BREVO_API_KEY`, magic-link URLs are logged to the wrangler console prefixed `[DEV]`.

**Web frontend** (`packages/web`):
```
API_URL=http://localhost:8787 npm run dev --workspace=@vmp/web   # Nuxt dev on port 3000
```
- Set `API_URL` to point to the local API; otherwise it defaults to the production URL.

### Database setup

Before the API can serve data, apply all D1 migrations in order:
```
cd packages/api
for f in $(ls -1 migrations/*.sql | sort); do
  npx wrangler d1 execute video-subscription-db --local --file="$f"
done
```
Seed videos default to `publish_status = 'draft'`. To make them visible on the public homepage:
```
npx wrangler d1 execute video-subscription-db --local \
  --command="UPDATE videos SET publish_status = 'published', published_at = CURRENT_TIMESTAMP WHERE publish_status = 'draft';"
```

### Lint / TypeScript

- No ESLint config exists in the repo.
- TypeScript check for shared: `cd packages/shared && npx tsc --noEmit`
- Nuxt typecheck (`npx nuxi typecheck`) requires a `tsconfig.json` in `packages/web` — the repo does not ship one; run `npx nuxi prepare` first to generate `.nuxt/tsconfig.json`.

### Build

```
npm run build --workspace=@vmp/web   # Nuxt production build (Cloudflare Pages preset)
```

### Gotchas

- The wrangler dev console truncates long log lines. Use a wide terminal (or tmux `resize-window -x 500`) to capture full magic-link tokens.
- Video playback on `/watch/:id` requires actual HLS segments in R2. The seed data has no media files, so the player shows "Media failed to load" — this is expected in a fresh local environment.
- There is no `package-lock.json` entry in `.gitignore`; the lockfile is committed.
