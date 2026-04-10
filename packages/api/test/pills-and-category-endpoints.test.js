import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { handlePillsPublic, handlePillsUpdate, handleCategoryVideosBySlug, hashPillsApiKeyValue } from '../src/adminExtras.js'

class FakeKV {
  constructor() {
    this.map = new Map()
  }
  async get(key) {
    return this.map.get(key) ?? null
  }
  async put(key, value) {
    this.map.set(key, value)
  }
}

class FakeDb {
  constructor() {
    this.settings = new Map([['pills_update_rate_limit_per_minute', '2']])
    this.hashedPillsKey = null
    this.pills = []
    this.categories = [{ id: 'cat-1', slug: 'fitness', name: 'Fitness', sort_order: 0, direction: 'desc' }]
    this.videos = [
      { id: 'v-1', title: 'One', publish_status: 'published', upload_date: '2026-01-01T00:00:00Z', category_slug: 'fitness' },
      { id: 'v-2', title: 'Two', publish_status: 'published', upload_date: '2026-01-02T00:00:00Z', category_slug: 'fitness' },
    ]
  }
  prepare(sql) {
    const db = this
    return {
      bind(...args) {
        this.args = args
        return this
      },
      async first() {
        if (sql.includes('SELECT value FROM admin_settings')) {
          const key = this.args[0]
          const value = db.settings.get(key)
          return value == null ? null : { value }
        }
        if (sql.includes('FROM video_categories') && sql.includes('WHERE slug')) {
          const slug = this.args[0]
          return db.categories.find((c) => c.slug === slug) ?? null
        }
        if (sql.includes('SELECT COUNT(*) AS total')) {
          const slug = this.args[0]
          return { total: db.videos.filter((v) => v.category_slug === slug && v.publish_status === 'published').length }
        }
        return null
      },
      async all() {
        if (sql.includes('FROM pills')) {
          return { results: [...db.pills].sort((a, b) => a.sort_order - b.sort_order) }
        }
        if (sql.includes('FROM videos v') && sql.includes('WHERE vc.slug = ?')) {
          const [slug, limit, offset] = this.args
          const rows = db.videos
            .filter((v) => v.category_slug === slug && v.publish_status === 'published')
            .slice(offset, offset + limit)
            .map((v) => ({
              ...v,
              category_id: 'cat-1',
              category_name: 'Fitness',
              category_slug: slug,
            }))
          return { results: rows }
        }
        return { results: [] }
      },
      async run() {
        if (sql.includes('INSERT INTO pills_updates_audit')) return { meta: { changes: 1 } }
        if (sql.includes('INSERT INTO admin_settings') && sql.includes('pills_api_key')) {
          const [, value] = this.args
          db.settings.set('pills_api_key', value)
          return { meta: { changes: 1 } }
        }
        if (sql.includes('INSERT INTO pills (id, label, value, color, sort_order, updated_at)')) {
          const [id, label, value, color, sortOrder] = this.args
          const idx = db.pills.findIndex((p) => p.id === id)
          const next = { id, label, value, color, sort_order: sortOrder, updated_at: new Date().toISOString() }
          if (idx >= 0) db.pills[idx] = next
          else db.pills.push(next)
          return { meta: { changes: 1 } }
        }
        return { meta: { changes: 1 } }
      },
    }
  }
  async batch(statements) {
    await Promise.all(statements.map((s) => s.run()))
  }
}

async function envWithDb() {
  const DB = new FakeDb()
  const hashForTests = await hashPillsApiKeyValue('secret-key')
  DB.settings.set('pills_api_key', hashForTests)
  return { DB, RATE_LIMIT_KV: new FakeKV() }
}

