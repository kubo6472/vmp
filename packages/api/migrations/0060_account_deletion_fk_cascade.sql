-- Account deletion groundwork (step 10): let DELETE FROM users clean up device and
-- handoff rows instead of failing.
--
-- offline_devices (0037), offline_download_licenses (0037), and pwa_handoffs (0018)
-- each hold a `user_id` FK with no ON DELETE action, so a plain user delete aborts
-- with a constraint error. None of this data has a retention duty, so it should go
-- with the account. Switch these FKs to ON DELETE CASCADE. Also cascade the license
-- -> device FK so removing a device drops its licenses (and so the two cascades on a
-- user delete cannot collide). SQLite cannot ALTER a FOREIGN KEY, so recreate the
-- tables (see 0006, 0036).

PRAGMA foreign_keys = OFF;

-- Child first: licenses reference devices. Rebuilt while the old devices table still
-- exists, so the device_id FK stays valid across the swap.
CREATE TABLE offline_download_licenses__v2 (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  video_id          TEXT NOT NULL,
  device_id         TEXT NOT NULL,
  rendition         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  issued_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at        DATETIME NOT NULL,
  last_renewed_at   DATETIME,
  revoked_at        DATETIME,
  revoked_reason    TEXT,
  manifest_hash     TEXT NOT NULL,
  manifest_paths    TEXT NOT NULL,
  manifest_version  INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (video_id) REFERENCES videos(id),
  FOREIGN KEY (device_id) REFERENCES offline_devices(id) ON DELETE CASCADE,
  UNIQUE(user_id, video_id, rendition, device_id)
);

INSERT INTO offline_download_licenses__v2 (
  id, user_id, video_id, device_id, rendition, status, issued_at, expires_at,
  last_renewed_at, revoked_at, revoked_reason, manifest_hash, manifest_paths,
  manifest_version
)
SELECT
  id, user_id, video_id, device_id, rendition, status, issued_at, expires_at,
  last_renewed_at, revoked_at, revoked_reason, manifest_hash, manifest_paths,
  manifest_version
FROM offline_download_licenses;

DROP TABLE offline_download_licenses;
ALTER TABLE offline_download_licenses__v2 RENAME TO offline_download_licenses;

CREATE INDEX idx_odl_user ON offline_download_licenses(user_id);
CREATE INDEX idx_odl_device ON offline_download_licenses(device_id);
CREATE INDEX idx_odl_expires ON offline_download_licenses(expires_at);

CREATE TABLE offline_devices__v2 (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  device_name        TEXT NOT NULL,
  public_key         TEXT,
  device_token_hash  TEXT NOT NULL,
  registered_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at       DATETIME,
  revoked_at         DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO offline_devices__v2 (
  id, user_id, device_name, public_key, device_token_hash, registered_at,
  last_seen_at, revoked_at
)
SELECT
  id, user_id, device_name, public_key, device_token_hash, registered_at,
  last_seen_at, revoked_at
FROM offline_devices;

DROP TABLE offline_devices;
ALTER TABLE offline_devices__v2 RENAME TO offline_devices;

CREATE INDEX idx_offline_devices_user ON offline_devices(user_id);
CREATE UNIQUE INDEX idx_offline_devices_token_hash ON offline_devices(device_token_hash);

CREATE TABLE pwa_handoffs__v2 (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO pwa_handoffs__v2 (code, user_id, expires_at, used_at)
SELECT code, user_id, expires_at, used_at FROM pwa_handoffs;

DROP TABLE pwa_handoffs;
ALTER TABLE pwa_handoffs__v2 RENAME TO pwa_handoffs;

CREATE INDEX IF NOT EXISTS idx_pwa_handoffs_code ON pwa_handoffs(code);

PRAGMA foreign_keys = ON;
