INSERT OR IGNORE INTO admin_settings (key, value, updated_at) VALUES
  ('monthly_price_eur', '6.90', CURRENT_TIMESTAMP),
  ('yearly_price_eur', '74.90', CURRENT_TIMESTAMP),
  ('club_price_eur', '109.00', CURRENT_TIMESTAMP),
  ('rate_limit_anon', '5', CURRENT_TIMESTAMP),
  ('brevo_subscriber_list_id', '', CURRENT_TIMESTAMP),
  ('brevo_campaign_sender_email', '', CURRENT_TIMESTAMP),
  ('brevo_campaign_sender_name', '', CURRENT_TIMESTAMP),
  ('homepage', '{"featuredVideoIds":[],"layoutBlocks":[{"id":"hero","type":"hero","title":"Discover Premium Video Content","body":"Watch free previews or unlock full access with a premium subscription"}],"featuredMode":"latest","featuredVideoId":null}', CURRENT_TIMESTAMP),
  ('homepage_hero_title', 'Discover Premium Video Content', CURRENT_TIMESTAMP),
  ('homepage_hero_subtitle', 'Watch free previews or unlock full access with a premium subscription', CURRENT_TIMESTAMP),
  ('pills_api_key', '', CURRENT_TIMESTAMP),
  ('pills_enabled', '1', CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO newsletter_templates (id, name, subject, html_body) VALUES
  (
    'default-template',
    'Default newsletter',
    'Latest updates from VMP',
    '<h1>Latest updates</h1><p>Thanks for being with us.</p>'
  );
