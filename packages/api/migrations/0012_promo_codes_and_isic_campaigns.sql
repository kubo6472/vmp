CREATE TABLE IF NOT EXISTS promo_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  reward_type TEXT NOT NULL DEFAULT 'free_month',
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  allowed_plan_types TEXT NOT NULL DEFAULT 'monthly,yearly,club',
  stripe_coupon_id TEXT,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES promo_campaigns(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id TEXT PRIMARY KEY,
  promo_code_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  subscription_id TEXT,
  provider TEXT,
  plan_type TEXT,
  granted_until DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (promo_code_id) REFERENCES promo_codes(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_redemptions_code_user
  ON promo_redemptions(promo_code_id, user_id);

CREATE INDEX IF NOT EXISTS idx_promo_codes_campaign
  ON promo_codes(campaign_id, is_active);

CREATE TABLE IF NOT EXISTS isic_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  free_slots_limit INTEGER NOT NULL DEFAULT 0,
  discount_percent REAL NOT NULL DEFAULT 0,
  renewal_months INTEGER NOT NULL DEFAULT 12,
  popup_behavior TEXT NOT NULL DEFAULT 'default',
  country_scope TEXT NOT NULL DEFAULT 'CZ,SK',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add promo_code_id column to payment_checkout_sessions for GoCardless promo redemption tracking
ALTER TABLE payment_checkout_sessions ADD COLUMN promo_code_id TEXT;

CREATE INDEX IF NOT EXISTS idx_payment_checkout_sessions_promo_code
  ON payment_checkout_sessions(promo_code_id);

INSERT INTO admin_settings(key, value, updated_at)
VALUES
  ('isic_api_base_url', '', CURRENT_TIMESTAMP),
  ('isic_api_key', '', CURRENT_TIMESTAMP),
  ('isic_api_enabled', '0', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO NOTHING;