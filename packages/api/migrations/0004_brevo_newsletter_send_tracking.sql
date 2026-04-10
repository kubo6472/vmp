-- Durable send tracking + claim time (PR5 hardening).
-- IF NOT EXISTS: brevo.js may have added columns at runtime on older local DBs.
ALTER TABLE brevo_newsletter_sends ADD COLUMN IF NOT EXISTS send_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE brevo_newsletter_sends ADD COLUMN IF NOT EXISTS claim_acquired_at TEXT;

-- Backfill: rows with a Brevo campaign but no sent_at should count as send-requested.
UPDATE brevo_newsletter_sends
SET send_requested = 1
WHERE campaign_id IS NOT NULL AND sent_at IS NULL AND (send_requested = 0 OR send_requested IS NULL);
