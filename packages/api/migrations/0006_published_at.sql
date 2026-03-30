ALTER TABLE videos ADD COLUMN published_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_videos_visibility ON videos(visibility);
CREATE INDEX IF NOT EXISTS idx_videos_published_at ON videos(published_at);
