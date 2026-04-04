-- Migration 0015: Remove dead columns, drop push attempt tracking, clean up test seed data.
--
-- Dead columns (added in 0005_videos_r2_sync_state.sql, never read or written by API):
--   source_key      — R2 object key for the source upload (never populated)
--   managed_by_r2   — flag for R2-managed videos (never used)
--   processed_at    — timestamp for when FFmpeg processing finished (never set)
--
-- publish_status (added in 0007) supersedes visibility. The API already uses
-- publish_status as the sole editorial gate. The visibility column sync was removed
-- from the application code in the same deploy as this migration.
--
-- push_notified_at and video_push_attempts were premature delivery-tracking
-- instrumentation added before push notifications were proven stable across browsers.

ALTER TABLE videos DROP COLUMN visibility;
ALTER TABLE videos DROP COLUMN source_key;
ALTER TABLE videos DROP COLUMN managed_by_r2;
ALTER TABLE videos DROP COLUMN processed_at;
ALTER TABLE videos DROP COLUMN push_notified_at;

DROP TABLE IF EXISTS video_push_attempts;

-- Remove test seed data inserted by migration 0002_seed.sql.
-- These rows have well-known IDs from the seed script.
DELETE FROM subscriptions WHERE user_id IN ('user_free', 'user_premium', 'user_expired');
DELETE FROM users       WHERE id         IN ('user_free', 'user_premium', 'user_expired');
-- Seed videos used predictable IDs:
DELETE FROM videos WHERE id IN ('test1', 'tutorial_advanced', 'marketing_essentials', 'content_strategy');
