#!/usr/bin/env bash
set -euo pipefail

DB_NAME="${DB_NAME:-video-subscription-db}"
MODE_FLAG="${MODE_FLAG:---local}"
DRY_RUN="${DRY_RUN:-1}"
APPLY="${APPLY:-0}"
MAPPING_JSON_PATH="${MAPPING_JSON_PATH:-/tmp/video-id-map.json}"

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
    printf '%s' "$input" | sha256sum | awk '{print substr($1,1,16)}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$input" | shasum -a 256 | awk '{print substr($1,1,16)}'
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

json_quote() {
  printf '%s' "$1" | node -e 'const fs=require("fs");const s=fs.readFileSync(0,"utf8");process.stdout.write(JSON.stringify(s));'
}

json_escape_for_json_string() {
  printf '%s' "$1" | node -e 'const fs=require("fs");const s=fs.readFileSync(0,"utf8");process.stdout.write(JSON.stringify(s).slice(1,-1));'
}

write_mapping_json() {
  local output_path="$1"
  local output_dir
  output_dir="$(dirname "$output_path")"
  mkdir -p "$output_dir"

  local tmp_path="${output_path}.tmp.$$"
  {
    printf '{\n'
    printf '  "generated_at": %s,\n' "$(json_quote "$(date -u +%FT%TZ)")"
    printf '  "mappings": [\n'
    local index=0
    local total="${#SORTED_KEYS[@]}"
    while [ "$index" -lt "$total" ]; do
      local old_id="${SORTED_KEYS[$index]}"
      local new_id="${VIDEO_ID_MAP[$old_id]}"
      local comma=","
      if [ "$index" -eq $((total - 1)) ]; then
        comma=""
      fi
      printf '    { "old_id": %s, "new_id": %s }%s\n' "$(json_quote "$old_id")" "$(json_quote "$new_id")" "$comma"
      index=$((index + 1))
    done
    printf '  ]\n'
    printf '}\n'
  } > "$tmp_path"

  mv "$tmp_path" "$output_path"
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

has_video_id_migration_map=0
if table_exists "video_id_migration_map"; then
  has_video_id_migration_map=1
elif [[ "$APPLY" == "1" ]]; then
  run_sql "CREATE TABLE video_id_migration_map (
    old_id TEXT PRIMARY KEY,
    new_id TEXT NOT NULL UNIQUE,
    migrated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );"
  has_video_id_migration_map=1
fi

declare -A VIDEO_ID_MAP
declare -A RESERVED_NEW_IDS
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
    mapped_count=0
    if [[ "$has_video_id_migration_map" == "1" ]]; then
      mapped_count="$(run_scalar "SELECT COUNT(*) AS n FROM video_id_migration_map WHERE new_id = '${new_sql}' AND old_id <> '${old_sql}';")"
    fi
    reserved_in_map=0
    if [[ -n "${RESERVED_NEW_IDS[$new_id]:-}" ]]; then
      reserved_in_map=1
    fi
    if [[ "$exists_count" == "0" && "$mapped_count" == "0" && "$reserved_in_map" == "0" ]]; then
      break
    fi
    suffix=$((suffix + 1))
    new_id="${base_new_id}-${suffix}"
  done

  VIDEO_ID_MAP["$old_id"]="$new_id"
  RESERVED_NEW_IDS["$new_id"]="1"
done < <(run_rows "SELECT id FROM videos ORDER BY id;")

if [[ "${#VIDEO_ID_MAP[@]}" -eq 0 ]]; then
  SORTED_KEYS=()
  write_mapping_json "$MAPPING_JSON_PATH"
  echo "[normalize-video-ids] Wrote empty mapping JSON: $MAPPING_JSON_PATH"
  echo "[normalize-video-ids] No video IDs required sanitization."
  exit 0
fi

echo "[normalize-video-ids] Planned rewrites: ${#VIDEO_ID_MAP[@]}"
mapfile -t SORTED_KEYS < <(printf '%s\n' "${!VIDEO_ID_MAP[@]}" | LC_ALL=C sort)
for old_id in "${SORTED_KEYS[@]}"; do
  new_id="${VIDEO_ID_MAP[$old_id]}"
  echo "  ${old_id} -> ${new_id}"
done

write_mapping_json "$MAPPING_JSON_PATH"
echo "[normalize-video-ids] Wrote mapping JSON: $MAPPING_JSON_PATH"

if [[ "$APPLY" != "1" ]]; then
  echo "[normalize-video-ids] Dry run only — no DB updates applied."
  echo "[normalize-video-ids] Re-run with APPLY=1 to execute."
  exit 0
fi

echo "[normalize-video-ids] Applying rewrites..."
has_livestream_video_id=0
if table_exists "livestreams" && column_exists "livestreams" "video_id"; then
  has_livestream_video_id=1
fi

has_livestream_recording_video_id=0
if table_exists "livestreams" && column_exists "livestreams" "recording_video_id"; then
  has_livestream_recording_video_id=1
fi

has_homepage_json=0
if table_exists "admin_settings" && column_exists "admin_settings" "key" && column_exists "admin_settings" "value"; then
  has_homepage_json=1
fi

for old_id in "${SORTED_KEYS[@]}"; do
  new_id="${VIDEO_ID_MAP[$old_id]}"
  old_sql="$(sql_escape "$old_id")"
  new_sql="$(sql_escape "$new_id")"
  escaped_old_json="$(json_escape_for_json_string "$old_id")"
  escaped_new_json="$(json_escape_for_json_string "$new_id")"
  escaped_old_sql="$(sql_escape "$escaped_old_json")"
  escaped_new_sql="$(sql_escape "$escaped_new_json")"

  sql_batch="PRAGMA defer_foreign_keys = ON;
UPDATE videos SET id = '${new_sql}' WHERE id = '${old_sql}';
UPDATE video_category_assignments SET video_id = '${new_sql}' WHERE video_id = '${old_sql}';
UPDATE video_segment_events SET video_id = '${new_sql}' WHERE video_id = '${old_sql}';
"
  if [[ "$has_livestream_video_id" == "1" ]]; then
    sql_batch+="UPDATE livestreams SET video_id = '${new_sql}' WHERE video_id = '${old_sql}';
"
  fi
  if [[ "$has_livestream_recording_video_id" == "1" ]]; then
    sql_batch+="UPDATE livestreams SET recording_video_id = '${new_sql}' WHERE recording_video_id = '${old_sql}';
"
  fi
  if [[ "$has_homepage_json" == "1" ]]; then
    sql_batch+="UPDATE admin_settings
SET value = replace(value, '\"${escaped_old_sql}\"', '\"${escaped_new_sql}\"'),
    updated_at = CURRENT_TIMESTAMP
WHERE key = 'homepage'
  AND instr(value, '\"${escaped_old_sql}\"') > 0;
"
  fi
  sql_batch+="INSERT INTO video_id_migration_map (old_id, new_id)
VALUES ('${old_sql}', '${new_sql}')
ON CONFLICT(old_id) DO UPDATE
  SET new_id = excluded.new_id, migrated_at = CURRENT_TIMESTAMP;
PRAGMA foreign_keys = ON;"

  run_sql "$sql_batch"
done

echo "[normalize-video-ids] Done."
echo "[normalize-video-ids] NOTE: Move R2 prefixes from videos/<old_id>/ to videos/<new_id>/ to keep playback paths aligned."