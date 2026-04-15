#!/usr/bin/env bash
set -euo pipefail

DB_NAME="${DB_NAME:-video-subscription-db}"
MODE_FLAG="${MODE_FLAG:---local}"

if [[ "${1:-}" == "--remote" ]]; then
  MODE_FLAG="--remote"
fi

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

print_check() {
  local label="$1"
  local value="$2"
  echo "[verify] ${label}: ${value}"
}

echo "[verify] Running integrity verification on ${DB_NAME} (${MODE_FLAG})"

schema_failures=0

if table_exists "subscriptions"; then
  subscriptions_count="$(run_scalar "SELECT COUNT(*) AS n FROM subscriptions;")"
else
  echo "[verify] schema_missing.table.subscriptions"
  subscriptions_count=0
  schema_failures=$((schema_failures + 1))
fi

if table_exists "brevo_newsletter_sends"; then
  newsletter_sends_count="$(run_scalar "SELECT COUNT(*) AS n FROM brevo_newsletter_sends;")"
else
  echo "[verify] schema_missing.table.brevo_newsletter_sends"
  newsletter_sends_count=0
  schema_failures=$((schema_failures + 1))
fi

if table_exists "video_segment_events"; then
  segment_events_count="$(run_scalar "SELECT COUNT(*) AS n FROM video_segment_events;")"
else
  echo "[verify] schema_missing.table.video_segment_events"
  segment_events_count=0
  schema_failures=$((schema_failures + 1))
fi

if table_exists "livestreams"; then
  livestreams_count="$(run_scalar "SELECT COUNT(*) AS n FROM livestreams;")"
else
  echo "[verify] schema_missing.table.livestreams"
  livestreams_count=0
  schema_failures=$((schema_failures + 1))
fi

if table_exists "payment_checkout_sessions"; then
  checkout_sessions_count="$(run_scalar "SELECT COUNT(*) AS n FROM payment_checkout_sessions;")"
else
  echo "[verify] schema_missing.table.payment_checkout_sessions"
  checkout_sessions_count=0
  schema_failures=$((schema_failures + 1))
fi

print_check "row_count.subscriptions" "$subscriptions_count"
print_check "row_count.brevo_newsletter_sends" "$newsletter_sends_count"
print_check "row_count.video_segment_events" "$segment_events_count"
print_check "row_count.livestreams" "$livestreams_count"
print_check "row_count.payment_checkout_sessions" "$checkout_sessions_count"

bad_provider=0
bad_provider_mapping=0
bad_brevo_missing_campaign=0
bad_brevo_inflight_sent=0
bad_segment_session_key=0
bad_segment_source_category=0
bad_livestream_status=0
orphan_subscription_users=0
orphan_category_assignments_video=0
orphan_category_assignments_category=0
orphan_livestream_video=0
orphan_checkout_users=0

if table_exists "subscriptions" && column_exists "subscriptions" "provider"; then
  bad_provider="$(run_scalar "SELECT COUNT(*) AS n FROM subscriptions WHERE provider IS NULL OR trim(provider) = '';")"
else
  echo "[verify] schema_missing.subscriptions.provider"
  schema_failures=$((schema_failures + 1))
fi

if table_exists "subscriptions" \
  && column_exists "subscriptions" "provider" \
  && column_exists "subscriptions" "provider_subscription_id" \
  && column_exists "subscriptions" "stripe_subscription_id"; then
  bad_provider_mapping="$(run_scalar "SELECT COUNT(*) AS n
    FROM subscriptions
    WHERE provider = 'stripe'
      AND stripe_subscription_id IS NOT NULL
      AND trim(stripe_subscription_id) <> ''
      AND (provider_subscription_id IS NULL OR trim(provider_subscription_id) = '');")"
else
  echo "[verify] schema_missing.subscriptions.provider_mapping_columns"
  schema_failures=$((schema_failures + 1))
fi

if table_exists "brevo_newsletter_sends" \
  && column_exists "brevo_newsletter_sends" "sent_at" \
  && column_exists "brevo_newsletter_sends" "campaign_id"; then
  bad_brevo_missing_campaign="$(run_scalar "SELECT COUNT(*) AS n FROM brevo_newsletter_sends WHERE sent_at IS NOT NULL AND campaign_id IS NULL;")"
else
  echo "[verify] schema_missing.brevo_newsletter_sends.campaign_id_or_sent_at"
  schema_failures=$((schema_failures + 1))
fi

if table_exists "brevo_newsletter_sends" \
  && column_exists "brevo_newsletter_sends" "sent_at" \
  && column_exists "brevo_newsletter_sends" "in_flight"; then
  bad_brevo_inflight_sent="$(run_scalar "SELECT COUNT(*) AS n FROM brevo_newsletter_sends WHERE sent_at IS NOT NULL AND COALESCE(in_flight, 0) <> 0;")"
else
  echo "[verify] schema_missing.brevo_newsletter_sends.in_flight"
  schema_failures=$((schema_failures + 1))
fi

if table_exists "video_segment_events" && column_exists "video_segment_events" "session_key"; then
  bad_segment_session_key="$(run_scalar "SELECT COUNT(*) AS n FROM video_segment_events WHERE session_key IS NULL OR trim(session_key) = '';")"
else
  echo "[verify] schema_missing.video_segment_events.session_key"
  schema_failures=$((schema_failures + 1))
