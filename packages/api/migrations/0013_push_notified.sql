-- Track when a push notification was last sent for a published video.
-- NULL = no notification has been sent yet.
ALTER TABLE videos ADD COLUMN push_notified_at DATETIME;
