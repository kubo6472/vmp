#!/usr/bin/env bash
set -euo pipefail

DB_NAME="${DB_NAME:-video-subscription-db}"
MODE_FLAG="${MODE_FLAG:---local}"
DRY_RUN="${DRY_RUN:-1}"
APPLY="${APPLY:-0}"
MAP_FILE="${MAP_FILE:-}"

if [[ "${1:-}" == "--remote" ]]; then
  MODE_FLAG="--remote"
fi

if [[ "$APPLY" == "1" ]]; then
  DRY_RUN="0"
fi

if [[ "$DRY_RUN" != "0" && "$DRY_RUN" != "1" ]]; then
  echo "[normalize-video-ids] DRY_RUN must be 0 or 1 (got '$DRY_RUN')"
  exit 1
fi

if [[ "$APPLY" != "0" && "$APPLY" != "1" ]]; then
  echo "[normalize-video-ids] APPLY must be 0 or 1 (got '$APPLY')"
  exit 1
fi

run_sql() {
  local sql="$1"
  npx wrangler d1 execute "$DB_NAME" "$MODE_FLAG" --command "$sql" >/dev/null
}

run_scalar() {
  local sql="$1"
  npx wrangler d1 execute "$DB_NAME" "$MODE_FLAG" --command "$sql" --json \
    | node -e '
      const fs = require("fs");
      const input = fs.readFileSync(0, "utf8").trim();
      const payload = JSON.parse(input);
      const firstResult = payload?.[0]?.results?.[0] ?? {};
      const firstValue = Object.values(firstResult)[0];
      process.stdout.write(String(firstValue ?? 0));
    '
}

run_rows() {
  local sql="$1"
  npx wrangler d1 execute "$DB_NAME" "$MODE_FLAG" --command "$sql" --json \
    | node -e '
      const fs = require("fs");
      const input = fs.readFileSync(0, "utf8").trim();
      const payload = JSON.parse(input);
      const rows = payload?.[0]?.results ?? [];
      for (const row of rows) {
        process.stdout.write(JSON.stringify(row) + "\n");
      }
    '
}

table_exists() {
  local table="$1"
  local n
  n="$(run_scalar "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '$table';")"
  [[ "$n" == "1" ]]
}

column_exists() {
  local table="$1"
  local column="$2"
  local n
  n="$(run_scalar "SELECT COUNT(*) AS n FROM pragma_table_info('$table') WHERE name = '$column';")"
  [[ "$n" == "1" ]]
}

video_id_hash8() {
  local input="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$input" | sha256sum | awk '{print substr($1,1,8)}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$input" | shasum -a 256 | awk '{print substr($1,1,8)}'
    return
  fi
  printf '00000000'
}

sanitize_video_id() {
  local raw="$1"
  local slug
  slug="$(printf '%s' "$raw" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-{2,}/-/g')"
  [ -n "$slug" ] || slug="video"
  if [[ "$raw" =~ ^[a-z0-9-]+$ ]]; then
    printf '%s' "$raw"
    return
  fi
  printf '%s-%s' "$slug" "$(video_id_hash8 "$raw")"
}

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

echo "[normalize-video-ids] Starting on ${DB_NAME} (${MODE_FLAG})"
echo "[normalize-video-ids] Mode: DRY_RUN=${DRY_RUN} APPLY=${APPLY}"

if ! table_exists "videos" || ! column_exists "videos" "id"; then
  echo "[normalize-video-ids] Required table/column missing: videos.id"
  exit 1
fi

if ! table_exists "video_category_assignments" || ! column_exists "video_category_assignments" "video_id"; then
  echo "[normalize-video-ids] Required table/column missing: video_category_assignments.video_id"
  exit 1
fi

if ! table_exists "video_segment_events" || ! column_exists "video_segment_events" "video_id"; then
  echo "[normalize-video-ids] Required table/column missing: video_segment_events.video_id"
  exit 1
fi

if ! table_exists "video_id_migration_map"; then
  run_sql "CREATE TABLE video_id_migration_map (
    old_id TEXT PRIMARY KEY,
    new_id TEXT NOT NULL UNIQUE,
    migrated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );"
fi

