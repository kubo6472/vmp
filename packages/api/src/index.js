/**
 * packages/api/src/index.js
 *
 * Main Cloudflare Worker entry point.
 * Auth routes added; CORS updated to support credentials (required for
 * the HttpOnly refresh-token cookie to be sent cross-origin).
 */

import {
  handleRequestMagicLink,
  handleVerifyMagicLink,
  handleRefreshToken,
  handleLogout,
  handleGetMe,
  handleTotpSetup,
  handleTotpConfirm,
  handleTotpVerify,
  requireAuth,
  requireRole,
} from './auth.js'
import { checkAnonymousRateLimit } from './rateLimit.js'
import {
  handleGetPricing,
  handleCheckout,
  handleWebhook,
  handleGetSubscription,
  handlePortal,
} from './stripe.js'

// ─── Durable Object for atomic segment rate limiting (Step 4c) ───────────────
//
// IMPORTANT: Add this binding to wrangler.toml:
// [[durable_objects.bindings]]
// name = "SEGMENT_RATE_LIMITER"
// class_name = "SegmentRateLimiterDO"
// script_name = "api" # or your worker name

export class SegmentRateLimiterDO {
  constructor(state, env) {
    this.state = state
    this.env = env
  }

  async fetch(request) {
    const body = await request.json()
    const { identifier, videoId, avgSegDur } = body

    const segDur = avgSegDur ?? 6 // default 6-second segments
    const threshold = Math.ceil(60 / segDur) * 3

    const minute = Math.floor(Date.now() / 60000)
    const countKey = `${identifier}:${videoId}:${minute}`

    // Atomically increment the count
    let count = (await this.state.storage.get(countKey)) || 0
    count += 1
    await this.state.storage.put(countKey, count)

    // Schedule cleanup of old keys (after 2 minutes) using alarm API
    // Store the countKey so the alarm handler knows what to delete
    await this.state.storage.put('pendingCleanupKey', countKey)
    await this.state.storage.setAlarm(Date.now() + 120000)

    const exceeded = count > threshold

    return new Response(JSON.stringify({ count, threshold, exceeded }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async alarm() {
    // Alarm handler - cleanup expired count keys
    const countKey = await this.state.storage.get('pendingCleanupKey')
    if (countKey) {
      await this.state.storage.delete(countKey)
      await this.state.storage.delete('pendingCleanupKey')
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // ── CORS ──────────────────────────────────────────────────────────────────
    //
    // When a request includes credentials (cookies), the browser requires:
    //   1. Access-Control-Allow-Origin must be a specific origin, never "*"
    //   2. Access-Control-Allow-Credentials: true
    //
    // We maintain an allowlist of origins in the ALLOWED_ORIGINS env var
    // (comma-separated).  If the request origin is in the list we reflect it
    // back.  Unknown origins get a non-credentialed response, which is fine
    // for public endpoints like /api/videos.
    const corsHeaders = buildCorsHeaders(request, env)

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    // ── Auth routes ───────────────────────────────────────────────────────────
    if (url.pathname === '/api/auth/magic-link' && request.method === 'POST') {
      return handleRequestMagicLink(request, env, corsHeaders)
    }
    if (url.pathname === '/api/auth/verify' && request.method === 'GET') {
      return handleVerifyMagicLink(request, env, corsHeaders)
    }
    if (url.pathname === '/api/auth/refresh' && request.method === 'POST') {
      return handleRefreshToken(request, env, corsHeaders)
    }
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      return handleLogout(request, env, corsHeaders)
    }
    if (url.pathname === '/api/auth/me' && request.method === 'GET') {
      return handleGetMe(request, env, corsHeaders)
    }
    if (url.pathname === '/api/auth/2fa/setup' && request.method === 'GET') {
      return handleTotpSetup(request, env, corsHeaders)
    }
    if (url.pathname === '/api/auth/2fa/confirm' && request.method === 'POST') {
      return handleTotpConfirm(request, env, corsHeaders)
    }
    if (url.pathname === '/api/auth/2fa/verify' && request.method === 'POST') {
      return handleTotpVerify(request, env, corsHeaders)
    }

    // ── Existing routes ───────────────────────────────────────────────────────
    if (url.pathname === '/api/videos') {
      return handleVideosList(request, env, corsHeaders)
    }
    if (url.pathname.startsWith('/api/video-access/')) {
      return handleVideoAccess(request, env, corsHeaders)
    }
    if (url.pathname.startsWith('/api/video-proxy/')) {
      return handleVideoProxy(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/bootstrap' && request.method === 'POST') {
      return handleBootstrap(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/config') {
      return handleAdminConfig(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/preview-locks') {
      return handlePreviewLocks(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/videos') {
      return handleAdminVideosList(request, env, corsHeaders)
    }
    if (url.pathname.startsWith('/api/admin/videos/') && request.method === 'PATCH') {
      return handleAdminVideoUpdate(request, env, corsHeaders)
    }
    if (url.pathname === '/api/account/pricing' && request.method === 'GET') {
      return handleGetPricing(request, env, corsHeaders)
    }
    if (url.pathname === '/api/payments/checkout' && request.method === 'POST') {
      return handleCheckout(request, env, corsHeaders)
    }
    if (url.pathname === '/api/payments/webhook' && request.method === 'POST') {
      return handleWebhook(request, env, corsHeaders)
    }
    if (url.pathname === '/api/account/subscription' && request.method === 'GET') {
      return handleGetSubscription(request, env, corsHeaders)
    }
    if (url.pathname === '/api/payments/portal' && request.method === 'POST') {
      return handlePortal(request, env, corsHeaders)
    }
    if (url.pathname === '/api/health') {
      return jsonResponse({ status: 'healthy' }, 200, corsHeaders)
    }

    return jsonResponse({ error: 'Not Found' }, 404, corsHeaders)
  },
}

// ─── CORS helpers ─────────────────────────────────────────────────────────────

function buildCorsHeaders(request, env) {
  const requestOrigin  = request.headers.get('Origin') || ''
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS)

  if (allowedOrigins.includes(requestOrigin)) {
    // Credentialed CORS — required for the cookie to be sent/received
    return {
      'Access-Control-Allow-Origin':      requestOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Expose-Headers':    'Accept-Ranges, Content-Length, Content-Range, Content-Type',
      'Vary':                              'Origin',
    }
  }

  // Public CORS — no credentials, matches any origin (e.g. curl, public consumers)
  return {
    'Access-Control-Allow-Origin':   '*',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type',
  }
}

function parseAllowedOrigins(envValue) {
  if (!envValue) return []
  return envValue.split(',').map(o => o.trim()).filter(Boolean)
}

// ─── Existing handler implementations (unchanged) ─────────────────────────────

async function handleVideosList(request, env, corsHeaders) {
  try {
    const db = getDatabaseBinding(env)

    // Editors and above see all statuses; everyone else only sees published videos.
    let isEditor = false
    try {
      await requireRole(request, env, 'editor', 'admin', 'super_admin')
      isEditor = true
    } catch {
      isEditor = false
    }

    const query = isEditor
      ? `SELECT id, title, description, thumbnail_url, full_duration, preview_duration, upload_date, publish_status
         FROM videos
         ORDER BY upload_date DESC`
      : `SELECT id, title, description, thumbnail_url, full_duration, preview_duration, upload_date, publish_status
         FROM videos
         WHERE publish_status = 'published'
         ORDER BY upload_date DESC`

    const videos = await db.prepare(query).all()
    return jsonResponse({ videos: videos.results || [] }, 200, corsHeaders)
  } catch (error) {
    console.error('Error:', error)
    return jsonResponse({ error: 'Internal server error', details: error.message }, 500, corsHeaders)
  }
}

async function handleVideoAccess(request, env, corsHeaders) {
  try {
    const url = new URL(request.url)
    const pathParts = url.pathname.split('/').filter(Boolean)

    // Supports both:
    //   /api/video-access/{videoId}                 (preferred; user from JWT)
    //   /api/video-access/{userId}/{videoId}        (legacy fallback)
    let legacyUserId = null
    let requestedVideoId = null

    if (pathParts.length === 3) {
      requestedVideoId = decodeURIComponent(pathParts[2] ?? '')
    } else if (pathParts.length === 4) {
      legacyUserId = pathParts[2]
      requestedVideoId = decodeURIComponent(pathParts[3] ?? '')
    } else {
      return jsonResponse({ error: 'Invalid path format. Expected: /api/video-access/{videoId}' }, 400, corsHeaders)
    }

    const videoId = normalizeVideoId(requestedVideoId)

    let authUser = null
    try {
      authUser = await requireAuth(request, env)
    } catch {
      authUser = null
    }

    const userId = authUser?.sub ?? legacyUserId

    // ── Anonymous rate limiting ────────────────────────────────────────────────
    // Only applied when there is no authenticated user (anonymous viewer).
    // Logged-in users — even on the free plan — are never rate-limited here.
    const isAnonymous = !authUser && (!userId || userId === 'anonymous')
    if (isAnonymous) {
      const rateLimitResult = await checkAnonymousRateLimit(request, env)
      if (rateLimitResult?.limited) {
        return new Response(
          JSON.stringify({
            error: 'rate_limit_exceeded',
            retryAfter: rateLimitResult.retryAfter,
            loginPrompt: true,
            current: rateLimitResult.current,
            limit: rateLimitResult.limit,
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(rateLimitResult.retryAfter),
              ...corsHeaders,
            },
          }
        )
      }
    }
    const db = getDatabaseBinding(env)

    const subscription = userId
      ? await db.prepare(`
          SELECT * FROM subscriptions
          WHERE user_id = ? AND status IN ('active', 'trialing')
            AND (current_period_end IS NULL OR datetime(current_period_end) > CURRENT_TIMESTAMP)
          ORDER BY created_at DESC
          LIMIT 1
        `).bind(userId).first()
      : null

    const video = await db.prepare('SELECT * FROM videos WHERE id = ?').bind(videoId).first()
    const hasElevatedRole = ['editor', 'admin', 'super_admin'].includes(authUser?.role ?? '')
    // Any active monthly/yearly/club subscription grants full access
    const hasPremiumSubscription = Boolean(subscription)
    const hasPremiumAccess = hasElevatedRole || hasPremiumSubscription

    const hasVideoMetadata = Boolean(video)
    const hasAccess = hasPremiumAccess || !hasVideoMetadata
    const requestedProtocol = normalizeProtocolOption(url.searchParams.get('protocol')) ?? 'hls'
    const resolvedEntrypointUrl = await resolveMediaEntrypointUrl({ env, videoId, hasPremiumAccess: true, protocol: requestedProtocol })
    const previewDuration = video?.preview_duration ?? video?.full_duration ?? 0
    const basePlaylistUrl = buildProxyPlaylistUrl(request, resolvedEntrypointUrl, hasPremiumAccess ? null : previewDuration, requestedProtocol)
    const fullDuration = video?.full_duration ?? previewDuration

    // Sign the playlist URL with a short-lived video token so the proxy can
    // authenticate every subsequent manifest and segment request.
    const effectiveUserId = authUser?.sub ?? userId ?? 'anonymous'
    let playlistUrl = basePlaylistUrl
    if (env.JWT_SECRET) {
      const vt = await signVideoToken(effectiveUserId, videoId, env.JWT_SECRET, hasPremiumAccess ? null : previewDuration)
      playlistUrl = basePlaylistUrl.includes('?')
        ? `${basePlaylistUrl}&vt=${vt}`
        : `${basePlaylistUrl}?vt=${vt}`
    }

    const response = {
      userId: userId ?? null,
      videoId,
      hasAccess,
      subscription: {
        planType: subscription ? subscription.plan_type : 'free',
        status: subscription ? subscription.status : 'none',
        expiresAt: subscription ? subscription.current_period_end : null,
      },
      video: { title: video?.title ?? `Uploaded Video ${videoId}`, fullDuration, previewDuration, playlistUrl },
      chapters: [
        { title: 'Preview', startTime: 0, endTime: previewDuration, accessible: true },
        { title: 'Full Content', startTime: previewDuration, endTime: fullDuration, accessible: hasAccess },
      ],
    }
    return jsonResponse(response, 200, corsHeaders)
  } catch (error) {
    console.error('Error:', error)
    return jsonResponse({ error: 'Internal server error', details: error.message }, 500, corsHeaders)
  }
}

async function handleVideoProxy(request, env, corsHeaders) {
  const requestUrl = new URL(request.url)
  const proxyPrefix = '/api/video-proxy/'
  const objectPath = requestUrl.pathname.slice(proxyPrefix.length)
  const requestedProtocol = normalizeProtocolOption(requestUrl.searchParams.get('protocol'))
  const previewUntil = Number.parseFloat(requestUrl.searchParams.get('previewUntil') ?? '')
  const previewUntilSeconds = Number.isFinite(previewUntil) && previewUntil > 0 ? previewUntil : null
  if (!objectPath) return jsonResponse({ error: 'Missing proxied object path' }, 400, corsHeaders)
  const allowedPrefix = ['videos/', 'preview/', 'full/']
  if (!allowedPrefix.some(p => objectPath.startsWith(p))) return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders)

  // ── Step 4a: Validate the signed video token ──────────────────────────────
  // Every proxy request must carry a valid short-lived HMAC token issued by
  // handleVideoAccess.  This prevents direct enumeration / bulk downloading of
  // R2 segment URLs without going through the access-control layer.
  let tokenClaims = null
  if (env.JWT_SECRET) {
    const vtParam = requestUrl.searchParams.get('vt')
    if (!vtParam) {
      return new Response(JSON.stringify({ error: 'Missing video token' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }
    try {
      tokenClaims = await verifyVideoToken(vtParam, env.JWT_SECRET)
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid or expired video token' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }
  }

  // Extract videoId from path (videos/{id}/... or preview/{id}/... or full/{id}/...)
  const pathParts = objectPath.split('/')
  const proxyVideoId = pathParts[1] ?? ''

  // Verify token claims match the requested video
  if (tokenClaims && tokenClaims.videoId !== proxyVideoId) {
    return new Response(JSON.stringify({ error: 'Video token does not match requested video' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }

  // Enforce previewUntil from token claims
  let effectivePreviewUntil = previewUntilSeconds
  if (tokenClaims && tokenClaims.previewUntil !== null && tokenClaims.previewUntil !== undefined) {
    // Token has a preview limit - enforce it
    effectivePreviewUntil = tokenClaims.previewUntil
  } else if (tokenClaims && (tokenClaims.previewUntil === null || tokenClaims.previewUntil === undefined)) {
    // Token grants full access (no preview limit)
    effectivePreviewUntil = null
  }

  // Strip vt from the upstream URL — R2 doesn't need it
  const upstreamUrl = new URL(`${env.R2_BASE_URL}/${objectPath}`)
  const upstreamHeaders = new Headers()
  const rangeHeader = request.headers.get('Range')
  if (rangeHeader) upstreamHeaders.set('Range', rangeHeader)

  // vt to propagate to rewritten manifest/segment URLs
  const vtForRewrite = requestUrl.searchParams.get('vt') ?? null

  const isSegment = objectPath.endsWith('.ts') || objectPath.endsWith('.m4s')

  // ── Step 4c: Segment count rate limiting ─────────────────────────────────
  if (isSegment && env.RATE_LIMIT_KV) {
    let authUser = null
    try { authUser = await requireAuth(request, env) } catch { /* anonymous */ }
    const identifier = authUser?.sub ?? request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const avgDur = await getAvgSegmentDuration(proxyVideoId, env)
    const limited = await checkSegmentRateLimit(identifier, proxyVideoId, avgDur, env)
    if (limited) {
      return new Response(JSON.stringify({ error: 'Too many segment requests. Slow down.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '30', ...corsHeaders },
      })
    }
  }

  const upstreamResponse = await fetch(upstreamUrl, { method: request.method, headers: upstreamHeaders })

  const manifestType = getManifestType(objectPath, upstreamResponse, requestedProtocol)
  if (manifestType === 'hls') {
    const manifest = await upstreamResponse.text()
    const rewrittenManifest = rewriteManifestForProxyWithPreview(manifest, effectivePreviewUntil, objectPath, vtForRewrite)
    const headers = new Headers(upstreamResponse.headers)
    headers.set('Content-Type', 'application/vnd.apple.mpegurl')
    headers.delete('Content-Length')
    for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v)
    return new Response(rewrittenManifest, { status: upstreamResponse.status, headers })
  }
  if (manifestType === 'dash') {
    if (effectivePreviewUntil !== null) return jsonResponse({ error: 'Preview lock not supported for DASH' }, 501, corsHeaders)
    const manifest = await upstreamResponse.text()
    const rewrittenManifest = rewriteDashManifestForProxy(manifest, vtForRewrite)
    const headers = new Headers(upstreamResponse.headers)
    headers.set('Content-Type', 'application/dash+xml')
    headers.delete('Content-Length')
    for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v)
    return new Response(rewrittenManifest, { status: upstreamResponse.status, headers })
  }

  const headers = new Headers(upstreamResponse.headers)
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v)
  return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers })
}

async function handleBootstrap(request, env, corsHeaders) {
  const body = await request.json().catch(() => null)
  if (!body?.email || typeof body.email !== 'string') {
    return jsonResponse({ error: 'email is required' }, 400, corsHeaders)
  }
  const email = body.email.toLowerCase().trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: 'Invalid email format' }, 400, corsHeaders)
  }

  const db = getDatabaseBinding(env)

  // Guard: only allow bootstrap when no super_admin exists
  const existingAdmin = await db
    .prepare("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1")
    .first()
  if (existingAdmin) {
    return jsonResponse({ error: 'Bootstrap already completed — a super_admin already exists.' }, 409, corsHeaders)
  }

  // Upsert: promote existing user or create new one
  const existingUser = await db
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first()
  if (existingUser) {
    await db
      .prepare("UPDATE users SET role = 'super_admin' WHERE id = ?")
      .bind(existingUser.id)
      .run()
  } else {
    await db
      .prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'super_admin')")
      .bind(crypto.randomUUID(), email)
      .run()
  }

  return jsonResponse({ ok: true, message: `${email} is now super_admin. Sign in via magic link to access admin features.` }, 200, corsHeaders)
}

async function handleAdminConfig(request, env, corsHeaders) {
  const db = getDatabaseBinding(env)
  await ensureAdminSettingsTable(db)

  if (request.method === 'GET') {
    const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ? LIMIT 1').bind('homepage').first()
    const value = safeJsonParse(row?.value, defaultHomepageConfig())
    return jsonResponse({ config: value }, 200, corsHeaders)
  }

  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch (error) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const body = await request.json().catch(() => null)
  if (!body?.config || typeof body.config !== 'object') return jsonResponse({ error: 'config object is required' }, 400, corsHeaders)
  const normalized = normalizeHomepageConfig(body.config)
  await db.prepare(`INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind('homepage', JSON.stringify(normalized)).run()
  return jsonResponse({ ok: true, config: normalized }, 200, corsHeaders)
}

async function handlePreviewLocks(request, env, corsHeaders) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch (error) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const body = await request.json().catch(() => null)
  if (!Array.isArray(body?.locks)) return jsonResponse({ error: 'locks array is required' }, 400, corsHeaders)
  const db = getDatabaseBinding(env)
  for (const lockEntry of body.locks) {
    if (!lockEntry || typeof lockEntry.videoId !== 'string') continue
    const lockSeconds = Number.parseInt(lockEntry.previewDuration, 10)
    if (!Number.isFinite(lockSeconds) || lockSeconds < 0) continue
    // When full_duration = 0 (unprocessed draft), MIN would clamp preview to 0.
    // Treat 0 as "unknown duration" and store the requested value as-is.
    await db.prepare(`
      UPDATE videos
      SET preview_duration = CASE WHEN full_duration = 0 THEN ? ELSE MIN(full_duration, ?) END
      WHERE id = ?
    `).bind(lockSeconds, lockSeconds, lockEntry.videoId).run()
  }
  return jsonResponse({ ok: true }, 200, corsHeaders)
}

async function handleAdminVideosList(request, env, corsHeaders) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const db = getDatabaseBinding(env)
  try {
    // ── 1. Auto-register any R2 uploads that have no D1 row ──────────────────
    if (env.BUCKET) {
      const listed = await env.BUCKET.list({ prefix: 'videos/', delimiter: '/' })
      const r2VideoIds = (listed.delimitedPrefixes ?? []).map(prefix => {
        // prefix looks like "videos/abc123/" — extract the folder name
        const parts = prefix.replace(/\/$/, '').split('/')
        return parts[parts.length - 1]
      }).filter(Boolean)

      // ── 1b. Remove D1 rows for videos whose R2 folder no longer exists ────────
      const r2VideoIdSet = new Set(r2VideoIds)
      const allD1Rows = await db.prepare('SELECT id FROM videos').all()
      for (const { id } of (allD1Rows.results || [])) {
        if (!r2VideoIdSet.has(id)) {
          await db.prepare('DELETE FROM videos WHERE id = ?').bind(id).run()
        }
      }

      for (const r2Id of r2VideoIds) {
        // Register every R2 video folder as a draft regardless of whether
        // processed artifacts exist yet — source-only and mid-processing
        // videos should still appear in the admin list.
        await db.prepare(`
          INSERT OR IGNORE INTO videos (id, title, publish_status, upload_date, full_duration, preview_duration)
          VALUES (?, 'Untitled upload', 'draft', CURRENT_TIMESTAMP, 0, 0)
        `).bind(r2Id).run()
      }
    }

    // ── 2. Fetch all videos from D1 ──────────────────────────────────────────
    const videos = await db.prepare(`
      SELECT id, title, description, thumbnail_url, full_duration, preview_duration,
             upload_date, visibility, status, publish_status, published_at, updated_at
      FROM videos
      ORDER BY upload_date DESC
    `).all()

    // ── 3. Annotate each row with r2_exists ──────────────────────────────────
    const annotated = await Promise.all((videos.results || []).map(async (video) => {
      let r2Exists = null
      if (env.BUCKET) {
        r2Exists = await hasProcessedPlaybackArtifact(env.BUCKET, video.id)
      }
      return { ...video, r2_exists: r2Exists }
    }))

    return jsonResponse({ videos: annotated }, 200, corsHeaders)
  } catch (error) {
    console.error('Error:', error)
    return jsonResponse({ error: 'Internal server error', details: error.message }, 500, corsHeaders)
  }
}

async function handleAdminVideoUpdate(request, env, corsHeaders) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const url = new URL(request.url)
  const pathParts = url.pathname.split('/').filter(Boolean)
  const videoId = pathParts[3] // /api/admin/videos/{videoId}
  if (!videoId) return jsonResponse({ error: 'Missing videoId' }, 400, corsHeaders)

  const body = await request.json().catch(() => null)
  if (!body) return jsonResponse({ error: 'Request body is required' }, 400, corsHeaders)

  const allowedStatuses = ['draft', 'published', 'archived']
  const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status')
  const hasTitle  = Object.prototype.hasOwnProperty.call(body, 'title')

  if (!hasStatus && !hasTitle) {
    return jsonResponse({ error: 'At least one of status or title must be provided' }, 400, corsHeaders)
  }
  if (hasTitle && (typeof body.title !== 'string' || body.title.trim().length === 0)) {
    return jsonResponse({ error: 'title must not be empty' }, 400, corsHeaders)
  }
  if (hasStatus && !allowedStatuses.includes(body.status)) {
    return jsonResponse({ error: 'status must be one of: draft, published, archived' }, 400, corsHeaders)
  }

  // Guard: refuse to publish if the processed playlist is missing from R2.
  if (hasStatus && body.status === 'published' && env.BUCKET) {
    const exists = await hasProcessedPlaybackArtifact(env.BUCKET, videoId)
    if (!exists) {
      return jsonResponse({
        error: 'Cannot publish: processed media not found in R2. Upload and process the video first.',
        code: 'r2_missing',
      }, 422, corsHeaders)
    }
  }

  // Map publish_status to visibility so both stay in sync:
  //   published  → visibility=public  (appears on homepage)
  //   draft      → visibility=private (hidden from homepage)
  //   archived   → visibility=unlisted (hidden but URL still works for editors)
  const visibilityMap = { published: 'public', draft: 'private', archived: 'unlisted' }

  const db = getDatabaseBinding(env)
  try {
    if (hasTitle) {
      await db.prepare(`UPDATE videos SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(body.title.trim(), videoId).run()
    }

    if (hasStatus) {
      if (body.status === 'published') {
        // Stamp published_at only on first publish; preserve it on re-publish
        await db.prepare(`
          UPDATE videos
          SET publish_status = 'published',
              visibility = 'public',
              published_at = COALESCE(published_at, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(videoId).run()
      } else {
        await db.prepare(`
          UPDATE videos
          SET publish_status = ?,
              visibility = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(body.status, visibilityMap[body.status], videoId).run()
      }
    }

    const video = await db.prepare(`
      SELECT id, title, visibility, status, publish_status, published_at, updated_at
      FROM videos WHERE id = ?
    `).bind(videoId).first()
    if (!video) return jsonResponse({ error: 'Video not found' }, 404, corsHeaders)
    return jsonResponse({ ok: true, video }, 200, corsHeaders)
  } catch (error) {
    console.error('Error:', error)
    return jsonResponse({ error: 'Internal server error', details: error.message }, 500, corsHeaders)
  }
}

async function hasProcessedPlaybackArtifact(bucket, videoId) {
  const candidateKeys = [
    // Flat layout produced by the current upload script (rclone copies TMP_DIR
    // directly into videos/{id}/ with no processed/ subdirectory)
    `videos/${videoId}/master.m3u8`,
    `videos/${videoId}/manifest.mpd`,
    // Legacy / processed-subdirectory layouts kept for backwards compatibility
    `videos/${videoId}/processed/playlist.m3u8`,
    `videos/${videoId}/processed/hls/master.m3u8`,
    `videos/${videoId}/processed/dash/manifest.mpd`,
  ]

  for (const key of candidateKeys) {
    const object = await bucket.head(key)
    if (object) return true
  }
  return false
}

// ─── All the unchanged helper functions from the original index.js ─────────────

function getManifestType(objectPath, upstreamResponse, requestedProtocol) {
  if (objectPath.endsWith('.m3u8')) return 'hls'
  if (objectPath.endsWith('.mpd')) return 'dash'
  const ct = upstreamResponse.headers.get('content-type') ?? ''
  if (/application\/dash\+xml/i.test(ct)) return 'dash'
  if (/application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl/i.test(ct)) return 'hls'
  return requestedProtocol
}

function rewriteManifestForProxyWithPreview(manifest, previewUntilSeconds, objectPath = '', vt = null) {
  const lines = manifest.split('\n')
  const hasPreviewLimit = typeof previewUntilSeconds === 'number' && previewUntilSeconds > 0
  const isMediaPlaylist = lines.some(l => l.trim().startsWith('#EXTINF:'))
  const isMasterPlaylist = lines.some(l => l.trim().startsWith('#EXT-X-STREAM-INF'))
  const previewQuery = hasPreviewLimit ? `previewUntil=${Math.floor(previewUntilSeconds)}` : null

  // Build extra query params to append to every URL: vt (required) + previewUntil (optional)
  function buildExtraQuery(includePreview) {
    const parts = []
    if (includePreview && previewQuery) parts.push(previewQuery)
    if (vt) parts.push(`vt=${vt}`)
    return parts.length ? parts.join('&') : null
  }

  // Base directory of the manifest in the proxy URL space, e.g. "videos/abc/".
  // Used to resolve relative paths in master playlists so that previewUntil
  // can be propagated to variant playlist requests.
  const manifestDir = objectPath.includes('/') ? objectPath.slice(0, objectPath.lastIndexOf('/') + 1) : ''

  // Resolve segment paths relative to this manifest's directory so that bare
  // filenames (e.g. "seg_1080_1.m4s", "init_1080.mp4") emitted by shaka-packager
  // are routed through the proxy with the vt token intact.
  function proxySegmentPath(path, query) {
    return rewriteSegmentPath(path, query, manifestDir)
  }

  // Helper to rewrite URLs in HLS tag attributes
  function rewriteTagAttributes(line, query) {
    // Handle #EXT-X-MAP:URI="..."
    line = line.replace(/(#EXT-X-MAP:[^"'\n]*URI=["'])([^"']+)(["'])/gi, (match, prefix, url, suffix) => {
      return prefix + proxySegmentPath(url, query) + suffix
    })
    // Handle #EXT-X-KEY:URI="..."
    line = line.replace(/(#EXT-X-KEY:[^"'\n]*URI=["'])([^"']+)(["'])/gi, (match, prefix, url, suffix) => {
      // Preserve custom-scheme URIs (skd://, data:, etc.) - only rewrite scheme-less paths
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
        return prefix + url + suffix
      }
      return prefix + proxySegmentPath(url, query) + suffix
    })
    // Handle #EXT-X-MEDIA:URI="..."
    line = line.replace(/(#EXT-X-MEDIA:[^"'\n]*URI=["'])([^"']+)(["'])/gi, (match, prefix, url, suffix) => {
      return prefix + proxySegmentPath(url, query) + suffix
    })
    // Handle #EXT-X-I-FRAME-STREAM-INF:URI="..."
    line = line.replace(/(#EXT-X-I-FRAME-STREAM-INF:[^"'\n]*URI=["'])([^"']+)(["'])/gi, (match, prefix, url, suffix) => {
      return prefix + proxySegmentPath(url, query) + suffix
    })
    return line
  }

  if (hasPreviewLimit && isMediaPlaylist) {
    let elapsed = 0, pending = null
    const out = []
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith('#')) {
        if (t.startsWith('#EXTINF:')) pending = Number.parseFloat(t.slice('#EXTINF:'.length)) || 0
        if (t !== '#EXT-X-ENDLIST') {
          // Rewrite tag attributes even in preview mode
          out.push(rewriteTagAttributes(line, buildExtraQuery(true)))
        }
        continue
      }
      if (elapsed >= previewUntilSeconds) break
      out.push(proxySegmentPath(t, buildExtraQuery(true)))
      elapsed += pending ?? 0
      pending = null
    }
    out.push('#EXT-X-ENDLIST')
    return out.join('\n')
  }
  return lines.map(line => {
    const t = line.trim()
    if (!t) return line
    if (t.startsWith('#')) {
      // Rewrite URLs in HLS tag attributes
      return rewriteTagAttributes(line, buildExtraQuery(isMasterPlaylist && hasPreviewLimit))
    }
    if (isMasterPlaylist) {
      // For relative paths in master playlists we must resolve them to an
      // absolute proxy path so the previewUntil param is carried through to
      // the variant playlist request (hls.js fetches the URL verbatim).
      const isRelative = !/^https?:\/\//i.test(t) && !t.startsWith('/')
      if (isRelative && manifestDir) {
        const absolutePath = `${manifestDir}${t}`
        return rewriteSegmentPath(absolutePath, buildExtraQuery(hasPreviewLimit))
      }
    }
    return proxySegmentPath(t, buildExtraQuery(isMasterPlaylist && hasPreviewLimit))
  }).join('\n')
}

function rewriteDashManifestForProxy(mpdManifest, vt = null) {
  const query = vt ? `vt=${vt}` : null
  let r = mpdManifest.replace(/<BaseURL([^>]*)>([^<]+)<\/BaseURL>/gi, (_, attrs, value) => {
    const v = value.trim()
    return v ? `<BaseURL${attrs}>${rewriteSegmentPath(v, query)}</BaseURL>` : _
  })
  return r.replace(/\b(initialization|media|sourceURL)=["']([^"']+)["']/gi, (_, attr, value) => `${attr}="${rewriteSegmentPath(value, query)}"`)
}

function rewriteSegmentPath(path, query, baseDir = '') {
  // Preserve custom-scheme URIs (skd://, data:, etc.) - only rewrite scheme-less paths
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) && !/^https?:\/\//i.test(path)) {
    return path
  }
  let proxied
  if (/^https?:\/\//i.test(path)) {
    const u = new URL(path)
    proxied = `/api/video-proxy${u.pathname}${u.search}`
  } else if (path.startsWith('/')) {
    proxied = `/api/video-proxy${path}`
  } else if (/^(videos|preview|full)\//i.test(path)) {
    proxied = `/api/video-proxy/${path}`
  } else if (baseDir) {
    // Bare relative filename (e.g. "seg_1080_1.m4s", "init_1080.mp4") —
    // resolve against the manifest's directory so the proxy prefix and vt
    // token are preserved for every segment/init request.
    proxied = `/api/video-proxy/${baseDir}${path}`
  } else {
    return path
  }
  return query ? (proxied.includes('?') ? `${proxied}&${query}` : `${proxied}?${query}`) : proxied
}

