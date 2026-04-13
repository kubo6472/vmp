/**
 * packages/api/src/brevo.js
 *
 * Brevo Marketing: sync paying subscribers to a contact list; optional newsletter sends.
 *
 * Requires env.BREVO_API_KEY. List ID and campaign sender are stored in admin_settings:
 *   brevo_subscriber_list_id, brevo_campaign_sender_email, brevo_campaign_sender_name
 */

import { requireRole } from './auth.js'

const BREVO_BASE = 'https://api.brevo.com/v3'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Default 10 minutes; min 1 minute; max 24h (admin_settings: brevo_newsletter_poll_interval_ms) */
export const DEFAULT_NEWSLETTER_POLL_INTERVAL_MS = 600_000

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function clampNewsletterPollIntervalMs(raw: any) {
  const s = raw != null && String(raw).trim() !== '' ? String(raw).trim() : ''
  if (!/^\d+$/.test(s)) return DEFAULT_NEWSLETTER_POLL_INTERVAL_MS
  const n = Number.parseInt(s, 10)
  if (!Number.isFinite(n) || n < 60_000 || n > 86_400_000) return DEFAULT_NEWSLETTER_POLL_INTERVAL_MS
  return n
}

/**
 * @param {{ sent_at?: string | null, campaign_id?: number | null } | null | undefined} row
 */
export function isNewsletterSendFinished(row: any) {
  return !!(row?.sent_at && row.campaign_id != null)
}

/** Brevo classic campaign statuses that mean delivery has been triggered. */
const BREVO_CAMPAIGN_SENT_STATUSES = new Set(['sent', 'completed'])

function correlationFromRequest(request: any) {
  const clientCid = request.headers?.get?.('x-correlation-id')?.trim()
  if (clientCid) return clientCid
  const cf = request.headers?.get?.('CF-Ray')
  const trace = request.headers?.get?.('X-Amzn-Trace-Id')
  const rid = request.headers?.get?.('X-Request-Id')
  return cf || trace || rid || null
}

function newsletterLog(event: any, fields = {}) {
  console.log(JSON.stringify({ source: 'brevo_newsletter', event, ...fields }))
}

/** One-way id for logs (Workers: Web Crypto; no raw user ids). */
async function hashUserId(userId: any) {
  const enc = new TextEncoder()
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(`user:${String(userId)}`))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function getDb(env: any) {
  const db = env.DB || env.video_subscription_db
  if (!db) throw new Error('D1 binding not found')
  return db
}

async function getAdminSetting(db: any, key: any) {
  const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ?').bind(key).first()
  return row?.value ?? null
}

