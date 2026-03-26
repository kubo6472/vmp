-- Test users
INSERT INTO users (id, email) VALUES 
  ('user_free', 'free@example.com'),
  ('user_premium', 'premium@example.com'),
  ('user_expired', 'expired@example.com');

-- Test subscriptions
INSERT INTO subscriptions (user_id, plan_type, status, expires_at) VALUES 
  ('user_free', 'free', 'active', NULL),
  ('user_premium', 'premium', 'active', '2026-12-31 23:59:59'),
  ('user_expired', 'premium', 'expired', '2024-01-01 00:00:00');

-- Test videos
INSERT INTO videos (id, title, full_duration, preview_duration) VALUES 
  ('demo_video', 'Demo Course Video', 1800, 300),
  ('tutorial_advanced', 'Advanced Tutorial', 2400, 180);