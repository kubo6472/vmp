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
export function clampNewsletterPollIntervalMs(raw) {
  const n = raw != null && String(raw).trim() !== '' ? Number.parseInt(String(raw).trim(), 10) : NaN
  if (!Number.isFinite(n) || n < 60_000) return DEFAULT_NEWSLETTER_POLL_INTERVAL_MS
  return Math.min(n, 86_400_000)
}

/**
 * @param {{ sent_at?: string | null, campaign_id?: number | null } | null | undefined} row
 */
export function isNewsletterSendFinished(row) {
  return !!(row?.sent_at && row.campaign_id != null)
}

function correlationFromRequest(request) {
  const cf = request.headers?.get?.('CF-Ray')
  const trace = request.headers?.get?.('X-Amzn-Trace-Id')
  const rid = request.headers?.get?.('X-Request-Id')
  return cf || trace || rid || null
}

function newsletterLog(event, fields = {}) {
  console.log(JSON.stringify({ source: 'brevo_newsletter', event, ...fields }))
}

function getDb(env) {
  const db = env.DB || env.video_subscription_db
  if (!db) throw new Error('D1 binding not found')
  return db
}

async function getAdminSetting(db, key) {
  const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ?').bind(key).first()
  return row?.value ?? null
}

async function setAdminSetting(db, key, value) {
  await db.prepare(`
    INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).bind(key, value).run()
}

function brevoTimeoutMs(env) {
  const raw = env.BREVO_FETCH_TIMEOUT_MS
  const n = raw != null && String(raw).trim() !== '' ? Number.parseInt(String(raw).trim(), 10) : 5000
  return Number.isFinite(n) && n > 0 ? Math.min(n, 120_000) : 5000
}

/**
 * Fetch against Brevo with a hard timeout; merges AbortSignal with optional caller signal.
 * On timeout or abort, returns a 504 Response (does not throw).
 */
async function brevoFetch(path, options = {}, env) {
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

  const userSignal = options.signal
  if (userSignal) {
    if (userSignal.aborted) controller.abort()
    else userSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  const { signal: _omit, ...rest } = options

  try {
    const res = await fetch(`${BREVO_BASE}${path}`, {
      ...rest,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'api-key': key,
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
export async function syncNewsletterForStripeSubscription(db, userId, stripeStatus, env) {
  const paying = ['active', 'trialing'].includes(stripeStatus)
  if (paying) {
    await syncPayingSubscriberToNewsletter(db, userId, env)
  } else {
    await removeSubscriberFromNewsletter(db, userId, env)
  }
}

/**
 * Add or update a user in the Brevo subscriber list (paying subscribers).
 * No-op if API key or list id is missing.
 */
export async function syncPayingSubscriberToNewsletter(db, userId, env) {
  if (!env.BREVO_API_KEY) return

  const listIdRaw = await getAdminSetting(db, 'brevo_subscriber_list_id')
  const listId = listIdRaw != null && String(listIdRaw).trim() !== '' ? Number.parseInt(String(listIdRaw).trim(), 10) : NaN
  if (!Number.isFinite(listId) || listId <= 0) return

  const row = await db.prepare('SELECT email FROM users WHERE id = ? LIMIT 1').bind(userId).first()
  const email = row?.email ? String(row.email).trim().toLowerCase() : ''
  if (!email || !EMAIL_RE.test(email)) return

  const body = {
    email,
    updateEnabled: true,
    listIds: [listId],
  }

  const res = await brevoFetch('/contacts', { method: 'POST', body: JSON.stringify(body) }, env)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    newsletterLog('sync_contact_failed', { userId, status: res.status, code: err?.code })
  }
}

async function syncAllEligibleSubscribers(db, env) {
  const rows = await db.prepare(`
    SELECT u.id
    FROM users u
    LEFT JOIN subscriptions s
      ON s.user_id = u.id
      AND s.status IN ('active', 'trialing')
      AND (s.current_period_end IS NULL OR datetime(s.current_period_end) > CURRENT_TIMESTAMP)
    GROUP BY u.id
    HAVING
      MAX(CASE WHEN s.user_id IS NOT NULL THEN 1 ELSE 0 END) = 1
      OR u.role IN ('super_admin', 'admin', 'editor', 'analyst', 'moderator')
  `).all()

  const userIds = (rows?.results ?? []).map(r => r.id).filter(Boolean)
  let synced = 0
  for (const userId of userIds) {
    await syncPayingSubscriberToNewsletter(db, userId, env)
    synced += 1
  }
  return synced
}

/**
 * Remove a user's email from the subscriber list (e.g. subscription ended).
 */
export async function removeSubscriberFromNewsletter(db, userId, env) {
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
    newsletterLog('remove_from_list_failed', { userId, status: res.status, code: err?.code })
  }
}

async function ensureBrevoNewsletterSendsTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS brevo_newsletter_sends (
      dedupe_key   TEXT PRIMARY KEY,
      campaign_id  INTEGER,
      sent_at      TEXT,
      created_at   TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run()
}

function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

/**
 * GET/PATCH /api/admin/newsletter/settings — admin or super_admin only
 * GET returns current Brevo-related settings (no secrets).
 * PATCH body: { brevoSubscriberListId?, brevoCampaignSenderEmail?, brevoCampaignSenderName? }
 */
export async function handleAdminNewsletterSettings(request, env, corsHeaders) {
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
export async function handleAdminNewsletterSend(request, env, corsHeaders) {
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

  let row = await db.prepare(
    'SELECT campaign_id, sent_at FROM brevo_newsletter_sends WHERE dedupe_key = ? LIMIT 1',
  ).bind(dedupeKey).first()

  if (isNewsletterSendFinished(row)) {
    newsletterLog('send_idempotent_hit', { correlationId, campaignId: Number(row.campaign_id) })
    return jsonResponse({
      ok: true,
      campaignId: Number(row.campaign_id),
      idempotent: true,
    }, 200, corsHeaders)
  }

  const listIdRaw = await getAdminSetting(db, 'brevo_subscriber_list_id')
  const listId = listIdRaw != null && String(listIdRaw).trim() !== '' ? Number.parseInt(String(listIdRaw).trim(), 10) : NaN
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

  const campaignPayload = {
    name: `VMP Newsletter ${new Date().toISOString()}`,
    subject,
    type: 'classic',
    sender: senderName ? { email: senderEmail, name: senderName } : { email: senderEmail },
    htmlContent: htmlBody,
    recipients: { listIds: [listId] },
  }

  let campaignId = row?.campaign_id != null ? Number(row.campaign_id) : null

  if (campaignId == null || !Number.isFinite(campaignId)) {
    await db.prepare('INSERT OR IGNORE INTO brevo_newsletter_sends (dedupe_key) VALUES (?)').bind(dedupeKey).run()
    row = await db.prepare(
      'SELECT campaign_id, sent_at FROM brevo_newsletter_sends WHERE dedupe_key = ? LIMIT 1',
    ).bind(dedupeKey).first()
    if (isNewsletterSendFinished(row)) {
      newsletterLog('send_idempotent_race', { correlationId, campaignId: Number(row.campaign_id) })
      return jsonResponse({
        ok: true,
        campaignId: Number(row.campaign_id),
        idempotent: true,
      }, 200, corsHeaders)
    }
    campaignId = row?.campaign_id != null ? Number(row.campaign_id) : null
  }

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
      return jsonResponse({ error: 'Unexpected response creating campaign', code: 'brevo_campaign_error' }, 502, corsHeaders)
    }

    const upd = await db.prepare(`
      UPDATE brevo_newsletter_sends SET campaign_id = ? WHERE dedupe_key = ? AND campaign_id IS NULL
    `).bind(Number(newId), dedupeKey).run()
    const changed = upd.meta?.changes ?? upd.changes ?? 0
    if (changed === 0) {
      row = await db.prepare(
        'SELECT campaign_id, sent_at FROM brevo_newsletter_sends WHERE dedupe_key = ? LIMIT 1',
      ).bind(dedupeKey).first()
      if (isNewsletterSendFinished(row)) {
        return jsonResponse({
          ok: true,
          campaignId: Number(row.campaign_id),
          idempotent: true,
        }, 200, corsHeaders)
      }
      campaignId = row?.campaign_id != null ? Number(row.campaign_id) : Number(newId)
    } else {
      campaignId = Number(newId)
    }
  }

  row = await db.prepare(
    'SELECT campaign_id, sent_at FROM brevo_newsletter_sends WHERE dedupe_key = ? LIMIT 1',
  ).bind(dedupeKey).first()
  if (isNewsletterSendFinished(row)) {
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
    UPDATE brevo_newsletter_sends SET sent_at = ? WHERE dedupe_key = ? AND sent_at IS NULL
  `).bind(sentAt, dedupeKey).run()

  newsletterLog('send_complete', { correlationId, campaignId: Number(campaignId) })
  return jsonResponse({ ok: true, campaignId: Number(campaignId) }, 200, corsHeaders)
}

