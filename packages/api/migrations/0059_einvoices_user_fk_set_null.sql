-- Account deletion groundwork (step 10): einvoices must survive user deletion.
--
-- 0044 created einvoices with `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE
-- CASCADE`. Deleting a user would erase their invoice rows, which CZ/SK accounting
-- law (zákon č. 563/1991 Sb. and its Slovak equivalent) requires the business to
-- retain for years. GDPR Art. 17(3)(b) allows keeping these records where the law
-- demands it. Change the FK to ON DELETE SET NULL and make user_id nullable so the
-- deletion handler can detach the invoice from the person while keeping the record.
-- SQLite cannot ALTER a FOREIGN KEY, so recreate the table (see 0006, 0036).

PRAGMA foreign_keys = OFF;

CREATE TABLE einvoices__v2 (
  id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  user_id TEXT,
  stripe_invoice_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  stripe_subscription_id TEXT,
  plan_type TEXT,
  issue_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  net_amount_cents INTEGER NOT NULL,
  tax_amount_cents INTEGER NOT NULL DEFAULT 0,
  gross_amount_cents INTEGER NOT NULL,
  vat_rate_percent REAL,
  buyer_country TEXT,
  buyer_vat_id TEXT,
  buyer_name TEXT,
  buyer_email TEXT,
  buyer_address_json TEXT,
  buyer_peppol_endpoint_id TEXT,
  buyer_peppol_scheme_id TEXT,
  seller_jurisdiction TEXT NOT NULL,
  format TEXT NOT NULL,
  routing TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  mandate_applies INTEGER NOT NULL DEFAULT 0,
  xml_payload_r2_key TEXT,
  pdf_payload_r2_key TEXT,
  peppol_message_id TEXT,
  peppol_transmission_id TEXT,
  error_message TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO einvoices__v2 (
  id, invoice_number, user_id, stripe_invoice_id, stripe_payment_intent_id,
  stripe_subscription_id, plan_type, issue_date, currency, net_amount_cents,
  tax_amount_cents, gross_amount_cents, vat_rate_percent, buyer_country, buyer_vat_id,
  buyer_name, buyer_email, buyer_address_json, buyer_peppol_endpoint_id,
  buyer_peppol_scheme_id, seller_jurisdiction, format, routing, status, mandate_applies,
  xml_payload_r2_key, pdf_payload_r2_key, peppol_message_id, peppol_transmission_id,
  error_message, idempotency_key, created_at, updated_at
)
SELECT
  id, invoice_number, user_id, stripe_invoice_id, stripe_payment_intent_id,
  stripe_subscription_id, plan_type, issue_date, currency, net_amount_cents,
  tax_amount_cents, gross_amount_cents, vat_rate_percent, buyer_country, buyer_vat_id,
  buyer_name, buyer_email, buyer_address_json, buyer_peppol_endpoint_id,
  buyer_peppol_scheme_id, seller_jurisdiction, format, routing, status, mandate_applies,
  xml_payload_r2_key, pdf_payload_r2_key, peppol_message_id, peppol_transmission_id,
  error_message, idempotency_key, created_at, updated_at
FROM einvoices;

DROP TABLE einvoices;
ALTER TABLE einvoices__v2 RENAME TO einvoices;

CREATE INDEX IF NOT EXISTS idx_einvoices_user_created ON einvoices(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_einvoices_status ON einvoices(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_einvoices_stripe_invoice ON einvoices(stripe_invoice_id);
CREATE INDEX IF NOT EXISTS idx_einvoices_issue_date ON einvoices(issue_date DESC);

PRAGMA foreign_keys = ON;
