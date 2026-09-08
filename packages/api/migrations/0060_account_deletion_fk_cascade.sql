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
--
-- offline_download_licenses.device_id references offline_devices, so recreating
-- offline_devices needs that child FK out of the way first. D1 always enforces FKs
-- (PRAGMA foreign_keys = OFF is a no-op there); use PRAGMA defer_foreign_keys so the
-- parent DROP/rename can finish before the child table is rebuilt. Postgres (api-node)
-- drops the child constraint via the -- POSTGRES: hint below, then gets it back when
-- the licenses table is rebuilt.
--
-- api-node rewrites CREATE TABLE → CREATE TABLE IF NOT EXISTS for idempotent boots,
-- so DROP leftover __v2 tables first or a stale shadow table becomes a silent no-op.
-- Some Postgres backups are also missing offline_download_licenses.manifest_paths
-- (0037 used IF NOT EXISTS against an older thinner table); add it before the copy.
--
-- INSERTs only copy rows whose FK targets still exist so deferred checks at commit
-- do not fail on orphaned device/license/handoff rows left from earlier cleanup.
-- SELECT lists use a source alias so Postgres cannot resolve column names against
-- the INSERT target (__v2) when the source is missing a column.

PRAGMA defer_foreign_keys = ON;

-- POSTGRES: ALTER TABLE offline_download_licenses DROP CONSTRAINT IF EXISTS offline_download_licenses_device_id_fkey;

-- Parent first: rebuild offline_devices with ON DELETE CASCADE on user_id.
DROP TABLE IF EXISTS offline_devices__v2;
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
  src.id, src.user_id, src.device_name, src.public_key, src.device_token_hash,
  src.registered_at, src.last_seen_at, src.revoked_at
FROM offline_devices AS src
WHERE src.user_id IN (SELECT id FROM users);

DROP TABLE offline_devices;
ALTER TABLE offline_devices__v2 RENAME TO offline_devices;

CREATE INDEX idx_offline_devices_user ON offline_devices(user_id);
CREATE UNIQUE INDEX idx_offline_devices_token_hash ON offline_devices(device_token_hash);

-- Ensure license copy columns exist on Postgres before the rebuild INSERT.
-- POSTGRES: ALTER TABLE offline_download_licenses ADD COLUMN IF NOT EXISTS manifest_paths TEXT NOT NULL DEFAULT '[]';

-- Child: rebuild offline_download_licenses with ON DELETE CASCADE on user_id and
-- device_id. On Postgres this recreates the device_id FK dropped above.
DROP TABLE IF EXISTS offline_download_licenses__v2;
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
  src.id, src.user_id, src.video_id, src.device_id, src.rendition, src.status,
  src.issued_at, src.expires_at, src.last_renewed_at, src.revoked_at,
  src.revoked_reason, src.manifest_hash, src.manifest_paths, src.manifest_version
FROM offline_download_licenses AS src
WHERE src.user_id IN (SELECT id FROM users)
  AND src.video_id IN (SELECT id FROM videos)
  AND src.device_id IN (SELECT id FROM offline_devices);

DROP TABLE offline_download_licenses;
ALTER TABLE offline_download_licenses__v2 RENAME TO offline_download_licenses;

CREATE INDEX idx_odl_user ON offline_download_licenses(user_id);
CREATE INDEX idx_odl_device ON offline_download_licenses(device_id);
CREATE INDEX idx_odl_expires ON offline_download_licenses(expires_at);

-- pwa_handoffs has no child tables; a plain rebuild with the new FK is enough.
DROP TABLE IF EXISTS pwa_handoffs__v2;
CREATE TABLE pwa_handoffs__v2 (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO pwa_handoffs__v2 (code, user_id, expires_at, used_at)
SELECT src.code, src.user_id, src.expires_at, src.used_at
FROM pwa_handoffs AS src
WHERE src.user_id IN (SELECT id FROM users);

DROP TABLE pwa_handoffs;
ALTER TABLE pwa_handoffs__v2 RENAME TO pwa_handoffs;

CREATE INDEX IF NOT EXISTS idx_pwa_handoffs_code ON pwa_handoffs(code);

PRAGMA defer_foreign_keys = OFF;
