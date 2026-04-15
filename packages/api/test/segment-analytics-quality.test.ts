import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSegmentAnalyticsSnapshot,
  buildSegmentAnalyticsSnapshotWithOptions,
  buildSegmentSessionKey,
  classifySegmentSource,
  derivePlaybackPositionSeconds,
  logSegmentEvent,
} from '../src/adminExtras.js'

describe('segment analytics source classification', () => {
  it('classifies campaign from UTM params', () => {
    const source = classifySegmentSource({
      referer: 'https://example.com/watch?v=1&utm_source=newsletter&utm_medium=email',
    })
    assert.equal(source.category, 'campaign')
    assert.equal(source.campaignSource, 'newsletter')
    assert.equal(source.campaignMedium, 'email')
  })

  it('classifies search/social/referral/direct', () => {
    assert.equal(classifySegmentSource({ referer: 'https://www.google.com/search?q=vmp' }).category, 'search')
    assert.equal(classifySegmentSource({ referer: 'https://t.co/xyz' }).category, 'social')
    assert.equal(classifySegmentSource({ referer: 'https://partner.example.net/article' }).category, 'referral')
    assert.equal(classifySegmentSource({ referer: '' }).category, 'direct')
  })

  it('falls back to direct for malformed referer values', () => {
    assert.equal(classifySegmentSource({ referer: 'not a url' }).category, 'direct')
  })
})

describe('segment playback + session derivation', () => {
  it('derives playback position from segment index and duration', () => {
    const playback = derivePlaybackPositionSeconds({ segmentIndex: 5, segmentDurationSeconds: 6.2 })
    assert.equal(playback, 31)
  })

  it('falls back to segment index when duration is unavailable', () => {
    const playback = derivePlaybackPositionSeconds({ segmentIndex: 8, segmentDurationSeconds: null })
    assert.equal(playback, 8)
  })

  it('builds stable session keys in 30-minute buckets', () => {
    const early = buildSegmentSessionKey({ videoId: 'vid-1', userId: 'u-1', timestampMs: 1_700_000_000_000 })
    const laterSameBucket = buildSegmentSessionKey({ videoId: 'vid-1', userId: 'u-1', timestampMs: 1_700_000_100_000 })
    const nextBucket = buildSegmentSessionKey({ videoId: 'vid-1', userId: 'u-1', timestampMs: 1_700_001_900_000 })
    assert.equal(early, laterSameBucket)
    assert.notEqual(early, nextBucket)
  })
})

