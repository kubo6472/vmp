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
  requireAuth,
  requireRole,
} from './auth.js'

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
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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
    if (url.pathname === '/api/admin/config') {
      return handleAdminConfig(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/preview-locks') {
      return handlePreviewLocks(request, env, corsHeaders)
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
    const videos = await db.prepare(`
      SELECT id, title, description, thumbnail_url, full_duration, preview_duration, upload_date
      FROM videos
      ORDER BY upload_date DESC
    `).all()
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
    const db = getDatabaseBinding(env)

    const subscription = userId
      ? await db.prepare(`
        SELECT s.*, u.email
        FROM subscriptions s
        JOIN users u ON u.id = s.user_id
        WHERE s.user_id = ? AND s.status = 'active'
        ORDER BY s.created_at DESC
        LIMIT 1
      `).bind(userId).first()
      : null

    const video = await db.prepare('SELECT * FROM videos WHERE id = ?').bind(videoId).first()
    const hasPremiumAccess = Boolean(subscription &&
      subscription.plan_type === 'premium' &&
      (subscription.expires_at === null || new Date(subscription.expires_at) > new Date()))

    const hasVideoMetadata = Boolean(video)
    const hasAccess = hasPremiumAccess || !hasVideoMetadata
    const requestedProtocol = normalizeProtocolOption(url.searchParams.get('protocol')) ?? 'hls'
    const resolvedEntrypointUrl = await resolveMediaEntrypointUrl({ env, videoId, hasPremiumAccess: true, protocol: requestedProtocol })
    const previewDuration = video?.preview_duration ?? video?.full_duration ?? 0
    const playlistUrl = buildProxyPlaylistUrl(request, resolvedEntrypointUrl, hasPremiumAccess ? null : previewDuration, requestedProtocol)
    const fullDuration = video?.full_duration ?? previewDuration

    const response = {
      userId: userId ?? null,
      videoId,
      hasAccess,
      subscription: {
        planType: subscription ? subscription.plan_type : 'free',
        status: subscription ? subscription.status : 'none',
        expiresAt: subscription ? subscription.expires_at : null,
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
  const upstreamUrl = new URL(`${env.R2_BASE_URL}/${objectPath}`)
  const upstreamHeaders = new Headers()
  const rangeHeader = request.headers.get('Range')
  if (rangeHeader) upstreamHeaders.set('Range', rangeHeader)
  const upstreamResponse = await fetch(upstreamUrl, { method: request.method, headers: upstreamHeaders })
  const manifestType = getManifestType(objectPath, upstreamResponse, requestedProtocol)
  if (manifestType === 'hls') {
    const manifest = await upstreamResponse.text()
    const rewrittenManifest = rewriteManifestForProxyWithPreview(manifest, previewUntilSeconds)
    const headers = new Headers(upstreamResponse.headers)
    headers.set('Content-Type', 'application/vnd.apple.mpegurl')
    headers.delete('Content-Length')
    for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v)
    return new Response(rewrittenManifest, { status: upstreamResponse.status, headers })
  }
  if (manifestType === 'dash') {
    if (previewUntilSeconds !== null) return jsonResponse({ error: 'Preview lock not supported for DASH' }, 501, corsHeaders)
    const manifest = await upstreamResponse.text()
    const rewrittenManifest = rewriteDashManifestForProxy(manifest)
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
    await db.prepare('UPDATE videos SET preview_duration = MIN(full_duration, ?) WHERE id = ?').bind(lockSeconds, lockEntry.videoId).run()
  }
  return jsonResponse({ ok: true }, 200, corsHeaders)
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

function rewriteManifestForProxyWithPreview(manifest, previewUntilSeconds) {
  const lines = manifest.split('\n')
  const hasPreviewLimit = typeof previewUntilSeconds === 'number' && previewUntilSeconds > 0
  const isMediaPlaylist = lines.some(l => l.trim().startsWith('#EXTINF:'))
  const isMasterPlaylist = lines.some(l => l.trim().startsWith('#EXT-X-STREAM-INF'))
  const previewQuery = hasPreviewLimit ? `previewUntil=${Math.floor(previewUntilSeconds)}` : null
  if (hasPreviewLimit && isMediaPlaylist) {
    let elapsed = 0, pending = null
    const out = []
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith('#')) {
        if (t.startsWith('#EXTINF:')) pending = Number.parseFloat(t.slice('#EXTINF:'.length)) || 0
        if (t !== '#EXT-X-ENDLIST') out.push(line)
        continue
      }
      if (elapsed >= previewUntilSeconds) break
      out.push(rewriteSegmentPath(t, previewQuery))
      elapsed += pending ?? 0
      pending = null
    }
    out.push('#EXT-X-ENDLIST')
    return out.join('\n')
  }
  return lines.map(line => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return line
    return rewriteSegmentPath(t, isMasterPlaylist && hasPreviewLimit ? previewQuery : null)
  }).join('\n')
}

function rewriteDashManifestForProxy(mpdManifest) {
  let r = mpdManifest.replace(/<BaseURL([^>]*)>([^<]+)<\/BaseURL>/gi, (_, attrs, value) => {
    const v = value.trim()
    return v ? `<BaseURL${attrs}>${rewriteSegmentPath(v, null)}</BaseURL>` : _
  })
  return r.replace(/\b(initialization|media|sourceURL)=["']([^"']+)["']/gi, (_, attr, value) => `${attr}="${rewriteSegmentPath(value, null)}"`)
}

function rewriteSegmentPath(path, query) {
  let proxied
  if (/^https?:\/\//i.test(path)) {
    const u = new URL(path)
    proxied = `/api/video-proxy${u.pathname}${u.search}`
  } else if (path.startsWith('/')) {
    proxied = `/api/video-proxy${path}`
  } else if (/^(videos|preview|full)\//i.test(path)) {
    proxied = `/api/video-proxy/${path}`
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
    return protocol === 'dash'
      ? [`${base}/videos/${videoId}/processed/manifest.mpd`, `${base}/videos/${videoId}/processed/playlist.mpd`]
      : [`${base}/videos/${videoId}/processed/playlist.m3u8`]
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
          type:  typeof b.type  === 'string' ? b.type  : 'hero',
          title: typeof b.title === 'string' ? b.title : '',
          body:  typeof b.body  === 'string' ? b.body  : '',
        }))
      : [],
  }
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
