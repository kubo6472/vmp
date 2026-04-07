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
import { sendPushNotification, sendPushToAllSubscribers } from './webpush.js'
import {
  handleGetPricing,
  handleCheckout,
  handleWebhook,
  handleGetSubscription,
  handlePortal,
} from './stripe.js'
import { isAdministrativeRole } from './roles.js'
import { handleThumbnailUpload, handleThumbnailDelete } from './thumbnails.js'

// ─── Durable Object for atomic segment rate limiting (Step 4c) ───────────────
// Binding is configured in wrangler.json under durable_objects.bindings.
// Used conditionally: only active when env.SEGMENT_RATE_LIMITER is present.

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
    if (url.pathname.match(/^\/api\/admin\/videos\/[^/]+\/thumbnail$/) && request.method === 'POST') {
      return handleThumbnailUpload(request, env, corsHeaders)
    }
    if (url.pathname.match(/^\/api\/admin\/videos\/[^/]+\/thumbnail$/) && request.method === 'DELETE') {
      return handleThumbnailDelete(request, env, corsHeaders)
    }
    if (url.pathname.startsWith('/api/admin/videos/') && request.method === 'PATCH') {
      return handleAdminVideoUpdate(request, env, ctx, corsHeaders)
    }
    if (url.pathname.match(/^\/api\/admin\/videos\/[^/]+$/) && request.method === 'DELETE') {
      return handleAdminVideoDelete(request, env, corsHeaders)
    }
    if (url.pathname.match(/^\/api\/admin\/videos\/[^/]+\/notify$/) && request.method === 'POST') {
      return handleAdminVideoNotify(request, env, ctx, corsHeaders)
    }
    if (url.pathname.match(/^\/api\/admin\/videos\/[^/]+\/swap$/) && request.method === 'POST') {
      return handleVideoSwap(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/push/test' && request.method === 'POST') {
      return handleAdminPushTest(request, env, corsHeaders)
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
    // ── Push notification routes ──────────────────────────────────────────────
    if (url.pathname === '/api/push/vapid-public-key' && request.method === 'GET') {
      return handleGetVapidPublicKey(request, env, corsHeaders)
    }
    if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
      return handlePushSubscribe(request, env, corsHeaders)
    }
    if (url.pathname === '/api/push/subscribe' && request.method === 'DELETE') {
      return handlePushUnsubscribe(request, env, corsHeaders)
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
      ? `SELECT id, title, description, thumbnail_url, full_duration, preview_duration, upload_date, publish_status, slug
         FROM videos
         ORDER BY upload_date DESC`
      : `SELECT id, title, description, thumbnail_url, full_duration, preview_duration, upload_date, publish_status, slug
         FROM videos
         WHERE publish_status = 'published'
         ORDER BY upload_date DESC`

    const videos = await db.prepare(query).all()

    // Best-effort duration hydration for legacy rows where full_duration=0.
    // Cached in KV so this stays cheap for repeated list loads.
    const results = videos.results || []
    if (env.R2_BASE_URL) {
      await Promise.all(results.map(async (v) => {
        if (!v || typeof v.id !== 'string') return
        if (typeof v.full_duration === 'number' && v.full_duration > 0) return
        const resolved = await resolveVideoDurationSeconds(v.id, env)
        if (resolved && resolved > 0) v.full_duration = resolved
      }))
    }

    return jsonResponse({ videos: results }, 200, corsHeaders)
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
      // DEPRECATED: Legacy callers still send /api/video-access/{userId}/{videoId}.
      // Keep this temporarily for backward compatibility while clients migrate
      // to /api/video-access/{videoId} with Authorization header when available.
      legacyUserId = pathParts[2]
      requestedVideoId = decodeURIComponent(pathParts[3] ?? '')
      // Log deprecation warning without raw user identifiers to comply with privacy/retention policies
      // Suppress warning for 'anonymous' userId to avoid log spam from admin UI
      if (legacyUserId !== 'anonymous') {
        console.warn('DEPRECATED_API_CALL /api/video-access/{userId}/{videoId} - Legacy path format still in use')
      }
    } else {
      return jsonResponse({ error: 'Invalid path format. Expected: /api/video-access/{videoId}' }, 400, corsHeaders)
    }

    const videoId = normalizeVideoId(requestedVideoId)

    let authUser = null
    let userId = legacyUserId

    // Legacy non-anonymous callers must now authenticate.
    if (legacyUserId && legacyUserId !== 'anonymous') {
      try {
        authUser = await requireAuth(request, env)
      } catch {
        return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
      }
      userId = authUser?.sub
    } else {
      try {
        authUser = await requireAuth(request, env)
      } catch {
        authUser = null
      }
      if (authUser?.sub) userId = authUser.sub
    }

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

    // Resolve by ID first, then by vanity slug so /watch/<slug> works transparently.
    const video = await resolveVideoByIdOrSlug(db, videoId)
    // Use the canonical database ID for all downstream operations (R2 paths, token signing).
    const resolvedVideoId = video?.id ?? videoId

    // Treat all non-viewer staff roles as premium-equivalent entitlements.
    const hasElevatedRole = isAdministrativeRole(authUser?.role)

    // Reject unpublished videos for non-staff so drafts/archived videos can't
    // receive signed playlist tokens via a slug or ID they happen to know.
    if (video && video.publish_status !== 'published' && !hasElevatedRole) {
      return jsonResponse({ error: 'Video not found' }, 404, corsHeaders)
    }

    // Any active monthly/yearly/club subscription grants full access
    const hasPremiumSubscription = Boolean(subscription)
    const hasPremiumAccess = hasElevatedRole || hasPremiumSubscription

    const hasVideoMetadata = Boolean(video)
    const hasAccess = hasPremiumAccess || !hasVideoMetadata
    const previewDuration = video?.preview_duration ?? video?.full_duration ?? 0
    const resolvedEntrypointUrl = await resolveMediaEntrypointUrl({ env, videoId: resolvedVideoId })
    const basePlaylistUrl = buildProxyPlaylistUrl(request, resolvedEntrypointUrl, hasPremiumAccess ? null : previewDuration)
    // Unify duration logic with the frontend: if D1 has 0/unknown duration,
    // attempt to resolve from the HLS playlist stored in R2.
    let fullDuration = video?.full_duration ?? previewDuration
    // Avoid racing the video-processor duration sync while a video is still in the
    // "uploaded" (not yet processed) state.
    const isProcessingInFlight = Boolean(video && video.status && video.status !== 'processed')
    if ((!fullDuration || fullDuration === 0) && env.R2_BASE_URL && !isProcessingInFlight) {
      const resolved = await resolveVideoDurationSeconds(resolvedVideoId, env)
      if (resolved && resolved > 0) {
        fullDuration = resolved
        // Best-effort: backfill D1 so list endpoints and cards stop showing "--".
        if (video && video.full_duration === 0) {
          try {
            await db.prepare(
              `UPDATE videos
               SET full_duration = ?,
                   preview_duration = CASE
                     WHEN preview_duration IS NULL THEN NULL
                     WHEN preview_duration <= 0 THEN preview_duration
                     ELSE MIN(preview_duration, ?)
                   END,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status = 'processed'`
            ).bind(fullDuration, fullDuration, resolvedVideoId).run()
          } catch (e) {
            console.warn(`Duration backfill failed for ${resolvedVideoId}:`, e?.message ?? e)
          }
        }
      }
    }

    // Sign the playlist URL with a short-lived video token so the proxy can
    // authenticate every subsequent manifest and segment request.
    const effectiveUserId = authUser?.sub ?? userId ?? 'anonymous'
    let playlistUrl = basePlaylistUrl
    if (env.JWT_SECRET) {
      const vt = await signVideoToken(effectiveUserId, resolvedVideoId, env.JWT_SECRET, hasPremiumAccess ? null : previewDuration)
      playlistUrl = basePlaylistUrl.includes('?')
        ? `${basePlaylistUrl}&vt=${vt}`
        : `${basePlaylistUrl}?vt=${vt}`
    }

    const response = {
      userId: userId ?? null,
      videoId: resolvedVideoId,
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
  const previewUntil = Number.parseFloat(requestUrl.searchParams.get('previewUntil') ?? '')
  const previewUntilSeconds = Number.isFinite(previewUntil) && previewUntil > 0 ? previewUntil : null
  if (!objectPath) return jsonResponse({ error: 'Missing proxied object path' }, 400, corsHeaders)

  // This platform is HLS-only. Explicitly reject DASH manifest requests (.mpd)
  // so they fail clearly rather than passing through the proxy unprocessed
  // (where preview limits would not be enforced).
  if (objectPath.endsWith('.mpd')) {
    return jsonResponse({ error: 'DASH streaming is not supported. Use HLS.' }, 410, corsHeaders)
  }

  // Normalize the path to resolve any dot-segments, leading slashes, etc.
  // This prevents rewritten URLs from rewriteSegmentPath() that produce root-relative
  // or dot-containing paths from bypassing the subtree check.
  let normalizedPath
  try {
    // Use WHATWG URL to normalize the path (resolves dots and removes leading slash)
    const tempUrl = new URL(objectPath, 'http://dummy')
    normalizedPath = tempUrl.pathname.replace(/^\/+/, '') // strip leading slashes
  } catch {
    return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders)
  }

  // Enforce that the normalized path is within the videos/ subtree
  if (!normalizedPath.startsWith('videos/')) {
    return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders)
  }

  // Reject dot-segment traversal in the normalized path
  // Decoding catches percent-encoded forms like %2e%2e
  const pathSegments = normalizedPath.split('/')
  for (const seg of pathSegments) {
    let decoded
    try { decoded = decodeURIComponent(seg) } catch {
      return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders)
    }
    if (decoded === '.' || decoded === '..') {
      return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders)
    }
  }

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

  // Extract videoId from path (videos/{id}/...)
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

  const manifestType = getManifestType(objectPath, upstreamResponse)
  if (manifestType === 'hls') {
    const manifest = await upstreamResponse.text()
    const rewrittenManifest = rewriteManifestForProxyWithPreview(manifest, effectivePreviewUntil, objectPath, vtForRewrite)
    const headers = new Headers(upstreamResponse.headers)
    headers.set('Content-Type', 'application/vnd.apple.mpegurl')
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
    let videos
    videos = await db.prepare(`
      SELECT id, title, description, thumbnail_url, full_duration, preview_duration,
             upload_date, status, publish_status, published_at, updated_at, slug
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

async function handleAdminVideoUpdate(request, env, ctx, corsHeaders) {
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
  const hasSlug   = Object.prototype.hasOwnProperty.call(body, 'slug')

  if (!hasStatus && !hasTitle && !hasSlug) {
    return jsonResponse({ error: 'At least one of status, title, or slug must be provided' }, 400, corsHeaders)
  }
  if (hasTitle && (typeof body.title !== 'string' || body.title.trim().length === 0)) {
    return jsonResponse({ error: 'title must not be empty' }, 400, corsHeaders)
  }
  if (hasStatus && !allowedStatuses.includes(body.status)) {
    return jsonResponse({ error: 'status must be one of: draft, published, archived' }, 400, corsHeaders)
  }
  if (hasSlug && body.slug !== null && (typeof body.slug !== 'string' || !isValidSlug(body.slug))) {
    return jsonResponse({ error: 'slug must be lowercase alphanumeric words separated by hyphens (e.g. my-video-title), or null to clear it' }, 400, corsHeaders)
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

  const db = getDatabaseBinding(env)

  // Guard: reject a slug that equals another video's id — resolveVideoByIdOrSlug
  // resolves by id before slug, so the slug would become permanently shadowed.
  if (hasSlug && body.slug !== null) {
    const idCollision = await db.prepare(
      'SELECT 1 FROM videos WHERE id = ? AND id != ? LIMIT 1'
    ).bind(body.slug, videoId).first()
    if (idCollision) {
      return jsonResponse({ error: 'Slug conflicts with an existing video ID' }, 409, corsHeaders)
    }
  }

  try {
    // When both title and slug are supplied, write them atomically so a slug
    // constraint violation cannot leave the title committed but the slug not.
    if (hasTitle || hasSlug) {
      try {
        if (hasTitle && hasSlug) {
          await db.prepare(`UPDATE videos SET title = ?, slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .bind(body.title.trim(), body.slug ?? null, videoId).run()
        } else if (hasTitle) {
          await db.prepare(`UPDATE videos SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .bind(body.title.trim(), videoId).run()
        } else {
          await db.prepare(`UPDATE videos SET slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .bind(body.slug ?? null, videoId).run()
        }
      } catch (err) {
        if (err?.message?.includes('UNIQUE')) {
          return jsonResponse({ error: 'Slug already in use by another video' }, 409, corsHeaders)
        }
        throw err
      }
    }

    let transitionedToPublished = false
    if (hasStatus) {
      if (body.status === 'published') {
        // Atomic transition: the WHERE clause ensures we only update (and fire push)
        // when the row was NOT already published, eliminating the TOCTOU race.
        const result = await db.prepare(`
          UPDATE videos
          SET publish_status = 'published',
              published_at = COALESCE(published_at, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND publish_status != 'published'
        `).bind(videoId).run()
        transitionedToPublished = (result.meta?.changes ?? result.changes ?? 0) > 0
        // If the row was already published, still run a no-op update to get consistent
        // state for the SELECT below — this is a read guard, not a second write
      } else {
        await db.prepare(`
          UPDATE videos
          SET publish_status = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(body.status, videoId).run()
      }
    }

    const video = await db.prepare(`
      SELECT id, title, status, publish_status, published_at, updated_at, slug
      FROM videos WHERE id = ?
    `).bind(videoId).first()
    if (!video) return jsonResponse({ error: 'Video not found' }, 404, corsHeaders)

    // Fire push only when the UPDATE itself confirmed the transition (atomic guard)
    if (transitionedToPublished) {
      ctx.waitUntil(
        sendPushToAllSubscribers(video.title || videoId, videoId, env, db)
          .then((stats) => {
            console.log(`Push notify [videoId:${videoId}] attempted=${stats.attempted} succeeded=${stats.succeeded} failed=${stats.failed} stale=${stats.stale}`)
          })
          .catch(err => {
            console.error(`Push notify error [videoId:${videoId}]:`, err)
          }),
      )
    }

    return jsonResponse({ ok: true, video }, 200, corsHeaders)
  } catch (error) {
    console.error('Error:', error)
    return jsonResponse({ error: 'Internal server error', details: error.message }, 500, corsHeaders)
  }
}

async function handleAdminVideoDelete(request, env, corsHeaders) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const url = new URL(request.url)
  const pathParts = url.pathname.split('/').filter(Boolean)
  const videoId = pathParts[3] // /api/admin/videos/{videoId}
  if (!videoId) return jsonResponse({ error: 'Missing videoId' }, 400, corsHeaders)

  try {
    const db = getDatabaseBinding(env)
    // Guard: ensure admin_settings exists on fresh/migration-lagged deployments
    // before the homepage cleanup query below tries to read from it.
    await ensureAdminSettingsTable(db)

    const video = await db.prepare(`SELECT id FROM videos WHERE id = ?`).bind(videoId).first()
    if (!video) return jsonResponse({ error: 'Video not found' }, 404, corsHeaders)
    // Delete all R2 objects under videos/{videoId}/ (paginated)
    let deletedR2Objects = 0
    if (env.BUCKET) {
      let cursor
      do {
        const listed = await env.BUCKET.list({ prefix: `videos/${videoId}/`, cursor })
        const keys = listed.objects.map(obj => obj.key)
        if (keys.length > 0) {
          const batchSize = 100
          for (let i = 0; i < keys.length; i += batchSize) {
            await Promise.all(keys.slice(i, i + batchSize).map(key => env.BUCKET.delete(key)))
          }
          deletedR2Objects += keys.length
        }
        cursor = listed.truncated ? listed.cursor : undefined
      } while (cursor)
    }

    // Evict the deleted ID from the persisted homepage featured-slots config so
    // a subsequent page load doesn't rehydrate a stale or empty featured card.
    const homepageRow = await db.prepare(
      'SELECT value FROM admin_settings WHERE key = ? LIMIT 1'
    ).bind('homepage').first()
    if (homepageRow?.value) {
      const homepage = safeJsonParse(homepageRow.value, defaultHomepageConfig())
      const before = Array.isArray(homepage.featuredVideoIds) ? homepage.featuredVideoIds : []
      const after  = before.filter(id => id !== videoId)
      if (after.length !== before.length) {
        homepage.featuredVideoIds = after
        await db.prepare(`
          INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).bind('homepage', JSON.stringify(homepage)).run()
      }
    }

    // Delete the D1 row
    await db.prepare(`DELETE FROM videos WHERE id = ?`).bind(videoId).run()

    return jsonResponse({ ok: true, deletedR2Objects }, 200, corsHeaders)
  } catch (error) {
    console.error(`handleAdminVideoDelete [videoId:${videoId}]:`, error)
    return jsonResponse({ error: 'Internal server error', details: error.message }, 500, corsHeaders)
  }
}