function normalizeProtocolOption(v) { return v === 'hls' || v === 'dash' ? v : null }
function normalizeVideoId(input) {
  const t = (input ?? '').trim()
  const m = t.match(/^videos\/([^/]+)\/processed\/playlist\.m3u8$/i)
  return m ? m[1] : t
}

async function resolveMediaEntrypointUrl({ env, videoId, hasPremiumAccess, protocol = 'hls' }) {
  const base = env.R2_BASE_URL
  const scope = hasPremiumAccess ? 'full' : 'preview'
  const primary = protocol === 'dash' ? 'dash' : 'hls'
  const secondary = primary === 'hls' ? 'dash' : 'hls'
  const candidates = [
    ...buildEntrypointCandidates(base, videoId, scope, primary),
    ...buildEntrypointCandidates(base, videoId, 'videos', primary),
    ...buildEntrypointCandidates(base, videoId, scope, secondary),
    ...buildEntrypointCandidates(base, videoId, 'videos', secondary),
  ]
  for (const c of candidates) { if (await canLoadEntrypoint(c)) return c }
  return candidates[0]
}

function buildEntrypointCandidates(base, videoId, scope, protocol) {
  if (scope === 'videos') {
    // Flat layout (upload script copies TMP_DIR directly under videos/{id}/)
    // checked first; processed/ subdirectory kept for backwards compatibility.
    return protocol === 'dash'
      ? [
          `${base}/videos/${videoId}/manifest.mpd`,
          `${base}/videos/${videoId}/processed/dash/manifest.mpd`,
          `${base}/videos/${videoId}/processed/manifest.mpd`,
          `${base}/videos/${videoId}/processed/playlist.mpd`,
        ]
      : [
          `${base}/videos/${videoId}/master.m3u8`,
          `${base}/videos/${videoId}/processed/hls/master.m3u8`,
          `${base}/videos/${videoId}/processed/playlist.m3u8`,
        ]
  }
  return protocol === 'dash'
    ? [`${base}/${scope}/${videoId}/manifest.mpd`, `${base}/${scope}/${videoId}/playlist.mpd`]
    : [`${base}/${scope}/${videoId}/playlist.m3u8`]
}

