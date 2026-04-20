ALTER TABLE videos ADD COLUMN scheduled_publish_at DATETIME;
ALTER TABLE videos ADD COLUMN notified_at DATETIME;

ALTER TABLE pills ADD COLUMN image_url TEXT;

ALTER TABLE video_categories ADD COLUMN homepage_layout_variant TEXT NOT NULL DEFAULT 'three_by_one';

CREATE INDEX idx_videos_publish_schedule
  ON videos(publish_status, scheduled_publish_at, upload_date DESC);
