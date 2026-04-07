# AGENTS.md

## Project overview

VMP (Video Monetization Platform) is a subscription-gated HLS video streaming platform. npm workspaces monorepo with four packages:

| Package | Path | Runtime |
|---|---|---|
| `@vmp/api` | `packages/api` | Cloudflare Worker (JS) — REST API, auth, Stripe, push, thumbnails |
| `@vmp/web` | `packages/web` | Nuxt 4 / Vue 3 frontend (TypeScript) |
| `@vmp/shared` | `packages/shared` | Shared TS types |
| `@vmp/video-processor` | `packages/video-processor` | Cloudflare Pages admin for video upload |

### Infrastructure

| Concern | Service |
|---|---|
| Video/asset storage | Cloudflare R2 |
| API + auth backend | Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Config format | `wrangler.json` (not `.toml`) |
| Frontend | Nuxt 4, hls.js, media-chrome |
| Email | Brevo Transactional API |
| Payments | Stripe |
| Push notifications | Web Push / VAPID |

### Roles

```text
super_admin  — full permissions including promoting/demoting other admins
admin        — everything except editing super_admin accounts
editor       — video CRUD, change visibility/status
analyst      — read-only analytics (future)
moderator    — comment moderation (future)
viewer       — default for all registered users
```

### D1 schema (key tables)

- `users` — id, email, role, totp_secret, totp_enabled
- `videos` — id, title, description, thumbnail_url, full_duration, preview_duration, upload_date, publish_status, published_at, slug
- `subscriptions` — user_id, plan_type (monthly/yearly/club), status, stripe_subscription_id, stripe_customer_id, current_period_end
- `magic_link_tokens` — user_id, token_hash, expires_at, used_at
- `refresh_tokens` — user_id, token_hash, expires_at
- `admin_settings` — key/value store for configurable limits, prices, etc.
- `push_subscriptions` — user_id, endpoint, p256dh, auth

Migrations live in `packages/api/migrations/` — always add a new numbered file, never edit existing ones.

### Auth system (DO NOT rewrite)

Fully implemented in `packages/api/src/auth.js`. Key exports:
- `handleRequestMagicLink` — `POST /api/auth/magic-link`
- `handleVerifyMagicLink` — `GET /api/auth/verify?token=`
- `handleRefreshToken` — `POST /api/auth/refresh`
- `handleLogout` — `POST /api/auth/logout`
- `handleGetMe` — `GET /api/auth/me`
- `handleTotpSetup/Confirm/Verify` — 2FA endpoints
- `requireAuth(request, env)` — throws if no valid Bearer JWT
- `requireRole(request, env, ...roles)` — throws if role not in list

Frontend auth: `packages/web/composables/useAuth.ts` — singleton composable with `user`, `accessToken`, `isLoggedIn`, `isPremium`, `canEditContent`, `isAdmin`, `authHeader()`, etc. Session restored on boot by `plugins/auth.client.ts`. Admin routes guarded by `middleware/admin.ts`.

### Video access flow

1. Frontend calls `GET /api/video-access/{userId}/{videoId}`
2. Worker checks subscription in D1
3. Returns `hasAccess`, `playlistUrl` (proxied through `/api/video-proxy/`)
4. Anonymous users pass `userId = 'anonymous'` — preview only
5. Proxy worker rewrites HLS manifests to truncate at `previewDuration` for non-subscribers

### Pricing (stored in `admin_settings`, not hardcoded)

All prices, limits, and plan names are configurable via `admin_settings` in D1. Key settings: `stripe_price_monthly`, `stripe_price_yearly`, `stripe_price_club`, `rate_limit_anon`.

### General implementation rules

- **Every protected API endpoint** must use `requireAuth` or `requireRole`. Never trust client-supplied userId — always read from the JWT payload.
- **No hardcoded prices, limits, or plan names** — read from `admin_settings`.
- **All admin API calls from the frontend** must include `...authHeader()` from `useAuth()`.
- **CORS**: `buildCorsHeaders` in `index.js` handles credentialed vs public CORS. Don't bypass it.
- **Error format**: all API errors return `{ error: string, code?: string }`.
- **Secrets**: never commit secrets. Use `wrangler secret put` for sensitive values. Local dev secrets go in `packages/api/.dev.vars`.
- **TypeScript in `@vmp/web`**: all new composables and pages should be `.ts` / `<script setup lang="ts">` with explicit prop and emit types.
- **SubtleCrypto over npm for crypto**: Workers have full WebCrypto. Don't add `crypto`, `jsonwebtoken`, `otplib`, `web-push` as Worker dependencies. Implement with SubtleCrypto directly.
- **PRs**: one PR per step. PR description should list every file changed and why.
- **Before writing code for a step**: read all files that will be modified, check if migrations already exist, confirm API contract before implementing, implement API first then frontend, smoke-test with `wrangler dev`.

