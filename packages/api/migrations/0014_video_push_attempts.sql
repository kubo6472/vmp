-- Persist push delivery attempts for admin diagnostics.
CREATE TABLE IF NOT EXISTS video_push_attempts (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  attempted_count INTEGER NOT NULL DEFAULT 0,
  succeeded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  stale_count INTEGER NOT NULL DEFAULT 0,
  attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_video_push_attempts_video_time
ON video_push_attempts(video_id, attempted_at DESC);
