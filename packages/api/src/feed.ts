/**
 * packages/api/src/feed.js
 *
 * RSS / Podcast feed endpoints (Step 9).
 *
 * Note: enclosures prefer HLS (preview-truncated) or `podcast_preview.mp3` when a preview
 * cap applies, else full `podcast.mp3`, all proxied through /api/video-proxy. We rely on
 * `vt` tokens (HMAC, short-lived) for access control and preview truncation.
 */
 
import { isAdministrativeRole } from './roles.js'
import { signVideoToken } from './videoTokens.js'
import { resolveMediaEntrypointUrl, buildProxyPlaylistUrl } from './mediaEntrypoints.js'
import { computeRssTokenHex } from './rssToken.js'
import { getSetting } from './settingsStore.js'
import { getReadSession, applySessionBookmark, getDb } from './d1Session.js'
 
function xmlEscape(text: any) {
  if (text == null) return ''
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
 
function toRfc2822Date(isoLike: any) {
  try {
    const d = isoLike ? new Date(isoLike) : new Date()
    // RSS pubDate should be RFC-822/2822. JS Date toUTCString is close enough.
    return d.toUTCString()
  } catch {
    return new Date().toUTCString()
  }
}
 
function secondsToItunesDuration(seconds: any) {
  const s = Number.parseInt(String(seconds ?? 0), 10)
  if (!Number.isFinite(s) || s <= 0) return '0:00'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

function getErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function cdataSafe(text: unknown): string {
  return String(text ?? '').replaceAll(']]>', ']]]]><![CDATA[>')
}

function inferEnclosureContentType(enclosureUrl: unknown) {
  const pathname = (() => {
    const normalizedUrl = String(enclosureUrl ?? '')
    try {
      return new URL(normalizedUrl).pathname.toLowerCase()
    } catch {
      return normalizedUrl.toLowerCase()
    }
  })()
  if (pathname.endsWith('.mp3')) return 'audio/mpeg'
  if (pathname.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl'
  return 'application/octet-stream'
}

function buildSquareCoverImageUrl(imageUrl: unknown) {
  const normalized = String(imageUrl ?? '').trim()
  if (!normalized) return null
  try {
    const source = new URL(normalized)
    // Use Cloudflare Image Resizing syntax to force a square podcast-art result.
    // Podcast apps often require 1:1 cover images on both channel and item level.
    return `${source.origin}/cdn-cgi/image/fit=cover,width=1400,height=1400/${source.pathname.replace(/^\/+/, '')}`
  } catch {
    return normalized
  }
}

function buildFeedFaviconUrl(request: any, env: any) {
  const requestOrigin = new URL(request.url).origin
  const rawOrigin = String(env.FRONTEND_URL || requestOrigin)
  let frontendOrigin = rawOrigin
  while (frontendOrigin.length > 0 && frontendOrigin.endsWith('/')) {
    frontendOrigin = frontendOrigin.slice(0, -1)
  }
  if (!frontendOrigin) frontendOrigin = requestOrigin
  return `${frontendOrigin}/favicon.ico`
}
 
function buildRssXml({
  channel,
  items
}: any) {
  const itunesNs = 'http://www.itunes.com/dtds/podcast-1.0.dtd'
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<rss version="2.0" xmlns:itunes="${itunesNs}">`,
    '<channel>',
    `<title>${xmlEscape(channel.title)}</title>`,
    `<description>${xmlEscape(channel.description)}</description>`,
    `<link>${xmlEscape(channel.link)}</link>`,
    `<language>${xmlEscape(channel.language || 'en')}</language>`,
    channel.imageUrl ? `<itunes:image href="${xmlEscape(channel.imageUrl)}" />` : '',
    ...items.map((item: any) => [
      '<item>',
      `<title>${xmlEscape(item.title)}</title>`,
      `<description><![CDATA[${cdataSafe(item.description)}]]></description>`,
      `<guid isPermaLink="false">${xmlEscape(item.guid)}</guid>`,
      `<pubDate>${xmlEscape(item.pubDate)}</pubDate>`,
      `<enclosure url="${xmlEscape(item.enclosureUrl)}" type="${xmlEscape(item.enclosureType)}" length="${xmlEscape(item.enclosureLength)}" />`,
      item.imageUrl ? `<itunes:image href="${xmlEscape(item.imageUrl)}" />` : '',
      `<itunes:duration>${xmlEscape(item.itunesDuration)}</itunes:duration>`,
      '<itunes:explicit>false</itunes:explicit>',
      '</item>',
    ].filter(Boolean).join('\n')),
    '</channel>',
    '</rss>',
  ].filter(Boolean).join('\n');
}
 
async function listPublishedVideos(db: any) {
  // Support both old (visibility-based) and new (publish_status-based) schemas.
  // Some local dev D1 states may not have the newer publish_status column yet.
  try {
    const byPublishStatus = await db.prepare(`
      SELECT id, title, description, thumbnail_url, full_duration, preview_duration, published_at, updated_at
      FROM videos
      WHERE publish_status = 'published'
      ORDER BY datetime(published_at) DESC, datetime(upload_date) DESC
    `).all()
    return byPublishStatus.results || []
  } catch {
    // Fall back to the legacy visibility column.
  }
  const rows = await db.prepare(`
    SELECT id, title, description, thumbnail_url, full_duration, preview_duration, published_at, updated_at
    FROM videos
    WHERE visibility = 'public'
    ORDER BY datetime(published_at) DESC, datetime(upload_date) DESC
  `).all()
  return rows.results || []
}

async function sha256HexOfString(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')
}

/** Bust RSS edge cache when preview windows or metadata change (per-video). */
async function rssFeedVersionFingerprint(rows: any[]): Promise<string> {
  const parts = (rows || []).map((v: any) => {
    const id = v.id ?? ''
    const p = Number(v.preview_duration ?? 0) || 0
    const u = v.updated_at != null ? String(v.updated_at) : ''
    return `${id}:${p}:${u}`
  })
  parts.sort()
  return sha256HexOfString(parts.join('|'))
}

function entrypointPathnameLower(entrypointUrl: unknown): string {
  try {
    return new URL(String(entrypointUrl ?? '')).pathname.toLowerCase()
  } catch {
    return ''
  }
}

async function buildRssEnclosureForVideo({
  request,
  env,
  videoId,
  vtUserId,
  previewUntilSeconds,
  v,
}: {
  request: any
  env: any
  videoId: string
  vtUserId: string
  previewUntilSeconds: number | null
  v: any
}) {
  const hasPreviewCap = previewUntilSeconds !== null
    && typeof previewUntilSeconds === 'number'
    && previewUntilSeconds > 0

  const entrypointUrl = await resolveMediaEntrypointUrl({
    env,
    videoId,
    preferPodcast: true,
    rssPreview: hasPreviewCap,
  })

  const pathLower = entrypointPathnameLower(entrypointUrl)
  const isMp3 = pathLower.endsWith('.mp3')
  const proxyPreviewSeconds = isMp3 && hasPreviewCap ? null : (hasPreviewCap ? previewUntilSeconds : null)

  const basePlaylistUrl = buildProxyPlaylistUrl(request, entrypointUrl, proxyPreviewSeconds)

  let enclosureUrl = basePlaylistUrl
  if (env.JWT_SECRET) {
    const vt = await signVideoToken(
      vtUserId,
      videoId,
      env.JWT_SECRET,
      hasPreviewCap ? previewUntilSeconds : null,
      { ttlSeconds: 60 * 60 * 24 * 30 },
    )
    enclosureUrl = basePlaylistUrl.includes('?') ? `${basePlaylistUrl}&vt=${vt}` : `${basePlaylistUrl}?vt=${vt}`
  }

  let itunesDurationStr: string
  const previewDuration = Number(v.preview_duration ?? 0) || 0
  const fullDuration = Number(v.full_duration ?? 0) || 0
  const mediaDuration = fullDuration > 0 ? fullDuration : previewDuration
  const isTruncatedPreview = hasPreviewCap
    && typeof previewUntilSeconds === 'number'
    && previewUntilSeconds > 0
    && previewUntilSeconds < mediaDuration
  const effectiveDurationSeconds = isTruncatedPreview
    ? previewUntilSeconds
    : (mediaDuration > 0 ? mediaDuration : (hasPreviewCap ? previewUntilSeconds : 0))
  if (isTruncatedPreview) {
    itunesDurationStr = secondsToItunesDuration(previewUntilSeconds)
  } else {
    itunesDurationStr = secondsToItunesDuration(mediaDuration)
  }
  const enclosureType = inferEnclosureContentType(entrypointUrl)
  const persistedSize = Number(
    v.media_size_bytes
      ?? v.podcast_size_bytes
      ?? v.audio_size_bytes
      ?? 0,
  ) || 0
  let enclosureLength = persistedSize > 0 ? persistedSize : 0
  if (!enclosureLength) {
    try {
      const head = await fetch(entrypointUrl, { method: 'HEAD' })
      if (head.ok) {
        const contentLength = Number(head.headers.get('content-length') || 0)
        if (Number.isFinite(contentLength) && contentLength > 0) enclosureLength = contentLength
      }
    } catch {
      // Best-effort; RSS generation must not fail if HEAD is unavailable.
    }
  }
  if (!enclosureLength) {
    if (enclosureType === 'application/vnd.apple.mpegurl') {
      // HLS manifests are tiny text files; keep non-zero for strict clients.
      enclosureLength = 1024
    } else if (enclosureType === 'audio/mpeg') {
      // Last-resort CBR-ish estimate when no byte metadata is available.
      enclosureLength = Math.max(1, Math.round(effectiveDurationSeconds * 24000))
    } else {
      enclosureLength = 1
    }
  }

  return {
    title: v.title || `Episode ${videoId}`,
    description: v.description || '',
    guid: videoId,
    pubDate: toRfc2822Date(v.published_at),
    enclosureUrl,
    enclosureType,
    enclosureLength,
    imageUrl: buildSquareCoverImageUrl(v.thumbnail_url),
    itunesDuration: itunesDurationStr,
  }
}
 
function feedResponse(xml: any, corsHeaders: any, cacheControl: any) {
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': cacheControl,
      ...corsHeaders,
    },
  })
}
 
function feedCacheKey(request: any, extraParams = {}) {
  const u = new URL(request.url)
  // Never include raw tokens in cache keys.
  const base = `${u.origin}${u.pathname}`
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(extraParams)) {
    if (v == null) continue
    params.set(k, String(v))
  }
  const suffix = params.toString()
  return new Request(suffix ? `${base}?${suffix}` : base, { method: 'GET' })
}

function getDefaultCache(): Cache | null {
  const maybeDefault = (caches as unknown as { default?: Cache }).default
  return maybeDefault ?? null
}

async function recordFeedPoll(db: any, {
  endpoint,
  userId
}: any) {
  try {
    await db.prepare(`
      INSERT INTO rss_feed_polls (endpoint, user_id, poll_count, last_polled_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(endpoint, user_id) DO UPDATE SET
        poll_count = poll_count + 1,
        last_polled_at = CURRENT_TIMESTAMP
    `).bind(endpoint, userId ?? 'public').run()
  } catch (e) {
    // Best-effort: analytics must never break feed delivery.
    console.warn('[rss] recordFeedPoll failed', getErrorMessage(e))
  }
}

function constantTimeEqual(a: any, b: any) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function getUserById(db: any, userId: any) {
  return db.prepare('SELECT id, email, role FROM users WHERE id = ? LIMIT 1').bind(userId).first()
}

async function getActiveSubscriptionRow(db: any, userId: any) {
  return db.prepare(`
    SELECT *
    FROM subscriptions
    WHERE user_id = ? AND status IN ('active', 'trialing')
      AND (current_period_end IS NULL OR datetime(current_period_end) > CURRENT_TIMESTAMP)
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(userId).first()
}

export async function handlePublicFeed(request: any, env: any, corsHeaders: any) {
  try {
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const { session } = getReadSession(env, request)
    const db = getDb(env)
    const cache = getDefaultCache()
    const publicPollMeta = { endpoint: 'feed_public', userId: 'public' }

    const videos = await listPublishedVideos(session)
    const feedV = await rssFeedVersionFingerprint(videos)

    if (cache) {
      const cached = await cache.match(feedCacheKey(request, { v: 2, fp: feedV }))
      if (cached) {
        await recordFeedPoll(db, publicPollMeta)
        return cached
      }
    }
    const origin = new URL(request.url).origin

    const [titleSetting, descSetting] = await Promise.all([
      getSetting(env, 'podcast_title', { defaultValue: null }),
      getSetting(env, 'podcast_description', { defaultValue: null }),
    ])

    const siteLogoUrl = await getSetting(env, 'site_logo_url', { defaultValue: null })
    const channelImageUrl = siteLogoUrl
      ? buildSquareCoverImageUrl(siteLogoUrl) ?? buildFeedFaviconUrl(request, env)
      : buildFeedFaviconUrl(request, env)

    const channel = {
      title: titleSetting || 'VMP Podcast',
      description: descSetting || 'Preview episodes from VMP. Subscribe to unlock full access in your personal feed.',
      link: env.FRONTEND_URL || origin,
      language: 'en',
      imageUrl: channelImageUrl,
    }

    const items = []
    for (const v of videos) {
      const videoId = v.id
      if (!videoId) continue
      const previewDuration = v.preview_duration ?? 0
      if (!previewDuration || previewDuration <= 0) continue
      const previewUntil = previewDuration
      items.push(await buildRssEnclosureForVideo({
        request,
        env,
        videoId,
        vtUserId: 'anonymous',
        previewUntilSeconds: previewUntil,
        v,
      }))
    }

    const xml = buildRssXml({ channel, items })
    await recordFeedPoll(db, publicPollMeta)
    const response = feedResponse(xml, corsHeaders, 'public, max-age=300, s-maxage=300')
    applySessionBookmark(response.headers, session)
    if (cache) await cache.put(feedCacheKey(request, { v: 2, fp: feedV }), response.clone())
    return response
  } catch (err: unknown) {
    const message = getErrorMessage(err)
    console.error('[feed] handlePublicFeed failed:', message)
    return new Response(
      JSON.stringify({ error: 'Internal error', code: 'internal_error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    )
  }
}
 
export async function handlePersonalFeed(request: any, env: any, corsHeaders: any) {
  try {
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const rssSecret = env.RSS_SECRET?.trim()
    if (!rssSecret) {
      return new Response(JSON.stringify({ error: 'RSS not configured' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean) // api, feed, :userId, :token
    if (parts.length !== 4) {
      return new Response(JSON.stringify({ error: 'Invalid path format' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const userId = parts[2]
    const token = parts[3]
    if (!userId || !token) {
      return new Response(JSON.stringify({ error: 'Invalid path format' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const cache = getDefaultCache()
    const expectedToken = await computeRssTokenHex(rssSecret, userId)
    if (!constantTimeEqual(expectedToken, token)) {
      // 404 to avoid leaking valid user IDs.
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const { session } = getReadSession(env, request)
    const db = getDb(env)
    const user = await getUserById(session, userId)
    if (!user) {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const subscription = await getActiveSubscriptionRow(session, userId)
    const hasPremiumAccess = isAdministrativeRole(user.role) || Boolean(subscription)
    const userPollMeta = { endpoint: 'feed_user', userId }

    const videos = await listPublishedVideos(session)
    const feedV = await rssFeedVersionFingerprint(videos)

    if (cache) {
      const cached = await cache.match(feedCacheKey(request, {
        v: 2,
        fp: feedV,
        uid: userId,
        premium: hasPremiumAccess ? 1 : 0,
      }))
      if (cached) {
        await recordFeedPoll(db, userPollMeta)
        return cached
      }
    }

    const origin = new URL(request.url).origin
    const [titleSetting, descSetting] = await Promise.all([
      getSetting(env, 'podcast_title', { defaultValue: null }),
      getSetting(env, 'podcast_description', { defaultValue: null }),
    ])

    const siteLogoUrlPersonal = await getSetting(env, 'site_logo_url', { defaultValue: null })
    const personalChannelImage = siteLogoUrlPersonal
      ? buildSquareCoverImageUrl(siteLogoUrlPersonal) ?? buildFeedFaviconUrl(request, env)
      : buildFeedFaviconUrl(request, env)

    const channel = {
      title: titleSetting || 'VMP Podcast',
      description: descSetting || 'Your VMP podcast feed.',
      link: env.FRONTEND_URL || origin,
      language: 'en',
      imageUrl: personalChannelImage,
    }

    const items = []
    for (const v of videos) {
      const videoId = v.id
      if (!videoId) continue

      if (!hasPremiumAccess) {
        const previewDuration = v.preview_duration ?? 0
        if (!previewDuration || previewDuration <= 0) continue
        const previewUntil = previewDuration
        items.push(await buildRssEnclosureForVideo({
          request,
          env,
          videoId,
          vtUserId: userId,
          previewUntilSeconds: previewUntil,
          v,
        }))
      } else {
        items.push(await buildRssEnclosureForVideo({
          request,
          env,
          videoId,
          vtUserId: userId,
          previewUntilSeconds: null,
          v,
        }))
      }
    }

    const xml = buildRssXml({ channel, items })
    await recordFeedPoll(db, userPollMeta)
    const response = feedResponse(xml, corsHeaders, 'private, max-age=300, stale-while-revalidate=60')
    applySessionBookmark(response.headers, session)
    if (cache) {
      await cache.put(
        feedCacheKey(request, { v: 2, fp: feedV, uid: userId, premium: hasPremiumAccess ? 1 : 0 }),
        response.clone(),
      )
    }
    return response
  } catch (err: unknown) {
    const message = getErrorMessage(err)
    console.error('[feed] handlePersonalFeed failed:', message)
    return new Response(
      JSON.stringify({ error: 'Internal error', code: 'internal_error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    )
  }
}