async function handleAdminVideoNotify(request, env, ctx, corsHeaders) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const url = new URL(request.url)
  const pathParts = url.pathname.split('/').filter(Boolean)
  // /api/admin/videos/{videoId}/notify → index 3 is videoId
  const videoId = pathParts[3]
  if (!videoId) return jsonResponse({ error: 'Missing videoId' }, 400, corsHeaders)

  const db = getDatabaseBinding(env)
  const video = await db.prepare(
    `SELECT id, title, publish_status FROM videos WHERE id = ?`
  ).bind(videoId).first()

  if (!video) return jsonResponse({ error: 'Video not found' }, 404, corsHeaders)
  if (video.publish_status !== 'published') {
    return jsonResponse({ error: 'Only published videos can trigger notifications' }, 422, corsHeaders)
  }

  // KV-based cooldown: prevent accidental spam from double-clicks or repeated sends.
  // TTL matches the cooldown window so the key auto-expires.
  const NOTIFY_COOLDOWN_SECONDS = 300 // 5 minutes
  if (env.RATE_LIMIT_KV) {
    const cooldownKey = `notify:video:${videoId}`
    const lastSent = await env.RATE_LIMIT_KV.get(cooldownKey)
    if (lastSent) {
      const secondsAgo = Math.floor((Date.now() - Number(lastSent)) / 1000)
      const retryAfter = NOTIFY_COOLDOWN_SECONDS - secondsAgo
      return jsonResponse(
        { error: 'Notification cooldown active — wait 5 minutes between sends.', code: 'cooldown', retryAfter },
        429,
        corsHeaders,
      )
    }
    await env.RATE_LIMIT_KV.put(cooldownKey, String(Date.now()), { expirationTtl: NOTIFY_COOLDOWN_SECONDS })
  }

  const responseTimestamp = new Date().toISOString()

  // Send in the background; log delivery stats so failures are visible in logs.
  ctx.waitUntil(
    sendPushToAllSubscribers(video.title || videoId, videoId, env, db)
      .then(stats => {
        console.log(`Push notify [videoId:${videoId}] attempted=${stats.attempted} succeeded=${stats.succeeded} failed=${stats.failed} stale=${stats.stale}`)
      })
      .catch(err => {
        console.error(`Push notify error [videoId:${videoId}]:`, err)
      }),
  )

  return jsonResponse({ ok: true, push_enqueued_at: responseTimestamp }, 200, corsHeaders)
}

