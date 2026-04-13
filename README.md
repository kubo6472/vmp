# VMP (Video Monetization Platform)

VMP is a Cloudflare-based video subscription platform with a Worker API, Nuxt web app, shared TypeScript types, and a Pages-based video processor admin.

## Monorepo packages

- `@vmp/api` (`packages/api`) — Cloudflare Worker API + D1/R2/KV integrations.
- `@vmp/web` (`packages/web`) — Nuxt 4 frontend deployed to Cloudflare Pages.
- `@vmp/shared` (`packages/shared`) — shared TypeScript contracts.
- `@vmp/video-processor` (`packages/video-processor`) — Pages Functions admin for upload/processing.

## Deployment model (high level)

- Pushes to `main` run staging deploy in `.github/workflows/deploy.yml`.
- Version tags (`v*.*.*`) run production deploy in `.github/workflows/deploy.yml`.
- Deploy pipeline fails fast on type-checking before build/deploy:
  - `@vmp/shared` `tsc --noEmit`
  - `@vmp/api` `tsc --noEmit`
  - `@vmp/video-processor` `tsc --noEmit`
  - `@vmp/web` `nuxi prepare && nuxi typecheck`

## Prerequisites

1. Node.js 20+ and npm 10+.
2. Cloudflare account with:
   - Worker/API service
   - Pages project(s)
   - D1 database
   - R2 bucket
   - KV namespaces
3. Repository secrets configured for CI deploy:
   - `CLOUDFLARE_API_TOKEN_STAGING`
   - `CLOUDFLARE_ACCOUNT_ID_STAGING`
   - `CLOUDFLARE_API_TOKEN_PROD`
   - `CLOUDFLARE_ACCOUNT_ID_PROD`
   - `CF_PAGES_PROJECT_NAME` (staging web deploy)

## Local setup

1. Install dependencies:
   - `npm ci`
2. Build service worker helper from TS source:
   - `npm run build:sw-push --workspace=@vmp/web`
3. Type-check everything:
   - `npm run typecheck`

## Manual deploy commands

These are useful for controlled/manual rollouts outside GitHub Actions.

1. API deploy:
   - `npm run deploy:api`
2. Web deploy:
   - `npm run deploy:web`
3. Video processor deploy:
   - `npm run deploy:video-processor`

## Runtime secrets/vars

Use Wrangler secrets for sensitive values (never commit secrets). Required values are documented in `AGENTS.md` and `DEPLOYMENT.md` (JWT, Stripe, Brevo, VAPID, RSS, TOTP encryption, etc.).

## Notes

- API entrypoint is TypeScript (`packages/api/src/index.ts`) referenced by `packages/api/wrangler.json`.
- Worker/service scripts that must remain JavaScript at runtime (for browser/service-worker execution) are generated from TypeScript sources during build.
