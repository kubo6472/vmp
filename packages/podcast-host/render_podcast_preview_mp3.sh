#!/bin/bash
# Generate videos/<VIDEO_ID>/podcast_preview.mp3 from full podcast.mp3 for RSS preview length.
# Requires: ffmpeg, rclone (same bucket layout as scripts/video_pipeline_watch.sh).
#
# Usage (from repo root):
#   R2_BUCKET=vmp-videos npm run render --workspace=@vmp/podcast-host -- <video_id> <preview_seconds>
#
set -euo pipefail

VIDEO_ID="${1:?video id}"
PREVIEW_SEC="${2:?preview seconds (integer)}"

R2_BUCKET="${R2_BUCKET:-vmp-videos}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"
R2_BUCKET_NAME="${R2_BUCKET_NAME:-}"
MP3_FULL="podcast.mp3"
MP3_OUT="podcast_preview.mp3"
TMP_DIR="${TMPDIR:-/tmp}/vmp_podcast_preview_${VIDEO_ID}_$$"

mkdir -p "$TMP_DIR"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

r2_root() {
  if [ -n "$RCLONE_REMOTE" ]; then
    if [ -n "$R2_BUCKET_NAME" ]; then
      printf "%s:%s" "$RCLONE_REMOTE" "$R2_BUCKET_NAME"
    else
      printf "%s:" "$RCLONE_REMOTE"
    fi
    return
  fi

  if [[ "$R2_BUCKET" == *:* ]]; then
    printf "%s" "$R2_BUCKET"
  else
    printf "%s:" "$R2_BUCKET"
  fi
}

r2_path() {
  local rel="${1#/}"
  local root
  root="$(r2_root)"
  root="${root%/}"
  printf "%s/%s" "$root" "$rel"
}

REMOTE_FULL="$(r2_path "videos/${VIDEO_ID}/${MP3_FULL}")"
LOCAL_IN="$TMP_DIR/${MP3_FULL}"
LOCAL_OUT="$TMP_DIR/${MP3_OUT}"

echo "Downloading ${REMOTE_FULL}"
rclone copyto "$REMOTE_FULL" "$LOCAL_IN"

if [ ! -s "$LOCAL_IN" ]; then
  echo "Missing or empty ${MP3_FULL} for ${VIDEO_ID}" >&2
  exit 1
fi

echo "Encoding first ${PREVIEW_SEC}s to ${MP3_OUT} at 128k"
ffmpeg -hide_banner -y -i "$LOCAL_IN" -t "$PREVIEW_SEC" -vn -c:a libmp3lame -b:a 128k -f mp3 "$LOCAL_OUT"

REMOTE_OUT="$(r2_path "videos/${VIDEO_ID}/${MP3_OUT}")"
echo "Uploading ${REMOTE_OUT}"
rclone copyto "$LOCAL_OUT" "$REMOTE_OUT"

echo "Done: ${VIDEO_ID} preview MP3 (${PREVIEW_SEC}s)"