function buildProxyPlaylistUrl(request, playlistUrl, previewUntilSeconds, protocol) {
  const origin = new URL(request.url).origin
  const upstream = new URL(playlistUrl)
  const u = new URL(`${origin}/api/video-proxy${upstream.pathname}`)
  u.searchParams.set('protocol', protocol)
  if (previewUntilSeconds && previewUntilSeconds > 0) u.searchParams.set('previewUntil', String(Math.floor(previewUntilSeconds)))
  return u.toString()
}

async function ensureAdminSettingsTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run()
}

function safeJsonParse(v, fallback) {
  if (!v) return fallback
  try { return JSON.parse(v) } catch { return fallback }
}

function defaultHomepageConfig() { return { featuredVideoIds: [], layoutBlocks: [] } }

function normalizeHomepageConfig(config) {
  return {
    featuredVideoIds: Array.isArray(config.featuredVideoIds)
      ? config.featuredVideoIds.filter(id => typeof id === 'string').slice(0, 4)
      : [],
    layoutBlocks: Array.isArray(config.layoutBlocks)
      ? config.layoutBlocks.filter(b => b && typeof b === 'object').map(b => ({
          id:    typeof b.id    === 'string' ? b.id    : crypto.randomUUID(),
          type:  normalizeLayoutBlockType(b.type),
          title: typeof b.title === 'string' ? b.title : '',
          body:  typeof b.body  === 'string' ? b.body  : '',
        }))
      : [],
  }
}

