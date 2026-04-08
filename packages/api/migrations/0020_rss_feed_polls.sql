-- Step 9: RSS feed poll counters (basic analytics foundation)
--
-- Counts how often RSS endpoints are fetched.
-- Personal feed entries are keyed by user_id; public feed uses user_id='public'.

CREATE TABLE IF NOT EXISTS rss_feed_polls (
  endpoint       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  poll_count     INTEGER NOT NULL DEFAULT 0,
  last_polled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (endpoint, user_id)
);

