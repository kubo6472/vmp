/**
 * KV-tolerant settings store.
 *
 * Source of truth remains D1 `admin_settings` for durability and relational safety.
 * KV is used as a global, low-latency read cache for settings that are tolerant
 * to brief staleness.
 */

function getDb(env: any) {
  const db = env.DB || env.video_subscription_db
  if (!db) throw new Error('D1 binding not found')
  return db
}

function getSettingsKv(env: any) {
  // Dedicated namespace for settings cache; fallback keeps older environments working.
  return env.SETTINGS_KV || env.RATE_LIMIT_KV || null
}

function kvKey(key: any) {
  return `settings:${key}`
}

export interface SettingsOptions {
  ttlSeconds?: number
  defaultValue?: any
  bypassKv?: boolean
}

export async function getSetting(env: any, key: any, options: SettingsOptions = {}) {
  const { ttlSeconds = 300, defaultValue = null, bypassKv = false } = options
  const db = getDb(env)
  const kv = getSettingsKv(env)
  const keyName = kvKey(key)

  if (!bypassKv && kv) {
    try {
      const cached = await kv.get(keyName)
      if (cached !== null) return cached
    } catch {
      // KV miss/failure falls back to D1.
    }
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

  if (kv && hasDbRowValue) {
    try {
      await kv.put(keyName, value == null ? '' : String(value), { expirationTtl: ttlSeconds })
    } catch {
      // Best-effort cache write only.
    }
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
  const kv = getSettingsKv(env)
  const normalized = value == null ? '' : String(value)

  await db.prepare(`
    INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).bind(key, normalized).run()

  if (kv) {
    try {
      await kv.put(kvKey(key), normalized, { expirationTtl: ttlSeconds })
    } catch {
      // D1 write succeeded; cache can self-heal on next read.
    }
  }
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
  const kv = getSettingsKv(env)

  if (!Array.isArray(entries) || entries.length === 0) return

  // D1 does not support SQL BEGIN/COMMIT via db.exec(); use batch() for atomic multi-row writes.
  const statements = buildSettingsStatements(env, entries)
  await db.batch(statements)

  if (kv) {
    for (const [key, value] of entries) {
      try {
        const normalized = value == null ? '' : String(value)
        await kv.put(kvKey(key), normalized, { expirationTtl: ttlSeconds })
      } catch {
        // D1 write transaction already committed; cache can self-heal on read.
      }
    }
  }
}