function normalizeLayoutBlockType(type) {
  if (type === 'featured') return 'featured_row'
  const allowedTypes = new Set(['hero', 'featured_row', 'cta', 'text_split', 'video_grid'])
  return allowedTypes.has(type) ? type : 'hero'
}

async function canLoadEntrypoint(url) {
  try { return (await fetch(url, { method: 'HEAD' })).ok } catch { return false }
}

function getDatabaseBinding(env) {
  const db = env.DB || env.video_subscription_db
  if (!db) throw new Error('Database binding not configured')
  return db
}

function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

// ─── Video token helpers (Step 4a) ────────────────────────────────────────────
//
// Short-lived HMAC-SHA-256 tokens that authenticate every HLS playlist and
// segment request through the proxy.  Without a valid token the proxy returns
// 403, so enumeration and bulk downloading of segments requires knowing the
// JWT_SECRET.
//
// Token format:  base64url(payload) + "." + hex(HMAC-SHA256(base64url(payload)))
// where payload = "<userId>:<videoId>:<unixExpires>"

async function importVideoHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function b64urlEncode(str) {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function b64urlDecode(b64url) {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/')
    + '=='.slice(0, (4 - (b64url.length % 4)) % 4)
  return atob(padded)
}

async function signVideoToken(userId, videoId, secret, previewUntil = null) {
  const expires = Math.floor(Date.now() / 1000) + 7200 // 2 hours
  const previewUntilStr = previewUntil !== null ? String(previewUntil) : ''
  const payload = b64urlEncode(`${userId}:${videoId}:${expires}:${previewUntilStr}`)
  const key = await importVideoHmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  const sigHex = Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('')
  return `${payload}.${sigHex}`
}

async function verifyVideoToken(token, secret) {
  if (!token || typeof token !== 'string') throw new Error('Missing video token')
  const dotIndex = token.lastIndexOf('.')
  if (dotIndex < 1) throw new Error('Malformed video token')

  const payload = token.slice(0, dotIndex)
  const sigHex  = token.slice(dotIndex + 1)

  // Validate sigHex before conversion
  if (!sigHex || typeof sigHex !== 'string') {
    throw new Error('Malformed video token signature')
  }
  if (sigHex.length === 0 || sigHex.length % 2 !== 0) {
    throw new Error('Malformed video token signature')
  }
  if (!/^[0-9a-fA-F]+$/.test(sigHex)) {
    throw new Error('Malformed video token signature')
  }

  const key = await importVideoHmacKey(secret)

  // Constant-time verification
  try {
    const sigBytes = new Uint8Array(sigHex.match(/../g).map(h => parseInt(h, 16)))
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payload))
    if (!valid) throw new Error('Invalid video token signature')
  } catch (error) {
    if (error.message === 'Invalid video token signature') throw error
    throw new Error('Malformed video token signature')
  }

  const decoded = b64urlDecode(payload)
  const parts   = decoded.split(':')
  if (parts.length < 3) throw new Error('Malformed video token payload')

  const userId  = parts[0]
  const videoId = parts[1]
  const expires = parseInt(parts[2], 10)
  const previewUntil = parts[3] ? (parts[3] !== '' ? parseFloat(parts[3]) : null) : null

  if (Math.floor(Date.now() / 1000) > expires) throw new Error('Video token expired')

  return { userId, videoId, expires, previewUntil }
}