async function handleVideoSwap(request, env, corsHeaders) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const url = new URL(request.url)
  const pathParts = url.pathname.split('/').filter(Boolean)
  // /api/admin/videos/{publishedId}/swap → index 3 is the published video ID
  const publishedId = pathParts[3]
  if (!publishedId) return jsonResponse({ error: 'Missing video id' }, 400, corsHeaders)

  const body = await request.json().catch(() => null)
  if (!body?.swapWithId || typeof body.swapWithId !== 'string') {
    return jsonResponse({ error: 'swapWithId (draft video id) is required' }, 400, corsHeaders)
  }
  const draftId = body.swapWithId.trim()
  if (draftId === publishedId) {
    return jsonResponse({ error: 'Cannot swap a video with itself' }, 400, corsHeaders)
  }

  const db = getDatabaseBinding(env)

  const [oldVideo, newVideo] = await Promise.all([
    db.prepare('SELECT * FROM videos WHERE id = ?').bind(publishedId).first(),
    db.prepare('SELECT * FROM videos WHERE id = ?').bind(draftId).first(),
  ])

  if (!oldVideo) return jsonResponse({ error: 'Published video not found' }, 404, corsHeaders)
  if (!newVideo) return jsonResponse({ error: 'Draft video not found' }, 404, corsHeaders)
  if (oldVideo.publish_status !== 'published') {
    return jsonResponse({ error: 'Source video must be published' }, 422, corsHeaders)
  }
  if (newVideo.publish_status !== 'draft') {
    return jsonResponse({ error: 'Target video must be a draft' }, 422, corsHeaders)
  }
  if (env.BUCKET) {
    const exists = await hasProcessedPlaybackArtifact(env.BUCKET, draftId)
    if (!exists) {
      return jsonResponse({
        error: 'Cannot swap: processed media not found in R2. Upload and process the target draft first.',
        code: 'r2_missing',
      }, 422, corsHeaders)
    }
  }

  // Cap the preview lock to the new video's actual duration (which may differ).
  const cappedPreviewDuration = newVideo.full_duration > 0
    ? Math.min(oldVideo.preview_duration ?? 0, newVideo.full_duration)
    : (oldVideo.preview_duration ?? 0)

  // Promote the draft and retire the old video atomically via D1 batch so both
  // updates succeed or both fail — no half-swapped state.
  // thumbnail_url starts as the old video's URL; upgraded below after the copy succeeds.
  const promoteStmt = db.prepare(`
    UPDATE videos SET
      title            = ?,
      description      = ?,
      thumbnail_url    = ?,
      slug             = ?,
      upload_date      = ?,
      preview_duration = ?,
      publish_status   = 'published',
      published_at     = CURRENT_TIMESTAMP,
      updated_at       = CURRENT_TIMESTAMP
    WHERE id = ? AND publish_status = 'draft'
  `).bind(
    oldVideo.title,
    oldVideo.description ?? null,
    oldVideo.thumbnail_url ?? null,
    oldVideo.slug ?? null,
    oldVideo.upload_date,
    cappedPreviewDuration,
    draftId,
  )

  const retireStmt = db.prepare(`
    UPDATE videos SET
      title          = 'OLD - ' || title,
      thumbnail_url  = NULL,
      slug           = NULL,
      publish_status = 'draft',
      published_at   = NULL,
      updated_at     = CURRENT_TIMESTAMP
    WHERE id = ? AND publish_status = 'published'
  `).bind(publishedId)

  // Retire must run first to clear the slug before the draft claims it — otherwise
  // D1 raises a UNIQUE constraint violation on the partial index on videos.slug.
  // The WHERE predicates ensure concurrent requests can't both succeed.
  const [retireResult, promoteResult] = await db.batch([retireStmt, promoteStmt])
  if ((retireResult.meta?.changes ?? 0) === 0 || (promoteResult.meta?.changes ?? 0) === 0) {
    return jsonResponse({ error: 'Swap failed: video status changed concurrently, please retry' }, 409, corsHeaders)
  }

  // Copy thumbnails only after the swap has committed so a failed swap never
  // overwrites the draft's existing thumbnail assets.
  if (env.BUCKET && oldVideo.thumbnail_url) {
    const thumbnailFiles = ['original.jpg', 'large.jpg', 'medium.jpg', 'small.jpg']
    const copyResults = await Promise.allSettled(thumbnailFiles.map(async (file) => {
      const srcKey = `thumbnails/${publishedId}/${file}`
      const dstKey = `thumbnails/${draftId}/${file}`
      const obj = await env.BUCKET.get(srcKey)
      if (obj) {
        await env.BUCKET.put(dstKey, obj.body, { httpMetadata: obj.httpMetadata })
        return true
      }
      return false
    }))
    const failures = copyResults.filter(r => r.status === 'rejected')
    if (failures.length) {
      console.warn(`Thumbnail copy: ${failures.length}/${thumbnailFiles.length} failed for swap ${publishedId} -> ${draftId}`)
    }
    // Upgrade the thumbnail URL on the newly promoted row only if large.jpg was
    // actually written; the initial value set in the batch was oldVideo.thumbnail_url.
    const largeCopyOk = copyResults[1]?.status === 'fulfilled' && copyResults[1].value === true
    if (env.R2_BASE_URL && largeCopyOk) {
      await db.prepare(`UPDATE videos SET thumbnail_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(`${env.R2_BASE_URL}/thumbnails/${draftId}/large.jpg`, draftId).run()
    }
  }

  // Update homepage featured slots: replace old ID with new ID so the page
  // doesn't silently show a stale/empty featured card after the swap.
  // Best-effort: the swap itself already committed — don't let this fail the response.
  try {
    await ensureAdminSettingsTable(db)
    const homepageRow = await db.prepare(
      'SELECT value FROM admin_settings WHERE key = ? LIMIT 1'
    ).bind('homepage').first()
    if (homepageRow?.value) {
      const homepage = safeJsonParse(homepageRow.value, defaultHomepageConfig())
      const before = Array.isArray(homepage.featuredVideoIds) ? homepage.featuredVideoIds : []
      const after  = before.map(id => id === publishedId ? draftId : id)
      if (after.some((id, i) => id !== before[i])) {
        homepage.featuredVideoIds = after
        await db.prepare(`
          INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).bind('homepage', JSON.stringify(homepage)).run()
      }
    }
  } catch (err) {
    console.warn('Homepage featured-slot update failed after swap (non-fatal):', err?.message)
  }

  const [published, retired] = await Promise.all([
    db.prepare('SELECT id, title, publish_status, slug, thumbnail_url FROM videos WHERE id = ?').bind(draftId).first(),
    db.prepare('SELECT id, title, publish_status, slug, thumbnail_url FROM videos WHERE id = ?').bind(publishedId).first(),
  ])

  return jsonResponse({ ok: true, published, retired }, 200, corsHeaders)
}

