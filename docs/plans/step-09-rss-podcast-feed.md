# Step 9 — RSS / podcast feed

**Roadmap:** [ROADMAP.md](../../ROADMAP.md) → *Shipped*  
**Issue:** [#644](https://github.com/tojemoc/vmp/issues/644) / [TOJ-137](https://linear.app/tojemoc/issue/TOJ-137) (closed)  
**Status:** Shipped ([#653](https://github.com/tojemoc/vmp/pull/653))

## Scope

- Per-user RSS token: `HMAC-SHA256(RSS_SECRET, 'rss:' + userId + ':' + tokenVersion)` (or equivalent per-user secret). Store a **`rss_token_version`** (or per-user secret) on the user row; incorporate it into the HMAC input so URLs can be invalidated.
- **Rotation:** `POST /api/account/rss/rotate` (auth required) increments `rss_token_version` (or rotates the per-user secret) **before** returning the new `personalUrl`, invalidating previously issued premium-feed URLs.
- `GET /api/feed/:userId/:token` — validates token + user exists; personal feed access rules (see below).
- Account page section with copyable RSS URL, rotate control, and instructions.
- Public listing feed: `GET /api/feed/public` — stable URL for directory submission; always serves **preview-only** enclosures.
- Account helper: `GET /api/account/rss` (auth required) — returns `{ publicUrl, personalUrl }` for copy/paste into podcast apps.

### Personal feed access (match current handler)

Documented contract for `handlePersonalFeed` (`feed.ts`):

- **Premium access** (`hasPremiumAccess`): active subscription **or** administrative role (`editor`+).
- Premium users receive **full** enclosures for all published videos with media.
- When **`rss_free_preview_enabled`** admin setting is `1` (default), users **without** premium access still receive the feed but items are **preview-only** (respect `preview_duration`).
- When `rss_free_preview_enabled` is `0`, non-premium users get **402** `premium_required`.
- Invalid token → **404** (do not leak valid user IDs).

## Checklist

- [x] RSS token signing + validation (include token version / per-user secret)
- [x] Token rotation endpoint + account UI
- [x] Personal feed endpoint (documented access rules above)
- [x] Public preview-only feed
- [x] `GET /api/account/rss` helper (return URLs using current token version)
- [x] Account page RSS section (copy URLs + rotate + instructions)
- [x] Tests + feed validator smoke
