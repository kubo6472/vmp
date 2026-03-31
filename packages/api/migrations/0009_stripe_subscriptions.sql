-- Migration 0009: Rebuild subscriptions table for Stripe integration
--
-- The original subscriptions table (0001_initial.sql) used an INTEGER PK and
-- had plan_type/status values incompatible with Stripe ('free'/'premium',
-- 'active'/'cancelled'/'expired'). We recreate it with TEXT PK, Stripe ID
-- columns, and current_period_end instead of expires_at.
-- SQLite cannot ALTER TABLE to change a CHECK constraint, so we rename → recreate → drop.

ALTER TABLE subscriptions RENAME TO subscriptions_v1;

CREATE TABLE subscriptions (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL,
  plan_type              TEXT NOT NULL,           -- 'monthly' | 'yearly' | 'club'
  status                 TEXT NOT NULL,           -- 'active' | 'cancelled' | 'past_due' | 'trialing'
  stripe_subscription_id TEXT UNIQUE,
  stripe_customer_id     TEXT,
  current_period_end     DATETIME,
  created_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user   ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe ON subscriptions(stripe_subscription_id);

-- Migrate any real subscription rows before dropping the old table.
-- Maps legacy plan_type ('premium' → 'monthly') and status ('expired' → 'cancelled').
-- Free-tier rows (plan_type = 'free') have no entitlements and are skipped.
-- Integer PKs are cast to TEXT. Stripe columns default to NULL.
INSERT OR IGNORE INTO subscriptions (id, user_id, plan_type, status, created_at, updated_at)
SELECT
  CAST(id AS TEXT),
  user_id,
  CASE plan_type WHEN 'premium' THEN 'monthly' ELSE plan_type END,
  CASE status    WHEN 'expired' THEN 'cancelled' ELSE status END,
  created_at,
  updated_at
FROM subscriptions_v1
WHERE plan_type != 'free';

DROP TABLE subscriptions_v1;

-- Ensure admin_settings table exists (created in 0003, but guard for safety).
CREATE TABLE IF NOT EXISTS admin_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed display prices (EUR). These drive the PremiumOverlay UI.
INSERT OR IGNORE INTO admin_settings (key, value) VALUES
  ('monthly_price_eur', '6.90'),
  ('yearly_price_eur',  '74.90'),
  ('club_price_eur',    '109.00'),
  ('rate_limit_anon',   '5');

-- Stripe Price IDs are set separately after creating products in the Stripe dashboard:
--   wrangler d1 execute video-subscription-db --command="
--     INSERT OR REPLACE INTO admin_settings (key, value) VALUES
--       ('stripe_price_monthly', 'price_xxx'),
--       ('stripe_price_yearly',  'price_yyy'),
--       ('stripe_price_club',    'price_zzz')
--   "