async function handleAdminPushTest(request, env, corsHeaders) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const user = await requireAuth(request, env).catch(() => null)
  if (!user?.sub) return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)

  const db = getDatabaseBinding(env)
  const subscription = await db.prepare(`
    SELECT endpoint, p256dh, auth, created_at
    FROM push_subscriptions
    WHERE user_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 1
  `).bind(user.sub).first()

  if (!subscription) {
    return jsonResponse(
      { ok: false, error: 'No push subscription found for current user', code: 'missing_subscription' },
      404,
      corsHeaders,
    )
  }

  const endpointHost = safeEndpointHost(subscription.endpoint)
  const payload = {
    title: 'VMP push diagnostic',
    body: `Diagnostic ping ${new Date().toISOString()}`,
    url: `${env.FRONTEND_URL || ''}/account?push-test=1`,
  }

  try {
    const result = await sendPushNotification(subscription, payload, env)
    return jsonResponse({
      ok: true,
      endpointHost,
      subscriptionCreatedAt: subscription.created_at || null,
      delivery: {
        status: result.status,
        statusClass: result.statusClass,
      },
    }, 200, corsHeaders)
  } catch (error) {
    return jsonResponse({
      ok: false,
      endpointHost,
      subscriptionCreatedAt: subscription.created_at || null,
      error: error.message || 'Push test failed',
      code: error.code || 'push_failed',
      delivery: {
        status: error.status ?? null,
        statusClass: error.statusClass ?? null,
        responseSnippet: error.responseSnippet ?? null,
      },
    }, 502, corsHeaders)
  }
}

