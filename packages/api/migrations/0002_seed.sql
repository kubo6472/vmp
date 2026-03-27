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

-- Test videos with descriptions and thumbnails
INSERT INTO videos (id, title, description, thumbnail_url, full_duration, preview_duration, upload_date) VALUES 
  (
    'demo_video',
    'Introduction to Video Monetization',
    'Learn the fundamentals of building a sustainable video monetization platform. This comprehensive guide covers subscription models, content protection, and best practices for engaging your audience.',
    'https://placehold.co/1280x720',
    1800,
    300,
    '2026-03-20 10:00:00'
  ),
  (
    'tutorial_advanced',
    'Advanced Streaming Techniques',
    'Master advanced HLS streaming optimization, adaptive bitrate switching, and delivering flawless video experiences across all devices and network conditions.',
    'https://placehold.co/1280x720',
    2400,
    180,
    '2026-03-22 14:30:00'
  ),
  (
    'marketing_essentials',
    'Marketing Your Video Platform',
    'Discover proven strategies for growing your subscriber base, retention tactics, and conversion optimization techniques that actually work in today''s competitive landscape.',
    'https://placehold.co/1280x720',
    2100,
    240,
    '2026-03-25 09:15:00'
  ),
  (
    'content_strategy',
    'Content Strategy Masterclass',
    'Build a content calendar that keeps subscribers engaged month after month. Learn from successful creators who''ve built thriving communities around their video content.',
    'https://placehold.co/1280x720',
    1950,
    210,
    '2026-03-26 16:45:00'
  );