describe('segment analytics persistence + snapshot', () => {
  function buildDbStub(resultsByMatch: Array<{ match: string, response: any }>) {
    return {
      prepare(sql: string) {
        const matched = resultsByMatch.find((item) => sql.includes(item.match))
        return {
          bind() {
            return this
          },
          async first() {
            if (!matched) return null
            if (matched.response && Object.prototype.hasOwnProperty.call(matched.response, 'first')) {
              return matched.response.first
            }
            return null
          },
          async all() {
            if (!matched) return { results: [] }
            if (matched.response && Object.prototype.hasOwnProperty.call(matched.response, 'all')) {
              return matched.response.all
            }
            return { results: [] }
          },
        }
      },
    }
  }

  it('writes canonical source/session/position fields on event log', async () => {
    const captured: { sql: string; args: any[] }[] = []
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            values: [] as any[],
            bind(...args: any[]) {
              this.values = args
              return this
            },
            async run() {
              captured.push({ sql, args: this.values })
              return { meta: { changes: 1 } }
            },
          }
        },
      },
    }
    await logSegmentEvent(env, {
      videoId: 'video-1',
      userId: null,
      requestPath: 'videos/video-1/segment-12.m4s',
      segmentIndex: 12,
      segmentDurationSeconds: 6,
      referer: 'https://news.example.com/post?utm_source=launch&utm_medium=social',
      ipHash: 'hash123',
      timestampMs: 1_700_000_000_000,
    })
    assert.equal(captured.length, 1)
    const args = captured[0]?.args || []
    assert.equal(args[5], 12)
    assert.equal(args[10], 6)
    assert.equal(args[11], 72)
    assert.equal(args[13], 'campaign')
    assert.equal(args[15], 'launch')
    assert.equal(args[16], 'social')
    assert.match(String(args[12]), /^video-1:i:hash123:/)
  })

  it('builds analytics snapshot from session-based aggregations', async () => {
    const db = buildDbStub([
      { match: 'AS total', response: { first: { total: 4 } } },
      { match: 'COALESCE(source_category', response: { all: { results: [{ source: 'search', unique_sessions: 3 }, { source: 'direct', unique_sessions: 1 }] } } },
      { match: 'WITH events AS', response: { all: { results: [{ video_id: 'video-1', bucket_start_percent: 20, viewers: 2 }] } } },
      { match: 'SELECT COALESCE(status, ', response: { all: { results: [{ status: 'active', count: 5 }] } } },
      { match: 'SELECT plan_type, COUNT(*) AS active_count', response: { all: { results: [{ plan_type: 'monthly', active_count: 5 }] } } },
    ])
    const snapshot = await buildSegmentAnalyticsSnapshot(db)
    assert.equal(snapshot.totalViews, 4)
    assert.equal(snapshot.trafficSources[0].source, 'search')
    assert.equal(snapshot.retention[0].bucket_start_percent, 20)
    assert.equal(snapshot.subscriptionsLegacy[0].status, 'active')
  })

  it('builds analytics snapshot with time-series options and overview sections', async () => {
    const db = buildDbStub([
      { match: 'AS total', response: { first: { total: 9 } } },
      { match: 'COALESCE(source_category', response: { all: { results: [{ source: 'social', unique_sessions: 5 }] } } },
      { match: 'WITH events AS', response: { all: { results: [{ video_id: 'video-1', bucket_start_percent: 30, viewers: 4 }] } } },
      { match: 'SELECT COALESCE(status, ', response: { all: { results: [{ status: 'active', count: 8 }] } } },
      { match: 'COUNT(DISTINCT', response: { all: { results: [{ bucket: '2026-04-01', unique_sessions: 3 }] } } },
      { match: 'AS new_subscriptions', response: { all: { results: [{ bucket: '2026-04-01', new_subscriptions: 2 }] } } },
      { match: 'AS churned_subscriptions', response: { all: { results: [{ bucket: '2026-04-01', churned_subscriptions: 1 }] } } },
      { match: 'AS expiring_subscriptions', response: { all: { results: [{ bucket: '2026-04-01', expiring_subscriptions: 1 }] } } },
      { match: 'SELECT plan_type, COUNT(*) AS active_count', response: { all: { results: [{ plan_type: 'monthly', active_count: 6 }] } } },
    ])
    const settings = new Map<string, string>([
      ['monthly_price_eur', '12'],
      ['yearly_price_eur', '120'],
      ['club_price_eur', '30'],
    ])
    const env = {
      DB: db,
      SETTINGS_KV: {
        async get(key: string) {
          if (!key.startsWith('settings:')) return null
          return settings.get(key.slice('settings:'.length)) ?? null
        },
        async put() {},
      },
    }
    const snapshot = await buildSegmentAnalyticsSnapshotWithOptions(db, env, {
      range: '30d',
      granularity: 'day',
      dataset: 'all',
      format: 'json',
    })
    assert.equal(snapshot.kpis.totalUniqueViews, 9)
    assert.equal(snapshot.trafficSources[0].source, 'social')
    assert.equal(snapshot.views.series[0].bucket, '2026-04-01')
    assert.equal(snapshot.subscriptionOverview.statusBreakdown[0].status, 'active')
    assert.equal(snapshot.subscriptionOverview.trends[0].newSubscriptions, 2)
    assert.equal(snapshot.cashflow.trend[0].estimatedNetNewEur, 12)
  })
})