function safeEndpointHost(endpoint) {
  try {
    return new URL(endpoint).host || null
  } catch {
    return null
  }
}

// ─── Push notification helpers ────────────────────────────────────────────────

/**
 * Returns true if the hostname should be blocked as a push endpoint target.
 * Prevents SSRF by rejecting localhost, loopback, link-local, and RFC-1918 ranges.
 */
function isPrivateHost(hostname) {
  // Reject .local mDNS, localhost, and empty hostnames
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) return true

  // Normalise: strip IPv6 brackets, lowercase
  const h = hostname.replace(/^\[|]$/g, '').toLowerCase()

  // ── IPv4 ──────────────────────────────────────────────────────────────────
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) return isPrivateIPv4Octets(Number(ipv4[1]), Number(ipv4[2]))

  // ── IPv6 ──────────────────────────────────────────────────────────────────
  // Only apply IPv6 checks when the hostname contains ':' (IPv6 addresses always do).
  // Without this guard, domain names like `fcm.googleapis.com` (Chrome's push
  // service) would be falsely flagged as ULA fc00::/7 addresses because they
  // start with "fc".
  if (h.includes(':')) {
    if (h === '::1') return true                          // loopback
    if (h.startsWith('fe80:')) return true                // link-local fe80::/10
    if (h.startsWith('fc') || h.startsWith('fd')) return true // ULA fc00::/7
  }

  // IPv4-mapped IPv6 — ::ffff:x.x.x.x  (covers ::ffff:127.0.0.1 etc.)
  const mapped = h.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    ?? h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mapped) {
    if (mapped.length === 5) {
      // Dotted-decimal form
      return isPrivateIPv4Octets(Number(mapped[1]), Number(mapped[2]))
    }
    // Hex-word form: convert each 16-bit word to two octets
    const a = parseInt(mapped[1], 16)
    return isPrivateIPv4Octets(a >> 8, a & 0xff)
  }

  return false
}

