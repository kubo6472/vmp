PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS video_segment_events;
DROP TABLE IF EXISTS rss_feed_polls;
DROP TABLE IF EXISTS pills_updates_audit;
DROP TABLE IF EXISTS pills;
DROP TABLE IF EXISTS newsletter_templates;
DROP TABLE IF EXISTS brevo_newsletter_sends;
DROP TABLE IF EXISTS push_subscriptions;
DROP TABLE IF EXISTS admin_settings;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS video_category_assignments;
DROP TABLE IF EXISTS video_categories;
DROP TABLE IF EXISTS videos;
DROP TABLE IF EXISTS totp_challenges;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS magic_link_tokens;
DROP TABLE IF EXISTS users;

PRAGMA foreign_keys = ON;
