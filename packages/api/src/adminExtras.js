import { requireAuth, requireRole } from './auth.js'
import { ensureAdminSettingsTable } from './adminSettingsTable.js'
import { getSetting, setSetting, setSettings } from './settingsStore.js'
import {
  evaluateRoleChange,
  evaluateSelfRoleChange,
  evaluateSubscriptionStatusChange,
  isValidRoleName,
} from './adminUserPolicy.js'

const PILLS_KEY_HASH_PREFIX = 'sha256'
const PILLS_KEY_HASH_LEGACY_PREFIX = 'pbkdf2-sha256'
const PILLS_KEY_HASH_ITERATIONS = 120000

function getDb(env) {
  const db = env.DB || env.video_subscription_db
  if (!db) throw new Error('D1 binding not found')
  return db
}

function buildAdminAuditLogStatement(db, { actorUserId, actionType, targetUserId, detail }) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (id, actor_user_id, action_type, target_user_id, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(
    crypto.randomUUID(),
    actorUserId,
    actionType,
    targetUserId,
    JSON.stringify(detail ?? {}),
  )
}

function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

export async function handleHomepageContent(request, env, corsHeaders) {
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  try {
    const db = getDb(env)
    await ensureAdminSettingsTable(db)

    if (request.method === 'GET') {
      const [title, subtitle] = await Promise.all([
        getSetting(env, 'homepage_hero_title'),
        getSetting(env, 'homepage_hero_subtitle'),
      ])
      return jsonResponse({
        title: title ?? 'Discover Premium Video Content',
        subtitle: subtitle ?? 'Watch free previews or unlock full access with a premium subscription',
      }, 200, corsHeaders)
    }
    if (request.method !== 'PATCH') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const subtitle = typeof body?.subtitle === 'string' ? body.subtitle.trim() : ''
    if (!title || !subtitle) return jsonResponse({ error: 'title and subtitle are required' }, 400, corsHeaders)
    await setSettings(env, [
      ['homepage_hero_title', title],
      ['homepage_hero_subtitle', subtitle],
    ])
    return jsonResponse({ ok: true, title, subtitle }, 200, corsHeaders)
  } catch (error) {
    console.error('handleHomepageContent:', error)
    return jsonResponse({ error: 'Internal server error', code: 'internal_error' }, 500, corsHeaders)
  }
}

export async function handlePillsPublic(request, env, corsHeaders) {
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const db = getDb(env)
  const rows = await db.prepare(`
    SELECT id, label, value, color, sort_order, updated_at
    FROM pills ORDER BY sort_order ASC, datetime(updated_at) DESC
  `).all()
  return jsonResponse({ pills: rows?.results ?? [] }, 200, corsHeaders)
}

