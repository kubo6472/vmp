ALTER TABLE video_segment_events ADD COLUMN segment_index INTEGER;
ALTER TABLE video_segment_events ADD COLUMN segment_duration_seconds REAL;
ALTER TABLE video_segment_events ADD COLUMN playback_position_seconds REAL;
ALTER TABLE video_segment_events ADD COLUMN session_key TEXT;
ALTER TABLE video_segment_events ADD COLUMN source_category TEXT;
ALTER TABLE video_segment_events ADD COLUMN source_detail TEXT;
ALTER TABLE video_segment_events ADD COLUMN campaign_source TEXT;
ALTER TABLE video_segment_events ADD COLUMN campaign_medium TEXT;

CREATE INDEX IF NOT EXISTS idx_video_segment_events_session_created
  ON video_segment_events(session_key, created_at);
CREATE INDEX IF NOT EXISTS idx_video_segment_events_source_category_created
  ON video_segment_events(source_category, created_at);
CREATE INDEX IF NOT EXISTS idx_video_segment_events_video_session
  ON video_segment_events(video_id, session_key);