describe('pills update endpoint', () => {
  it('returns 401 when API key is missing', async () => {
    const env = await envWithDb()
    env.DB.settings.set('pills_api_key', await hashPillsApiKeyValue('secret-key'))
    const req = new Request('http://localhost/api/pills/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pills: [] }),
    })
    const res = await handlePillsUpdate(req, env, {})
    assert.equal(res.status, 401)
  })

  it('returns 429 when rate-limited and succeeds otherwise', async () => {
    const env = await envWithDb()
    env.DB.settings.set('pills_api_key', await hashPillsApiKeyValue('secret-key'))
    const req = () => new Request('http://localhost/api/pills/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'secret-key', 'x-forwarded-for': '1.2.3.4' },
      body: JSON.stringify({
        pills: [{ id: 'p1', label: 'Users', value: 42, color: '#0ea5e9', sortOrder: 0 }],
      }),
    })
    const r1 = await handlePillsUpdate(req(), env, {})
    const r2 = await handlePillsUpdate(req(), env, {})
    const r3 = await handlePillsUpdate(req(), env, {})
    assert.equal(r1.status, 200)
    assert.equal(r2.status, 200)
    assert.equal(r3.status, 429)
  })

  it('persists pills and exposes them on /api/pills', async () => {
    const env = await envWithDb()
    env.DB.settings.set('pills_api_key', await hashPillsApiKeyValue('secret-key'))
    const updateReq = new Request('http://localhost/api/pills/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'secret-key', 'x-forwarded-for': '5.6.7.8' },
      body: JSON.stringify({ pills: [{ id: 'pA', label: 'Subscribers', value: 9, color: '#16a34a', sortOrder: 0 }] }),
    })
    const updateRes = await handlePillsUpdate(updateReq, env, {})
    assert.equal(updateRes.status, 200)
    const publicRes = await handlePillsPublic(new Request('http://localhost/api/pills', { method: 'GET' }), env, {})
    const payload = await publicRes.json()
    assert.equal(publicRes.status, 200)
    assert.equal(payload.pills.length, 1)
    assert.equal(payload.pills[0].label, 'Subscribers')
  })

  it('supports env-managed API key path with rate limiting', async () => {
    const env = await envWithDb()
    env.PILLS_API_KEY = 'env-secret-key'
    env.DB.settings.delete('pills_api_key')
    const req = () => new Request('http://localhost/api/pills/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'env-secret-key', 'x-forwarded-for': '9.9.9.9' },
      body: JSON.stringify({
        pills: [{ id: 'env-1', label: 'Env path', value: 1, color: '#2563eb', sortOrder: 0 }],
      }),
    })
    const r1 = await handlePillsUpdate(req(), env, {})
    const r2 = await handlePillsUpdate(req(), env, {})
    const r3 = await handlePillsUpdate(req(), env, {})
    assert.equal(r1.status, 200)
    assert.equal(r2.status, 200)
    assert.equal(r3.status, 429)
  })

  it('returns config error when pills_update_rate_limit_per_minute is invalid', async () => {
    const env = await envWithDb()
    env.PILLS_API_KEY = 'env-secret-key'
    env.DB.settings.delete('pills_api_key')
    env.DB.settings.set('pills_update_rate_limit_per_minute', '')
    const req = new Request('http://localhost/api/pills/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'env-secret-key', 'x-forwarded-for': '8.8.8.8' },
      body: JSON.stringify({
        pills: [{ id: 'badcfg', label: 'Bad cfg', value: 1, color: '#2563eb', sortOrder: 0 }],
      }),
    })
    const res = await handlePillsUpdate(req, env, {})
    const payload = await res.json()
    assert.equal(res.status, 500)
    assert.equal(payload.code, 'invalid_config')
  })
})

describe('category slug endpoint', () => {
  it('returns 404 for unknown category slug', async () => {
    const env = await envWithDb()
    const req = new Request('http://localhost/api/categories/unknown/videos', { method: 'GET' })
    const res = await handleCategoryVideosBySlug(req, env, {})
    assert.equal(res.status, 404)
  })

  it('returns category videos for known slug', async () => {
    const env = await envWithDb()
    const req = new Request('http://localhost/api/categories/fitness/videos?page=1&pageSize=10', { method: 'GET' })
    const res = await handleCategoryVideosBySlug(req, env, {})
    const payload = await res.json()
    assert.equal(res.status, 200)
    assert.equal(payload.category.slug, 'fitness')
    assert.equal(payload.videos.length, 2)
    assert.equal(payload.pagination.total, 2)
  })
})
