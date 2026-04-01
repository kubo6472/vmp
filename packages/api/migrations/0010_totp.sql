-- Step 5: Add TOTP 2FA columns to users table.
-- editor / admin / super_admin roles require TOTP on login once enabled.

ALTER TABLE users ADD COLUMN totp_secret TEXT;                          -- NULL = not set up; encrypted AES-GCM when set
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;   -- 0 = disabled, 1 = enabled
