-- Brevo newsletter: list ID and campaign sender (filled in via admin API).
INSERT OR IGNORE INTO admin_settings (key, value, updated_at) VALUES
  ('brevo_subscriber_list_id', '', CURRENT_TIMESTAMP),
  ('brevo_campaign_sender_email', '', CURRENT_TIMESTAMP),
  ('brevo_campaign_sender_name', '', CURRENT_TIMESTAMP);