export async function handlePillsUpdate(request, env, corsHeaders) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const db = getDb(env)
  const preAuthRateLimit = await checkPillsUpdateRateLimit(request, env, { phase: 'ip' })
  if (preAuthRateLimit.error) {
    return jsonResponse({ error: preAuthRateLimit.error, code: 'invalid_config' }, 500, corsHeaders)
  }
  if (preAuthRateLimit.limited) {
    return new Response(JSON.stringify({
      error: 'Too many pills update requests',
      code: 'rate_limited',
    }, null, 2), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(preAuthRateLimit.retryAfterSeconds),
        ...corsHeaders,
      },
    })
  }

  const expectedHash = await getActivePillsApiKeyHash(env)
  const provided = request.headers.get('x-api-key') || ''
  const keyValid = expectedHash
    ? await verifyPillsApiKeyValue(provided, expectedHash)
    : false
  if (!keyValid) {
    return jsonResponse({ error: 'Unauthorized', code: 'invalid_api_key' }, 401, corsHeaders)
  }
  const keyFingerprint = getPillsKeyFingerprint(expectedHash)
  const postAuthRateLimit = await checkPillsUpdateRateLimit(request, env, { phase: 'key', keyFingerprint })
  if (postAuthRateLimit.error) {
    return jsonResponse({ error: postAuthRateLimit.error, code: 'invalid_config' }, 500, corsHeaders)
  }
  if (postAuthRateLimit.limited) {
    return new Response(JSON.stringify({
      error: 'Too many pills update requests',
      code: 'rate_limited',
    }, null, 2), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(postAuthRateLimit.retryAfterSeconds),
        ...corsHeaders,
      },
    })
  }
  const body = await request.json().catch(() => null)
  if (!Array.isArray(body?.pills)) return jsonResponse({ error: 'pills[] is required' }, 400, corsHeaders)
  const upsert = db.prepare(`
    INSERT INTO pills (id, label, value, color, sort_order, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      value = excluded.value,
      color = excluded.color,
      sort_order = excluded.sort_order,
      updated_at = CURRENT_TIMESTAMP
  `)
  const nowPayload = JSON.stringify(body.pills).slice(0, 100000)
  await db.prepare(`
    INSERT INTO pills_updates_audit (id, source, payload_json, created_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(crypto.randomUUID(), request.headers.get('x-forwarded-for') || 'external-api', nowPayload).run()
  const statements = []
  for (let i = 0; i < body.pills.length; i += 1) {
    const pill = body.pills[i]
    if (!pill || typeof pill.id !== 'string' || typeof pill.label !== 'string') continue
    const value = Number(pill.value)
    statements.push(upsert.bind(
      pill.id,
      pill.label.trim(),
      Number.isFinite(value) ? value : 0,
      typeof pill.color === 'string' && pill.color.trim() ? pill.color.trim() : '#2563eb',
      Number.isInteger(pill.sortOrder) ? pill.sortOrder : i,
    ))
  }
  if (statements.length) await db.batch(statements)
  return jsonResponse({ ok: true, updated: statements.length }, 200, corsHeaders)
}

async function checkPillsUpdateRateLimit(request, env, options = {}) {
  const kv = env.RATE_LIMIT_KV || null
  if (!kv) return { limited: false, retryAfterSeconds: 0 }

  const configured = Number.parseInt(
    String(await getSetting(env, 'pills_update_rate_limit_per_minute') ?? ''),
    10,
  )
  const perMinuteLimit = Number.isFinite(configured) && configured > 0 ? configured : null
  if (!perMinuteLimit) {
    return { limited: true, retryAfterSeconds: 60, error: 'pills_update_rate_limit_per_minute is not configured' }
  }
  const minute = Math.floor(Date.now() / 60000)
  const sourceIp = extractClientIp(request)
  const phase = options.phase === 'key' ? 'key' : 'ip'
  const keyFingerprint = typeof options.keyFingerprint === 'string' ? options.keyFingerprint : 'unknown'
  const rateKey = phase === 'ip'
    ? `pillsupd:${sourceIp}:${minute}`
    : `pillsupd:${sourceIp}:${keyFingerprint}:${minute}`
  const current = Number.parseInt((await kv.get(rateKey)) ?? '0', 10) || 0
  const next = current + 1
  await kv.put(rateKey, String(next), { expirationTtl: 75 })
  if (next > perMinuteLimit) return { limited: true, retryAfterSeconds: 60 }
  return { limited: false, retryAfterSeconds: 0 }
}

function extractClientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP')
  if (cf && cf.trim()) return cf.trim()
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim()
  }
  return 'unknown'
}

export async function handleAdminPills(request, env, corsHeaders) {
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  const db = getDb(env)

  if (request.method === 'GET') {
    const rows = await db.prepare(`
      SELECT id, label, value, color, sort_order, updated_at
      FROM pills ORDER BY sort_order ASC, datetime(updated_at) DESC
    `).all()
    return jsonResponse({ pills: rows?.results ?? [] }, 200, corsHeaders)
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return jsonResponse({ error: 'Request body is required' }, 400, corsHeaders)

  if (request.method === 'POST') {
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : crypto.randomUUID()
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    const value = Number(body.value)
    const color = typeof body.color === 'string' && body.color.trim() ? body.color.trim() : '#2563eb'
    const sortOrder = Number.isInteger(body.sortOrder) ? body.sortOrder : 0
    if (!label) return jsonResponse({ error: 'label is required' }, 400, corsHeaders)
    await db.prepare(`
      INSERT INTO pills (id, label, value, color, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(id, label, Number.isFinite(value) ? value : 0, color, sortOrder).run()
    return jsonResponse({ ok: true, id }, 201, corsHeaders)
  }

  if (request.method === 'PATCH') {
    if (Array.isArray(body.items)) {
      const reorderStatements = []
      for (let i = 0; i < body.items.length; i += 1) {
        const item = body.items[i]
        if (!item || typeof item.id !== 'string') continue
        reorderStatements.push(
          db.prepare(`UPDATE pills SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(i, item.id),
        )
      }
      if (reorderStatements.length) await db.batch(reorderStatements)
      return jsonResponse({ ok: true, updated: reorderStatements.length }, 200, corsHeaders)
    }
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) return jsonResponse({ error: 'id is required' }, 400, corsHeaders)
    const updates = []
    const values = []
    if (typeof body.label === 'string') {
      const next = body.label.trim()
      if (!next) return jsonResponse({ error: 'label must not be empty' }, 400, corsHeaders)
      updates.push('label = ?')
      values.push(next)
    }
    if (Object.prototype.hasOwnProperty.call(body, 'value')) {
      const next = Number(body.value)
      if (!Number.isFinite(next)) return jsonResponse({ error: 'value must be a number' }, 400, corsHeaders)
      updates.push('value = ?')
      values.push(next)
    }
    if (typeof body.color === 'string') {
      const next = body.color.trim()
      if (!next) return jsonResponse({ error: 'color must not be empty' }, 400, corsHeaders)
      updates.push('color = ?')
      values.push(next)
    }
    if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
      if (!Number.isInteger(body.sortOrder)) return jsonResponse({ error: 'sortOrder must be an integer' }, 400, corsHeaders)
      updates.push('sort_order = ?')
      values.push(body.sortOrder)
    }
    if (!updates.length) return jsonResponse({ error: 'No fields to update' }, 400, corsHeaders)
    values.push(id)
    await db.prepare(`
      UPDATE pills
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(...values).run()
    return jsonResponse({ ok: true }, 200, corsHeaders)
  }

  if (request.method === 'DELETE') {
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) return jsonResponse({ error: 'id is required' }, 400, corsHeaders)
    await db.prepare('DELETE FROM pills WHERE id = ?').bind(id).run()
    return jsonResponse({ ok: true }, 200, corsHeaders)
  }

  return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
}

export async function handleAdminPillsSettings(request, env, corsHeaders) {
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  const envKey = typeof env.PILLS_API_KEY === 'string' ? env.PILLS_API_KEY.trim() : ''
  const activeHash = await getActivePillsApiKeyHash(env)
  const active = envKey || activeHash

  if (request.method === 'GET') {
    return jsonResponse({
      hasKey: Boolean(active),
      managedByEnv: Boolean(envKey),
      maskedKey: active ? buildMaskedKey(active) : '',
    }, 200, corsHeaders)
  }
  if (request.method !== 'PATCH') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  if (envKey) {
    return jsonResponse({ error: 'PILLS_API_KEY is managed by environment secret' }, 409, corsHeaders)
  }
  const body = await request.json().catch(() => null)
  const nextKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!nextKey) return jsonResponse({ error: 'apiKey is required' }, 400, corsHeaders)
  const nextHash = await hashPillsApiKey(nextKey)
  await setSetting(env, 'pills_api_key', nextHash)
  return jsonResponse({ ok: true, hasKey: true, maskedKey: buildMaskedKey(nextHash) }, 200, corsHeaders)
}

export async function handleCategoryVideosBySlug(request, env, corsHeaders) {
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const db = getDb(env)
  const url = new URL(request.url)
  let slug = ''
  try {
    slug = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-2) || '')
  } catch {
    return jsonResponse({ error: 'Invalid slug encoding', code: 'INVALID_SLUG' }, 400, corsHeaders)
  }
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('pageSize') || '50', 10) || 50))
  const offset = (page - 1) * pageSize

  const category = await db.prepare(`
    SELECT id, slug, name, sort_order, direction
    FROM video_categories
    WHERE slug = ?
    LIMIT 1
  `).bind(slug).first()
  if (!category) return jsonResponse({ error: 'Category not found', code: 'category_not_found' }, 404, corsHeaders)

  const sortDirection = category.direction === 'asc' ? 'ASC' : 'DESC'
  const [rows, total] = await Promise.all([
    db.prepare(`
      SELECT v.id, v.title, v.description, v.thumbnail_url, v.full_duration, v.preview_duration, v.upload_date, v.publish_status, v.slug,
             vc.id AS category_id, vc.name AS category_name, vc.slug AS category_slug
      FROM videos v
      INNER JOIN video_category_assignments vca ON vca.video_id = v.id
      INNER JOIN video_categories vc ON vc.id = vca.category_id
      WHERE vc.slug = ? AND v.publish_status = 'published'
      ORDER BY datetime(v.upload_date) ${sortDirection}
      LIMIT ? OFFSET ?
    `).bind(slug, pageSize, offset).all(),
    db.prepare(`
      SELECT COUNT(*) AS total
      FROM videos v
      INNER JOIN video_category_assignments vca ON vca.video_id = v.id
      INNER JOIN video_categories vc ON vc.id = vca.category_id
      WHERE vc.slug = ? AND v.publish_status = 'published'
    `).bind(slug).first(),
  ])

  return jsonResponse({
    category,
    videos: rows?.results ?? [],
    pagination: {
      page,
      pageSize,
      total: Number(total?.total || 0),
      hasMore: page * pageSize < Number(total?.total || 0),
    },
  }, 200, corsHeaders)
}

