import { requireAuth, requireRole } from './auth.js'
import { getSetting, setSetting, setSettings } from './settingsStore.js'

function getDb(env) {
  const db = env.DB || env.video_subscription_db
  if (!db) throw new Error('D1 binding not found')
  return db
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
  const db = getDb(env)
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
  const rateLimit = await checkPillsUpdateRateLimit(request, env)
  if (rateLimit.limited) {
    return new Response(JSON.stringify({
      error: 'Too many pills update requests',
      code: 'rate_limited',
    }, null, 2), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(rateLimit.retryAfterSeconds),
        ...corsHeaders,
      },
    })
  }
  const storedKey = await getSetting(env, 'pills_api_key')
  const envKey = typeof env.PILLS_API_KEY === 'string' ? env.PILLS_API_KEY.trim() : ''
  const expected = envKey || (typeof storedKey === 'string' ? storedKey.trim() : '')
  const provided = request.headers.get('x-api-key') || ''
  if (!expected || provided !== expected) {
    return jsonResponse({ error: 'Unauthorized', code: 'invalid_api_key' }, 401, corsHeaders)
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

async function checkPillsUpdateRateLimit(request, env) {
  const kv = env.RATE_LIMIT_KV || null
  if (!kv) return { limited: false, retryAfterSeconds: 0 }

  const configured = Number.parseInt(
    String(await getSetting(env, 'pills_update_rate_limit_per_minute', { defaultValue: '30' }) ?? '30'),
    10,
  )
  const perMinuteLimit = Number.isFinite(configured) && configured > 0 ? configured : 30
  const minute = Math.floor(Date.now() / 60000)
  const sourceIp = extractClientIp(request)
  const apiKey = request.headers.get('x-api-key') || 'missing'
  const rateKey = `pillsupd:${sourceIp}:${apiKey.slice(0, 12)}:${minute}`
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
  const stored = (await getSetting(env, 'pills_api_key')) ?? ''
  const active = envKey || String(stored)

  if (request.method === 'GET') {
    return jsonResponse({
      hasKey: Boolean(active),
      managedByEnv: Boolean(envKey),
      maskedKey: active ? `••••••••${active.slice(-4)}` : '',
    }, 200, corsHeaders)
  }
  if (request.method !== 'PATCH') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  if (envKey) {
    return jsonResponse({ error: 'PILLS_API_KEY is managed by environment secret' }, 409, corsHeaders)
  }
  const body = await request.json().catch(() => null)
  const nextKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!nextKey) return jsonResponse({ error: 'apiKey is required' }, 400, corsHeaders)
  await setSetting(env, 'pills_api_key', nextKey)
  return jsonResponse({ ok: true, hasKey: true, maskedKey: `••••••••${nextKey.slice(-4)}` }, 200, corsHeaders)
}

export async function handleCategoryVideosBySlug(request, env, corsHeaders) {
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const db = getDb(env)
  const url = new URL(request.url)
  const slug = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-2) || '')
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

  const [rows, total] = await Promise.all([
    db.prepare(`
      SELECT v.id, v.title, v.description, v.thumbnail_url, v.full_duration, v.preview_duration, v.upload_date, v.publish_status, v.slug,
             vc.id AS category_id, vc.name AS category_name, vc.slug AS category_slug
      FROM videos v
      INNER JOIN video_category_assignments vca ON vca.video_id = v.id
      INNER JOIN video_categories vc ON vc.id = vca.category_id
      WHERE vc.slug = ? AND v.publish_status = 'published'
      ORDER BY datetime(v.upload_date) DESC
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
  if (!envKey) return
  const stored = await getSetting(env, 'pills_api_key')
  if ((stored ?? '').trim() === envKey) return
  await setSetting(env, 'pills_api_key', envKey)
}

export async function handleAdminUsers(request, env, corsHeaders) {
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  const db = getDb(env)
  if (request.method === 'GET') {
    const rows = await db.prepare(`
      SELECT
        u.id, u.email, u.role, u.created_at,
        s.plan_type, s.status AS subscription_status, s.current_period_end
      FROM users u
      LEFT JOIN (
        SELECT user_id, plan_type, status, current_period_end
        FROM subscriptions
        ORDER BY datetime(updated_at) DESC
      ) s ON s.user_id = u.id
      GROUP BY u.id
      ORDER BY datetime(u.created_at) DESC
    `).all()
    return jsonResponse({ users: rows?.results ?? [] }, 200, corsHeaders)
  }
  if (request.method !== 'PATCH') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const currentUser = await requireAuth(request, env).catch(() => null)
  const body = await request.json().catch(() => null)
  const userId = typeof body?.userId === 'string' ? body.userId : ''
  if (!userId) return jsonResponse({ error: 'userId is required' }, 400, corsHeaders)
  if (typeof body?.role === 'string') {
    if (body.role === 'super_admin' && currentUser?.role !== 'super_admin') {
      return jsonResponse({ error: 'Only super_admin can assign super_admin role' }, 403, corsHeaders)
    }
    await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role, userId).run()
  }
  if (typeof body?.subscriptionStatus === 'string') {
    const nextStatus = body.subscriptionStatus === 'none' ? null : body.subscriptionStatus
    if (nextStatus === null) {
      await db.prepare(`
        UPDATE subscriptions
        SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE id = (
          SELECT id FROM subscriptions
          WHERE user_id = ?
          ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
          LIMIT 1
        )
      `).bind(userId).run()
    } else {
      await db.prepare(`
        UPDATE subscriptions
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = (
          SELECT id FROM subscriptions
          WHERE user_id = ?
          ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
          LIMIT 1
        )
      `).bind(nextStatus, userId).run()
    }
  }
  return jsonResponse({ ok: true }, 200, corsHeaders)
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
