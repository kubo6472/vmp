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
        if ! pgrep -f "process_video.*$VIDEO_ID" > /dev/null; then
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
            "input=$TMP_DIR/1080p.mp4,stream=video,init_segment=$TMP_DIR/init_1080.mp4,segment_template=$TMP_DIR/seg_1080_\$Number\$.m4s"
            "input=$TMP_DIR/720p.mp4,stream=video,init_segment=$TMP_DIR/init_720.mp4,segment_template=$TMP_DIR/seg_720_\$Number\$.m4s"
            "input=$TMP_DIR/480p.mp4,stream=video,init_segment=$TMP_DIR/init_480.mp4,segment_template=$TMP_DIR/seg_480_\$Number\$.m4s"
            --segment_duration 2
            --fragment_duration 2
            --generate_static_live_mpd
            --mpd_output "$TMP_DIR/manifest.mpd"
            --hls_master_playlist_output "$TMP_DIR/master.m3u8"
        )

        [ "$HAS_AUDIO" -gt 0 ] && \
            SHAKA_CMD+=("input=$TMP_DIR/1080p.mp4,stream=audio,init_segment=$TMP_DIR/init_audio.mp4,segment_template=$TMP_DIR/seg_audio_\$Number\$.m4s")

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
log "🚀 Uploading to R2"

UPLOAD_OK=false

for i in {1..5}; do
    if ! rclone copy "$TMP_DIR" "${R2_BUCKET}:/videos/${VIDEO_ID}" \
        --exclude "1080p.mp4" \
        --exclude "720p.mp4" \
        --exclude "480p.mp4" \
        --ignore-existing \
        --transfers 8 \
        --checkers 16; then
        log "⚠️ Upload attempt $i failed (rclone error)"
        sleep 3
        continue
    fi

    # Verify the full segmented artifact set is present on R2
    if ! REMOTE=$(rclone lsf "${R2_BUCKET}:/videos/${VIDEO_ID}" 2>/dev/null); then
        log "⚠️ Upload attempt $i: rclone lsf failed — retrying upload"
        sleep 3
        continue
    fi
    MISSING=""

    for required in master.m3u8 manifest.mpd init_1080.mp4 init_720.mp4 init_480.mp4; do
        echo "$REMOTE" | grep -qx "$required" || MISSING="$MISSING $required"
    done

    # Check for audio artifacts if audio was present
    if [ "$HAS_AUDIO" -gt 0 ]; then
        echo "$REMOTE" | grep -qx "init_audio.mp4" || MISSING="$MISSING init_audio.mp4"
        audio_seg_cnt=$(echo "$REMOTE" | grep -c "^seg_audio_" 2>/dev/null || echo 0)
        [ "$audio_seg_cnt" -gt 0 ] || MISSING="$MISSING seg_audio_*.m4s(none)"
    fi

    for res in 1080 720 480; do
        cnt=$(echo "$REMOTE" | grep -c "^seg_${res}_" 2>/dev/null || echo 0)
        [ "$cnt" -gt 0 ] || MISSING="$MISSING seg_${res}_*.m4s(none)"
    done

    if [ -z "$MISSING" ]; then
        UPLOAD_OK=true
        break
    else
        log "⚠️ Upload attempt $i incomplete — missing:$MISSING"
        sleep 3
    fi
done

if [ "$UPLOAD_OK" = false ]; then
    log "❌ Upload failed permanently — will retry later"
    rm -f "$LOCK"
    return
fi

log "✅ Upload verified"
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
# GARBAGE COLLECTION
# ------------------------
# Removes leftover tmp dirs and inbox files from previous runs:
#   - Dirs with a .done file (upload succeeded but cleanup didn't finish)
#   - Orphaned dirs with no matching inbox file and no active lock
garbage_collect() {
    log "🗑️  Garbage collecting stale pipeline directories..."
    local had_any=false

    for dir in "$TMP_DIR_BASE"/*/; do
        [ -d "$dir" ] || continue
        had_any=true
        local VIDEO_ID
        VIDEO_ID=$(basename "$dir")
        local LOCK="$dir/.lock"
        local DONE="$dir/.done"

        # Clear stale locks using the same heuristic as process_video():
        # if a lock exists but no process is running for this VIDEO_ID, the job crashed.
        if [ -f "$LOCK" ] && ! pgrep -f "process_video.*$VIDEO_ID" > /dev/null; then
            log "🗑️  GC: removing stale lock for $VIDEO_ID"
            rm -f "$LOCK"
        fi

        # Check if a corresponding inbox file still exists (any supported extension)
        local inbox_exists=false
        for ext in mp4 mkv mov; do
            [ -f "$INBOX_DIR/${VIDEO_ID}.${ext}" ] && { inbox_exists=true; break; }
        done

        if [ -f "$DONE" ]; then
            # Upload completed but cleanup was interrupted — safe to remove now
            log "🗑️  GC: removing completed tmp dir for $VIDEO_ID"
            for ext in mp4 mkv mov; do
                rm -f "$INBOX_DIR/${VIDEO_ID}.${ext}"
            done
            rm -rf "$dir"
        elif [ "$inbox_exists" = false ] && [ ! -f "$LOCK" ]; then
            # No inbox file, no active lock, no done marker — orphaned partial job
            log "🗑️  GC: removing orphaned tmp dir for $VIDEO_ID"
            rm -rf "$dir"
        fi
        # Dirs with an active .lock (currently processing) are left untouched
    done

    if [ "$had_any" = false ]; then
        log "🗑️  GC: nothing to clean up"
    fi
}

# ------------------------
# RESUME EXISTING JOBS
# ------------------------
garbage_collect

log "🔍 Resuming existing jobs..."

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
garbage_collect

log "🎬 Watching for new uploads..."

inotifywait -m -e close_write --format "%f" "$INBOX_DIR" | while read FILE; do
    [[ "$FILE" =~ \.(mp4|mkv|mov)$ ]] || continue
    VIDEO_ID="${FILE%.*}"

    wait_for_slot
    process_video "$VIDEO_ID" "$INBOX_DIR/$FILE" &
done

wait