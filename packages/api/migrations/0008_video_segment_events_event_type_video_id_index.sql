CREATE INDEX IF NOT EXISTS idx_video_segment_events_event_type_video_id
  ON video_segment_events(event_type, video_id);
