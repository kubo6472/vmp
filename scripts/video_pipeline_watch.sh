#!/bin/bash
set -euo pipefail

INBOX_DIR="/mnt/videos/inbox"
TMP_DIR_BASE="/mnt/tmp/video_pipeline"
R2_BUCKET="vmp-videos"
MP3_NAME="podcast.mp3"
# Optional RSS preview clip (same bucket path): `podcast_preview.mp3` — generate with
# `scripts/render_podcast_preview_mp3.sh` when preview_duration changes, or rely on HLS in the feed.
BACKFILL_FROM_R2="${BACKFILL_FROM_R2:-1}"
MP3_ONLY="${MP3_ONLY:-0}"

MAX_JOBS=2

mkdir -p "$TMP_DIR_BASE"
SLOT_DIR="$TMP_DIR_BASE/.slots"
SLOT_LOCK="$TMP_DIR_BASE/.slots.lock"
BACKFILL_STAGING_DIR="$TMP_DIR_BASE/.backfill_staging"
mkdir -p "$SLOT_DIR"
mkdir -p "$BACKFILL_STAGING_DIR"
touch "$SLOT_LOCK"

log() {
    echo "$(date '+%F %T') $*"
}

wait_for_slot() {
    local holder_pid="${1:-$BASHPID}"
    while true; do
        if flock -x "$SLOT_LOCK" bash -s -- "$SLOT_DIR" "$MAX_JOBS" "$holder_pid" <<'EOF'
set -euo pipefail
slot_dir="$1"
max_jobs="$2"
holder_pid="$3"

mkdir -p "$slot_dir"
shopt -s nullglob
files=( "$slot_dir"/*.pid )

for token in "${files[@]}"; do
    pid="$(basename "$token" .pid)"
    kill -0 "$pid" 2>/dev/null || rm -f "$token"
done

files=( "$slot_dir"/*.pid )
current_jobs=${#files[@]}
if [ "$current_jobs" -lt "$max_jobs" ]; then
    printf "%s\n" "$holder_pid" > "$slot_dir/$holder_pid.pid"
    exit 0
fi
exit 1
EOF
        then
            return
        fi
        sleep 1
    done
}

release_slot() {
    local holder_pid="${1:-$BASHPID}"
    rm -f "$SLOT_DIR/$holder_pid.pid"
}

has_remote_file() {
    local video_id="$1"
    local file_name="$2"
    rclone lsf "${R2_BUCKET}:/videos/${video_id}" --recursive 2>/dev/null | awk -F/ '{print $NF}' | grep -qx "$file_name"
}

has_remote_hls_complete() {
    local video_id="$1"
    local remote
    if ! remote=$(rclone lsf "${R2_BUCKET}:/videos/${video_id}" --recursive 2>/dev/null); then
        return 1
    fi

    local basenames
    basenames=$(echo "$remote" | awk -F/ '{print $NF}')

    echo "$basenames" | grep -qx "master.m3u8" || return 1
    # DASH manifest is optional in some newer pipelines; accept if present or absent.

    for res in 1080 720 480; do
        echo "$basenames" | grep -qx "init_${res}.mp4" || return 1
        local cnt
        cnt=$(echo "$basenames" | grep -c "^seg_${res}_.*\\.m4s$" || true)
        [ "${cnt:-0}" -gt 0 ] || return 1
    done

    return 0
}

find_remote_source_key() {
    local video_id="$1"
    local key
    key=$(rclone lsf "${R2_BUCKET}:/videos/${video_id}/source" 2>/dev/null | \
        grep -Ei '\.(mp4|mkv|mov)$' | head -n 1 || true)
    [ -n "$key" ] || return 1
    printf "%s\n" "$key"
}

ensure_input_from_r2() {
    local video_id="$1"
    local input_path="$2"
    local src_key

    src_key=$(find_remote_source_key "$video_id" || true)
    if [ -z "$src_key" ]; then
        log "❌ $video_id has no source file in R2 (videos/$video_id/source/)"
        return 1
    fi

    mkdir -p "$(dirname "$input_path")"
    log "☁️  Downloading source from R2 for $video_id ($src_key)"
    rclone copyto "${R2_BUCKET}:/videos/${video_id}/source/${src_key}" "$input_path"
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
    wait_for_slot "$BASHPID"

    # always release lock on ANY error
    trap 'log "âŒ Error occurred for '"$VIDEO_ID"' â€” releasing lock"; rm -f "$LOCK"; release_slot "$BASHPID"' ERR

    log "ðŸ“¥ Processing $VIDEO_ID"

    # pull source from R2 if inbox file is missing (backfill mode)
    if [ ! -f "$INPUT_PATH" ]; then
        if ! ensure_input_from_r2 "$VIDEO_ID" "$INPUT_PATH"; then
            rm -f "$LOCK"
            rm -f "$BACKFILL_STAGING_DIR/${VIDEO_ID}.mp4"
            release_slot "$BASHPID"
            garbage_collect
            return
        fi
    fi

    # wait for upload completion
    PREV=-1
    while true; do
        [ ! -f "$INPUT_PATH" ] && { log "❌ Missing input"; rm -f "$LOCK"; release_slot "$BASHPID"; return; }
        CUR=$(stat -c%s "$INPUT_PATH")
        [[ "$CUR" -eq "$PREV" ]] && break
        PREV=$CUR
        sleep 2
    done

    log "âœ… Upload complete"

    HAS_AUDIO=$({
        ffprobe -v error -select_streams a \
            -show_entries stream=index -of csv=p=0 "$INPUT_PATH" 2>/dev/null || true
    } | wc -l)
    HAS_AUDIO=${HAS_AUDIO:-0}

    should_process_video="1"
    if [ "$MP3_ONLY" = "1" ] || has_remote_hls_complete "$VIDEO_ID"; then
        should_process_video="0"
    fi

    # ------------------------
    # ENCODING (only missing)
    # ------------------------
    if [ "$should_process_video" = "1" ]; then
        need_encode=false
        for r in 1080p.mp4 720p.mp4 480p.mp4; do
            if [ -f "$TMP_DIR/$r" ]; then
                # Validate existing artifact
                if ! ffprobe -v error -show_streams "$TMP_DIR/$r" >/dev/null 2>&1; then
                    log "⚠️ Existing $r is corrupt, will re-encode"
                    rm -f "$TMP_DIR/$r"
                    need_encode=true
                fi
            else
                need_encode=true
            fi
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
            -map "[v1out]" -map 0:a? -c:v:0 libx264 -b:v:0 5M -preset fast -c:a:0 aac -b:a:0 128k -f mp4 "$TMP_DIR/1080p.mp4.tmp.$$" \
            -map "[v2out]" -map 0:a? -c:v:1 libx264 -b:v:1 3M -preset fast -c:a:1 aac -b:a:1 128k -f mp4 "$TMP_DIR/720p.mp4.tmp.$$" \
            -map "[v3out]" -map 0:a? -c:v:2 libx264 -b:v:2 1.5M -preset fast -c:a:2 aac -b:a:2 96k -f mp4 "$TMP_DIR/480p.mp4.tmp.$$"

            # Move temp files to final location only after successful encoding
            mv "$TMP_DIR/1080p.mp4.tmp.$$" "$TMP_DIR/1080p.mp4"
            mv "$TMP_DIR/720p.mp4.tmp.$$" "$TMP_DIR/720p.mp4"
            mv "$TMP_DIR/480p.mp4.tmp.$$" "$TMP_DIR/480p.mp4"

            log "âœ… Encoding done"
        else
            log "â© Skipping encoding (already done)"
        fi
    else
        if [ "$MP3_ONLY" = "1" ]; then
            log "⏩ MP3_ONLY=1 — skipping video encoding and packaging"
        else
            log "⏩ Remote HLS already complete for $VIDEO_ID — skipping video encoding and packaging"
        fi
    fi

    # ------------------------
    # PODCAST MP3 (only missing)
    # ------------------------
    need_mp3=true
    if [ -f "$TMP_DIR/$MP3_NAME" ]; then
        # Validate existing MP3
        if [ -s "$TMP_DIR/$MP3_NAME" ] && ffprobe -v error -show_streams "$TMP_DIR/$MP3_NAME" >/dev/null 2>&1; then
            need_mp3=false
        else
            log "⚠️ Existing $MP3_NAME is invalid, will re-encode"
            rm -f "$TMP_DIR/$MP3_NAME"
        fi
    elif has_remote_file "$VIDEO_ID" "$MP3_NAME"; then
        need_mp3=false
    fi

    if [ "$need_mp3" = true ]; then
        if [ "$HAS_AUDIO" -gt 0 ]; then
            log "🎧 Encoding podcast MP3"
            ffmpeg -hide_banner -y -i "$INPUT_PATH" \
                -vn -map 0:a:0 -c:a libmp3lame -b:a 192k -f mp3 "$TMP_DIR/$MP3_NAME.tmp.$$"
            mv "$TMP_DIR/$MP3_NAME.tmp.$$" "$TMP_DIR/$MP3_NAME"
            log "✅ MP3 encoding done"
        else
            log "⚠️ No audio stream for $VIDEO_ID — skipping MP3 generation"
        fi
    else
        log "⏩ Skipping MP3 encoding (already exists)"
    fi

    # ------------------------
    # SHAKA (only if needed)
    # ------------------------
    if [ "$should_process_video" = "1" ]; then
        need_package=true
        if [ -f "$TMP_DIR/master.m3u8" ]; then
            # Validate existing manifests
            if [ -s "$TMP_DIR/master.m3u8" ] && [ -s "$TMP_DIR/manifest.mpd" ]; then
                need_package=false
            else
                log "⚠️ Existing manifests are invalid, will re-package"
                rm -f "$TMP_DIR/master.m3u8" "$TMP_DIR/manifest.mpd"
            fi
        fi

        if [ "$need_package" = true ]; then
            log "ðŸš€ Packaging with Shaka"

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

            shaka_ok=false
            for i in {1..3}; do
                if "${SHAKA_CMD[@]}"; then
                    log "âœ… Packaging done"
                    shaka_ok=true
                    break
                else
                    log "âš ï¸ Shaka failed (attempt $i)"
                    sleep 2
                fi
            done
            if [ "$shaka_ok" != true ]; then
                log "❌ Packaging failed after 3 attempts for $VIDEO_ID"
                rm -f "$LOCK"
                release_slot "$BASHPID"
                return
            fi
        else
            log "â© Skipping packaging (already done)"
        fi
    fi

# ------------------------
# UPLOAD (retry + verify)
# ------------------------
    log "🚀 [$VIDEO_ID] Uploading to R2"

UPLOAD_OK=false

for i in {1..5}; do
    if ! rclone copy "$TMP_DIR" "${R2_BUCKET}:/videos/${VIDEO_ID}" \
        --exclude "1080p.mp4" \
        --exclude "720p.mp4" \
        --exclude "480p.mp4" \
        --ignore-existing \
        --transfers 8 \
        --checkers 16; then
        log "⚠️ [$VIDEO_ID] Upload attempt $i failed (rclone error)"
        sleep 3
        continue
    fi

    # Verify the full segmented artifact set is present on R2
    if ! REMOTE=$(rclone lsf "${R2_BUCKET}:/videos/${VIDEO_ID}" --recursive 2>/dev/null); then
        log "⚠️ [$VIDEO_ID] Upload attempt $i: rclone lsf failed — retrying upload"
        sleep 3
        continue
    fi
    MISSING=""
    REMOTE_BASENAMES=$(echo "$REMOTE" | awk -F/ '{print $NF}')

    if [ "$should_process_video" = "1" ]; then
        for required in master.m3u8 init_1080.mp4 init_720.mp4 init_480.mp4; do
            echo "$REMOTE_BASENAMES" | grep -qx "$required" || MISSING="$MISSING $required"
        done
        # manifest.mpd is generated in the modern pipeline but not required for playback.
        # Keep it optional so uploads do not get stuck when DASH packaging is disabled.

        # Check for audio artifacts if audio was present
        if [ "$HAS_AUDIO" -gt 0 ]; then
            echo "$REMOTE_BASENAMES" | grep -qx "init_audio.mp4" || MISSING="$MISSING init_audio.mp4"
            audio_seg_cnt=$(echo "$REMOTE_BASENAMES" | grep -c "^seg_audio_.*\\.m4s$" || true)
            [ "${audio_seg_cnt:-0}" -gt 0 ] || MISSING="$MISSING seg_audio_*.m4s(none)"
        fi

        for res in 1080 720 480; do
            cnt=$(echo "$REMOTE_BASENAMES" | grep -c "^seg_${res}_.*\\.m4s$" || true)
            [ "${cnt:-0}" -gt 0 ] || MISSING="$MISSING seg_${res}_*.m4s(none)"
        done
    fi

    if [ "$HAS_AUDIO" -gt 0 ]; then
        echo "$REMOTE_BASENAMES" | grep -qx "$MP3_NAME" || MISSING="$MISSING $MP3_NAME"
    fi

    if [ -z "$MISSING" ]; then
        UPLOAD_OK=true
        break
    else
        log "⚠️ [$VIDEO_ID] Upload attempt $i incomplete — missing:$MISSING"
        sleep 3
    fi
done

if [ "$UPLOAD_OK" = false ]; then
    log "❌ [$VIDEO_ID] Upload failed permanently — will retry later"
    rm -f "$LOCK"
    release_slot "$BASHPID"
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
release_slot "$BASHPID"

log "ðŸŽ‰ Finished $VIDEO_ID"
}

enqueue_backfill_jobs_from_r2() {
    [ "$BACKFILL_FROM_R2" = "1" ] || return

    log "☁️  Scanning R2 for videos missing $MP3_NAME"
    local prefixes
    if ! prefixes=$(rclone lsf "${R2_BUCKET}:/videos" 2>/dev/null); then
        log "⚠️ Could not list R2 videos prefix; skipping backfill scan"
        return
    fi

    while IFS= read -r prefix; do
        [ -n "$prefix" ] || continue
        [[ "$prefix" =~ /$ ]] || continue
        local VIDEO_ID
        VIDEO_ID="${prefix%/}"
        [ -n "$VIDEO_ID" ] || continue

        if has_remote_file "$VIDEO_ID" "$MP3_NAME"; then
            continue
        fi

        local INPUT_PATH="$BACKFILL_STAGING_DIR/${VIDEO_ID}.mp4"
        # Call process_video but don't let its failure abort the loop
        process_video "$VIDEO_ID" "$INPUT_PATH" || {
            log "⚠️ Backfill processing failed for $VIDEO_ID, continuing scan"
        }
    done <<< "$prefixes"
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
    FILE_LOWER="${FILE,,}"
    [[ "$FILE_LOWER" =~ \.(mp4|mkv|mov)$ ]] || continue
    VIDEO_ID="${FILE%.*}"

    process_video "$VIDEO_ID" "$f" &
done

# ------------------------
# WATCH NEW FILES
# ------------------------
garbage_collect

log "🎬 Watching for new uploads..."

enqueue_backfill_jobs_from_r2 &

inotifywait -m -e close_write --format "%f" "$INBOX_DIR" | while IFS= read -r FILE; do
    FILE_LOWER="${FILE,,}"
    [[ "$FILE_LOWER" =~ \.(mp4|mkv|mov)$ ]] || continue
    VIDEO_ID="${FILE%.*}"

    process_video "$VIDEO_ID" "$INBOX_DIR/$FILE" &
done

wait
