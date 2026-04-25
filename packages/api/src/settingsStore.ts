/**
 * Settings store backed by D1 with per-isolate in-memory caching.
 *
 * Source of truth is always D1 `admin_settings`.
 * To avoid hot-path DB reads we keep a short-lived in-memory cache per worker
 * isolate, which has zero external write amplification.
 */

function getDb(env: any) {
  const db = env.DB || env.video_subscription_db
  if (!db) throw new Error('D1 binding not found')
  return db
}

const inMemorySettingsCache = new Map<string, { value: any, expiresAt: number }>()

export interface SettingsOptions {
  ttlSeconds?: number
  defaultValue?: any
  // Kept for backwards compatibility with older callsites.
  bypassKv?: boolean
}

export async function getSetting(env: any, key: any, options: SettingsOptions = {}) {
  const { ttlSeconds = 300, defaultValue = null } = options
  const db = getDb(env)
  const cacheKey = String(key)
  const now = Date.now()

  const cached = inMemorySettingsCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }

  let value: any
  let hasDbRowValue = false
  try {
    const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ? LIMIT 1').bind(key).first()
    value = row?.value ?? defaultValue
    hasDbRowValue = row != null && row.value != null
  } catch {
    value = defaultValue
  }

  if (hasDbRowValue) {
    inMemorySettingsCache.set(cacheKey, {
      value,
      expiresAt: now + Math.max(1, ttlSeconds) * 1000,
    })
  } else {
    inMemorySettingsCache.delete(cacheKey)
  }

  return value
}

export async function getSettings(env: any, keys: any, options: SettingsOptions = {}) {
  const entries = await Promise.all(keys.map(async (k: any) => [k, await getSetting(env, k, options)]))
  return Object.fromEntries(entries)
}

export async function setSetting(env: any, key: any, value: any, options: SettingsOptions = {}) {
  const { ttlSeconds = 300 } = options
  const db = getDb(env)
  const normalized = value == null ? '' : String(value)

  await db.prepare(`
    INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).bind(key, normalized).run()

  inMemorySettingsCache.set(String(key), {
    value: normalized,
    expiresAt: Date.now() + Math.max(1, ttlSeconds) * 1000,
  })
}

export function buildSettingsStatements(env: any, entries: any) {
  const db = getDb(env)
  if (!Array.isArray(entries) || entries.length === 0) return []

  const upsert = db.prepare(`
    INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `)
  return entries.map(([key, value]) => {
    const normalized = value == null ? '' : String(value)
    return upsert.bind(key, normalized)
  })
}

export async function setSettings(env: any, entries: any, options: SettingsOptions = {}) {
  const { ttlSeconds = 300 } = options
  const db = getDb(env)

  if (!Array.isArray(entries) || entries.length === 0) return

  // D1 does not support SQL BEGIN/COMMIT via db.exec(); use batch() for atomic multi-row writes.
  const statements = buildSettingsStatements(env, entries)
  await db.batch(statements)

  const expiresAt = Date.now() + Math.max(1, ttlSeconds) * 1000
  for (const [key, value] of entries) {
    const normalized = value == null ? '' : String(value)
    inMemorySettingsCache.set(String(key), { value: normalized, expiresAt })
  }
}