#!/usr/bin/env bash
set -euo pipefail

DB_NAME="${DB_NAME:-video-subscription-db}"
MODE_FLAG="${MODE_FLAG:---local}"

if [[ "${1:-}" == "--remote" ]]; then
  MODE_FLAG="--remote"
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

echo "[backfill] Starting migration backfill + mapping on ${DB_NAME} (${MODE_FLAG})"

# Payments provider mapping (Task 10 follow-up): canonicalize provider fields.
if table_exists "subscriptions" \
  && column_exists "subscriptions" "provider" \
  && column_exists "subscriptions" "provider_subscription_id" \
  && column_exists "subscriptions" "provider_customer_id" \
  && column_exists "subscriptions" "stripe_subscription_id" \
  && column_exists "subscriptions" "stripe_customer_id"; then
  run_sql "UPDATE subscriptions SET provider = 'stripe' WHERE lower(trim(provider)) = '' OR provider IS NULL;"
  run_sql "UPDATE subscriptions
           SET provider_subscription_id = stripe_subscription_id
           WHERE lower(trim(provider)) = 'stripe'
             AND (provider_subscription_id IS NULL OR trim(provider_subscription_id) = '')
             AND stripe_subscription_id IS NOT NULL
             AND trim(stripe_subscription_id) <> '';"
  run_sql "UPDATE subscriptions
           SET provider_customer_id = stripe_customer_id
           WHERE lower(trim(provider)) = 'stripe'
             AND (provider_customer_id IS NULL OR trim(provider_customer_id) = '')
             AND stripe_customer_id IS NOT NULL
             AND trim(stripe_customer_id) <> '';"
else
  echo "[backfill] Skipped subscriptions provider mapping (required columns missing)."
fi

# Newsletter send state recovery (Task 4 hardening): normalize dedupe rows.
if table_exists "brevo_newsletter_sends" \
  && column_exists "brevo_newsletter_sends" "campaign_id" \
  && column_exists "brevo_newsletter_sends" "sent_at" \
  && column_exists "brevo_newsletter_sends" "send_requested" \
  && column_exists "brevo_newsletter_sends" "in_flight" \
  && column_exists "brevo_newsletter_sends" "claim_acquired_at"; then
  run_sql "UPDATE brevo_newsletter_sends
           SET send_requested = 1
           WHERE campaign_id IS NOT NULL
             AND sent_at IS NULL
             AND COALESCE(send_requested, 0) = 0;"
  run_sql "UPDATE brevo_newsletter_sends
           SET in_flight = 0,
               claim_acquired_at = NULL
           WHERE sent_at IS NOT NULL
             AND (COALESCE(in_flight, 0) <> 0 OR claim_acquired_at IS NOT NULL);"
else
  echo "[backfill] Skipped brevo send-state backfill (required columns missing)."
fi

# Segment analytics quality backfill (Task 7): repair nullable enrichment columns.
if table_exists "video_segment_events" \
  && column_exists "video_segment_events" "session_key" \
  && column_exists "video_segment_events" "source_category" \
  && column_exists "video_segment_events" "source_detail" \
  && column_exists "video_segment_events" "video_id" \
  && column_exists "video_segment_events" "user_id" \
  && column_exists "video_segment_events" "ip_hash" \
  && column_exists "video_segment_events" "source_host" \
  && column_exists "video_segment_events" "created_at"; then
  run_sql "UPDATE video_segment_events
           SET session_key = COALESCE(video_id, 'unknown') || ':' ||
             CASE
               WHEN user_id IS NOT NULL AND trim(user_id) <> '' THEN 'u:' || user_id
               WHEN ip_hash IS NOT NULL AND trim(ip_hash) <> '' THEN 'i:' || ip_hash
               ELSE 'anon'
             END || ':' ||
             CAST(strftime('%s', COALESCE(created_at, CURRENT_TIMESTAMP)) / 1800 AS INTEGER)
           WHERE session_key IS NULL OR trim(session_key) = '';"
  run_sql "UPDATE video_segment_events
           SET source_category = 'direct'
           WHERE source_category IS NULL OR trim(source_category) = '';"
  run_sql "UPDATE video_segment_events
           SET source_detail = COALESCE(NULLIF(trim(source_host), ''), 'direct')
           WHERE source_detail IS NULL OR trim(source_detail) = '';"
else
  echo "[backfill] Skipped segment analytics backfill (required columns missing)."
fi

# Livestream status normalization (Task 9): ensure enum-compatible values.
if table_exists "livestreams" && column_exists "livestreams" "status"; then
  run_sql "UPDATE livestreams
           SET status = CASE
             WHEN lower(trim(status)) IN ('scheduled', 'live', 'ended', 'vod_attached', 'replaced_with_vod')
               THEN lower(trim(status))
             ELSE 'scheduled'
           END
           WHERE status IS NULL
              OR status <> CASE
                WHEN lower(trim(status)) IN ('scheduled', 'live', 'ended', 'vod_attached', 'replaced_with_vod')
                  THEN lower(trim(status))
                ELSE 'scheduled'
              END;"
else
  echo "[backfill] Skipped livestream normalization (required columns missing)."
fi

echo "[backfill] Completed successfully."
echo "[backfill] Safe to re-run: updates are conditional and idempotent."