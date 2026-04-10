-- Durable send tracking + claim time for stale recovery (newsletter hardening).
ALTER TABLE brevo_newsletter_sends ADD COLUMN send_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE brevo_newsletter_sends ADD COLUMN claim_acquired_at TEXT;

-- Rows that already have a Brevo campaign but no sent_at should count as send-requested for idempotency.
UPDATE brevo_newsletter_sends
SET send_requested = 1
WHERE campaign_id IS NOT NULL AND sent_at IS NULL AND send_requested = 0;
