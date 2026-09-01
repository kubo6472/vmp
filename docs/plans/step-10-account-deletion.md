# Step 10 — Self-service account deletion

**Roadmap:** [ROADMAP.md](../../ROADMAP.md) → *Step 10*  
**Issue:** [#646](https://github.com/tojemoc/vmp/issues/646) (spec [#506](https://github.com/tojemoc/vmp/issues/506) closed)  
**Status:** Blocked — payment gateway adapter must support provider-agnostic immediate cancellation

### Groundwork landed (independent of the payment blocker)

- `requireAuth` now rejects a valid token whose user row is gone, so a deleted account loses access on every protected endpoint.
- `einvoices.user_id` is nullable with `ON DELETE SET NULL` (migration `0059`), so a user delete keeps the invoice for statutory retention instead of erasing it.
- `offline_devices`, `offline_download_licenses`, and `pwa_handoffs` FKs use `ON DELETE CASCADE` (migration `0060`), so `DELETE FROM users` cleans them up. The step-4 explicit deletes for these three tables are no longer needed. The deletion handler still owns invoice PII anonymization and R2 sanitization.

## Checklist (high level)

- [ ] `requireAuth` hardening (deleted / deletion-pending users)
- [ ] Deletion token table + request/confirm API
- [ ] Durable `account_deletion_jobs` + R2 object inventory
- [ ] `cancelSubscriptionImmediately` on payment adapter
- [ ] Invoice anonymization + FK fix (`einvoices`)
- [ ] Brevo contact deletion path
- [ ] Account deletion UI + legal copy
- [ ] Checkout consent persistence (`checkout_consents`)

---

**Blocked on**: payment gateway adapter completion (all Stripe-touching work is on hold until the adapter is provider-agnostic).

#### API (`@vmp/api`)

- `POST /api/account/delete-request` — `requireAuth`; sends a one-time verification email (via Brevo) with a signed HMAC token (short TTL ~15 min) bound to the authenticated user ID and purpose `account_deletion`.
- `POST /api/account/delete-confirm` — `requireAuth`; validates the signed token is bound to the authenticated JWT subject (`sub`) and purpose `account_deletion`; validates confirmation phrase; **before** committing the deletion job or setting `deletion_pending`, verify the user's active subscription provider supports immediate cancellation (see step 2). If unsupported, reject with a clear error **without** consuming the token or locking the account; alternatively persist a recoverable terminal `blocked` job state with an explicit retry path once the provider gains support. When supported, **atomically** in one `db.batch()`: consume the deletion token (`used_at` / single-use) **and** idempotently create or upsert the durable deletion job — a crash must not leave `used_at` set without a corresponding job row. Job state lives in `account_deletion_jobs` (or equivalent **not** cascaded by user deletion — do **not** store retry state on `magic_link_tokens`, which is deleted with the user). The deletion-token table’s `user_id` FK must be `ON DELETE CASCADE` or `ON DELETE SET NULL` (and if `SET NULL`, `user_id` **must be nullable** — SQLite/D1 will reject `SET NULL` on a `NOT NULL` column), or token rows must be deleted in the same cleanup transaction as the user (step 4); a default `NO ACTION` FK would make `DELETE FROM users` fail. Unused tokens expire at TTL and may be garbage-collected independently. Consumed tokens need no long-term retention: cascade/explicit delete with the user is enough; if kept for a short audit window, nullable `user_id` + `ON DELETE SET NULL` and purge after the job completes.
- On confirmation — **durable, retry-safe deletion job** (do **not** rely on a bare `DELETE FROM users` or a single fire-and-forget handler):
  1. Persist deletion state in `account_deletion_jobs` (FK to `users` with `ON DELETE SET NULL` or no FK — job must survive until explicitly completed): track per-step completion (`subscription_cancelled`, `einvoices_anonymized`, `r2_sanitized`, `db_cleaned`, `brevo_deleted`, `user_deleted`) so retries skip completed work and external effects are not duplicated. **Before** the step 3–4 cleanup batch (user deletion and `einvoices.user_id` SET NULL), persist every non-null `xml_payload_r2_key` and `pdf_payload_r2_key` for that user’s invoices into `account_deletion_r2_objects`. Rows must reference the deletion job via a durable `job_id` FK to `account_deletion_jobs` (not user or invoice ownership) so inventory survives cleanup. Unique constraint on `(job_id, object_key)` so retries cannot insert duplicate object records. Track **each object key independently** (`object_key`, `outcome`: `sanitized` | `retained_under_policy`): on retry, skip only objects with recorded outcomes and process unresolved ones; set aggregate `r2_sanitized` only after every inventoried object has a recorded outcome.
  2. **Subscription cancellation** — distinguish provider semantics:
     - `PaymentProvider.cancelSubscription` today sets `cancel_at_period_end: true` (Stripe provider in `packages/payments/src/providers/stripe/index.ts`) — access continues until period end.
     - Account deletion requires **immediate** access revocation. Extend the payment gateway adapter with an explicit immediate-cancellation capability (e.g. `cancelSubscriptionImmediately`) and call it here; UI copy should state that remaining prepaid access ends immediately (refund eligibility per applicable consumer law — see legal section). If immediate cancel is unavailable for a provider, block deletion with a clear error rather than leaving access active.
     - Make provider cancellation **idempotent** (safe to retry; persist `subscription_cancelled` before proceeding).
  3. **Anonymize retained billing records** (inside a D1 `db.batch()` transaction together with step 4): `einvoices` currently has `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE` (`0044_einvoicing.sql`). That cascade would delete invoice rows, which conflicts with CZ/SK accounting law (zákon č. 563/1991 Sb. and its Slovak equivalent — multi-year retention of financial records). Requires a new migration: change FK to `ON DELETE SET NULL`, make `user_id` nullable, and in the deletion handler clear/anonymize buyer PII columns (`buyer_name`, `buyer_email`, `buyer_address_json`, `buyer_vat_id`, `buyer_peppol_*`) while keeping invoice amounts, dates, and retention metadata. **R2 payloads** (`xml_payload_r2_key`, `pdf_payload_r2_key`): ISDOC/UBL XML embeds buyer name, email, address, and VAT ID (`eInvoicing.ts`). Either replace each object with a sanitized archival version stripping buyer PII, or document a lawful-retention policy with access controls on the original object. Preserve amounts, dates, and statutory retention either way. GDPR Art. 17(3)(b) permits this retention where required by law.
  4. **Explicit cleanup of non-CASCADE FK tables** (same `db.batch()` as step 3):
     - `DELETE FROM offline_download_licenses WHERE user_id = ?` (must precede devices — FK to `offline_devices`)
     - `DELETE FROM offline_devices WHERE user_id = ?` (`0037_offline_downloads.sql` — no CASCADE)
     - `DELETE FROM pwa_handoffs WHERE user_id = ?` (`0018_pwa_handoffs.sql` — no CASCADE)
     - Deletion-token rows: omit if the table uses `ON DELETE CASCADE`; otherwise `DELETE FROM <deletion_tokens> WHERE user_id = ?` in this same batch (required unless `user_id` is nullable with `ON DELETE SET NULL` plus post-job purge)
     - `DELETE FROM users WHERE id = ?` — remaining `ON DELETE CASCADE` / `ON DELETE SET NULL` FKs handle the rest (`playback_positions`, `refresh_tokens`, `magic_link_tokens`, `push_subscriptions`, `subscriptions`, `native_push_tokens`, `device_pairing_sessions`, `admin_audit_logs` actor/target, etc.).
  5. On batch failure, retain job state so the handler can resume from the last incomplete step without repeating completed external calls.
  6. **Brevo contact deletion** (mandatory when `BREVO_API_KEY` is configured): capture the contact identifier (email) **before** any local cleanup batch runs and **persist it on `account_deletion_jobs`** (e.g. `brevo_contact_identifier` column) when the job is created or confirmed. The deletion worker must reuse that stored identifier on retries — do not re-read from `users` after step 3–4 cleanup. Call `DELETE /contacts/{identifier}` via a dedicated deletion worker/adapter (not `removeSubscriberFromNewsletter`, which only removes list membership). Treat **2xx and 404** as successful completion and persist `brevo_deleted`; retry only transient failures (5xx, timeouts). Permanent client/auth errors (e.g. 400, 401, 403) must not retry forever: persist a durable terminal job state (`brevo_failed` or `blocked`) with response details and expose an operator retry/remediation path. Stale-contact sync is a backstop only, never the primary deletion path.
  7. Revoke all sessions: refresh tokens deleted by cascade; `requireAuth` must reject access tokens for deleted or deletion-pending users (see below).
- **Deletion-pending gate** (set atomically when `delete-confirm` creates the job): mark the account `deletion_pending` (column on `users` or job status). Reject deletion-pending accounts in `requireAuth`, `handleRefreshToken`, and magic-link redemption **before** issuing or rotating sessions. Preserve existing behavior for accounts not pending. Add tests covering all three auth paths.
- **`requireAuth` hardening** (prerequisite): today `requireAuth` only verifies the JWT signature (`auth.ts`); it does not check whether the user row still exists, is deletion-pending, or whether a server-side revocation/version stamp is valid. Extend it to reject tokens for deleted or deletion-pending users (and optionally a `users.token_version` bump on deletion) consistently across all protected endpoints; add tests for deleted users and revoked/outdated tokens.
- New migration(s): `account_deletion_jobs` + `account_deletion_r2_objects` (`job_id` FK to the job, unique `(job_id, object_key)`) + deletion token table (separate from `magic_link_tokens`; `user_id` `ON DELETE CASCADE`, or nullable `user_id` with `ON DELETE SET NULL`) **and** `einvoices` FK/retention fix described above.

#### Web (`@vmp/web`)

- Account page section: "Delete my account" with warning copy (include that anonymized invoice records are retained for the statutory accounting period).
- Confirmation flow: email sent → user must be **signed in** (or complete a secure handoff authenticated and bound to the same JWT `sub` as `delete-confirm`'s `requireAuth`) → type confirmation phrase → done. An email link alone must not submit the phrase without an authenticated session matching the deletion token subject.
- Redirect to homepage post-deletion.

#### Legal / regulatory (CZ + SK)

- **Czech law**: Consumer Protection Act (zákon č. 634/1992 Sb.), Civil Code (zákon č. 89/2012 Sb.) — digital content contracts; EU Consumer Rights Directive implemented via § 1820+ of the Civil Code. For digital content/services delivered immediately (streaming access), the 14-day withdrawal right can be waived with prior express consent.
- **Slovak law**: zákon č. 108/2024 Z. z. (Consumer Protection Act, effective 1 July 2024; replaces zákon č. 102/2014 Z.z.) — same EU directive transposition, same waiver mechanism for immediate digital content delivery.
- **Key wording**: pre-purchase consent checkbox or acknowledgment covering applicable statutory conditions only — e.g. (a) access begins immediately upon payment, (b) the consumer waives the 14-day withdrawal right **where the law permits** for immediately delivered digital content. Do **not** use blanket "all sales are final" or "no refund for remaining subscription period" language that overrides mandatory remedies for ongoing streaming services, partial performance, or non-conforming delivery. Deletion/cancellation copy should reference forfeiture of remaining prepaid access only where legally defensible, not as a universal waiver.
- **GDPR Art. 17 (right to erasure)**: the self-service flow satisfies this for personal/account data. **Exception — financial records**: invoice rows in `einvoices` must be retained (anonymized, not deleted) for the statutory accounting period under CZ/SK law; disclose this in the deletion UI copy.

#### Checkout integration

Require **affirmative terms acceptance in every checkout flow**. Persist consent at checkout time, not at deletion.

- **Stripe Checkout** (when used): set `consent_collection.terms_of_service` to `required` with a valid terms URL for supported embedded/hosted UI modes.
- **Other providers / UI modes**: gate payment confirmation behind a first-party checkbox acknowledging the same terms.
- Extend the provider-agnostic checkout and webhook normalization to persist immutable metadata:
  - Accepted wording or version ID
  - Timestamp
  - User ID
  - Checkout session ID
  - Provider session ID
  - Subscription ID (when available)

Store in a dedicated table (e.g. `checkout_consents`) via the payment gateway adapter and webhook handling. Limit stored consent text to applicable statutory withdrawal conditions — do not record blanket no-refund waivers beyond what the law allows.
