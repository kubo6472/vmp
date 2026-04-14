PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS livestreams (
  video_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'realtimekit',
  stream_id TEXT,
  stream_key TEXT,
  ingest_url TEXT,
  playback_url TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  recording_video_id TEXT,
  started_at DATETIME,
  ended_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (recording_video_id) REFERENCES videos(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_livestreams_status ON livestreams(status);
CREATE INDEX IF NOT EXISTS idx_livestreams_recording_video_id ON livestreams(recording_video_id);