## Implementation roadmap

Steps 1–7 are complete. Work continues from step 8.

| Step | Title | Status |
|---|---|---|
| 1 | Video Draft/Publish Flow | ✅ Done |
| 2 | Rate Limiting for Anonymous Users | ✅ Done |
| 3 | Stripe Payments | ✅ Done |
| 4 | Signed Segment URLs + yt-dlp Throttling | ✅ Done |
| 5 | 2FA for Editor+ Roles | ✅ Done |
| 6 | PWA + Push Notifications | ✅ Done (push has known issues) |
| 7 | Thumbnail Management | ✅ Done |
| 8 | Brevo Newsletter Sync | Pending |
| 9 | RSS / Podcast Feed | Pending |

### Step 8 — Brevo Newsletter Sync

- `packages/api/src/brevo.js` — sync paying subscribers to a Brevo contact list; remove on cancellation.
- Call sync from Stripe webhook on `checkout.session.completed` and renewal; call remove on `customer.subscription.deleted`.
- Admin Newsletter tab: compose subject + body, preview as HTML, send via Brevo campaign API. Requires `admin` or `super_admin` role (NOT editor).
- Store `brevo_subscriber_list_id` in `admin_settings`.

### Step 9 — RSS / Podcast Feed

- Per-user stable RSS token: `HMAC-SHA256(RSS_SECRET, 'rss:' + userId)`.
- `GET /api/feed/:userId/:token` — validates token + active subscription, returns RSS 2.0 with iTunes podcast tags for all published videos.
- Account page section with copyable RSS URL and instructions.

## Cursor Cloud-specific instructions

### Running services locally

**API** (`packages/api`):

```bash
npm run dev --workspace=@vmp/api   # runs wrangler dev on port 8787
```

- Wrangler emulates D1, R2, KV, and Durable Objects locally — no external services needed.
- Local secrets must be in `packages/api/.dev.vars` (not committed). Required:
  - `JWT_SECRET` — any string >= 32 chars
  - `TOTP_ENCRYPTION_KEY` — any string >= 32 chars
- Without `BREVO_API_KEY`, magic-link URLs are logged to the wrangler console prefixed `[DEV]`.

**Web frontend** (`packages/web`):

```bash
API_URL=http://localhost:8787 npm run dev --workspace=@vmp/web   # Nuxt dev on port 3000
```

- Set `API_URL` to point to the local API; otherwise it defaults to the production URL.

### Database setup

Before the API can serve data, apply all D1 migrations in order:

```bash
cd packages/api
for f in $(ls -1 migrations/*.sql | sort); do
  npx wrangler d1 execute video-subscription-db --local --file="$f"
done
```

Seed videos default to `publish_status = 'draft'`. To make them visible on the public homepage:

```bash
npx wrangler d1 execute video-subscription-db --local \
  --command="UPDATE videos SET publish_status = 'published', published_at = CURRENT_TIMESTAMP WHERE publish_status = 'draft';"
```

### Lint / TypeScript

- No ESLint config exists in the repo.
- TypeScript check for shared: `cd packages/shared && npx tsc --noEmit`
- Nuxt typecheck (`npx nuxi typecheck`) requires a `tsconfig.json` in `packages/web` — the repo does not ship one; run `npx nuxi prepare` first to generate `.nuxt/tsconfig.json`.

### Build

```bash
npm run build --workspace=@vmp/web   # Nuxt production build (Cloudflare Pages preset)
```

### Gotchas

- The wrangler dev console truncates long log lines. Use a wide terminal (or tmux `resize-window -x 500`) to capture full magic-link tokens.
- Video playback on `/watch/:id` requires actual HLS segments in R2. The seed data has no media files, so the player shows "Media failed to load" — this is expected in a fresh local environment.
- There is no `package-lock.json` entry in `.gitignore`; the lockfile is committed.

### Required Wrangler secrets (for production — set via `wrangler secret put`)

```text
JWT_SECRET              — 32+ random chars
BREVO_API_KEY           — from brevo.com
STRIPE_SECRET_KEY       — from stripe.com dashboard
STRIPE_WEBHOOK_SECRET   — from stripe webhook registration
TOTP_ENCRYPTION_KEY     — AES-256-GCM encryption key for TOTP secrets
VAPID_PRIVATE_KEY       — generated with web-push generate-vapid-keys
```
