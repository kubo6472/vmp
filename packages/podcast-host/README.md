# @vmp/podcast-host

Runs on the **media VM** (alongside ffmpeg, shaka-packager, rclone). It bundles:

1. **`bin/video_pipeline_watch.sh`** — watchfolder → encode → Shaka HLS → `podcast.mp3` → R2 (same behaviour as the historical `scripts/video_pipeline_watch.sh`; the repo root script is now a thin wrapper for backwards compatibility).
2. **`supervisor.mjs`** — one long-lived Node process that:
   - spawns the pipeline as a child (optional via `VMP_RUN_PIPELINE`),
   - serves a **local dashboard** at `http://127.0.0.1:8788/` (job queue + pipeline status + log tail),
   - accepts the **same signed webhook** the Worker sends (`POST /api/podcast-preview-rebuild`, HMAC body).
3. **`render_podcast_preview_mp3.sh`** — builds `podcast_preview.mp3` from full `podcast.mp3` for a given duration (used by the webhook queue).

## Install on the VM

From a git checkout of this monorepo:

```bash
cd /path/to/vmp
npm install
```

## Run (recommended: systemd)

Point `WorkingDirectory` at the repo (or at `packages/podcast-host` if you copy only that package — then set `VMP_PIPELINE_SCRIPT` to the absolute path of `bin/video_pipeline_watch.sh`).

```ini
[Service]
Type=simple
WorkingDirectory=/opt/vmp
Environment=VMP_WEBHOOK_SECRET=your-long-shared-secret
Environment=INBOX_DIR=/mnt/videos/inbox
Environment=TMP_DIR_BASE=/mnt/tmp/video_pipeline
Environment=R2_BUCKET=vmp-videos
ExecStart=/usr/bin/node /opt/vmp/packages/podcast-host/supervisor.mjs
Restart=always
```

Expose the HTTP port to the Worker only (VPN, SSH tunnel, or reverse proxy with auth). In the admin UI, set the webhook URL to:

`https://your-media-host/vmp/api/podcast-preview-rebuild`

(supervisor also accepts `/api/podcast-preview-rebuild` and legacy `/vmp/podcast-preview-rebuild`).

### Environment

| Variable | Purpose |
|----------|---------|
| `VMP_WEBHOOK_SECRET` | Same value as `podcast_rebuild_webhook_secret` in D1 admin settings |
| `VMP_UI_HOST` | Bind address (default `127.0.0.1`) |
| `VMP_UI_PORT` | Dashboard + webhook port (default `8788`) |
| `VMP_RUN_PIPELINE` | `1` (default) run watchfolder pipeline; `0` only UI + preview jobs |
| `VMP_PIPELINE_SCRIPT` | Override path to `video_pipeline_watch.sh` |
| `VMP_PREVIEW_CONCURRENCY` | Parallel preview encodes (default `1`) |
| `MP3_BITRATE` | Full and preview podcast MP3 bitrate in kbps (default `128`) |
| `VIDEO_ID_SANITIZE_MODE` | Controls ID derivation from filename stem: `slug-hash` (default), `slug`, `base64url`, `none` |
| `VAAPI_DEVICE` | GPU device node for VAAPI hardware encoding (default `/dev/dri/renderD128`). Requires a GPU with VAAPI support and read/write access to the device node. |
| `INBOX_DIR`, `TMP_DIR_BASE`, `R2_BUCKET`, … | Passed through to the bash pipeline |

## “Fragmented MP3” and podcast apps

**HLS** (and DASH) use **segmented** media — that is what people often mean by “fragmented” streaming. **Podcast RSS enclosures** almost always expect a **single URL** to one file (MP3/M4A) or, in our app, an HLS URL — not a bag of raw MPEG TS fragments.

**MP3** can be streamed in theory, but there is **no** widely supported standard for “fragmented MP3” as a podcast enclosure the way HLS is for video. **Do not** rely on exotic MP3 framing for RSS: keep using **one `podcast_preview.mp3` file** (re-encoded when preview length changes) or **HLS** for preview, which podcast apps already handle via the proxy URL.

## npm scripts

- `npm run start` — supervisor (pipeline + dashboard + webhook)
- `npm run pipeline` — bash pipeline only (no Node; for debugging)
- `npm run render -- <video_id> <seconds>` — one-off preview MP3
- `npm run migrate-r2-prefixes` — copy/sync `videos/<old_id>/` prefixes to `videos/<new_id>/` using mapping JSON from API migration

## Video ID migration workflow (no reupload)

1. Generate mapping on API side (dry run):

```bash
cd /path/to/vmp
DRY_RUN=1 APPLY=0 MAPPING_JSON_PATH=/tmp/video-id-map.json \
  npm run db:migration-normalize-video-ids --workspace=@vmp/api
```

2. Apply DB rewrite when mapping looks correct:

```bash
DRY_RUN=0 APPLY=1 MAPPING_JSON_PATH=/tmp/video-id-map.json \
  npm run db:migration-normalize-video-ids --workspace=@vmp/api
```

3. On the podcast-host VM, pull this branch and run R2 prefix migration:

```bash
cd /path/to/vmp
MAPPING_JSON_PATH=/tmp/video-id-map.json \
  R2_BUCKET=vmp-videos \
  bash ./packages/podcast-host/bin/video_id_r2_prefix_migrate.sh
```

Optional flags:
- `APPLY=0` (default) preview only
- `APPLY=1` perform copy/sync
- `DELETE_OLD=1` delete old prefixes after successful copy + verification