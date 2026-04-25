/**
 * packages/api/src/rateLimit.js
 *
 * D1-backed hourly rate limiter for anonymous video-access requests.
 *
 * Counter key: (ip, bucket_hour) where bucket_hour = YYYY-MM-DDTHH in UTC.
 * The limit value is read from admin_settings (key "rate_limit_anon", default 5)
 * and cached in module scope for 60 seconds to avoid re-reading settings on every request.
 */

const rateLimitCacheByEnv = new WeakMap<any, { value: number, expiresAt: number }>()

/**
 * Read rate_limit_anon from admin_settings, caching for 60 s.
 * Falls back to 5 if the row is missing or invalid.
 */
async function getRateLimitValue(env: any) {
  const now = Date.now()
  const existingCache = rateLimitCacheByEnv.get(env)
  if (existingCache && now < existingCache.expiresAt) return existingCache.value

  try {
    const db = env.DB || env.video_subscription_db
    const row = await db
      .prepare("SELECT value FROM admin_settings WHERE key = 'rate_limit_anon' LIMIT 1")
      .first()
    const parsed = row ? parseInt(row.value, 10) : NaN
    const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 5
    rateLimitCacheByEnv.set(env, { value, expiresAt: now + 60_000 })
    return value
  } catch {
    if (existingCache) {
      rateLimitCacheByEnv.set(env, { value: existingCache.value, expiresAt: now + 5_000 })
      return existingCache.value
    }
    rateLimitCacheByEnv.set(env, { value: 5, expiresAt: now + 5_000 })
    return 5
  }
}

/**
 * Check (and increment) the hourly counter for an anonymous request.
 *
 * Returns:
 *   null                              — D1 binding not configured, rate limiting skipped
 *   { limited: false, current, limit } — request is allowed
 *   { limited: true, retryAfter, limit, current } — request is blocked (429)
 */
export async function checkAnonymousRateLimit(request: any, env: any, ctx?: ExecutionContext) {
  const db = env.DB || env.video_subscription_db
  if (!db) return null // Database binding not configured — skip silently

  // Use CF-Connecting-IP (set by Cloudflare) as the client identifier.
  // Fall back to X-Forwarded-For for local dev / non-CF environments.
  const ip =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'

  const now = new Date()
  // e.g. "2026-03-30T14" — one bucket per UTC hour
  const hourKey = now.toISOString().slice(0, 13)

  // Opportunistic cleanup runs before the counter check and, when available,
  // is dispatched asynchronously to avoid adding latency to request handling.
  if (Math.random() < 0.01) {
    const cleanupPromise = db.prepare('DELETE FROM anonymous_rate_limits WHERE expires_at <= CURRENT_TIMESTAMP').run()
      .catch(() => {
        // Cleanup failures are non-fatal for request handling.
      })
    if (ctx?.waitUntil) {
      ctx.waitUntil(cleanupPromise)
    } else {
      await cleanupPromise
    }
  }

  const limit = await getRateLimitValue(env)
  const upsert = await db.prepare(`
    INSERT INTO anonymous_rate_limits (
      ip, bucket_hour, request_count, expires_at, updated_at
    ) VALUES (
      ?, ?, 1, datetime('now', '+3700 seconds'), CURRENT_TIMESTAMP
    )
    ON CONFLICT(ip, bucket_hour) DO UPDATE SET
      request_count = anonymous_rate_limits.request_count + 1,
      expires_at = datetime('now', '+3700 seconds'),
      updated_at = CURRENT_TIMESTAMP
    RETURNING request_count
  `).bind(ip, hourKey).first()
  const current = Number.parseInt(String(upsert?.request_count ?? 0), 10) || 0

  if (current > limit) {
    // Seconds remaining in the current UTC hour
    const minutesElapsed = now.getUTCMinutes()
    const secondsElapsed = now.getUTCSeconds()
    const retryAfter = (60 - minutesElapsed) * 60 - secondsElapsed

    return { limited: true, retryAfter, limit, current }
  }

  return { limited: false, current, limit }
}
