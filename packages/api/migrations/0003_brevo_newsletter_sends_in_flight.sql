-- Serialize concurrent newsletter sends for the same dedupe_key (PR5 hardening).
-- Plain ADD COLUMN matches runtime ensureBrevoNewsletterSendsTable() in brevo.js (try/catch).
ALTER TABLE brevo_newsletter_sends ADD COLUMN in_flight INTEGER NOT NULL DEFAULT 0;
