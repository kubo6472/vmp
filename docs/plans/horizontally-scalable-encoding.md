# Horizontally scalable encoding (`horizontally-scalable-encoding`)

Shipped as part of the video-startup-latency PR (media pipeline ops). See also [video-startup-latency.md](./video-startup-latency.md).

## Problem

Default Compose runs FFmpeg on a single `encore-web` poller. Packager already had replica knobs; encode throughput did not scale across hosts/cores without a durable worker pool. SVT `encore-worker` exits after one job / drain, so naive `restart: unless-stopped` busy-loops when idle.

## Deliverables

- [x] `docker-compose.scale.yml` — disable web poller; looped `encore-worker-high` (queue 0) + `encore-worker-low` (queue 1); packager replicas
- [x] GPU / NFS overlays for scaled workers (`scale.nvidia.yml`, `scale.vaapi.yml`, `scale.nfs.yml`)
- [x] `encore-worker-loop.sh` — sleep between worker exits (no restart storm)
- [x] Encore job priorities remapped so fast-lane 720p → queue 0 (`encorePriorities.ts`)
- [x] Optional `ENCORE_SEGMENT_LENGTH_SECONDS` for Encore segmented (intra-job) parallel encode
- [x] `npm run encore:up:scale` + README / MIGRATION docs

## Ops quickstart

```bash
ENCORE_WORKER_HIGH_REPLICAS=3 ENCORE_WORKER_LOW_REPLICAS=2 ENCORE_PACKAGER_REPLICAS=3 \
  npm run encore:up:scale --workspace=@vmp/media-pipeline
```