// ─── Segment duration helpers (Step 4b) ──────────────────────────────────────
//
// We cache the average HLS segment duration per videoId in KV so we can
// throttle .ts responses to roughly real-time speed.

async function getAvgSegmentDuration(videoId, env) {
  if (!env.RATE_LIMIT_KV) return null

  // Check KV cache first (1-hour TTL)
  const cached = await env.RATE_LIMIT_KV.get(`manifest:${videoId}`, 'json')
  if (cached?.avg && typeof cached.avg === 'number') return cached.avg

  // Try to fetch one of the known playlist paths from R2
  const base = env.R2_BASE_URL
  const candidates = [
    `${base}/videos/${videoId}/master.m3u8`,
    `${base}/videos/${videoId}/processed/hls/master.m3u8`,
    `${base}/videos/${videoId}/processed/playlist.m3u8`,
  ]

  let manifest = null
  for (const url of candidates) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const text = await res.text()
        // For master playlists, follow the first variant
        if (text.includes('#EXT-X-STREAM-INF')) {
          const lines    = text.split('\n')
          const varLine  = lines.find(l => !l.startsWith('#') && l.trim().endsWith('.m3u8'))
          if (varLine) {
            const trimmedLine = varLine.trim()
            let varUrl
            if (trimmedLine.startsWith('http://') || trimmedLine.startsWith('https://')) {
              // Full absolute URL
              varUrl = trimmedLine
            } else if (trimmedLine.startsWith('/')) {
              // Absolute path - resolve against the base origin
              const baseUrl = new URL(url)
              varUrl = `${baseUrl.origin}${trimmedLine}`
            } else {
              // Relative path - resolve against videos/{videoId}/
              varUrl = `${base}/videos/${videoId}/${trimmedLine}`
            }
            const varRes = await fetch(varUrl)
            if (varRes.ok) manifest = await varRes.text()
          }
        } else {
          manifest = text
        }
        break
      }
    } catch { /* try next */ }
  }

  if (!manifest) return null

  // Parse #EXTINF durations from media playlist
  const durations = []
  for (const line of manifest.split('\n')) {
    const t = line.trim()
    if (t.startsWith('#EXTINF:')) {
      const dur = parseFloat(t.slice('#EXTINF:'.length))
      if (dur > 0) durations.push(dur)
    }
  }
  if (!durations.length) return null

  const avg = durations.reduce((a, b) => a + b, 0) / durations.length
  await env.RATE_LIMIT_KV.put(`manifest:${videoId}`, JSON.stringify({ avg }), { expirationTtl: 3600 })
  return avg
}

