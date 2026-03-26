#!/bin/bash
# Upload HLS to Cloudflare R2
# Usage: ./upload-to-r2.sh local_dir bucket_name video_id

LOCAL_DIR=$1
BUCKET=$2
VIDEO_ID=$3

# Using wrangler r2 object put
for file in "$LOCAL_DIR"/*; do
  filename=$(basename "$file")
  wrangler r2 object put "$BUCKET/$VIDEO_ID/$filename" --file="$file"
  echo "Uploaded $filename"
done

echo "All files uploaded to $BUCKET/$VIDEO_ID/"