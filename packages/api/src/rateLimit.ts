/**
 * packages/api/src/rateLimit.js
 *
 * KV-backed hourly rate limiter for anonymous video-access requests.
 *
 * Key format : ratelimit:{ip}:{YYYY-MM-DDTHH}   (hourly bucket)
 * Value      : integer count (stringified)
 * TTL        : 3700 s  (a little over an hour so the key outlives the window)
 *
 * The limit value is read from admin_settings (key "rate_limit_anon", default 5)
 * and cached in module scope for 60 seconds to avoid a D1 hit on every request.
 */

let cachedRateLimit: any = null
let cacheExpiresAt = 0

/**
 * Read rate_limit_anon from admin_settings, caching for 60 s.
 * Falls back to 5 if the row is missing or invalid.
 */
async function getRateLimitValue(env: any) {
  const now = Date.now()
  if (cachedRateLimit !== null && now < cacheExpiresAt) return cachedRateLimit

  try {
    const db = env.DB || env.video_subscription_db
    const row = await db
      .prepare("SELECT value FROM admin_settings WHERE key = 'rate_limit_anon' LIMIT 1")
      .first()
    const parsed = row ? parseInt(row.value, 10) : NaN
    cachedRateLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : 5
  } catch {
    cachedRateLimit = 5
  }

  cacheExpiresAt = now + 60_000
  return cachedRateLimit
}

/**
 * Check (and increment) the hourly counter for an anonymous request.
 *
 * Returns:
 *   null                              — KV not bound, rate limiting skipped
 *   { limited: false, current, limit } — request is allowed
 *   { limited: true, retryAfter, limit, current } — request is blocked (429)
 */
export async function checkAnonymousRateLimit(request: any, env: any) {
  if (!env.RATE_LIMIT_KV) return null // binding not configured — skip silently

  // Use CF-Connecting-IP (set by Cloudflare) as the client identifier.
  // Fall back to X-Forwarded-For for local dev / non-CF environments.
  const ip =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'

  const now = new Date()
  // e.g. "2026-03-30T14" — one bucket per UTC hour
  const hourKey = now.toISOString().slice(0, 13)
  const key = `ratelimit:${ip}:${hourKey}`

  const limit = await getRateLimitValue(env)
  const stored = await env.RATE_LIMIT_KV.get(key)
  const current = stored ? parseInt(stored, 10) : 0

  if (current >= limit) {
    // Seconds remaining in the current UTC hour
    const minutesElapsed = now.getUTCMinutes()
    const secondsElapsed = now.getUTCSeconds()
    const retryAfter = (60 - minutesElapsed) * 60 - secondsElapsed

    return { limited: true, retryAfter, limit, current }
  }

  // Increment; TTL 3700 s keeps the key alive past the hour boundary
  await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 3700 })
  return { limited: false, current: current + 1, limit }
}