function isPrivateIPv4Octets(a, b) {
  if (a === 10) return true                               // 10.0.0.0/8
  if (a === 127) return true                              // 127.0.0.0/8 loopback
  if (a === 172 && b >= 16 && b <= 31) return true       // 172.16.0.0/12
  if (a === 192 && b === 168) return true                 // 192.168.0.0/16
  if (a === 169 && b === 254) return true                 // 169.254.0.0/16 link-local
  if (a === 0) return true                                // 0.0.0.0/8
  return false
}

// ─── Push notification handlers ───────────────────────────────────────────────

function handleGetVapidPublicKey(request, env, corsHeaders) {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim()
  const privateKey = env.VAPID_PRIVATE_KEY?.trim()
  if (!publicKey || publicKey.startsWith('REPLACE_WITH_') || !privateKey) {
    return jsonResponse({ error: 'VAPID not configured' }, 503, corsHeaders)
  }
  return jsonResponse({ publicKey }, 200, corsHeaders)
}

async function handlePushSubscribe(request, env, corsHeaders) {
  let user
  try {
    user = await requireAuth(request, env)
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const body = await request.json().catch(() => null)
  if (
    typeof body?.endpoint !== 'string' ||
    typeof body?.keys?.p256dh !== 'string' ||
    typeof body?.keys?.auth !== 'string'
  ) {
    return jsonResponse({ error: 'Invalid push subscription object' }, 400, corsHeaders)
  }

  // Validate endpoint to prevent SSRF: must be https and not a private/local host
  let endpointUrl
  try {
    endpointUrl = new URL(body.endpoint)
  } catch {
    return jsonResponse({ error: 'Invalid push endpoint' }, 400, corsHeaders)
  }
  if (endpointUrl.protocol !== 'https:' || isPrivateHost(endpointUrl.hostname)) {
    return jsonResponse({ error: 'Invalid push endpoint' }, 400, corsHeaders)
  }

  const db = getDatabaseBinding(env)
  const id = crypto.randomUUID()
  try {
    await db.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
        p256dh = excluded.p256dh, auth = excluded.auth
    `).bind(id, user.sub, body.endpoint, body.keys.p256dh, body.keys.auth).run()
    return jsonResponse({ ok: true }, 201, corsHeaders)
  } catch (error) {
    console.error('Push subscribe error:', error)
    return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders)
  }
}

async function handlePushUnsubscribe(request, env, corsHeaders) {
  let user
  try {
    user = await requireAuth(request, env)
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const body = await request.json().catch(() => null)
  if (!body?.endpoint) {
    return jsonResponse({ error: 'endpoint is required' }, 400, corsHeaders)
  }

  const db = getDatabaseBinding(env)
  try {
    await db.prepare(
      'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
    ).bind(body.endpoint, user.sub).run()
    return jsonResponse({ ok: true }, 200, corsHeaders)
  } catch (error) {
    console.error('Push unsubscribe error:', error)
    return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders)
  }
}

async function hasProcessedPlaybackArtifact(bucket, videoId) {
  const candidateKeys = [
    // Flat layout produced by the current upload script (rclone copies TMP_DIR
    // directly into videos/{id}/ with no processed/ subdirectory)
    `videos/${videoId}/master.m3u8`,
    // Processed-subdirectory layouts (video-processor pipeline output)
    `videos/${videoId}/processed/playlist.m3u8`,
    `videos/${videoId}/processed/hls/master.m3u8`,
  ]

  for (const key of candidateKeys) {
    const object = await bucket.head(key)
    if (object) return true
  }
  return false
}

// ─── Duration resolver (shared by /video-access and /videos) ───────────────────
//
// Resolves total duration by summing #EXTINF lines in the HLS media playlist.
// Follows a master playlist to its first variant if needed.
// Cached in KV to avoid repeatedly fetching/parsing manifests.

async function resolveVideoDurationSeconds(videoId, env) {
  if (!videoId) return null
  if (!env.R2_BASE_URL) return null

  const kv = env.RATE_LIMIT_KV
  const cacheKey = kv ? `duration:${videoId}` : null
  if (kv && cacheKey) {
    const cached = await kv.get(cacheKey)
    // Three states:
    // - missing key => attempt resolve
    // - sentinel "-1" => treat as unresolvable (short TTL) and return null immediately
    // - positive integer => duration seconds
    if (cached === '-1') return null
    const n = cached ? Number.parseInt(cached, 10) : NaN
    if (Number.isFinite(n) && n > 0) return n
  }

  const candidates = buildEntrypointCandidates(env.R2_BASE_URL, videoId)
  let lastResult = null
  for (const entrypoint of candidates) {
    const result = await resolvePlaylistDurationFromUrl(entrypoint, 0)
    lastResult = result

    if (result.kind === 'ok' && result.duration && result.duration > 0) {
      if (kv && cacheKey) {
        await kv.put(cacheKey, String(result.duration), { expirationTtl: 86400 }) // 24h
      }
      return result.duration
    }

    // If we hit a transient error, stop trying and bubble it up (don't cache)
    if (result.kind === 'transient') {
      return null
    }

    // If not_found, continue to next candidate
  }

  // All candidates returned not_found — write negative cache sentinel
  // Only write -1 for definitive not_found, not for transient errors
  if (lastResult && lastResult.kind === 'not_found') {
    if (kv && cacheKey) {
      await kv.put(cacheKey, '-1', { expirationTtl: 300 }) // 5 minutes
    }
  }
  return null
}

async function resolvePlaylistDurationFromUrl(url, depth = 0) {
  if (!url || depth > 2) return { duration: null, kind: 'not_found' }
  try {
    // Avoid indefinite hangs on upstream fetch (network stalls, origin issues).
    // Prefer AbortSignal.timeout when available; otherwise use AbortController.
    const timeoutMs = 5000
    let controller = null
    let signal = undefined
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(timeoutMs)
    } else if (typeof AbortController !== 'undefined') {
      controller = new AbortController()
      signal = controller.signal
      setTimeout(() => controller.abort(), timeoutMs)
    }

    const res = await fetch(url, signal ? { signal } : undefined)

    // Distinguish between not-found (404) and transient errors
    if (!res.ok) {
      if (res.status === 404) {
        return { duration: null, kind: 'not_found' }
      }
      // Other HTTP errors (5xx, 403, etc.) are transient
      return { duration: null, kind: 'transient' }
    }

    const text = await res.text()
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

    // Media playlist: sum EXTINF segment durations
    const extInf = lines.filter(l => l.startsWith('#EXTINF:'))
    if (extInf.length) {
      const total = extInf.reduce((sum, l) => {
        const n = Number.parseFloat(l.slice('#EXTINF:'.length))
        return Number.isFinite(n) ? sum + n : sum
      }, 0)
      const rounded = Math.round(total)
      if (Number.isFinite(rounded) && rounded > 0) {
        return { duration: rounded, kind: 'ok' }
      }
      return { duration: null, kind: 'not_found' }
    }

    // Master playlist: follow first variant
    const idx = lines.findIndex(l => l.startsWith('#EXT-X-STREAM-INF'))
    if (idx >= 0 && lines[idx + 1]) {
      const nextUrl = new URL(lines[idx + 1], url).toString()
      return resolvePlaylistDurationFromUrl(nextUrl, depth + 1)
    }
  } catch (error) {
    // Network errors, timeouts, and aborts are transient
    return { duration: null, kind: 'transient' }
  } finally {
    if (controller) clearTimeout()
  }
  return { duration: null, kind: 'not_found' }
}

// ─── All the unchanged helper functions from the original index.js ─────────────

function getManifestType(objectPath, upstreamResponse) {
  if (objectPath.endsWith('.m3u8')) return 'hls'
  const ct = upstreamResponse.headers.get('content-type') ?? ''
  if (/application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl/i.test(ct)) return 'hls'
  return null
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
  } else if (path.startsWith('videos/')) {
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

function normalizeVideoId(input) {
  const t = (input ?? '').trim()
  const m = t.match(/^videos\/([^/]+)\/processed\/playlist\.m3u8$/i)
  return m ? m[1] : t
}

// Resolve a video row by ID first, then by vanity slug.
// Returns the D1 row or null.
async function resolveVideoByIdOrSlug(db, idOrSlug) {
  const byId = await db.prepare('SELECT * FROM videos WHERE id = ?').bind(idOrSlug).first()
  if (byId) return byId
  return db.prepare('SELECT * FROM videos WHERE slug = ?').bind(idOrSlug).first()
}

// Validate a vanity slug format: lowercase alphanumeric words separated by hyphens.
function isValidSlug(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
}

async function resolveMediaEntrypointUrl({ env, videoId }) {
  const base = env.R2_BASE_URL
  const candidates = buildEntrypointCandidates(base, videoId)
  for (const c of candidates) { if (await canLoadEntrypoint(c)) return c }
  return candidates[0]
}

function buildEntrypointCandidates(base, videoId) {
  // All videos live under videos/{id}/.  Flat layout (rclone output directly
  // under videos/{id}/) is checked first; processed/ subdirectory is kept for
  // older uploads that went through the video-processor pipeline.
  return [
    `${base}/videos/${videoId}/master.m3u8`,
    `${base}/videos/${videoId}/processed/hls/master.m3u8`,
    `${base}/videos/${videoId}/processed/playlist.m3u8`,
  ]
}

function buildProxyPlaylistUrl(request, playlistUrl, previewUntilSeconds) {
  const origin = new URL(request.url).origin
  const upstream = new URL(playlistUrl)
  const u = new URL(`${origin}/api/video-proxy${upstream.pathname}`)
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