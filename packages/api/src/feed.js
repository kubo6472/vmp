/**
 * packages/api/src/feed.js
 *
 * RSS / Podcast feed endpoints (Step 9).
 *
 * Note: enclosures point at HLS master playlists proxied through /api/video-proxy.
 * We rely on `vt` tokens (HMAC, short-lived) for access control and preview truncation.
 */
 
import { isAdministrativeRole } from './roles.js'
import { signVideoToken } from './videoTokens.js'
import { resolveMediaEntrypointUrl, buildProxyPlaylistUrl } from './mediaEntrypoints.js'
import { computeRssTokenHex } from './rssToken.js'
import { getSetting } from './settingsStore.js'
import { getReadSession, applySessionBookmark, getDb } from './d1Session.js'
 
function xmlEscape(text) {
  if (text == null) return ''
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
 
function toRfc2822Date(isoLike) {
  try {
    const d = isoLike ? new Date(isoLike) : new Date()
    // RSS pubDate should be RFC-822/2822. JS Date toUTCString is close enough.
    return d.toUTCString()
  } catch {
    return new Date().toUTCString()
  }
}
 
function secondsToItunesDuration(seconds) {
  const s = Number.parseInt(String(seconds ?? 0), 10)
  if (!Number.isFinite(s) || s <= 0) return '0:00'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}
 
function buildRssXml({ channel, items }) {
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
    ...items.map(item => [
      '<item>',
      `<title>${xmlEscape(item.title)}</title>`,
      `<description><![CDATA[${item.description ?? ''}]]></description>`,
      `<guid isPermaLink="false">${xmlEscape(item.guid)}</guid>`,
      `<pubDate>${xmlEscape(item.pubDate)}</pubDate>`,
      `<enclosure url="${xmlEscape(item.enclosureUrl)}" type="${xmlEscape(item.enclosureType)}" />`,
      `<itunes:duration>${xmlEscape(item.itunesDuration)}</itunes:duration>`,
      '<itunes:explicit>false</itunes:explicit>',
      '</item>',
    ].filter(Boolean).join('\n')),
    '</channel>',
    '</rss>',
  ].filter(Boolean).join('\n')
}
 
async function listPublishedVideos(db) {
  // Support both old (visibility-based) and new (publish_status-based) schemas.
  // Some local dev D1 states may not have the newer publish_status column yet.
  try {
    const byPublishStatus = await db.prepare(`
      SELECT id, title, description, full_duration, preview_duration, published_at
      FROM videos
      WHERE publish_status = 'published'
      ORDER BY datetime(published_at) DESC, datetime(upload_date) DESC
    `).all()
    return byPublishStatus.results || []
  } catch {
    // Fall back to the legacy visibility column.
  }
  const rows = await db.prepare(`
    SELECT id, title, description, full_duration, preview_duration, published_at
    FROM videos
    WHERE visibility = 'public'
    ORDER BY datetime(published_at) DESC, datetime(upload_date) DESC
  `).all()
  return rows.results || []
}
 
function feedResponse(xml, corsHeaders, cacheControl) {
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': cacheControl,
      ...corsHeaders,
    },
  })
}
 
