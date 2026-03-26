#!/bin/bash
# Create preview HLS (first N seconds)
# Usage: ./create-preview.sh input.mp4 output_dir duration_seconds

INPUT=$1
OUTPUT_DIR=$2
DURATION=$3

mkdir -p "$OUTPUT_DIR"

ffmpeg -i "$INPUT" \
  -t "$DURATION" \
  -codec: copy \
  -start_number 0 \
  -hls_time 10 \
  -hls_list_size 0 \
  -f hls \
  "$OUTPUT_DIR/playlist.m3u8"

echo "Preview HLS created at $OUTPUT_DIR/playlist.m3u8"