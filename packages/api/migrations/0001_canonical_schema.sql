PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE magic_link_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE totp_challenges (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  thumbnail_url TEXT,
  full_duration INTEGER NOT NULL DEFAULT 0,
  preview_duration INTEGER NOT NULL DEFAULT 0,
  upload_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'processed',
  publish_status TEXT NOT NULL DEFAULT 'draft',
  published_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  slug TEXT UNIQUE
);

CREATE TABLE video_categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  direction TEXT NOT NULL DEFAULT 'desc'
);

CREATE TABLE video_category_assignments (
  video_id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES video_categories(id) ON DELETE CASCADE
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_type TEXT NOT NULL,
  status TEXT NOT NULL,
  stripe_subscription_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  current_period_end DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE admin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE brevo_newsletter_sends (
  dedupe_key TEXT PRIMARY KEY,
  campaign_id INTEGER,
  sent_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE newsletter_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE pills (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#2563eb',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE pills_updates_audit (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE rss_feed_polls (
  endpoint TEXT NOT NULL,
  user_id TEXT NOT NULL,
  poll_count INTEGER NOT NULL DEFAULT 0,
  last_polled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (endpoint, user_id)
);

CREATE TABLE video_segment_events (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  user_id TEXT,
  request_path TEXT NOT NULL,
  event_type TEXT NOT NULL,
  position_seconds REAL,
  referer TEXT,
  source_host TEXT,
  ip_hash TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_magic_link_hash ON magic_link_tokens(token_hash);
CREATE INDEX idx_refresh_token_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_totp_challenges_user_id ON totp_challenges(user_id);
CREATE INDEX idx_videos_publish_status_date ON videos(publish_status, upload_date DESC);
CREATE INDEX idx_videos_slug ON videos(slug);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_status_period ON subscriptions(status, current_period_end);
CREATE INDEX idx_subscriptions_stripe ON subscriptions(stripe_subscription_id);
CREATE INDEX idx_push_subscriptions_user_id ON push_subscriptions(user_id);
CREATE INDEX idx_pills_sort_order ON pills(sort_order);
CREATE INDEX idx_video_segment_events_video_created ON video_segment_events(video_id, created_at);
CREATE INDEX idx_video_segment_events_created ON video_segment_events(created_at);
