/**
 * packages/api/src/rssAccount.js
 *
 * Account helper endpoint to return RSS feed URLs for the signed-in user.
 * Podcast clients typically cannot send Authorization headers, so the personal
 * feed URL includes a stable HMAC token.
 */

import { requireAuth } from './auth.js'

function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

function hexFromBytes(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

async function importRssHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

async function computeRssTokenHex(rssSecret, userId) {
  const key = await importRssHmacKey(rssSecret)
  const msg = new TextEncoder().encode(`rss:${userId}`)
  const sig = await crypto.subtle.sign('HMAC', key, msg)
  return hexFromBytes(new Uint8Array(sig))
}

export async function handleGetAccountRss(request, env, corsHeaders) {
  let user
  try {
    user = await requireAuth(request, env)
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const rssSecret = env.RSS_SECRET?.trim()
  if (!rssSecret) {
    return jsonResponse({ error: 'RSS not configured' }, 503, corsHeaders)
  }

  const origin = new URL(request.url).origin
  const userId = user.sub
  const token = await computeRssTokenHex(rssSecret, userId)

  return jsonResponse({
    publicUrl: `${origin}/api/feed/public`,
    personalUrl: `${origin}/api/feed/${encodeURIComponent(userId)}/${token}`,
  }, 200, corsHeaders)
}