// ─── Segment count rate limiting (Step 4c) ────────────────────────────────────
//
// Allows up to 3× real-time segment requests per minute per user per video.
// Exceeding the threshold bans that user+video pair for 30 seconds.
//
// Uses a Durable Object to ensure atomic increment operations.

async function checkSegmentRateLimit(identifier, videoId, avgSegDur, env) {
  if (!env.RATE_LIMIT_KV) return false

  // Check active ban
  const banKey = `segban:${identifier}:${videoId}`
  const banned = await env.RATE_LIMIT_KV.get(banKey)
  if (banned) return true

  // Use Durable Object for atomic counting if available
  if (env.SEGMENT_RATE_LIMITER) {
    try {
      // Create a deterministic ID based on identifier and videoId
      const doId = env.SEGMENT_RATE_LIMITER.idFromName(`${identifier}:${videoId}`)
      const doStub = env.SEGMENT_RATE_LIMITER.get(doId)

      const response = await doStub.fetch('https://dummy-url/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, videoId, avgSegDur }),
      })

      const result = await response.json()

      if (result.exceeded) {
        await env.RATE_LIMIT_KV.put(banKey, '1', { expirationTtl: 30 })
        return true
      }

      return false
    } catch (error) {
      console.error('Durable Object rate limit error:', error)
      // Fall through to KV-based rate limiting as fallback
    }
  }

  // Fallback to non-atomic KV-based rate limiting (legacy)
  const segDur    = avgSegDur ?? 6 // default 6-second segments
  const threshold = Math.ceil(60 / segDur) * 3

  const minute   = Math.floor(Date.now() / 60000)
  const countKey = `segcount:${identifier}:${videoId}:${minute}`
  const raw      = await env.RATE_LIMIT_KV.get(countKey)
  const count    = (parseInt(raw ?? '0', 10) || 0) + 1
  await env.RATE_LIMIT_KV.put(countKey, String(count), { expirationTtl: 90 })

  if (count > threshold) {
    await env.RATE_LIMIT_KV.put(banKey, '1', { expirationTtl: 30 })
    return true
  }

  return false
}