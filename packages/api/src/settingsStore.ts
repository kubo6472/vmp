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

const SETTINGS_VERSION_KEY = 'settings_changed_at'
const SETTINGS_VERSION_CACHE_MS = 5_000
const STRIPE_SETTING_PREFIX = 'stripe_price_'
const STRIPE_SETTING_TTL_SECONDS = 30

const inMemorySettingsCache = new Map<string, { value: any, expiresAt: number, version: string }>()
let cachedSettingsVersion = '0'
let cachedSettingsVersionExpiresAt = 0

export interface SettingsOptions {
  ttlSeconds?: number
  defaultValue?: any
  // Kept for backwards compatibility with older callsites.
  bypassKv?: boolean
}

/**
 * Invalidates one setting key from this isolate's in-memory cache.
 *
 * When `persistVersion` is true (default), this also updates the shared
 * `settings_changed_at` marker (`SETTINGS_VERSION_KEY`) in D1 and refreshes the
 * local version via `bumpLocalSettingsVersion`, so other isolates will observe
 * the new version on their next `getSettingsVersion` refresh.
 *
 * When `persistVersion` is false, invalidation is local-only and does not write
 * a new shared version marker; other isolates may continue serving cached values
 * until their `cachedSettingsVersionExpiresAt` window (`SETTINGS_VERSION_CACHE_MS`)
 * elapses and they re-read `settings_changed_at`.
 */

function normalizeCacheTtlSeconds(key: string, ttlSeconds: number) {
  if (key.startsWith(STRIPE_SETTING_PREFIX)) return Math.min(Math.max(1, ttlSeconds), STRIPE_SETTING_TTL_SECONDS)
  return Math.max(1, ttlSeconds)
}

function bumpLocalSettingsVersion(version: string) {
  cachedSettingsVersion = version
  cachedSettingsVersionExpiresAt = Date.now() + SETTINGS_VERSION_CACHE_MS
}

function invalidateLocalSettingCacheOnly(key: string) {
  inMemorySettingsCache.delete(key)
}

async function getSettingsVersion(env: any, db: any, forceRefresh = false) {
  const now = Date.now()
  if (!forceRefresh && cachedSettingsVersionExpiresAt > now) return cachedSettingsVersion

  try {
    const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ? LIMIT 1').bind(SETTINGS_VERSION_KEY).first()
    const version = String(row?.value ?? '0')
    bumpLocalSettingsVersion(version)
    return version
  } catch {
    if (cachedSettingsVersionExpiresAt > now) return cachedSettingsVersion
    cachedSettingsVersionExpiresAt = now + 1_000
    return cachedSettingsVersion
  }
}

export async function invalidateSetting(env: any, key: any, persistVersion = true) {
  const db = getDb(env)
  invalidateLocalSettingCacheOnly(String(key))
  if (!persistVersion) return
  const version = String(Date.now())
  await db.prepare(`
    INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).bind(SETTINGS_VERSION_KEY, version).run()
  bumpLocalSettingsVersion(version)
}

export async function getSetting(env: any, key: any, options: SettingsOptions = {}) {
  const { ttlSeconds = 300, defaultValue = null } = options
  const db = getDb(env)
  const cacheKey = String(key)
  const now = Date.now()
  const version = await getSettingsVersion(env, db)

  const cached = inMemorySettingsCache.get(cacheKey)
  if (cached && cached.expiresAt > now && cached.version === version) {
    return cached.value
  }

  let value: any
  let hasDbRowValue = false
  try {
    const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ? LIMIT 1').bind(key).first()
    value = row?.value ?? defaultValue
    hasDbRowValue = row != null && row.value != null
  } catch {
    const existing = inMemorySettingsCache.get(cacheKey)
    value = existing?.value ?? defaultValue
    hasDbRowValue = existing != null
  }

  if (hasDbRowValue) {
    inMemorySettingsCache.set(cacheKey, {
      value,
      expiresAt: now + normalizeCacheTtlSeconds(cacheKey, ttlSeconds) * 1000,
      version,
    })
  } else {
    inMemorySettingsCache.delete(cacheKey)
  }

  return value
}

export async function getSettings(env: any, keys: any, options: SettingsOptions = {}) {
  if (!Array.isArray(keys) || keys.length === 0) return {}
  const { ttlSeconds = 300, defaultValue = null } = options
  const db = getDb(env)
  const version = await getSettingsVersion(env, db)
  const now = Date.now()

  const result: any = {}
  const uniqueKeys = [...new Set(keys.map((key: any) => String(key)))]
  const missingKeys: string[] = []

  for (const key of uniqueKeys) {
    const cached = inMemorySettingsCache.get(key)
    if (cached && cached.expiresAt > now && cached.version === version) {
      result[key] = cached.value
      continue
    }
    missingKeys.push(key)
  }

  if (missingKeys.length) {
    try {
      const placeholders = missingKeys.map(() => '?').join(', ')
      const rows = await db
        .prepare(`SELECT key, value FROM admin_settings WHERE key IN (${placeholders})`)
        .bind(...missingKeys)
        .all()
      const rowsByKey = new Map((rows?.results ?? []).map((row: any) => [String(row.key), row.value]))

      for (const key of missingKeys) {
        if (rowsByKey.has(key)) {
          const value = rowsByKey.get(key)
          result[key] = value
          inMemorySettingsCache.set(key, {
            value,
            expiresAt: now + normalizeCacheTtlSeconds(key, ttlSeconds) * 1000,
            version,
          })
        } else {
          result[key] = defaultValue
          inMemorySettingsCache.delete(key)
        }
      }
    } catch {
      for (const key of missingKeys) {
        result[key] = await getSetting(env, key, options)
      }
    }
  }

  return Object.fromEntries(keys.map((key: any) => [key, result[String(key)] ?? defaultValue]))
}

export async function setSetting(env: any, key: any, value: any, options: SettingsOptions = {}) {
  const { ttlSeconds = 300 } = options
  const db = getDb(env)
  const cacheKey = String(key)
  const normalized = value == null ? '' : String(value)
  const version = String(Date.now())

  await db.batch([
    db.prepare(`
    INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).bind(key, normalized),
    db.prepare(`
    INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).bind(SETTINGS_VERSION_KEY, version),
  ])

  bumpLocalSettingsVersion(version)

  if (cacheKey.startsWith(STRIPE_SETTING_PREFIX)) {
    invalidateLocalSettingCacheOnly(cacheKey)
  } else {
    inMemorySettingsCache.set(cacheKey, {
      value: normalized,
      expiresAt: Date.now() + normalizeCacheTtlSeconds(cacheKey, ttlSeconds) * 1000,
      version,
    })
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

  if (!Array.isArray(entries) || entries.length === 0) return

  const version = String(Date.now())
  // D1 does not support SQL BEGIN/COMMIT via db.exec(); use batch() for atomic multi-row writes.
  const statements = buildSettingsStatements(env, entries)
  statements.push(db.prepare(`
    INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).bind(SETTINGS_VERSION_KEY, version))
  await db.batch(statements)
  bumpLocalSettingsVersion(version)

  for (const [key, value] of entries) {
    const normalized = value == null ? '' : String(value)
    const cacheKey = String(key)
    const adjustedExpiresAt = Date.now() + normalizeCacheTtlSeconds(cacheKey, ttlSeconds) * 1000
    if (cacheKey.startsWith(STRIPE_SETTING_PREFIX)) {
      invalidateLocalSettingCacheOnly(cacheKey)
    } else {
      inMemorySettingsCache.set(cacheKey, { value: normalized, expiresAt: adjustedExpiresAt, version })
    }
  }
}