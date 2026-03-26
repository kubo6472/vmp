#!/bin/bash
# Create HLS from input video
# Usage: ./create-hls.sh input.mp4 output_dir

INPUT=$1
OUTPUT_DIR=$2

mkdir -p "$OUTPUT_DIR"

ffmpeg -i "$INPUT" \
  -codec: copy \
  -start_number 0 \
  -hls_time 10 \
  -hls_list_size 0 \
  -f hls \
  "$OUTPUT_DIR/playlist.m3u8"

echo "HLS created at $OUTPUT_DIR/playlist.m3u8"