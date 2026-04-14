# Deployment and Environment Strategy

## Unified environment variables

Use the root `.env.example` as the single source template for all runtime values.

Copy per environment:

- `.env.staging`
- `.env.production`

For local API development, mirror required values into `packages/api/.dev.vars` (never commit secrets).

## Multi-domain setup

Keep domain-specific values as env overrides:

- `FRONTEND_URL`
- `ALLOWED_ORIGINS`
- `R2_BASE_URL`

Deploy each domain with its own Wrangler environment and secret set.

## CI/CD flow

Canonical deploy workflow: `.github/workflows/deploy.yml`.

`deploy.yml` is the only supported deployment workflow.

The canonical workflow uses:

- pushes to `main` -> staging deploy
- version tags (`v*.*.*`) -> production deploy

Required repository secrets:

- `CLOUDFLARE_API_TOKEN_STAGING`
- `CLOUDFLARE_API_TOKEN_PROD`
- `CLOUDFLARE_ACCOUNT_ID_STAGING`
- `CLOUDFLARE_ACCOUNT_ID_PROD`
- `STAGING_ADMIN_SMOKE_TOKEN` (JWT for an admin/super_admin staging account)
- `PROD_ADMIN_SMOKE_TOKEN` (JWT for an admin/super_admin production account)

Note: the deploy workflow reads these exact `CLOUDFLARE_*_STAGING/PROD` secret names.

Required environment variables (GitHub Environments/Repository Variables):

- Staging:
  - `API_URL_STAGING`
  - `FRONTEND_URL_STAGING`
  - `ALLOWED_ORIGINS_STAGING`
  - `CF_PAGES_PROJECT_NAME_STAGING`
- Production:
  - `API_URL_PROD`
  - `FRONTEND_URL_PROD`
  - `ALLOWED_ORIGINS_PROD`
  - `CF_PAGES_PROJECT_NAME_PROD`

The hardened workflows now enforce:

- API and web builds use the environment-specific `API_URL_*`.
- Deploy steps use environment-specific Cloudflare token/account secrets.
- Post-deploy smoke checks validate:
  - `/api/health` payload (`{ status: "healthy" }`)
  - CORS `Access-Control-Allow-Origin` against `FRONTEND_URL_*`
  - authenticated admin endpoint (`GET /api/auth/me`)
  - frontend reachability.

## Fresh infrastructure bootstrap runbook

Use this when staging/production D1, KV, and/or R2 were intentionally reset.

1) Freeze auto-deploys

- Confirm `.github/workflows/deploy.yml` is the only active deployment workflow.

1. Recreate bindings/resources (per environment)

- D1 database
- KV namespace(s)
- R2 bucket(s)
- Update Worker/Page bindings to point to recreated resources.

1. Restore required secrets (per environment)

- `JWT_SECRET`
- `BREVO_API_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `TOTP_ENCRYPTION_KEY`
- `VAPID_PRIVATE_KEY`
- `RSS_SECRET`

1. Re-apply database migrations in order

- Run all SQL files in `packages/api/migrations/` in ascending order.
- Do not edit historical migration files; add new numbered migrations as needed.

1. Seed data policy

- Staging: seed freely for smoke testing.
- Production: seed only intentional baseline config; avoid test/demo data.

1. Deploy order

- Deploy API first.
- Deploy web second.

1. Post-deploy smoke checks

- `GET /api/health` returns healthy.
- Auth flow (magic link + session restore) works.
- Admin loads and can perform one write action.
- Homepage and watch routes render without server errors.
- If media was reset, validate expected behavior for missing/placeholder media.

## Rollback notes (staging/production)

Use the smallest rollback that restores service:

1. Full rollback
- Re-run `.github/workflows/deploy.yml` from a known-good commit/tag (`workflow_dispatch`) targeting the affected environment.
- Validate health, CORS, admin auth smoke checks, and homepage/watch rendering.

2. Emergency containment
- If staging deploy is unstable, pause merges to `main` until smoke checks are green.
- If production deploy is unstable, disable further production tags and roll back first, then investigate.