export async function ensurePillsApiKeySetting(env) {
  const envKey = typeof env.PILLS_API_KEY === 'string' ? env.PILLS_API_KEY.trim() : ''
  if (!envKey) {
    await normalizeStoredPillsApiKeyHash(env)
    return
  }
  const envHash = await hashPillsApiKey(envKey)
  const stored = (await getSetting(env, 'pills_api_key')) ?? ''
  if (String(stored).trim() === envHash) return
  await setSetting(env, 'pills_api_key', envHash)
}

async function getActivePillsApiKeyHash(env) {
  const envKey = typeof env.PILLS_API_KEY === 'string' ? env.PILLS_API_KEY.trim() : ''
  if (envKey) return hashPillsApiKey(envKey)
  const normalizedStored = await normalizeStoredPillsApiKeyHash(env)
  return normalizedStored || ''
}

async function normalizeStoredPillsApiKeyHash(env) {
  const stored = (await getSetting(env, 'pills_api_key')) ?? ''
  const normalized = String(stored).trim()
  if (!normalized) return ''
  if (isHashedPillsApiKey(normalized)) return normalized
  const rehashed = await hashPillsApiKey(normalized)
  await setSetting(env, 'pills_api_key', rehashed)
  return rehashed
}

function isHashedPillsApiKey(value) {
  return typeof value === 'string'
    && (
      value.startsWith(`${PILLS_KEY_HASH_PREFIX}$`)
      || value.startsWith(`${PILLS_KEY_HASH_LEGACY_PREFIX}$`)
    )
}

