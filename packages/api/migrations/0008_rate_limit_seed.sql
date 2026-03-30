-- Seed the rate_limit_anon setting into admin_settings.
-- Default: 5 video previews per hour for unauthenticated users.
-- Adjustable via the admin console without redeploying the Worker.
INSERT OR IGNORE INTO admin_settings (key, value, updated_at)
VALUES ('rate_limit_anon', '5', CURRENT_TIMESTAMP);