async function setAdminSetting(db: any, key: any, value: any) {
  await db.prepare(`
    INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).bind(key, value).run()
}

function brevoTimeoutMs(env: any) {
  const raw = env.BREVO_FETCH_TIMEOUT_MS
  const n = raw != null && String(raw).trim() !== '' ? Number.parseInt(String(raw).trim(), 10) : 5000
  return Number.isFinite(n) && n > 0 ? Math.min(n, 120_000) : 5000
}

/**
 * Fetch against Brevo with a hard timeout; merges AbortSignal with optional caller signal.
 * On timeout or abort, returns a 504 Response (does not throw).
 */
async function brevoFetch(path: any, options = {}, env: any) {
  const key = env.BREVO_API_KEY
  if (!key) {
    return new Response(JSON.stringify({ message: 'BREVO_API_KEY not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const controller = new AbortController()
  const ms = brevoTimeoutMs(env)
  const tid = setTimeout(() => controller.abort(), ms)

  // @ts-expect-error TS(2339): Property 'signal' does not exist on type '{}'.
  const userSignal = options.signal
  if (userSignal) {
    if (userSignal.aborted) controller.abort()
    else userSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  // @ts-expect-error TS(2339): Property 'signal' does not exist on type '{}'.
  const { signal: _omit, ...rest } = options

  try {
    const res = await fetch(`${BREVO_BASE}${path}`, {
      ...rest,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'api-key': key,
        // @ts-expect-error TS(2339): Property 'headers' does not exist on type '{}'.
        ...rest.headers,
      },
    })
    return res
  } catch (err) {
    const name = err && typeof err === 'object' && 'name' in err ? err.name : ''
    if (name === 'AbortError') {
      return new Response(
        JSON.stringify({ message: 'Brevo request timed out', code: 'brevo_timeout' }),
        { status: 504, headers: { 'Content-Type': 'application/json' } },
      )
    }
    throw err
  } finally {
    clearTimeout(tid)
  }
}

/**
 * Sync newsletter membership from a Stripe subscription status.
 */
export async function syncNewsletterForStripeSubscription(db: any, userId: any, stripeStatus: any, env: any) {
  const paying = ['active', 'trialing'].includes(stripeStatus)
  if (paying) {
    await syncPayingSubscriberToNewsletter(db, userId, env)
  } else {
    await removeSubscriberFromNewsletter(db, userId, env)
  }
}

/**
 * Add or update a user in the Brevo subscriber list (paying subscribers).
 * Returns true if the remote API call succeeded, false otherwise.
 */
export async function syncPayingSubscriberToNewsletter(db: any, userId: any, env: any): Promise<boolean> {
  if (!env.BREVO_API_KEY) return false

  const listIdRaw = await getAdminSetting(db, 'brevo_subscriber_list_id')
  const listId = listIdRaw != null && String(listIdRaw).trim() !== '' ? Number.parseInt(String(listIdRaw).trim(), 10) : NaN
  if (!Number.isFinite(listId) || listId <= 0) return false

  const row = await db.prepare('SELECT email FROM users WHERE id = ? LIMIT 1').bind(userId).first()
  const email = row?.email ? String(row.email).trim().toLowerCase() : ''
  if (!email || !EMAIL_RE.test(email)) return false

  const body = {
    email,
    updateEnabled: true,
    listIds: [listId],
  }

  const res = await brevoFetch('/contacts', { method: 'POST', body: JSON.stringify(body) }, env)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const userIdHash = await hashUserId(userId)
    newsletterLog('sync_contact_failed', { userIdHash, status: res.status, code: err?.code })
    return false
  }
  return true
}

async function syncAllEligibleSubscribers(db: any, env: any) {
  if (!env.BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY is not configured')
  }

  const listIdRaw = await getAdminSetting(db, 'brevo_subscriber_list_id')
  const listId = listIdRaw != null && String(listIdRaw).trim() !== '' ? Number.parseInt(String(listIdRaw).trim(), 10) : NaN
  if (!Number.isFinite(listId) || listId <= 0) {
    throw new Error('Brevo subscriber list ID is not configured or invalid')
  }

  const payingSubscriberRows = await db.prepare(`
    SELECT DISTINCT s.user_id AS id
    FROM subscriptions s
    WHERE s.status IN ('active', 'trialing')
      AND (s.current_period_end IS NULL OR datetime(s.current_period_end) > CURRENT_TIMESTAMP)
  `).all()

  const payingSubscriberIds = (payingSubscriberRows?.results ?? []).map((r: any) => r.id).filter(Boolean)
  let synced = 0
  for (const userId of payingSubscriberIds) {
    const success = await syncPayingSubscriberToNewsletter(db, userId, env)
    if (success) synced += 1
  }

  const eligibleEmails = new Set<string>()
  if (payingSubscriberIds.length) {
    const BATCH_SIZE = 500
    for (let i = 0; i < payingSubscriberIds.length; i += BATCH_SIZE) {
      const chunk = payingSubscriberIds.slice(i, i + BATCH_SIZE)
      const placeholders = chunk.map(() => '?').join(',')
      const eligibleRows = await db.prepare(
        `SELECT email FROM users WHERE id IN (${placeholders})`,
      ).bind(...chunk).all()
      for (const row of eligibleRows?.results ?? []) {
        const email = typeof row?.email === 'string' ? row.email.trim().toLowerCase() : ''
        if (email) eligibleEmails.add(email)
      }
    }
  }

  const remoteEmails = new Set<string>()
  let offset = 0
  const pageLimit = 500
  while (true) {
    const pageRes = await brevoFetch(`/contacts/lists/${listId}/contacts?limit=${pageLimit}&offset=${offset}`, { method: 'GET' }, env)
    if (!pageRes.ok) break
    const page = await pageRes.json().catch(() => ({}))
    const contacts = Array.isArray(page?.contacts) ? page.contacts : []
    for (const contact of contacts) {
      const email = typeof contact?.email === 'string' ? contact.email.trim().toLowerCase() : ''
      if (email) remoteEmails.add(email)
    }
    if (contacts.length < pageLimit) break
    offset += contacts.length
  }

  const staleEmails = []
  for (const email of remoteEmails) {
    if (eligibleEmails.has(email)) continue
    const row = await db.prepare('SELECT id FROM users WHERE lower(email) = ? LIMIT 1').bind(email).first()
    if (row?.id) {
      await removeSubscriberFromNewsletter(db, row.id, env)
      continue
    }
    staleEmails.push(email)
  }

  const BREVO_BATCH_SIZE = 100
  for (let i = 0; i < staleEmails.length; i += BREVO_BATCH_SIZE) {
    const chunk = staleEmails.slice(i, i + BREVO_BATCH_SIZE)
    const res = await brevoFetch(
      `/contacts/lists/${listId}/contacts/remove`,
      { method: 'POST', body: JSON.stringify({ emails: chunk }) },
      env,
    )
    if (!res.ok && res.status !== 404) {
      const err = await res.json().catch(() => ({}))
      newsletterLog('remove_stale_email_failed', { status: res.status, code: err?.code })
    }
  }

  return synced
}

/**
 * Remove a user's email from the subscriber list (e.g. subscription ended).
 */
export async function removeSubscriberFromNewsletter(db: any, userId: any, env: any) {
  if (!env.BREVO_API_KEY) return

  const listIdRaw = await getAdminSetting(db, 'brevo_subscriber_list_id')
  const listId = listIdRaw != null && String(listIdRaw).trim() !== '' ? Number.parseInt(String(listIdRaw).trim(), 10) : NaN
  if (!Number.isFinite(listId) || listId <= 0) return

  const row = await db.prepare('SELECT email FROM users WHERE id = ? LIMIT 1').bind(userId).first()
  const email = row?.email ? String(row.email).trim().toLowerCase() : ''
  if (!email) return

  const res = await brevoFetch(
    `/contacts/lists/${listId}/contacts/remove`,
    { method: 'POST', body: JSON.stringify({ emails: [email] }) },
    env,
  )
  if (!res.ok && res.status !== 404) {
    const err = await res.json().catch(() => ({}))
    const userIdHash = await hashUserId(userId)
    newsletterLog('remove_from_list_failed', { userIdHash, status: res.status, code: err?.code })
  }
}

const STALE_CLAIM_MINUTES = 2

async function brevoNewsletterSendsHasColumn(db: any, columnName: any) {
  const res = await db.prepare('PRAGMA table_info(brevo_newsletter_sends)').all()
  const rows = res?.results ?? []
  return rows.some((r: any) => r.name === columnName);
}

async function ensureBrevoNewsletterSendsTable(db: any) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS brevo_newsletter_sends (
      dedupe_key   TEXT PRIMARY KEY,
      campaign_id  INTEGER,
      sent_at      TEXT,
      created_at   TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run()
  if (!(await brevoNewsletterSendsHasColumn(db, 'in_flight'))) {
    await db.prepare('ALTER TABLE brevo_newsletter_sends ADD COLUMN in_flight INTEGER NOT NULL DEFAULT 0').run()
  }
  if (!(await brevoNewsletterSendsHasColumn(db, 'send_requested'))) {
    await db.prepare('ALTER TABLE brevo_newsletter_sends ADD COLUMN send_requested INTEGER NOT NULL DEFAULT 0').run()
  }
  if (!(await brevoNewsletterSendsHasColumn(db, 'claim_acquired_at'))) {
    await db.prepare('ALTER TABLE brevo_newsletter_sends ADD COLUMN claim_acquired_at TEXT').run()
  }
}

/**
 * Try to acquire exclusive send lock for dedupe_key. Returns false if another request holds it or row is done.
 */
async function tryAcquireNewsletterSendClaim(db: any, dedupeKey: any) {
  const upd = await db.prepare(`
    UPDATE brevo_newsletter_sends
    SET in_flight = 1, claim_acquired_at = CURRENT_TIMESTAMP
    WHERE dedupe_key = ?
      AND sent_at IS NULL
      AND in_flight = 0
  `).bind(dedupeKey).run()
  const n = upd.meta?.changes ?? upd.changes ?? 0
  return n > 0
}

/**
 * Recover abandoned locks using claim_acquired_at (not created_at, which does not move on reclaim).
 * Clears partial state so a new attempt can run send_requested → create → sendNow.
 */
async function releaseStaleNewsletterSendClaim(db: any, dedupeKey: any) {
  const mod = `+${STALE_CLAIM_MINUTES} minutes`
  await db.prepare(`
    UPDATE brevo_newsletter_sends
    SET in_flight = 0,
        claim_acquired_at = NULL,
        send_requested = 0,
        campaign_id = NULL
    WHERE dedupe_key = ?
      AND sent_at IS NULL
      AND in_flight = 1
      AND claim_acquired_at IS NOT NULL
      AND datetime('now') > datetime(claim_acquired_at, ?)
  `).bind(dedupeKey, mod).run()
  await db.prepare(`
    UPDATE brevo_newsletter_sends
    SET in_flight = 0,
        claim_acquired_at = NULL,
        send_requested = 0,
        campaign_id = NULL
    WHERE dedupe_key = ?
      AND sent_at IS NULL
      AND in_flight = 1
      AND (claim_acquired_at IS NULL OR claim_acquired_at = '')
      AND datetime('now') > datetime(created_at, ?)
      AND (
        campaign_id IS NULL
        OR (campaign_id IS NOT NULL AND (claim_acquired_at IS NULL OR claim_acquired_at = ''))
      )
  `).bind(dedupeKey, mod).run()
}

async function releaseNewsletterSendClaimFullAbort(db: any, dedupeKey: any) {
  await db.prepare(`
    UPDATE brevo_newsletter_sends
    SET in_flight = 0,
        claim_acquired_at = NULL,
        send_requested = 0,
        campaign_id = NULL
    WHERE dedupe_key = ? AND sent_at IS NULL
  `).bind(dedupeKey).run()
}

async function releaseNewsletterSendClaimAfterSendNowFailure(db: any, dedupeKey: any) {
  await db.prepare(`
    UPDATE brevo_newsletter_sends
    SET in_flight = 0, claim_acquired_at = NULL
    WHERE dedupe_key = ? AND sent_at IS NULL
  `).bind(dedupeKey).run()
}

/**
 * Persist Brevo campaign id before any claim release. Retries on transient races; keeps claim if persist fails.
 * @returns {{ ok: true } | { ok: false, correlationId: string }}
 */
async function persistCampaignIdForDedupeKey(db: any, dedupeKey: any, newId: any, correlationId: any) {
  const id = Number(newId)
  if (!Number.isFinite(id) || id <= 0) return { ok: false, correlationId }
  const maxAttempts = 4
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 40 * attempt))
    const upd = await db.prepare(`
      UPDATE brevo_newsletter_sends SET campaign_id = ? WHERE dedupe_key = ? AND campaign_id IS NULL
    `).bind(id, dedupeKey).run()
    const changed = upd.meta?.changes ?? upd.changes ?? 0
    if (changed > 0) return { ok: true }
    const row = await db.prepare(
      'SELECT campaign_id, sent_at FROM brevo_newsletter_sends WHERE dedupe_key = ? LIMIT 1',
    ).bind(dedupeKey).first()
    if (row?.sent_at) return { ok: true }
    const existing = row?.campaign_id != null ? Number(row.campaign_id) : null
    if (existing === id) return { ok: true }
  }
  newsletterLog('send_campaign_id_persist_failed', { correlationId, dedupeKeyLen: dedupeKey.length })
  return { ok: false, correlationId }
}

/**
 * GET /emailCampaigns/:id — returns true if Brevo reports the campaign as sent (read-only, safe to retry).
 */
async function brevoCampaignLooksSent(campaignId: any, env: any) {
  const id = Number(campaignId)
  if (!Number.isFinite(id) || id <= 0) return false
  const res = await brevoFetch(`/emailCampaigns/${id}`, { method: 'GET' }, env)
  if (!res.ok) return false
  const data = await res.json().catch(() => null)
  const st = typeof data?.status === 'string' ? data.status.toLowerCase() : ''
  return BREVO_CAMPAIGN_SENT_STATUSES.has(st)
}

/**
 * If Brevo reports the campaign as sent, persist sent_at (recovery; do not clear campaign_id first).
 */
async function persistSentAtIfBrevoDelivered(db: any, dedupeKey: any, row: any, env: any) {
  if (row?.sent_at) return false
  const cid = row?.campaign_id != null ? Number(row.campaign_id) : null
  // @ts-expect-error TS(2531): Object is possibly 'null'.
  if (!Number.isFinite(cid) || cid <= 0) return false
  if (!(await brevoCampaignLooksSent(cid, env))) return false
  const sentAt = new Date().toISOString()
  await db.prepare(`
    UPDATE brevo_newsletter_sends
    SET sent_at = ?, in_flight = 0, claim_acquired_at = NULL, send_requested = 1
    WHERE dedupe_key = ? AND sent_at IS NULL
  `).bind(sentAt, dedupeKey).run()
  return true
}

function sanitizeErrorPayload(value: unknown): unknown {
  if (value instanceof Error) {
    return { error: 'Internal error', code: 'internal_error' }
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeErrorPayload(item))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase() === 'stack') continue
      out[key] = sanitizeErrorPayload(nested)
    }
    return out
  }
  return value
}

function jsonResponse(data: any, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(sanitizeErrorPayload(data), null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

/**
 * GET/PATCH /api/admin/newsletter/settings — admin or super_admin only
 * GET returns current Brevo-related settings (no secrets).
 * PATCH body: { brevoSubscriberListId?, brevoCampaignSenderEmail?, brevoCampaignSenderName? }
 */
export async function handleAdminNewsletterSettings(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const db = getDb(env)

  if (request.method === 'GET') {
    const [brevoSubscriberListId, brevoCampaignSenderEmail, brevoCampaignSenderName, pollRaw] = await Promise.all([
      getAdminSetting(db, 'brevo_subscriber_list_id'),
      getAdminSetting(db, 'brevo_campaign_sender_email'),
      getAdminSetting(db, 'brevo_campaign_sender_name'),
      getAdminSetting(db, 'brevo_newsletter_poll_interval_ms'),
    ])
    return jsonResponse({
      brevoSubscriberListId: brevoSubscriberListId ?? '',
      brevoCampaignSenderEmail: brevoCampaignSenderEmail ?? '',
      brevoCampaignSenderName: brevoCampaignSenderName ?? '',
      brevoNewsletterPollIntervalMs: clampNewsletterPollIntervalMs(pollRaw),
    }, 200, corsHeaders)
  }

  if (request.method !== 'PATCH') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders)
  }

  /** @type {{ key: string, value: string }[]} */
  const writes = []

  if ('brevoSubscriberListId' in body) {
    const v = body.brevoSubscriberListId
    if (v === null || v === '') {
      writes.push({ key: 'brevo_subscriber_list_id', value: '' })
    } else if (typeof v === 'number' && Number.isInteger(v) && v > 0) {
      writes.push({ key: 'brevo_subscriber_list_id', value: String(v) })
    } else if (typeof v === 'string') {
      const t = v.trim()
      if (!/^\d+$/.test(t)) {
        return jsonResponse({ error: 'brevoSubscriberListId must be a positive integer or empty', code: 'invalid_list_id' }, 400, corsHeaders)
      }
      const n = Number.parseInt(t, 10)
      if (!Number.isInteger(n) || n <= 0) {
        return jsonResponse({ error: 'brevoSubscriberListId must be a positive integer or empty', code: 'invalid_list_id' }, 400, corsHeaders)
      }
      writes.push({ key: 'brevo_subscriber_list_id', value: String(n) })
    } else {
      return jsonResponse({ error: 'brevoSubscriberListId must be a positive integer or empty', code: 'invalid_list_id' }, 400, corsHeaders)
    }
  }

  if ('brevoCampaignSenderEmail' in body) {
    const v = body.brevoCampaignSenderEmail
    if (v === null || v === '') {
      writes.push({ key: 'brevo_campaign_sender_email', value: '' })
    } else if (typeof v === 'string') {
      const t = v.trim().toLowerCase()
      if (!EMAIL_RE.test(t)) {
        return jsonResponse({ error: 'Invalid brevoCampaignSenderEmail', code: 'invalid_sender_email' }, 400, corsHeaders)
      }
      writes.push({ key: 'brevo_campaign_sender_email', value: t })
    } else {
      return jsonResponse({ error: 'brevoCampaignSenderEmail must be a string' }, 400, corsHeaders)
    }
  }

  if ('brevoCampaignSenderName' in body) {
    const v = body.brevoCampaignSenderName
    if (v === null || v === '') {
      writes.push({ key: 'brevo_campaign_sender_name', value: '' })
    } else if (typeof v === 'string') {
      writes.push({ key: 'brevo_campaign_sender_name', value: v.trim().slice(0, 120) })
    } else {
      return jsonResponse({ error: 'brevoCampaignSenderName must be a string' }, 400, corsHeaders)
    }
  }

  if ('brevoNewsletterPollIntervalMs' in body) {
    const v = body.brevoNewsletterPollIntervalMs
    if (v === null || v === '') {
      writes.push({ key: 'brevo_newsletter_poll_interval_ms', value: '' })
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      const ms = Math.round(v)
      if (ms < 60_000 || ms > 86_400_000) {
        return jsonResponse({
          error: 'brevoNewsletterPollIntervalMs must be between 60000 and 86400000',
          code: 'invalid_poll_interval',
        }, 400, corsHeaders)
      }
      writes.push({ key: 'brevo_newsletter_poll_interval_ms', value: String(ms) })
    } else {
      return jsonResponse({ error: 'brevoNewsletterPollIntervalMs must be a number (milliseconds)', code: 'invalid_poll_interval' }, 400, corsHeaders)
    }
  }

  if (writes.length) {
    const upsert = db.prepare(`
      INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `)
    await db.batch(writes.map(w => upsert.bind(w.key, w.value)))
  }

  const [brevoSubscriberListId, brevoCampaignSenderEmail, brevoCampaignSenderName, pollRaw] = await Promise.all([
    getAdminSetting(db, 'brevo_subscriber_list_id'),
    getAdminSetting(db, 'brevo_campaign_sender_email'),
    getAdminSetting(db, 'brevo_campaign_sender_name'),
    getAdminSetting(db, 'brevo_newsletter_poll_interval_ms'),
  ])

  return jsonResponse({
    ok: true,
    brevoSubscriberListId: brevoSubscriberListId ?? '',
    brevoCampaignSenderEmail: brevoCampaignSenderEmail ?? '',
    brevoCampaignSenderName: brevoCampaignSenderName ?? '',
    brevoNewsletterPollIntervalMs: clampNewsletterPollIntervalMs(pollRaw),
  }, 200, corsHeaders)
}

/**
 * POST /api/admin/newsletter/send — create a classic campaign and send immediately.
 * Body: { subject: string, htmlBody: string, dedupeKey: string }
 */
export async function handleAdminNewsletterSend(request: any, env: any, corsHeaders: any) {
  let correlationId = correlationFromRequest(request)
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  }

  if (!env.BREVO_API_KEY) {
    return jsonResponse({ error: 'Brevo is not configured (missing BREVO_API_KEY)', code: 'brevo_not_configured' }, 503, corsHeaders)
  }

  const body = await request.json().catch(() => null)
  const templateId = typeof body?.templateId === 'string' ? body.templateId.trim() : ''
  let subject = typeof body?.subject === 'string' ? body.subject.trim() : ''
  let htmlBody = typeof body?.htmlBody === 'string' ? body.htmlBody : ''
  const dedupeKey = typeof body?.dedupeKey === 'string' ? body.dedupeKey.trim() : ''
  if (templateId) {
    const template = await getDb(env).prepare(
      'SELECT subject, html_body FROM newsletter_templates WHERE id = ? LIMIT 1',
    ).bind(templateId).first()
    if (!template) {
      return jsonResponse({ error: 'Template not found', code: 'template_not_found' }, 404, corsHeaders)
    }
    subject = String(template.subject || '').trim()
    htmlBody = String(template.html_body || '')
  }
  if (!subject || !htmlBody.trim()) {
    return jsonResponse({ error: 'subject and htmlBody are required', code: 'validation' }, 400, corsHeaders)
  }
  if (!dedupeKey || dedupeKey.length > 256) {
    return jsonResponse({ error: 'dedupeKey is required (non-empty string, max 256 characters)', code: 'validation' }, 400, corsHeaders)
  }

  if (!correlationId) correlationId = crypto.randomUUID()
  newsletterLog('send_begin', { correlationId, dedupeKeyLen: dedupeKey.length })

  const db = getDb(env)
  await ensureBrevoNewsletterSendsTable(db)

  const sendRowSql = `
    SELECT campaign_id, sent_at, in_flight, send_requested, claim_acquired_at
    FROM brevo_newsletter_sends WHERE dedupe_key = ? LIMIT 1
  `

  const loadSendRow = () =>
    db.prepare(sendRowSql).bind(dedupeKey).first()

  let row = await loadSendRow()

  if (isNewsletterSendFinished(row)) {
    newsletterLog('send_idempotent_hit', { correlationId, campaignId: Number(row.campaign_id) })
    return jsonResponse({
      ok: true,
      campaignId: Number(row.campaign_id),
      idempotent: true,
    }, 200, corsHeaders)
  }

  await db.prepare('INSERT OR IGNORE INTO brevo_newsletter_sends (dedupe_key) VALUES (?)').bind(dedupeKey).run()
  row = await loadSendRow()

  if (isNewsletterSendFinished(row)) {
    newsletterLog('send_idempotent_race', { correlationId, campaignId: Number(row.campaign_id) })
    return jsonResponse({
      ok: true,
      campaignId: Number(row.campaign_id),
      idempotent: true,
    }, 200, corsHeaders)
  }

  if (await persistSentAtIfBrevoDelivered(db, dedupeKey, row, env)) {
    row = await loadSendRow()
    newsletterLog('send_idempotent_brevo_status', { correlationId, campaignId: Number(row.campaign_id) })
    return jsonResponse({
      ok: true,
      campaignId: Number(row.campaign_id),
      idempotent: true,
    }, 200, corsHeaders)
  }

  await releaseStaleNewsletterSendClaim(db, dedupeKey)
  row = await loadSendRow()

  if (isNewsletterSendFinished(row)) {
    newsletterLog('send_idempotent_after_stale', { correlationId, campaignId: Number(row.campaign_id) })
    return jsonResponse({
      ok: true,
      campaignId: Number(row.campaign_id),
      idempotent: true,
    }, 200, corsHeaders)
  }

  if (await persistSentAtIfBrevoDelivered(db, dedupeKey, row, env)) {
    row = await loadSendRow()
    newsletterLog('send_idempotent_brevo_after_stale', { correlationId, campaignId: Number(row.campaign_id) })
    return jsonResponse({
      ok: true,
      campaignId: Number(row.campaign_id),
      idempotent: true,
    }, 200, corsHeaders)
  }

  let inflight = Number(row?.in_flight) === 1
  let existingCampaignId = row?.campaign_id != null ? Number(row.campaign_id) : null
  const sendReq = Number(row?.send_requested) === 1

  // @ts-expect-error TS(2531): Object is possibly 'null'.
  if (inflight && Number.isFinite(existingCampaignId) && existingCampaignId > 0) {
    if (sendReq && (await brevoCampaignLooksSent(existingCampaignId, env))) {
      const sentAt = new Date().toISOString()
      await db.prepare(`
        UPDATE brevo_newsletter_sends
        SET sent_at = ?, in_flight = 0, claim_acquired_at = NULL, send_requested = 1
        WHERE dedupe_key = ? AND sent_at IS NULL
      `).bind(sentAt, dedupeKey).run()
      newsletterLog('send_idempotent_campaign_held', { correlationId, campaignId: existingCampaignId })
      return jsonResponse({
        ok: true,
        campaignId: existingCampaignId,
        idempotent: true,
      }, 200, corsHeaders)
    }
    if (!sendReq && (await brevoCampaignLooksSent(existingCampaignId, env))) {
      const sentAt = new Date().toISOString()
      await db.prepare(`
        UPDATE brevo_newsletter_sends
        SET sent_at = ?, in_flight = 0, claim_acquired_at = NULL, send_requested = 1
        WHERE dedupe_key = ? AND sent_at IS NULL
      `).bind(sentAt, dedupeKey).run()
      newsletterLog('send_idempotent_legacy_row', { correlationId, campaignId: existingCampaignId })
      return jsonResponse({
        ok: true,
        campaignId: existingCampaignId,
        idempotent: true,
      }, 200, corsHeaders)
    }
    newsletterLog('send_conflict_inflight', { correlationId, dedupeKeyLen: dedupeKey.length })
    return jsonResponse({
      error: 'Another send for this dedupe key is in progress. Retry shortly.',
      code: 'newsletter_send_in_progress',
    }, 409, corsHeaders)
  }

  let listId
  let campaignPayload
  try {
    const listIdRaw = await getAdminSetting(db, 'brevo_subscriber_list_id')
    listId = listIdRaw != null && String(listIdRaw).trim() !== '' ? Number.parseInt(String(listIdRaw).trim(), 10) : NaN
    if (!Number.isFinite(listId) || listId <= 0) {
      return jsonResponse({
        error: 'Configure brevoSubscriberListId in newsletter settings first',
        code: 'list_not_configured',
      }, 422, corsHeaders)
    }

    const senderEmailRaw = await getAdminSetting(db, 'brevo_campaign_sender_email')
    const senderEmail = senderEmailRaw ? String(senderEmailRaw).trim().toLowerCase() : ''
    if (!senderEmail || !EMAIL_RE.test(senderEmail)) {
      return jsonResponse({
        error: 'Configure a verified brevoCampaignSenderEmail in newsletter settings',
        code: 'sender_not_configured',
      }, 422, corsHeaders)
    }

    const senderNameRaw = await getAdminSetting(db, 'brevo_campaign_sender_name')
    const senderName = senderNameRaw ? String(senderNameRaw).trim() : ''

    campaignPayload = {
      name: `VMP Newsletter ${new Date().toISOString()}`,
      subject,
      type: 'classic',
      sender: senderName ? { email: senderEmail, name: senderName } : { email: senderEmail },
      htmlContent: htmlBody,
      recipients: { listIds: [listId] },
    }
  } catch (configErr) {
    const message = configErr instanceof Error ? configErr.message : String(configErr)
    newsletterLog('send_config_error', { correlationId, message })
    return jsonResponse({ error: 'Failed to load newsletter configuration', code: 'config_error' }, 500, corsHeaders)
  }

  let claimHeld = false
  if (!inflight) {
    claimHeld = await tryAcquireNewsletterSendClaim(db, dedupeKey)
    if (!claimHeld) {
      row = await loadSendRow()
      if (isNewsletterSendFinished(row)) {
        return jsonResponse({
          ok: true,
          campaignId: Number(row.campaign_id),
          idempotent: true,
        }, 200, corsHeaders)
      }
      if (await persistSentAtIfBrevoDelivered(db, dedupeKey, row, env)) {
        row = await loadSendRow()
        return jsonResponse({
          ok: true,
          campaignId: Number(row.campaign_id),
          idempotent: true,
        }, 200, corsHeaders)
      }
      const cid = row?.campaign_id != null ? Number(row.campaign_id) : null
      // @ts-expect-error TS(2531): Object is possibly 'null'.
      if (Number.isFinite(cid) && cid > 0 && Number(row?.send_requested) === 1 && !row?.sent_at) {
        if (await brevoCampaignLooksSent(cid, env)) {
          const sentAt = new Date().toISOString()
          await db.prepare(`
            UPDATE brevo_newsletter_sends
            SET sent_at = ?, in_flight = 0, claim_acquired_at = NULL
            WHERE dedupe_key = ? AND sent_at IS NULL
          `).bind(sentAt, dedupeKey).run()
          newsletterLog('send_idempotent_campaign_race', { correlationId, campaignId: cid })
          return jsonResponse({
            ok: true,
            campaignId: cid,
            idempotent: true,
          }, 200, corsHeaders)
        }
      }
      newsletterLog('send_conflict_after_claim', { correlationId, dedupeKeyLen: dedupeKey.length })
      return jsonResponse({
        error: 'Another send for this dedupe key is in progress. Retry shortly.',
        code: 'newsletter_send_in_progress',
      }, 409, corsHeaders)
    }
  } else {
    newsletterLog('send_conflict_inflight', { correlationId, dedupeKeyLen: dedupeKey.length })
    return jsonResponse({
      error: 'Another send for this dedupe key is in progress. Retry shortly.',
      code: 'newsletter_send_in_progress',
    }, 409, corsHeaders)
  }

  await db.prepare(`
    UPDATE brevo_newsletter_sends SET send_requested = 1 WHERE dedupe_key = ? AND sent_at IS NULL
  `).bind(dedupeKey).run()

  let campaignId = existingCampaignId != null && Number.isFinite(existingCampaignId) ? existingCampaignId : null

  const releaseIfHeld = async () => {
    if (claimHeld) await releaseNewsletterSendClaimFullAbort(db, dedupeKey)
  }

  const releaseAfterSendNowFail = async () => {
    if (claimHeld) await releaseNewsletterSendClaimAfterSendNowFailure(db, dedupeKey)
  }

  try {
    if (campaignId == null || !Number.isFinite(campaignId)) {
      const createRes = await brevoFetch('/emailCampaigns', { method: 'POST', body: JSON.stringify(campaignPayload) }, env)
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}))
        newsletterLog('send_create_failed', {
          correlationId,
          httpStatus: createRes.status,
          brevoCode: typeof err.code === 'string' ? err.code : undefined,
        })
        const status = createRes.status === 504 ? 504 : (createRes.status >= 400 && createRes.status < 600 ? createRes.status : 502)
        const msg = typeof err.message === 'string' ? err.message : 'Failed to create email campaign'
        await releaseIfHeld()
        return jsonResponse({
          error: msg,
          code: createRes.status === 504 ? 'brevo_timeout' : 'brevo_campaign_error',
          brevoStatus: createRes.status,
          brevoCode: typeof err.code === 'string' ? err.code : undefined,
        }, status, corsHeaders)
      }

      const created = await createRes.json().catch(() => null)
      const newId = created?.id
      if (newId == null || !Number.isFinite(Number(newId))) {
        newsletterLog('send_create_unexpected_body', { correlationId })
        await releaseIfHeld()
        return jsonResponse({ error: 'Unexpected response creating campaign', code: 'brevo_campaign_error' }, 502, corsHeaders)
      }

      campaignId = Number(newId)

      const persisted = await persistCampaignIdForDedupeKey(db, dedupeKey, newId, correlationId)
      if (!persisted.ok) {
        return jsonResponse(
          {
            error: 'Failed to persist campaign id after Brevo create; retry or contact support',
            code: 'campaign_id_persist_failed',
          },
          503,
          corsHeaders,
        )
      }

      row = await loadSendRow()
      if (isNewsletterSendFinished(row)) {
        await releaseIfHeld()
        return jsonResponse({
          ok: true,
          campaignId: Number(row.campaign_id),
          idempotent: true,
        }, 200, corsHeaders)
      }
      campaignId = row?.campaign_id != null ? Number(row.campaign_id) : Number(newId)
    }

    row = await loadSendRow()
    if (isNewsletterSendFinished(row)) {
      await releaseIfHeld()
      return jsonResponse({
        ok: true,
        campaignId: Number(row.campaign_id),
        idempotent: true,
      }, 200, corsHeaders)
    }

    const sendRes = await brevoFetch(`/emailCampaigns/${campaignId}/sendNow`, { method: 'POST' }, env)
    if (!sendRes.ok && sendRes.status !== 204) {
      const err = await sendRes.json().catch(() => ({}))
      newsletterLog('send_now_failed', {
        correlationId,
        campaignId,
        httpStatus: sendRes.status,
        brevoCode: typeof err.code === 'string' ? err.code : undefined,
      })
      const status = sendRes.status === 504 ? 504 : (sendRes.status >= 400 && sendRes.status < 600 ? sendRes.status : 502)
      const msg = typeof err.message === 'string' ? err.message : 'Campaign created but send failed'
      await releaseAfterSendNowFail()
      return jsonResponse({
        error: msg,
        code: sendRes.status === 504 ? 'brevo_timeout' : 'brevo_send_failed',
        campaignId,
        brevoStatus: sendRes.status,
        brevoCode: typeof err.code === 'string' ? err.code : undefined,
      }, status, corsHeaders)
    }

    const sentAt = new Date().toISOString()
    await db.prepare(`
      UPDATE brevo_newsletter_sends SET sent_at = ?, in_flight = 0, claim_acquired_at = NULL WHERE dedupe_key = ? AND sent_at IS NULL
    `).bind(sentAt, dedupeKey).run()

    newsletterLog('send_complete', { correlationId, campaignId: Number(campaignId) })
    return jsonResponse({ ok: true, campaignId: Number(campaignId) }, 200, corsHeaders)
  } catch (e) {
    const r = await loadSendRow()
    const persistedCid = r?.campaign_id != null ? Number(r.campaign_id) : null
    const hasPersistedCampaign =
      (campaignId != null && Number.isFinite(campaignId))
      || (persistedCid != null && Number.isFinite(persistedCid) && persistedCid > 0)
    if (hasPersistedCampaign) await releaseAfterSendNowFail()
    else await releaseIfHeld()
    throw e
  }
}

/**
 * Safe retry: read-only Brevo list; 504 gets one backoff retry.
 */
export async function fetchBrevoEmailCampaignsWithRetry(env: any) {
  const limit = 20
  const path = `/emailCampaigns?limit=${limit}&offset=0&sort=desc`
  let res = await brevoFetch(path, { method: 'GET' }, env)
  if (!res.ok && res.status === 504) {
    await new Promise(r => setTimeout(r, 400))
    res = await brevoFetch(path, { method: 'GET' }, env)
  }
  return res
}

export async function handleAdminNewsletterCampaigns(request: any, env: any, corsHeaders: any) {
  const correlationId = correlationFromRequest(request) || crypto.randomUUID()
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const res = await fetchBrevoEmailCampaignsWithRetry(env)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    newsletterLog('campaigns_list_failed', {
      correlationId,
      httpStatus: res.status,
      brevoCode: typeof err.code === 'string' ? err.code : undefined,
    })
    return jsonResponse({
      error: typeof err.message === 'string' ? err.message : 'Failed to fetch campaigns',
      code: 'brevo_campaigns_error',
      brevoStatus: res.status,
      brevoCode: typeof err.code === 'string' ? err.code : undefined,
    }, res.status, corsHeaders)
  }
  const data = await res.json().catch(() => ({}))
  newsletterLog('campaigns_list_ok', { correlationId, count: Array.isArray(data?.campaigns) ? data.campaigns.length : 0 })
  return jsonResponse({ campaigns: data?.campaigns ?? [] }, 200, corsHeaders)
}

export async function handleAdminNewsletterTemplates(request: any, env: any, corsHeaders: any) {
  const correlationId = correlationFromRequest(request) || crypto.randomUUID()
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  const db = getDb(env)
  if (request.method === 'GET') {
    const rows = await db.prepare(`
      SELECT id, name, subject, html_body, created_at, updated_at
      FROM newsletter_templates
      ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
    `).all()
    return jsonResponse({ templates: rows?.results ?? [] }, 200, corsHeaders)
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const body = await request.json().catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const subject = typeof body?.subject === 'string' ? body.subject.trim() : ''
  const htmlBody = typeof body?.htmlBody === 'string' ? body.htmlBody : ''
  if (!name || !subject || !htmlBody.trim()) {
    return jsonResponse({ error: 'name, subject and htmlBody are required', code: 'validation' }, 400, corsHeaders)
  }
  const id = crypto.randomUUID()
  await db.prepare(`
    INSERT INTO newsletter_templates (id, name, subject, html_body, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(id, name, subject, htmlBody).run()
  newsletterLog('template_created', { templateId: id, correlationId })
  return jsonResponse({ ok: true, id }, 201, corsHeaders)
}

/**
 * PATCH / DELETE /api/admin/newsletter/templates/:id
 */
export async function handleAdminNewsletterTemplateById(request: any, env: any, corsHeaders: any, templateId: any) {
  const correlationId = correlationFromRequest(request) || crypto.randomUUID()
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  const id = typeof templateId === 'string' ? templateId.trim() : ''
  if (!id) {
    return jsonResponse({ error: 'Invalid template id', code: 'validation' }, 400, corsHeaders)
  }
  const db = getDb(env)

  if (request.method === 'DELETE') {
    const del = await db.prepare('DELETE FROM newsletter_templates WHERE id = ?').bind(id).run()
    const n = del.meta?.changes ?? del.changes ?? 0
    if (!n) {
      return jsonResponse({ error: 'Template not found', code: 'template_not_found' }, 404, corsHeaders)
    }
    newsletterLog('template_deleted', { correlationId, templateId: id })
    return jsonResponse({ ok: true }, 200, corsHeaders)
  }

  if (request.method !== 'PATCH') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders)
  }

  const updates = []
  const values = []
  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return jsonResponse({ error: 'name must be a non-empty string', code: 'validation' }, 400, corsHeaders)
    }
    updates.push('name = ?')
    values.push(body.name.trim())
  }
  if ('subject' in body) {
    if (typeof body.subject !== 'string' || !body.subject.trim()) {
      return jsonResponse({ error: 'subject must be a non-empty string', code: 'validation' }, 400, corsHeaders)
    }
    updates.push('subject = ?')
    values.push(body.subject.trim())
  }
  if ('htmlBody' in body) {
    if (typeof body.htmlBody !== 'string' || !body.htmlBody.trim()) {
      return jsonResponse({ error: 'htmlBody must be a non-empty string', code: 'validation' }, 400, corsHeaders)
    }
    updates.push('html_body = ?')
    values.push(body.htmlBody)
  }

  if (!updates.length) {
    return jsonResponse({ error: 'Provide at least one of: name, subject, htmlBody', code: 'validation' }, 400, corsHeaders)
  }

  updates.push('updated_at = CURRENT_TIMESTAMP')
  const sql = `UPDATE newsletter_templates SET ${updates.join(', ')} WHERE id = ?`
  values.push(id)
  const run = await db.prepare(sql).bind(...values).run()
  const changed = run.meta?.changes ?? run.changes ?? 0
  if (!changed) {
    return jsonResponse({ error: 'Template not found', code: 'template_not_found' }, 404, corsHeaders)
  }
  newsletterLog('template_updated', { correlationId, templateId: id, fields: updates.length - 1 })
  const row = await db.prepare(
    'SELECT id, name, subject, html_body, created_at, updated_at FROM newsletter_templates WHERE id = ? LIMIT 1',
  ).bind(id).first()
  return jsonResponse({ ok: true, template: row }, 200, corsHeaders)
}

export async function handleAdminNewsletterSync(request: any, env: any, corsHeaders: any) {
  const correlationId = correlationFromRequest(request) || crypto.randomUUID()
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const db = getDb(env)
  newsletterLog('manual_sync_begin', { correlationId })
  try {
    const synced = await syncAllEligibleSubscribers(db, env)
    newsletterLog('manual_sync_complete', { correlationId, synced })
    return jsonResponse({ ok: true, synced }, 200, corsHeaders)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    newsletterLog('manual_sync_failed', { correlationId, error: message })
    const isConfigError = message.includes('not configured') || message.includes('invalid')
    const status = isConfigError ? 422 : 500
    return jsonResponse({ ok: false, error: message || 'sync_failed', code: 'newsletter_sync_failed' }, status, corsHeaders)
  }
}