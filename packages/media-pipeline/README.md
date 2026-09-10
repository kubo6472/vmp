# @vmp/media-pipeline

VMP media VM orchestration around **[SVT Encore](https://svt.github.io/encore/)** — production-grade transcoding-as-a-service used at Sveriges Television since 2019.

This package replaces the former `@vmp/podcast-host` custom ffmpeg/VAAPI encoder. Encore handles **video transcoding**; VMP still owns:

1. **Watchfolder intake** (`pipeline_watch.ts`) — inbox → stable file detection → video ID assignment
2. **encore-packager** — Shaka-based fMP4 HLS ladder + R2 upload (`master.m3u8`, per-rendition playlists, shared audio)
4. **Podcast MP3** — full `podcast.mp3` + preview jobs (`render_podcast_preview_mp3.ts`)
5. **Worker callbacks** — HMAC-signed `POST /api/admin/videos/:id/pipeline-status`
6. **Preview rebuild webhook** — supervisor accepts API-signed `podcast_preview_rebuild` events

## Architecture

Two ingest watchfolders let you A/B **fast-lane** (720p publishable first, then full ladder) vs **full-ladder-only** (single encode pass). Both paths log structured TTP with `pipelineMode` for comparison.

```text
┌─────────────────┐     POST /encoreJobs      ┌──────────────┐
│ pipeline_watch  │ ─────────────────────────►│ encore-web   │
│ (orchestrator)  │◄──── poll job status ─────│ + workers    │
└────────┬────────┘                           └──────┬───────┘
         │ enqueue packaging (Redis)                  │ FFmpeg (+ GPU profiles when available)
         ▼                                             ▼
┌─────────────────┐     S3 upload              shared /media volume
│ encore-packager │ ─────────────────────────► Cloudflare R2
│ (scale workers) │
└────────┬────────┘
         ▼
   @vmp/api Worker  ◄── pipeline-status callback (HMAC)
```

Encore transcodes → supervisor enqueues [Eyevinn encore-packager](https://github.com/Eyevinn/encore-packager) → packager runs Shaka and uploads HLS to R2. Scale Encore workers and packager replicas independently (e.g. 3 encode + 3 package).

Encore does **not** package HLS — that matches [SVT’s design](https://svt.github.io/encore/).

## Contents

- [Quick start (VM)](#quick-start-vm)
- [Encore deployment](#encore-deployment)
- [Run supervisor (systemd)](#run-supervisor-systemd)
- [Environment](#environment)
- [R2 object layout (unchanged)](#r2-object-layout-unchanged)
- [Migration from podcast-host](#migration-from-podcast-host)
- [Related documentation](#related-documentation)

## Quick start (VM)

From a git checkout of this monorepo:

```bash
cd /path/to/vmp
npm install
npm run build --workspace=@vmp/media-pipeline
```

Start Encore (Redis + web + workers):

```bash
npm run encore:up --workspace=@vmp/media-pipeline
# or: docker compose -f packages/media-pipeline/encore/docker-compose.yml up -d
```

Configure `/etc/vmp/env` (see [Environment](#environment)), then install the systemd unit from [systemd/README.md](systemd/README.md).

## Encore deployment

Bundled Compose stack: [`encore/docker-compose.yml`](encore/docker-compose.yml)

| Service | Image | Role |
| --- | --- | --- |
| `redis` | `redis:8.6-alpine` | Job queue (Encore + packager) |
| `encore-web` | `ghcr.io/svt/encore-web:latest` | REST API + job poller / FFmpeg encode (`POST /encoreJobs`, Swagger UI) |
| `vmp-supervisor` | `ghcr.io/tojemoc/vmp-media-pipeline:latest` | Watchfolder orchestrator, dashboard, webhooks, packaging queue API |
| `encore-packager` | `eyevinntechnology/encore-packager:latest` | Shaka HLS + R2 upload (scale via `ENCORE_PACKAGER_REPLICAS`) |

**Encore workers:** `ghcr.io/svt/encore-worker` is a **one-shot** process (poll once → exit). SVT intends them for on-demand scaling (e.g. KEDA), not a long-running Compose service — putting them under `restart: unless-stopped` causes a restart storm when the queue is empty. Default compose encodes on `encore-web`. Optional overlay: `docker-compose.workers.yml`.

VMP-specific encoding profiles live in [`encore/profiles/`](encore/profiles/):

| Profile | Rendition | Notes |
| --- | --- | --- |
| `vmp-720p-audio` (+ GPU variants) | 720p + AAC | Fast-lane phase 1 |
| `vmp-full-ladder` (+ GPU VAAPI) | 1080p + 720p + 480p | Full ladder (single job) |
| `vmp-podcast-mp3` / `vmp-podcast-preview` | Audio sidecars | Queued path podcast MP3 |

**Shared storage:** mount the same host tree Encore and the orchestrator use. Default Compose bind-mounts `${ENCORE_MEDIA_MOUNT:-/mnt}` → `/media` inside containers. On the host, set:

```bash
MEDIA_HOST_ROOT=/mnt
ENCORE_MEDIA_ROOT=/media   # path as seen inside Encore containers
```

**TrueNAS / NFS `mapall`:** stock images run as uid `1000` (encore-web) and `999` (vmp-supervisor). If the share squashes to another user (e.g. `3000:3000`), those containers get `Permission denied` on `/media`. Run:

```bash
MEDIA_USER=3000:3000 docker compose -f docker-compose.yml -f docker-compose.nfs.yml up -d
```

If Encore runs natively (JAR) on the same host without path translation, omit `ENCORE_MEDIA_ROOT` or set it equal to `MEDIA_HOST_ROOT`.

Official Encore docs: [Getting started](https://svt.github.io/encore/getting-started/) · [OpenAPI](https://svt.github.io/encore-doc/openapi.html)

## Run supervisor

**Recommended (Docker):** the supervisor runs in the same Compose stack as Encore — no host Node/npm or systemd required.

```bash
cd packages/media-pipeline/encore
cp .env.example .env   # fill secrets
docker compose up -d
curl -fsS http://127.0.0.1:8788/health
```

Image: `ghcr.io/tojemoc/vmp-media-pipeline` (built on every merge to `main` via `.github/workflows/media-pipeline-docker.yml`). Override with `VMP_SUPERVISOR_IMAGE` or `docker compose build vmp-supervisor` for a local build from the repo checkout.

**Alternative (systemd):** install the unit from [systemd/README.md](systemd/README.md). Requires `npm run build --workspace=@vmp/media-pipeline` on the host and a system Node binary (or `NODE_BIN` in `/etc/vmp/env` for NVM).

Expose the supervisor HTTP port to the Worker only (VPN, SSH tunnel, or reverse proxy). Admin webhook URL:

`https://your-media-host/vmp/api/podcast-preview-rebuild`

When the supervisor listens on a public interface (`VMP_UI_HOST=0.0.0.0`), set `VMP_SUPERVISOR_DASHBOARD_SECRET` and enter it in the dashboard unlock form. Webhook paths remain authenticated via HMAC (`VMP_WEBHOOK_SECRET`); packaging callbacks use their own secrets.

## Environment

### Encore

| Variable | Default | Purpose |
| --- | --- | --- |
| `ENCORE_BASE_URL` | `http://127.0.0.1:8080` | Encore web API base URL |
| `ENCORE_USER` / `ENCORE_PASSWORD` | — | HTTP basic auth when `ENCORE_SECURITY_ENABLED=true` |
| `ENCORE_MEDIA_ROOT` | `MEDIA_HOST_ROOT` | Path prefix Encore workers read (container mount) |
| `MEDIA_HOST_ROOT` | `/mnt` | Host path prefix for inbox/tmp |
| `ENCORE_POLL_MS` | `2000` | Job status poll interval |
| `ENCORE_JOB_TIMEOUT_MS` | `7200000` | Per-rendition transcode timeout (2 h) |
| `VMP_GPU_BACKEND` | `auto` | `auto` \| `vaapi` \| `nvenc` \| `cpu` — picks Encore profile variant |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | Passed to worker Compose for VAAPI profiles |

### Pipeline mode (dual inbox)

| Variable | Default | Purpose |
| --- | --- | --- |
| `INBOX_FAST_LANE_DIR` | `/mnt/videos/inbox-fast-lane` | **fast_lane** — 720p first, then full ladder (720p encoded twice) |
| `INBOX_FULL_LADDER_DIR` | `/mnt/videos/inbox-full-ladder` | **full_ladder** — single full ladder, `fully_processed` when done |
| `INBOX_DIR` | — | Legacy: if set, subdirs `fast-lane` / `full-ladder` are used when the above are unset |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Packaging queue (supervisor + packager) |
| `VMP_SUPERVISOR_URL` | `http://127.0.0.1:8788` | Packaging enqueue/status API |
| `PACKAGER_CALLBACK_URL` | `http://vmp:$VMP_PACKAGER_SECRET@vmp-supervisor:8788/vmp/api` | encore-packager callbacks (Basic auth; Eyevinn does not send custom headers) |
| `PACKAGE_FORMAT_OPTIONS_JSON` | `{"segmentDuration":2}` | Shaka options via encore-packager — **keep `segmentDuration` aligned with encode GOP** (profiles use `g`/`keyint_min` **60** @ 30fps = **2s** IDR; was 180/6s) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `S3_ENDPOINT_URL` | — | R2 credentials for encore-packager (`PACKAGE_OUTPUT_FOLDER=s3://…`) |

### HLS segment duration (startup latency)

New encodes target **2s** CMAF segments (was 6s after PR #162). Two knobs must stay in sync:

1. Encore profiles under `encore/profiles/` — `g` / `keyint_min: 60` at `r: 30`
2. `PACKAGE_FORMAT_OPTIONS_JSON` on `encore-packager` — `segmentDuration: 2`

Already-published VOD in R2 stays at whatever segment length it was packaged with until re-encoded. Shorter segments cut first-byte media size (~⅓ of a 6s segment) at the cost of more requests per minute of playback.

Drop a file in **fast-lane** inbox to stagger publish; drop in **full-ladder** for one-shot encoding. TTP logs include `pipelineMode` on every milestone for A/B analysis.

### VMP orchestrator

| Variable | Purpose |
| --- | --- |
| `VMP_WEBHOOK_SECRET` | Same as `podcast_rebuild_webhook_secret` in D1 |
| `VMP_SUPERVISOR_DASHBOARD_SECRET` | Protects dashboard + `/api/status` + job control (required when `VMP_UI_HOST` is not loopback) |
| `VMP_API_BASE_URL` | Worker base URL for pipeline status callbacks |
| `VMP_API_PIPELINE_SECRET` | Shared HMAC with Worker `VMP_API_PIPELINE_SECRET` |
| `VMP_UI_HOST` / `VMP_UI_PORT` | Supervisor dashboard + webhook bind (default `127.0.0.1:8788`) |
| `VMP_RUN_PIPELINE` | `1` run watchfolder; `0` UI + preview jobs only |
| `INBOX_FAST_LANE_DIR` / `INBOX_FULL_LADDER_DIR` | Dual watchfolders (see above) |
| `TMP_DIR_BASE` | Temp encode dirs (default `/mnt/tmp/video_pipeline`) |
| `VMP_TTP_LOG_PATH` | Optional JSONL time-to-publish log |
| `DD_*` | Datadog DogStatsD tags (see [datadog/README.md](datadog/README.md)) |

**GPU:** `VMP_GPU_BACKEND=auto` probes NVENC then VAAPI at job start and selects `*-gpu-nvenc` / `*-gpu-vaapi` Encore profiles when registered. Mount GPU devices on `encore-web` via `docker-compose.vaapi.yml` / `docker-compose.nvidia.yml`.

### Time-to-publish (TTP) logging

Unchanged — structured `VMP_TTP` lines on stdout. Summarize with:

```bash
node packages/media-pipeline/scripts/ttp-report.mjs /var/log/vmp-ttp.jsonl
```

## R2 object layout (unchanged)

Under `videos/{videoId}/`:

- `master.m3u8`, `720p/`, `1080p/`, `480p/`
- Shared audio: `init_audio.mp4`, `audio.m3u8`, `seg_audio_*.m4s`
- `podcast.mp3`, `podcast_preview.mp3`

The API video-proxy, RSS enclosures, and admin UI assume this layout — no Worker changes required for the Encore swap.

## Migration from podcast-host

See [MIGRATION.md](MIGRATION.md) for a step-by-step VM cutover checklist.

Summary:

1. Deploy Encore (`npm run encore:up`) and verify `curl http://127.0.0.1:8080/actuator/health`
2. Stop `vmp-supervisor`, pull this branch, `npm run build --workspace=@vmp/media-pipeline`
3. Update systemd `ExecStart` paths: `packages/media-pipeline/dist/supervisor.js`
4. Add Encore env vars; remove `VAAPI_DEVICE`
5. Start supervisor — pipeline health-checks Encore on boot

## Related documentation

| Document | Description |
| --- | --- |
| [MIGRATION.md](MIGRATION.md) | Cutover from `@vmp/podcast-host` |
| [systemd/README.md](systemd/README.md) | `vmp-supervisor` install |
| [datadog/README.md](datadog/README.md) | Agent templates |
| [AGENTS.md](../../AGENTS.md) | Monorepo secrets (`VMP_API_PIPELINE_SECRET`) |
| [SVT Encore docs](https://svt.github.io/encore/) | Upstream transcoder |