async function hashPillsApiKey(rawKey) {
  const normalized = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (!normalized) return ''
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  return `${PILLS_KEY_HASH_PREFIX}$${bytesToHex(new Uint8Array(digest))}`
}

export async function hashPillsApiKeyValue(rawKey) {
  return hashPillsApiKey(rawKey)
}

async function verifyPillsApiKeyValue(rawCandidate, storedHash) {
  const candidate = typeof rawCandidate === 'string' ? rawCandidate.trim() : ''
  if (!candidate || !storedHash) return false
  if (storedHash.startsWith(`${PILLS_KEY_HASH_PREFIX}$`)) {
    const expected = await hashPillsApiKey(candidate)
    return timingSafeEqual(new TextEncoder().encode(expected), new TextEncoder().encode(storedHash))
  }
  if (!storedHash.startsWith(`${PILLS_KEY_HASH_LEGACY_PREFIX}$`)) return false
  const parts = storedHash.split('$')
  if (parts.length !== 4) return false
  const iterations = Number.parseInt(parts[1], 10)
  if (!Number.isFinite(iterations) || iterations <= 0) return false
  const salt = hexToBytes(parts[2])
  const expected = hexToBytes(parts[3])
  const derived = new Uint8Array(await derivePbkdf2Sha256(candidate, salt, iterations))
  return timingSafeEqual(derived, expected)
}

