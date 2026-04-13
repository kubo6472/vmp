import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSegmentAnalyticsSnapshot,
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
})

describe('segment playback + session derivation', () => {
  it('derives playback position from segment index and duration', () => {
    const playback = derivePlaybackPositionSeconds({ segmentIndex: 5, segmentDurationSeconds: 6.2 })
    assert.equal(playback, 31)
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
    const executedSql: string[] = []
    const db = {
      prepare(sql: string) {
        executedSql.push(sql)
        return {
          async first() {
            if (sql.includes('AS total')) return { total: 4 }
            return null
          },
          async all() {
            if (sql.includes('COALESCE(source_category')) {
              return { results: [{ source: 'search', hits: 3 }, { source: 'direct', hits: 1 }] }
            }
            if (sql.includes('WITH events AS')) {
              return { results: [{ video_id: 'video-1', bucket_start_percent: 20, viewers: 2 }] }
            }
            if (sql.includes('FROM subscriptions')) {
              return { results: [{ status: 'active', count: 5 }] }
            }
            return { results: [] }
          },
        }
      },
    }
    const snapshot = await buildSegmentAnalyticsSnapshot(db)
    assert.equal(snapshot.totalViews, 4)
    assert.equal(snapshot.trafficSources[0].source, 'search')
    assert.equal(snapshot.retention[0].bucket_start_percent, 20)
    assert.equal(snapshot.subscriptions[0].status, 'active')
    assert.ok(executedSql.some((sql) => sql.includes('COUNT(DISTINCT')))
  })
})
