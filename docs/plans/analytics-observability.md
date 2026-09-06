# Analytics & observability (canonical stack)

Roadmap: `analytics-observability` (shipped [#642](https://github.com/tojemoc/vmp/pull/642)) — closed [#452](https://github.com/tojemoc/vmp/issues/452), [#509](https://github.com/tojemoc/vmp/issues/509), [#512](https://github.com/tojemoc/vmp/issues/512), [#611](https://github.com/tojemoc/vmp/issues/611). Remaining CMS scope: [#643](https://github.com/tojemoc/vmp/issues/643).

## Problem

Multiple overlapping tools were introduced over time (Contentsquare, GTM, Umami, Sentry, Datadog, Plausible, PostHog). Only a subset is loaded in application code today; the rest created privacy-notice drift and reviewer confusion about which system owns which signal.

## Canonical roles (2026)

### Web frontend (`@vmp/web`)

| Concern | Tool | Integration | Notes |
|---------|------|-------------|-------|
| Product analytics (funnels, cohorts, feature usage) | **PostHog** (EU) | `@posthog/nuxt`, `plugins/posthog*.client.ts` | Consent required for full capture; `cookieless_mode: on_reject` for declined visitors |
| Error monitoring + session replay on errors | **Sentry** | `@sentry/nuxt/module`, `sentry.*.config.ts` | When `NUXT_PUBLIC_SENTRY_DSN` is set, error-linked session replay may be captured (masked text, blocked media; 10% sample on errors) |
| Optional marketing / legacy tags | **GTM** | `features/gtm/plugin.client.ts` (when `gtm` ∈ `VMP_FEATURES`) | Admin opt-in via D1 (`gtm_enabled`); compile-time allowlist — see [deployment-feature-modules.md](./deployment-feature-modules.md) |

Registry: `packages/web/utils/analytics/`.

### API Worker (`@vmp/api`)

| Concern | Tool | Integration |
|---------|------|-------------|
| Structured logs | PostHog Logs (OTLP) | `logger.ts`, `posthogLogs.ts` |
| Optional log shipping | Datadog | `logger.ts` when `DD_LOGS_ENABLED=true` |
| Error monitoring | Sentry | `@sentry/cloudflare` |
| Subscription lifecycle analytics | PostHog server capture | `posthog.ts` from payment webhooks |

### Admin CMS analytics (first-party)

Video segment/view analytics for editors live in D1 (`video_segment_events`, `video_view_counts`, `video_view_count_sessions` — not a table named `segment_analytics`) and `/api/admin/analytics` — not a third-party SDK. The admin Analytics tab already surfaces views-over-time, per-video view counts, traffic-source split, and views-by-country (from `CF-IPCountry` on the HLS segment proxy).

## Retired / not loaded

- **Contentsquare**, **Plausible** — never shipped in repo code.
- **Umami (standalone SDK)** — removed from privacy copy; cookieless visit counts come from PostHog when analytics is declined.
- **Datadog browser RUM** — not used; Datadog is API logs only.

## GDPR / consent model

1. **Strictly necessary** — auth cookies, PWA/offline storage, playback prefs: disclosed, no consent wall.
2. **PostHog product analytics** — explicit accept/decline banner (`vmp_posthog_analytics_consent`). Decline → cookieless server-side counts only.
3. **GTM** — only when admin enables; may load additional tags configured in the GTM container (disclosed as optional marketing gateway).
4. **Sentry** — technical stability monitoring; disclosed under processors.
5. **Server-side PostHog** from Stripe webhooks — billing operations (legitimate interest); not gated by browser consent.

## Environment separation

Every PostHog browser event registers `$environment` from baked `deployTier` (`staging` | `beta` | `production` | `development`). Prefer separate PostHog project tokens per GitHub environment; the property is a fallback filter.

## Exception noise

Intentional navigation aborts (`AbortError`, “Request aborted”) are filtered from Sentry and PostHog — see `packages/web/utils/analytics/noiseFilter.ts`.

## Future work

- CMS analytics remaining scope — [#643](https://github.com/tojemoc/vmp/issues/643) / [TOJ-135](https://linear.app/tojemoc/issue/TOJ-135):
  - [x] Video view counts in admin
  - [x] Referrer / traffic source breakdown
  - [x] Country (geo) breakdown
  - [ ] CMS **page** view counts (only video-segment traffic is counted today)
  - [ ] “Help sponsor” (or similar) editor workflow — needs a product decision; no sponsor UX exists in-repo
  - Build on first-party D1 tables above, not a new third-party pageview SDK.
