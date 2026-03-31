#!/bin/bash
set -euo pipefail

INBOX_DIR="/mnt/videos/inbox"
TMP_DIR_BASE="/mnt/tmp/video_pipeline"
R2_BUCKET="vmp-videos"

MAX_JOBS=2

mkdir -p "$TMP_DIR_BASE"

log() {
    echo "$(date '+%F %T') $*"
}

wait_for_slot() {
    while [ "$(jobs -r | wc -l)" -ge "$MAX_JOBS" ]; do
        sleep 1
    done
}

# ------------------------
# PROCESS FUNCTION
# ------------------------
process_video() {
    VIDEO_ID="$1"
    INPUT_PATH="$2"
    TMP_DIR="$TMP_DIR_BASE/$VIDEO_ID"

    mkdir -p "$TMP_DIR"

    LOCK="$TMP_DIR/.lock"
    DONE="$TMP_DIR/.done"

    # skip finished jobs
    if [ -f "$DONE" ]; then
        log "âœ… $VIDEO_ID already done"
        return
    fi

    # smarter stale lock detection
    if [ -f "$LOCK" ]; then
        if ! pgrep -f "$VIDEO_ID" > /dev/null; then
            log "âš ï¸ Stale lock detected for $VIDEO_ID â€” recovering"
            rm -f "$LOCK"
        else
            log "â© $VIDEO_ID already processing"
            return
        fi
    fi

    touch "$LOCK"

    # always release lock on ANY error
    trap 'log "âŒ Error occurred for '"$VIDEO_ID"' â€” releasing lock"; rm -f "$LOCK"' ERR

    log "ðŸ“¥ Processing $VIDEO_ID"

    # wait for upload completion
    PREV=-1
    while true; do
        [ ! -f "$INPUT_PATH" ] && { log "âŒ Missing input"; rm -f "$LOCK"; return; }
        CUR=$(stat -c%s "$INPUT_PATH")
        [[ "$CUR" -eq "$PREV" ]] && break
        PREV=$CUR
        sleep 2
    done

    log "âœ… Upload complete"

    # ------------------------
    # ENCODING (only missing)
    # ------------------------
    need_encode=false
    for r in 1080p.mp4 720p.mp4 480p.mp4; do
        [ -f "$TMP_DIR/$r" ] || need_encode=true
    done

    if [ "$need_encode" = true ]; then
        log "ðŸš€ Encoding missing renditions"

        ffmpeg -hide_banner -y -i "$INPUT_PATH" \
        -filter_complex "\
        [0:v]split=3[v1][v2][v3]; \
        [v1]scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2[v1out]; \
        [v2]scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2[v2out]; \
        [v3]scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2[v3out]" \
        \
        -map "[v1out]" -map 0:a? -c:v:0 libx264 -b:v:0 5M -preset fast -c:a:0 aac -b:a:0 128k "$TMP_DIR/1080p.mp4" \
        -map "[v2out]" -map 0:a? -c:v:1 libx264 -b:v:1 3M -preset fast -c:a:1 aac -b:a:1 128k "$TMP_DIR/720p.mp4" \
        -map "[v3out]" -map 0:a? -c:v:2 libx264 -b:v:2 1.5M -preset fast -c:a:2 aac -b:a:2 96k "$TMP_DIR/480p.mp4"

        log "âœ… Encoding done"
    else
        log "â© Skipping encoding (already done)"
    fi

    # ------------------------
    # SHAKA (only if needed)
    # ------------------------
    if [ ! -f "$TMP_DIR/master.m3u8" ]; then
        log "ðŸš€ Packaging with Shaka"

        HAS_AUDIO=$(ffprobe -v error -select_streams a \
            -show_entries stream=index -of csv=p=0 "$INPUT_PATH" 2>/dev/null | wc -l || echo 0)
        HAS_AUDIO=${HAS_AUDIO:-0}

        SHAKA_CMD=(shaka-packager
            input="$TMP_DIR/1080p.mp4",stream=video,output="$TMP_DIR/video_1080.mp4"
            input="$TMP_DIR/720p.mp4",stream=video,output="$TMP_DIR/video_720.mp4"
            input="$TMP_DIR/480p.mp4",stream=video,output="$TMP_DIR/video_480.mp4"
            --segment_duration 2
            --fragment_duration 2
            --mpd_output "$TMP_DIR/manifest.mpd"
            --hls_master_playlist_output "$TMP_DIR/master.m3u8"
        )

        [ "$HAS_AUDIO" -gt 0 ] && \
            SHAKA_CMD+=(input="$TMP_DIR/1080p.mp4",stream=audio,output="$TMP_DIR/audio.mp4")

        for i in {1..3}; do
            if "${SHAKA_CMD[@]}"; then
                log "âœ… Packaging done"
                break
            else
                log "âš ï¸ Shaka failed (attempt $i)"
                sleep 2
            fi
        done
    else
        log "â© Skipping packaging (already done)"
    fi

# ------------------------
# UPLOAD (retry + verify)
# ------------------------
log "ðŸš€ Uploading to R2"

UPLOAD_OK=false

for i in {1..5}; do
    if rclone copy "$TMP_DIR" "${R2_BUCKET}:/videos/${VIDEO_ID}" \
        --ignore-existing \
        --transfers 8 \
        --checkers 16; then
        UPLOAD_OK=true
        break
    else
        log "âš ï¸ Upload failed (attempt $i)"
        sleep 3
    fi
done

if [ "$UPLOAD_OK" = false ]; then
    log "âŒ Upload failed permanently â€” will retry later"
    rm -f "$LOCK"
    return
fi

log "ðŸ” Verifying upload..."

VERIFY_OK=false

for i in {1..5}; do
    if rclone ls "${R2_BUCKET}:/videos/${VIDEO_ID}" | grep -q "master.m3u8"; then
        VERIFY_OK=true
        break
    else
        log "âš ï¸ Verification failed (attempt $i)"
        sleep 2
    fi
done

if [ "$VERIFY_OK" = false ]; then
    log "âŒ Upload verification failed â€” will retry later"
    rm -f "$LOCK"
    return
fi

log "âœ… Upload verified"

# ------------------------
# CLEANUP
# ------------------------
log "ðŸ§¹ Cleaning up local files"

# mark done BEFORE cleanup
touch "$DONE"

log "ðŸ§¹ Cleaning up local files"
rm -f "$INPUT_PATH"
rm -rf "$TMP_DIR"

rm -f "$LOCK"

log "ðŸŽ‰ Finished $VIDEO_ID"
}

# ------------------------
# RESUME EXISTING JOBS
# ------------------------
log "ðŸ” Resuming existing jobs..."

for f in "$INBOX_DIR"/*; do
    [ -f "$f" ] || continue
    FILE=$(basename "$f")
    [[ "$FILE" =~ \.(mp4|mkv|mov)$ ]] || continue
    VIDEO_ID="${FILE%.*}"

    wait_for_slot
    process_video "$VIDEO_ID" "$f" &
done

# ------------------------
# WATCH NEW FILES
# ------------------------
log "ðŸŽ¬ Watching for new uploads..."

inotifywait -m -e close_write --format "%f" "$INBOX_DIR" | while read FILE; do
    [[ "$FILE" =~ \.(mp4|mkv|mov)$ ]] || continue
    VIDEO_ID="${FILE%.*}"

    wait_for_slot
    process_video "$VIDEO_ID" "$INBOX_DIR/$FILE" &
done

wait