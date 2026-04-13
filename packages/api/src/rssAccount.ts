/**
 * packages/api/src/rssAccount.js
 *
 * Account helper endpoint to return RSS feed URLs for the signed-in user.
 * Podcast clients typically cannot send Authorization headers, so the personal
 * feed URL includes a stable HMAC token.
 */

import { requireAuth } from './auth.js'
import { computeRssTokenHex } from './rssToken.js'

function jsonResponse(data: any, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

export async function handleGetAccountRss(request: any, env: any, corsHeaders: any) {
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

