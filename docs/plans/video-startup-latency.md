# Video startup latency (`video-startup-latency`)

## Problem

Measured on production (`vmp-api.tjm.sk`, 2026-09-10) for a published VOD:

| Step | Cold time (this probe) | Notes |
|------|------------------------|-------|
| `GET /api/video-access/:id` | ~1.0s | D1 + token mint |
| Master `.m3u8` | ~0.35s | 6s CMAF, Shaka |
| Variant playlist | ~0.55s | |
| Init segment | ~0.5–0.6s | 854 B — TTFB-dominated |
| First **1080p** segment | ~0.5–1.4s | **~3.7 MB** at `#EXTINF:6.000` |
| First **720p** segment | ~0.9–1.2s | **~2.2 MB** |

End-to-end “click → playing” reported ~**7s** (SK/CZ viewers, R2 origin) vs ~**3s** on the old Bunny-edge platform.

### Root causes (validated)

1. **6s segments** (PR #162) — first media unit is 3× larger than 2s packaging; startup download dominates.
2. **Master lists 1080p first** (~5.9 Mbps) — players often start on the first / highest ladder rung.
3. **`vt` query on every URL** — unique per `video-access` call, so Cloudflare CDN `Cache-Control` cannot share segment objects across viewers. Responses also lacked `CF-Cache-Status` (Workers do not edge-cache by default).
4. **Watch-page waterfall** — recommendations + full playlist preflight `GET` run **before** player init, then Video.js fetches the same playlist again.
5. **Origin path** — every miss is Worker → R2 binding (or B2 primary). Old platform served from Bunny PoPs near the viewer.

R2 region vs B2 Amsterdam is secondary to (1)–(4) for first-play latency: TTFB on tiny init objects is already hundreds of ms through the proxy, and the first 6s 1080p segment is megabytes.

## Goals

Cut perceived startup toward the old ~3s bar without giving up signed proxy URLs / preview enforcement.

## Deliverables (this PR)

- [x] Path-keyed **Workers Cache API** for immutable `.m4s` / `init*.mp4` after `vt` auth (strip query from cache key).
- [x] Rewrite master playlists to **ascending BANDWIDTH** so ABR starts on the cheapest rung.
- [x] Watch page: **start player immediately**; recommendations load in parallel; playlist preflight no longer blocks init.
- [x] Aggressive async above-the-fold HLS startup prefetch (init + first **3** segments on the cheapest rung + audio): eager queue of ~12 cards when logged in / ~4 when anonymous (session budget under `rate_limit_anon`), plus IntersectionObserver with **one viewport** of `rootMargin` so content just below the fold warms too. Category grids use the same queue.
- [x] Plan + roadmap entry; unit tests for cache key / bandwidth sort / prefetch URL picking.

## Follow-ups (not this PR)

- Revisit **2–4s segment duration** for new encodes (packaging / Encore-packager config) — largest remaining byte-size lever; requires re-package or dual ladders.
- Optional Bunny (or R2 custom domain + Cache Rules) for hot segments once auth model allows cacheable URLs.
- PostHog `video_startup_ms` / `time_to_first_frame` event for ongoing validation (taxonomy currently lacks playback timing).