/**
 * Safe retry: read-only Brevo list; 504 gets one backoff retry.
 */
export async function fetchBrevoEmailCampaignsWithRetry(env) {
  const limit = 20
  const path = `/emailCampaigns?limit=${limit}&offset=0&sort=desc`
  let res = await brevoFetch(path, { method: 'GET' }, env)
  if (!res.ok && res.status === 504) {
    await new Promise(r => setTimeout(r, 400))
    res = await brevoFetch(path, { method: 'GET' }, env)
  }
  return res
}

export async function handleAdminNewsletterCampaigns(request, env, corsHeaders) {
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

export async function handleAdminNewsletterTemplates(request, env, corsHeaders) {
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
  newsletterLog('template_created', { templateId: id })
  return jsonResponse({ ok: true, id }, 201, corsHeaders)
}

/**
 * PATCH / DELETE /api/admin/newsletter/templates/:id
 */
export async function handleAdminNewsletterTemplateById(request, env, corsHeaders, templateId) {
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

export async function handleAdminNewsletterSync(request, env, corsHeaders) {
  const correlationId = correlationFromRequest(request) || crypto.randomUUID()
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const db = getDb(env)
  newsletterLog('manual_sync_begin', { correlationId })
  const synced = await syncAllEligibleSubscribers(db, env)
  newsletterLog('manual_sync_complete', { correlationId, synced })
  return jsonResponse({ ok: true, synced }, 200, corsHeaders)
}
