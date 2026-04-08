/**
 * packages/api/src/rssToken.js
 *
 * Shared HMAC helper for stable per-user RSS feed tokens.
 */

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

export async function computeRssTokenHex(rssSecret, userId) {
  const key = await importRssHmacKey(rssSecret)
  const msg = new TextEncoder().encode(`rss:${userId}`)
  const sig = await crypto.subtle.sign('HMAC', key, msg)
  return hexFromBytes(new Uint8Array(sig))
}

