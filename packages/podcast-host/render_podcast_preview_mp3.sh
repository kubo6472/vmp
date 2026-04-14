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
MP3_FULL="podcast.mp3"
MP3_OUT="podcast_preview.mp3"
TMP_DIR="${TMPDIR:-/tmp}/vmp_podcast_preview_${VIDEO_ID}_$$"

mkdir -p "$TMP_DIR"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

REMOTE_FULL="${R2_BUCKET}:/videos/${VIDEO_ID}/${MP3_FULL}"
LOCAL_IN="$TMP_DIR/${MP3_FULL}"
LOCAL_OUT="$TMP_DIR/${MP3_OUT}"

echo "Downloading ${REMOTE_FULL}"
rclone copyto "$REMOTE_FULL" "$LOCAL_IN"

if [ ! -s "$LOCAL_IN" ]; then
  echo "Missing or empty ${MP3_FULL} for ${VIDEO_ID}" >&2
  exit 1
fi

echo "Encoding first ${PREVIEW_SEC}s to ${MP3_OUT}"
ffmpeg -hide_banner -y -i "$LOCAL_IN" -t "$PREVIEW_SEC" -vn -c:a copy -f mp3 "$LOCAL_OUT"

REMOTE_OUT="${R2_BUCKET}:/videos/${VIDEO_ID}/${MP3_OUT}"
echo "Uploading ${REMOTE_OUT}"
rclone copyto "$LOCAL_OUT" "$REMOTE_OUT"

echo "Done: ${VIDEO_ID} preview MP3 (${PREVIEW_SEC}s)"
