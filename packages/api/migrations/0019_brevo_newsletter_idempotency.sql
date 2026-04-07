-- Idempotent newsletter sends: one row per client dedupe key; campaign_id set after Brevo create; sent_at after sendNow.
CREATE TABLE IF NOT EXISTS brevo_newsletter_sends (
  dedupe_key   TEXT PRIMARY KEY,
  campaign_id  INTEGER,
  sent_at      TEXT,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