fi

if table_exists "video_segment_events" && column_exists "video_segment_events" "source_category"; then
  bad_segment_source_category="$(run_scalar "SELECT COUNT(*) AS n FROM video_segment_events WHERE source_category IS NULL OR trim(source_category) = '';")"
else
  echo "[verify] schema_missing.video_segment_events.source_category"
  schema_failures=$((schema_failures + 1))
fi

if table_exists "livestreams" && column_exists "livestreams" "status"; then
  bad_livestream_status="$(run_scalar "SELECT COUNT(*) AS n
    FROM livestreams
    WHERE lower(trim(COALESCE(status, ''))) NOT IN ('scheduled', 'live', 'ended', 'vod_attached', 'replaced_with_vod');")"
else
  echo "[verify] schema_missing.livestreams.status"
  schema_failures=$((schema_failures + 1))
fi

if table_exists "subscriptions" && table_exists "users" \
  && column_exists "subscriptions" "user_id" && column_exists "users" "id"; then
  orphan_subscription_users="$(run_scalar "SELECT COUNT(*) AS n FROM subscriptions s LEFT JOIN users u ON u.id = s.user_id WHERE u.id IS NULL;")"
else
  echo "[verify] schema_missing.subscriptions_or_users_column"
  schema_failures=$((schema_failures + 1))
fi

if table_exists "video_category_assignments" && table_exists "videos" \
  && column_exists "video_category_assignments" "video_id" && column_exists "videos" "id"; then
  orphan_category_assignments_video="$(run_scalar "SELECT COUNT(*) AS n
    FROM video_category_assignments vca
    LEFT JOIN videos v ON v.id = vca.video_id
    WHERE v.id IS NULL;")"
else
  echo "[verify] schema_missing.video_category_assignments_or_videos_column"
  schema_failures=$((schema_failures + 1))
fi

if table_exists "video_category_assignments" && table_exists "video_categories" \
  && column_exists "video_category_assignments" "category_id" && column_exists "video_categories" "id"; then
  orphan_category_assignments_category="$(run_scalar "SELECT COUNT(*) AS n
    FROM video_category_assignments vca
    LEFT JOIN video_categories vc ON vc.id = vca.category_id
    WHERE vc.id IS NULL;")"
else
  echo "[verify] schema_missing.video_category_assignments_or_video_categories_column"
  schema_failures=$((schema_failures + 1))
fi

if table_exists "livestreams" && table_exists "videos" \
  && column_exists "livestreams" "video_id" && column_exists "videos" "id"; then
  orphan_livestream_video="$(run_scalar "SELECT COUNT(*) AS n FROM livestreams l LEFT JOIN videos v ON v.id = l.video_id WHERE v.id IS NULL;")"
else
  echo "[verify] schema_missing.livestreams_or_videos_column"
  schema_failures=$((schema_failures + 1))
fi

if table_exists "payment_checkout_sessions" && table_exists "users" \
  && column_exists "payment_checkout_sessions" "user_id" && column_exists "users" "id"; then
  orphan_checkout_users="$(run_scalar "SELECT COUNT(*) AS n
    FROM payment_checkout_sessions pcs
    LEFT JOIN users u ON u.id = pcs.user_id
    WHERE u.id IS NULL;")"
else
  echo "[verify] schema_missing.payment_checkout_sessions_or_users_column"
  schema_failures=$((schema_failures + 1))
fi

print_check "check.bad_provider" "$bad_provider"
print_check "check.bad_provider_mapping" "$bad_provider_mapping"
print_check "check.bad_brevo_missing_campaign" "$bad_brevo_missing_campaign"
print_check "check.bad_brevo_inflight_sent" "$bad_brevo_inflight_sent"
print_check "check.bad_segment_session_key" "$bad_segment_session_key"
print_check "check.bad_segment_source_category" "$bad_segment_source_category"
print_check "check.bad_livestream_status" "$bad_livestream_status"
print_check "check.orphan_subscription_users" "$orphan_subscription_users"
print_check "check.orphan_category_assignments_video" "$orphan_category_assignments_video"
print_check "check.orphan_category_assignments_category" "$orphan_category_assignments_category"
print_check "check.orphan_livestream_video" "$orphan_livestream_video"
print_check "check.orphan_checkout_users" "$orphan_checkout_users"

failures=0
for value in \
  "$bad_provider" \
  "$bad_provider_mapping" \
  "$bad_brevo_missing_campaign" \
  "$bad_brevo_inflight_sent" \
  "$bad_segment_session_key" \
  "$bad_segment_source_category" \
  "$bad_livestream_status" \
  "$orphan_subscription_users" \
  "$orphan_category_assignments_video" \
  "$orphan_category_assignments_category" \
  "$orphan_livestream_video" \
  "$orphan_checkout_users"; do
  if [[ "$value" != "0" ]]; then
    failures=$((failures + 1))
  fi
done

if [[ "$schema_failures" -gt 0 ]]; then
  echo "[verify] FAIL: ${schema_failures} required schema check(s) missing."
  exit 1
fi

if [[ "$failures" -gt 0 ]]; then
  echo "[verify] FAIL: ${failures} integrity check(s) are non-zero."
  exit 1
fi

echo "[verify] PASS: all integrity checks are zero."