async function derivePbkdf2Sha256(value, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(value),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    keyMaterial,
    256,
  )
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex) {
  if (!hex || hex.length % 2 !== 0) return new Uint8Array(0)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function timingSafeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i += 1) mismatch |= (a[i] ^ b[i])
  return mismatch === 0
}

function getPillsKeyFingerprint(keyHash) {
  if (!keyHash || typeof keyHash !== 'string') return 'unknown'
  return keyHash.slice(-12)
}

function buildMaskedKey(keyValue) {
  const suffix = keyValue.slice(-4)
  return `••••••••${suffix}`
}

function parseUsersListQuery(url) {
  const q = url.searchParams
  const page = Math.min(500, Math.max(1, Number.parseInt(q.get('page') || '1', 10) || 1))
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(q.get('pageSize') || '25', 10) || 25))
  const search = typeof q.get('search') === 'string' ? q.get('search').trim().slice(0, 200) : ''
  const role = typeof q.get('role') === 'string' ? q.get('role').trim() : ''
  const subscription = typeof q.get('subscription') === 'string' ? q.get('subscription').trim().toLowerCase() : 'all'
  return { page, pageSize, search, role, subscription }
}

function usersListWhereClause({ search, role, subscription }) {
  const clauses = ['1=1']
  const binds = []
  if (search) {
    const sanitized = search.replace(/%/g, '').replace(/_/g, '').trim()
    if (sanitized) {
      const emailPrefix = `${sanitized}%`
      const idPrefix = `${sanitized}%`
      clauses.push('(u.email LIKE ? OR u.id LIKE ?)')
      binds.push(emailPrefix, idPrefix)
    }
  }
  if (role && role !== 'all') {
    clauses.push('u.role = ?')
    binds.push(role)
  }
  if (subscription && subscription !== 'all') {
    if (subscription === 'none') {
      clauses.push('s.id IS NULL')
    } else {
      clauses.push('s.status = ?')
      binds.push(subscription)
    }
  }
  return { sql: clauses.join(' AND '), binds }
}

