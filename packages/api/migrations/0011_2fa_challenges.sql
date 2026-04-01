-- Step 5 (follow-up): stateful pending-2FA challenges for brute-force protection.
-- Each row tracks one pending TOTP verification attempt issued after a magic-link
-- login.  The jti column matches the JWT claim in the pending token.

CREATE TABLE IF NOT EXISTS totp_challenges (
  jti              TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  expires_at       DATETIME NOT NULL,
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  used_at          DATETIME,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_totp_challenges_user ON totp_challenges(user_id);
