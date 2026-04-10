-- Serialize concurrent newsletter sends for the same dedupe_key (PR5 hardening).
ALTER TABLE brevo_newsletter_sends ADD COLUMN IF NOT EXISTS in_flight INTEGER NOT NULL DEFAULT 0;