declare -A VIDEO_ID_MAP
while IFS= read -r row; do
  [[ -n "$row" ]] || continue
  old_id="$(printf '%s' "$row" | node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(r.id ?? ""));')"
  [[ -n "$old_id" ]] || continue

  if [[ "$old_id" =~ ^[a-z0-9-]+$ ]]; then
    continue
  fi

  new_id="$(sanitize_video_id "$old_id")"
  [[ "$new_id" == "$old_id" ]] && continue

  base_new_id="$new_id"
  suffix=0
  while :; do
    new_sql="$(sql_escape "$new_id")"
    old_sql="$(sql_escape "$old_id")"
    exists_count="$(run_scalar "SELECT COUNT(*) AS n FROM videos WHERE id = '${new_sql}' AND id <> '${old_sql}';")"
    mapped_count="$(run_scalar "SELECT COUNT(*) AS n FROM video_id_migration_map WHERE new_id = '${new_sql}' AND old_id <> '${old_sql}';")"
    if [[ "$exists_count" == "0" && "$mapped_count" == "0" ]]; then
      break
    fi
    suffix=$((suffix + 1))
    new_id="${base_new_id}-${suffix}"
  done

  VIDEO_ID_MAP["$old_id"]="$new_id"
done < <(run_rows "SELECT id FROM videos ORDER BY id;")

if [[ "${#VIDEO_ID_MAP[@]}" -eq 0 ]]; then
  if [[ -n "$MAP_FILE" ]]; then
    : > "$MAP_FILE"
    echo "[normalize-video-ids] Wrote empty mapping file: $MAP_FILE"
  fi
  echo "[normalize-video-ids] No video IDs required sanitization."
  exit 0
fi

echo "[normalize-video-ids] Planned rewrites: ${#VIDEO_ID_MAP[@]}"
for old_id in $(printf '%s\n' "${!VIDEO_ID_MAP[@]}" | LC_ALL=C sort); do
  new_id="${VIDEO_ID_MAP[$old_id]}"
  echo "  ${old_id} -> ${new_id}"
done

if [[ -n "$MAP_FILE" ]]; then
  : > "$MAP_FILE"
  for old_id in $(printf '%s\n' "${!VIDEO_ID_MAP[@]}" | LC_ALL=C sort); do
    new_id="${VIDEO_ID_MAP[$old_id]}"
    printf '%s\t%s\n' "$old_id" "$new_id" >> "$MAP_FILE"
  done
  echo "[normalize-video-ids] Wrote mapping file: $MAP_FILE"
fi

if [[ "$APPLY" != "1" ]]; then
  echo "[normalize-video-ids] Dry run only — no DB updates applied."
  echo "[normalize-video-ids] Re-run with APPLY=1 to execute."
  exit 0
fi

echo "[normalize-video-ids] Applying rewrites..."
for old_id in $(printf '%s\n' "${!VIDEO_ID_MAP[@]}" | LC_ALL=C sort); do
  new_id="${VIDEO_ID_MAP[$old_id]}"
  old_sql="$(sql_escape "$old_id")"
  new_sql="$(sql_escape "$new_id")"

  run_sql "PRAGMA foreign_keys = OFF;"
  run_sql "BEGIN TRANSACTION;"
  run_sql "UPDATE videos SET id = '${new_sql}' WHERE id = '${old_sql}';"
  run_sql "UPDATE video_category_assignments SET video_id = '${new_sql}' WHERE video_id = '${old_sql}';"
  run_sql "UPDATE video_segment_events SET video_id = '${new_sql}' WHERE video_id = '${old_sql}';"
  if table_exists "livestreams" && column_exists "livestreams" "video_id"; then
    run_sql "UPDATE livestreams SET video_id = '${new_sql}' WHERE video_id = '${old_sql}';"
  fi
  if table_exists "livestreams" && column_exists "livestreams" "recording_video_id"; then
    run_sql "UPDATE livestreams SET recording_video_id = '${new_sql}' WHERE recording_video_id = '${old_sql}';"
  fi
  if table_exists "admin_settings" && column_exists "admin_settings" "key" && column_exists "admin_settings" "value"; then
    run_sql "UPDATE admin_settings
             SET value = replace(value, '\"${old_sql}\"', '\"${new_sql}\"'),
                 updated_at = CURRENT_TIMESTAMP
             WHERE key = 'homepage'
               AND instr(value, '\"${old_sql}\"') > 0;"
  fi
  run_sql "INSERT INTO video_id_migration_map (old_id, new_id)
           VALUES ('${old_sql}', '${new_sql}')
           ON CONFLICT(old_id) DO UPDATE
             SET new_id = excluded.new_id, migrated_at = CURRENT_TIMESTAMP;"
  run_sql "COMMIT;"
  run_sql "PRAGMA foreign_keys = ON;"
done

echo "[normalize-video-ids] Done."
echo "[normalize-video-ids] NOTE: Move R2 prefixes from videos/<old_id>/ to videos/<new_id>/ to keep playback paths aligned."