export async function handleAdminUsers(request, env, corsHeaders) {
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  const db = getDb(env)
  if (request.method === 'GET') {
    const url = new URL(request.url)
    const { page, pageSize, search, role, subscription } = parseUsersListQuery(url)
    const { sql: whereSql, binds: whereBinds } = usersListWhereClause({ search, role, subscription })
    const offset = (page - 1) * pageSize
    const fromSql = `
      FROM users u
      LEFT JOIN subscriptions s ON s.id = (
        SELECT id FROM subscriptions
        WHERE user_id = u.id
        ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, datetime(created_at) DESC
        LIMIT 1
      )
      WHERE ${whereSql}
    `
    const countStmt = db.prepare(`SELECT COUNT(*) AS n ${fromSql}`)
    const listStmt = db.prepare(`
      SELECT
        u.id, u.email, u.role, u.created_at,
        s.plan_type, s.status AS subscription_status, s.current_period_end
      ${fromSql}
      ORDER BY datetime(u.created_at) DESC
      LIMIT ? OFFSET ?
    `)
    const countRow = await countStmt.bind(...whereBinds).first()
    const total = Number(countRow?.n || 0)
    const rows = await listStmt.bind(...whereBinds, pageSize, offset).all()
    return jsonResponse({
      users: rows?.results ?? [],
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    }, 200, corsHeaders)
  }
  if (request.method !== 'PATCH') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  let actor
  try {
    actor = await requireAuth(request, env)
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  const body = await request.json().catch(() => null)
  const userId = typeof body?.userId === 'string' ? body.userId : ''
  if (!userId) return jsonResponse({ error: 'userId is required' }, 400, corsHeaders)
  const target = await db.prepare('SELECT id, email, role FROM users WHERE id = ?').bind(userId).first()
  if (!target) return jsonResponse({ error: 'User not found', code: 'not_found' }, 404, corsHeaders)
  if (typeof actor.sub !== 'string' || !actor.sub) {
    return jsonResponse({ error: 'Invalid session', code: 'invalid_token' }, 401, corsHeaders)
  }
  const actorUserId = actor.sub
  const actorRole = typeof actor.role === 'string' ? actor.role : 'viewer'

  const wantsRole = typeof body?.role === 'string'
  const wantsSubscription = typeof body?.subscriptionStatus === 'string'
  if (wantsRole && wantsSubscription) {
    return jsonResponse({
      error: 'Send only one of role or subscriptionStatus per request',
      code: 'single_field_patch',
    }, 400, corsHeaders)
  }

  const latest = wantsSubscription
    ? await db.prepare(`
      SELECT id, status FROM subscriptions
      WHERE user_id = ?
      ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, datetime(created_at) DESC
      LIMIT 1
    `).bind(userId).first()
    : null

  if (wantsRole) {
    const newRole = body.role
    const matrix = evaluateRoleChange({
      actorRole,
      targetCurrentRole: target.role,
      newRole,
    })
    if (!matrix.ok) {
      const status = matrix.code === 'invalid_role' ? 400 : 403
      return jsonResponse({ error: matrix.error, code: matrix.code }, status, corsHeaders)
    }
    const selfCheck = evaluateSelfRoleChange({
      actorUserId,
      targetUserId: userId,
      actorRole,
      newRole,
    })
    if (!selfCheck.ok) {
      return jsonResponse({ error: selfCheck.error, code: selfCheck.code }, 403, corsHeaders)
    }
    if (!isValidRoleName(newRole)) {
      return jsonResponse({ error: 'Invalid role', code: 'invalid_role' }, 400, corsHeaders)
    }
    if (newRole === target.role) {
      return jsonResponse({ ok: true }, 200, corsHeaders)
    }
    const statements = [
      db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(newRole, userId),
      buildAdminAuditLogStatement(db, {
        actorUserId,
        actionType: 'user_role_change',
        targetUserId: userId,
        detail: { from: target.role, to: newRole },
      }),
    ]
    try {
      await db.batch(statements)
    } catch (e) {
      console.error('handleAdminUsers batch (role):', e)
      return jsonResponse({ error: 'Update failed', code: 'transaction_failed' }, 500, corsHeaders)
    }
    return jsonResponse({ ok: true }, 200, corsHeaders)
  }

  if (wantsSubscription) {
    if (actorRole === 'admin' && target.role === 'super_admin') {
      return jsonResponse({ error: 'Only super_admin may edit super_admin accounts', code: 'forbidden_target' }, 403, corsHeaders)
    }
    const prevStatus = latest?.status ?? null
    const transition = evaluateSubscriptionStatusChange(prevStatus, body.subscriptionStatus)
    if (!transition.ok) {
      return jsonResponse({ error: transition.error, code: transition.code }, 400, corsHeaders)
    }
    const prevNormalized = prevStatus == null || prevStatus === '' ? 'none' : prevStatus
    const nextPersisted = transition.next === 'none' ? 'cancelled' : transition.next
    if (nextPersisted === prevNormalized) {
      return jsonResponse({ ok: true }, 200, corsHeaders)
    }
    if (transition.next === 'none') {
      if (!latest?.id) {
        return jsonResponse({ error: 'User has no subscription to cancel', code: 'no_subscription' }, 400, corsHeaders)
      }
      const statements = [
        db.prepare(`
          UPDATE subscriptions SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).bind(latest.id),
        buildAdminAuditLogStatement(db, {
          actorUserId,
          actionType: 'subscription_status_change',
          targetUserId: userId,
          detail: { from: prevStatus ?? 'none', to: 'cancelled' },
        }),
      ]
      try {
        await db.batch(statements)
      } catch (e) {
        console.error('handleAdminUsers batch (subscription cancel):', e)
        return jsonResponse({ error: 'Update failed', code: 'transaction_failed' }, 500, corsHeaders)
      }
      return jsonResponse({ ok: true }, 200, corsHeaders)
    }
    if (!latest?.id) {
      return jsonResponse({ error: 'User has no subscription row to update', code: 'no_subscription' }, 400, corsHeaders)
    }
    const statements = [
      db.prepare(`
        UPDATE subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(transition.next, latest.id),
      buildAdminAuditLogStatement(db, {
        actorUserId,
        actionType: 'subscription_status_change',
        targetUserId: userId,
        detail: { from: prevStatus ?? 'none', to: transition.next },
      }),
    ]
    try {
      await db.batch(statements)
    } catch (e) {
      console.error('handleAdminUsers batch (subscription):', e)
      return jsonResponse({ error: 'Update failed', code: 'transaction_failed' }, 500, corsHeaders)
    }
    return jsonResponse({ ok: true }, 200, corsHeaders)
  }

  return jsonResponse({ error: 'role or subscriptionStatus is required' }, 400, corsHeaders)
}

export async function handleAdminAnalytics(request, env, corsHeaders) {
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const db = getDb(env)
  const [views, sourceRows, retentionRows, subsRows] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM video_segment_events WHERE event_type = 'segment'`).first(),
    db.prepare(`
      SELECT COALESCE(source_host, 'direct') AS source, COUNT(*) AS hits
      FROM video_segment_events
      GROUP BY source
      ORDER BY hits DESC
      LIMIT 12
    `).all(),
    db.prepare(`
      SELECT video_id, CAST(AVG(position_seconds) AS INTEGER) AS avg_position, COUNT(*) AS hits
      FROM video_segment_events
      WHERE position_seconds IS NOT NULL
      GROUP BY video_id
      ORDER BY hits DESC
      LIMIT 20
    `).all(),
    db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM subscriptions
      GROUP BY status
    `).all(),
  ])
  return jsonResponse({
    totalViews: Number(views?.total || 0),
    trafficSources: sourceRows?.results ?? [],
    retention: retentionRows?.results ?? [],
    subscriptions: subsRows?.results ?? [],
  }, 200, corsHeaders)
}

export async function logSegmentEvent(env, payload) {
  const db = getDb(env)
  const requestPath = typeof payload?.requestPath === 'string' ? payload.requestPath : ''
  const eventType = typeof payload?.eventType === 'string' ? payload.eventType : 'segment'
  if (!requestPath) return
  await db.prepare(`
    INSERT INTO video_segment_events (
      id, video_id, user_id, request_path, event_type, position_seconds, referer, source_host, ip_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(
    crypto.randomUUID(),
    payload.videoId || 'unknown',
    payload.userId || null,
    requestPath,
    eventType,
    Number.isFinite(payload.segmentIndex) ? payload.segmentIndex : null,
    payload.referer || null,
    payload.sourceHost || null,
    payload.ipHash || null,
  ).run()
}