function feedCacheKey(request, extraParams = {}) {
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

async function recordFeedPoll(db, { endpoint, userId }) {
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
    console.warn('[rss] recordFeedPoll failed', e?.message ?? e)
  }
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function getUserById(db, userId) {
  return db.prepare('SELECT id, email, role FROM users WHERE id = ? LIMIT 1').bind(userId).first()
}

async function getActiveSubscriptionRow(db, userId) {
  return db.prepare(`
    SELECT *
    FROM subscriptions
    WHERE user_id = ? AND status IN ('active', 'trialing')
      AND (current_period_end IS NULL OR datetime(current_period_end) > CURRENT_TIMESTAMP)
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(userId).first()
}

export async function handlePublicFeed(request, env, corsHeaders) {
  try {
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const { session } = getReadSession(env, request)
    const db = getDb(env)
    const cache = caches?.default
    const publicPollMeta = { endpoint: 'feed_public', userId: 'public' }
    if (cache) {
      const cached = await cache.match(feedCacheKey(request, { v: 1 }))
      if (cached) {
        await recordFeedPoll(db, publicPollMeta)
        return cached
      }
    }
    const origin = new URL(request.url).origin

    const [titleSetting, descSetting, imageSetting] = await Promise.all([
      getSetting(env, 'podcast_title', { defaultValue: null }),
      getSetting(env, 'podcast_description', { defaultValue: null }),
      getSetting(env, 'podcast_image_url', { defaultValue: null }),
    ])

    const channel = {
      title: titleSetting || 'VMP Podcast',
      description: descSetting || 'Preview episodes from VMP. Subscribe to unlock full access in your personal feed.',
      link: env.FRONTEND_URL || origin,
      language: 'en',
      imageUrl: imageSetting,
    }

    const videos = await listPublishedVideos(session)

    const items = []
    for (const v of videos) {
      const videoId = v.id
      if (!videoId) continue
      const previewDuration = v.preview_duration ?? v.full_duration ?? 0
      const entrypointUrl = await resolveMediaEntrypointUrl({ env, videoId })
      const basePlaylistUrl = buildProxyPlaylistUrl(request, entrypointUrl, previewDuration && previewDuration > 0 ? previewDuration : null)

      let enclosureUrl = basePlaylistUrl
      if (env.JWT_SECRET) {
        const vt = await signVideoToken(
          'anonymous',
          videoId,
          env.JWT_SECRET,
          previewDuration && previewDuration > 0 ? previewDuration : null,
          { ttlSeconds: 60 * 60 * 24 * 30 }
        )
        enclosureUrl = basePlaylistUrl.includes('?') ? `${basePlaylistUrl}&vt=${vt}` : `${basePlaylistUrl}?vt=${vt}`
      }

      items.push({
        title: v.title || `Episode ${videoId}`,
        description: v.description || '',
        guid: videoId,
        pubDate: toRfc2822Date(v.published_at),
        enclosureUrl,
        enclosureType: 'application/vnd.apple.mpegurl',
        itunesDuration: secondsToItunesDuration(v.full_duration ?? previewDuration ?? 0),
      })
    }

    const xml = buildRssXml({ channel, items })
    await recordFeedPoll(db, publicPollMeta)
    const response = feedResponse(xml, corsHeaders, 'public, max-age=300, s-maxage=300')
    applySessionBookmark(response.headers, session)
    if (cache) await cache.put(feedCacheKey(request, { v: 1 }), response.clone())
    return response
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err?.message || 'Internal error', code: 'internal_error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    )
  }
}
 
export async function handlePersonalFeed(request, env, corsHeaders) {
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

    const cache = caches?.default
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
    if (cache) {
      const cached = await cache.match(feedCacheKey(request, { v: 1, uid: userId, premium: hasPremiumAccess ? 1 : 0 }))
      if (cached) {
        await recordFeedPoll(db, userPollMeta)
        return cached
      }
    }

    const origin = new URL(request.url).origin
    const [titleSetting, descSetting, imageSetting] = await Promise.all([
      getSetting(env, 'podcast_title', { defaultValue: null }),
      getSetting(env, 'podcast_description', { defaultValue: null }),
      getSetting(env, 'podcast_image_url', { defaultValue: null }),
    ])

    const channel = {
      title: titleSetting || 'VMP Podcast',
      description: descSetting || 'Your VMP podcast feed.',
      link: env.FRONTEND_URL || origin,
      language: 'en',
      imageUrl: imageSetting,
    }

    const videos = await listPublishedVideos(session)

    const items = []
    for (const v of videos) {
      const videoId = v.id
      if (!videoId) continue

      const previewDuration = v.preview_duration ?? v.full_duration ?? 0
      const previewUntil = hasPremiumAccess ? null : (previewDuration && previewDuration > 0 ? previewDuration : null)

      const entrypointUrl = await resolveMediaEntrypointUrl({ env, videoId })
      const basePlaylistUrl = buildProxyPlaylistUrl(request, entrypointUrl, previewUntil && previewUntil > 0 ? previewUntil : null)

      let enclosureUrl = basePlaylistUrl
      if (env.JWT_SECRET) {
        const vt = await signVideoToken(
          userId,
          videoId,
          env.JWT_SECRET,
          previewUntil,
          { ttlSeconds: 60 * 60 * 24 * 30 }
        )
        enclosureUrl = basePlaylistUrl.includes('?') ? `${basePlaylistUrl}&vt=${vt}` : `${basePlaylistUrl}?vt=${vt}`
      }

      items.push({
        title: v.title || `Episode ${videoId}`,
        description: v.description || '',
        guid: videoId,
        pubDate: toRfc2822Date(v.published_at),
        enclosureUrl,
        enclosureType: 'application/vnd.apple.mpegurl',
        itunesDuration: secondsToItunesDuration(v.full_duration ?? previewDuration ?? 0),
      })
    }

    const xml = buildRssXml({ channel, items })
    await recordFeedPoll(db, userPollMeta)
    const response = feedResponse(xml, corsHeaders, 'private, max-age=300, stale-while-revalidate=60')
    applySessionBookmark(response.headers, session)
    if (cache) await cache.put(feedCacheKey(request, { v: 1, uid: userId, premium: hasPremiumAccess ? 1 : 0 }), response.clone())
    return response
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err?.message || 'Internal error', code: 'internal_error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    )
  }
}

