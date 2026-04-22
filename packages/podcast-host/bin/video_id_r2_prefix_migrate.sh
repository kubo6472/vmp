#!/bin/bash
set -euo pipefail

# Mirrors legacy videos/<old_id>/ prefixes to videos/<new_id>/ using mapping
# rows produced by packages/api/scripts/migration_normalize_video_ids.sh.
#
# Usage examples:
#   # Dry-run copy plan (default)
#   DB_NAME=video-subscription-db MODE_FLAG=--remote \
#   bash packages/podcast-host/bin/video_id_r2_prefix_migrate.sh
#
#   # Apply copy to R2
#   APPLY=1 DB_NAME=video-subscription-db MODE_FLAG=--remote \
#   bash packages/podcast-host/bin/video_id_r2_prefix_migrate.sh
#
#   # Optionally delete old prefixes after successful copy
#   APPLY=1 DELETE_OLD=1 DB_NAME=video-subscription-db MODE_FLAG=--remote \
#   bash packages/podcast-host/bin/video_id_r2_prefix_migrate.sh

DB_NAME="${DB_NAME:-video-subscription-db}"
MODE_FLAG="${MODE_FLAG:-}"
MAPPING_JSON_PATH="${MAPPING_JSON_PATH:-}"
if [[ "${1:-}" == "--remote" ]]; then
  MODE_FLAG="--remote"
fi

R2_BUCKET="${R2_BUCKET:-vmp-videos}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"
R2_BUCKET_NAME="${R2_BUCKET_NAME:-}"
APPLY="${APPLY:-0}"
DELETE_OLD="${DELETE_OLD:-0}"

if [[ "$APPLY" != "0" && "$APPLY" != "1" ]]; then
  echo "[r2-prefix-migrate] APPLY must be 0 or 1 (got '$APPLY')" >&2
  exit 1
fi

if [[ "$DELETE_OLD" != "0" && "$DELETE_OLD" != "1" ]]; then
  echo "[r2-prefix-migrate] DELETE_OLD must be 0 or 1 (got '$DELETE_OLD')" >&2
  exit 1
fi

run_rows() {
  local sql="$1"
  npx wrangler d1 execute "$DB_NAME" "$MODE_FLAG" --command "$sql" --json \
    | node -e '
      const fs = require("fs");
      const input = fs.readFileSync(0, "utf8").trim();
      const payload = JSON.parse(input);
      const rows = payload?.[0]?.results ?? [];
      for (const row of rows) process.stdout.write(JSON.stringify(row) + "\n");
    '
}

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

if [[ -n "$MAPPING_JSON_PATH" && -f "$MAPPING_JSON_PATH" ]]; then
  if [[ -z "$MODE_FLAG" ]]; then
    MODE_FLAG="--remote"
  elif [[ "$MODE_FLAG" != "--remote" ]]; then
    echo "[r2-prefix-migrate] MAPPING_JSON_PATH is set; MODE_FLAG must be --remote (or unset)." >&2
    exit 1
  fi
elif [[ -n "$MAPPING_JSON_PATH" ]]; then
  echo "[r2-prefix-migrate] MAPPING_JSON_PATH does not exist: $MAPPING_JSON_PATH" >&2
  exit 1
else
  # No mapping artifact provided; require explicit DB mode.
  if [[ -z "$MODE_FLAG" ]]; then
    echo "[r2-prefix-migrate] No MAPPING_JSON_PATH provided. Set MODE_FLAG explicitly to --local or --remote." >&2
    exit 1
  fi
fi

echo "[r2-prefix-migrate] DB=${DB_NAME} MODE=${MODE_FLAG:-n/a} APPLY=${APPLY} DELETE_OLD=${DELETE_OLD}"
echo "[r2-prefix-migrate] R2 root: $(r2_root)"

mapping_count=0
while IFS= read -r row; do
  [ -n "$row" ] || continue
  old_id="$(printf '%s' "$row" | node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(r.old_id ?? r.oldId ?? ""));')"
  new_id="$(printf '%s' "$row" | node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(r.new_id ?? r.newId ?? ""));')"
  [ -n "$old_id" ] || continue
  [ -n "$new_id" ] || continue
  [ "$old_id" != "$new_id" ] || continue
  mapping_count=$((mapping_count + 1))

  src_prefix="videos/${old_id}"
  dst_prefix="videos/${new_id}"
  src="$(r2_path "$src_prefix")"
  dst="$(r2_path "$dst_prefix")"

  echo "[r2-prefix-migrate] ${old_id} -> ${new_id}"

  if [ "$APPLY" != "1" ]; then
    echo "  dry-run: rclone copy \"$src\" \"$dst\" --create-empty-src-dirs --checkers 16 --transfers 8"
    if [ "$DELETE_OLD" = "1" ]; then
      echo "  dry-run: rclone delete \"$src\" --rmdirs"
    fi
    continue
  fi

  if rclone lsf "$src" --recursive >/dev/null 2>&1; then
    rclone copy "$src" "$dst" \
      --create-empty-src-dirs \
      --checkers 16 \
      --transfers 8
    if [ "$DELETE_OLD" = "1" ]; then
      if ! rclone check "$src" "$dst"; then
        echo "  ERROR: verification failed for $old_id -> $new_id; refusing to delete source." >&2
        exit 1
      fi
      rclone delete "$src" --rmdirs
    fi
  else
    echo "  skip: source prefix missing ($src_prefix)"
  fi
done < <(
  if [[ -n "$MAPPING_JSON_PATH" && -f "$MAPPING_JSON_PATH" ]]; then
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const payload = JSON.parse(fs.readFileSync(p, "utf8"));
      const rows = Array.isArray(payload?.mappings) ? payload.mappings : [];
      rows
        .filter((r) => r && typeof r.old_id === "string" && typeof r.new_id === "string")
        .sort((a, b) => a.old_id.localeCompare(b.old_id))
        .forEach((r) => process.stdout.write(JSON.stringify(r) + "\n"));
    ' "$MAPPING_JSON_PATH"
  else
    run_rows "SELECT old_id, new_id FROM video_id_migration_map ORDER BY old_id;"
  fi
)

if [ "$mapping_count" -eq 0 ]; then
  echo "[r2-prefix-migrate] No rows in video_id_migration_map. Run DB normalize script first."
else
  echo "[r2-prefix-migrate] Processed mappings: ${mapping_count}"
fi
