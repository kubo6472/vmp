#!/bin/bash
# Thin wrapper — canonical script lives in the npm package (single copy for systemd / upgrades).
# Override paths with env: INBOX_DIR, TMP_DIR_BASE, R2_BUCKET, etc.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
exec bash "$REPO_ROOT/packages/podcast-host/bin/video_pipeline_watch.sh" "$@"
