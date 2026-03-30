ALTER TABLE videos ADD COLUMN source_key TEXT;
ALTER TABLE videos ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public'));
ALTER TABLE videos ADD COLUMN status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'processed'));
ALTER TABLE videos ADD COLUMN updated_at DATETIME;
ALTER TABLE videos ADD COLUMN processed_at DATETIME;
ALTER TABLE videos ADD COLUMN managed_by_r2 INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_videos_managed_by_r2 ON videos(managed_by_r2);
CREATE INDEX IF NOT EXISTS idx_videos_updated_at ON videos(updated_at);
