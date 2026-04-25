CREATE TABLE IF NOT EXISTS anonymous_rate_limits (
  ip TEXT NOT NULL,
  bucket_hour TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ip, bucket_hour)
);

CREATE INDEX IF NOT EXISTS idx_anonymous_rate_limits_expires_at
  ON anonymous_rate_limits(expires_at);
