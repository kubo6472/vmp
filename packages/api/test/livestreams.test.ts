import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCloudflareLivestream, normalizeLivestreamStatus } from '../src/livestreams.js'

describe('normalizeLivestreamStatus', () => {
  it('keeps known statuses', () => {
    assert.equal(normalizeLivestreamStatus('draft'), 'draft')
    assert.equal(normalizeLivestreamStatus('provisioning'), 'provisioning')
    assert.equal(normalizeLivestreamStatus('ready'), 'ready')
    assert.equal(normalizeLivestreamStatus('live'), 'live')
    assert.equal(normalizeLivestreamStatus('ended'), 'ended')
    assert.equal(normalizeLivestreamStatus('failed'), 'failed')
  })

  it('normalizes casing and whitespace', () => {
    assert.equal(normalizeLivestreamStatus('  LIVE '), 'live')
  })

  it('returns fallback for unknown statuses', () => {
    assert.equal(normalizeLivestreamStatus('unknown'), 'draft')
    assert.equal(normalizeLivestreamStatus('unknown', 'ended'), 'ended')
    assert.equal(normalizeLivestreamStatus(null, 'draft'), 'draft')
  })

  it('uses custom fallback for non-string statuses', () => {
    assert.equal(normalizeLivestreamStatus(undefined, 'ready'), 'ready')
  })
})

describe('createCloudflareLivestream', () => {
  it('uses Cloudflare Stream Live endpoint and parses rtmps response', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string, init: RequestInit | undefined }> = []
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({
        success: true,
        result: {
          uid: 'live-uid-123',
          rtmps: {
            url: 'rtmps://live.cloudflare.com:443/live/',
            streamKey: 'secret-stream-key',
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const result = await createCloudflareLivestream({
        CF_ACCOUNT_ID: 'acc-123',
        CF_API_TOKEN: 'token-123',
        CF_STREAM_CUSTOMER_CODE: 'customer-code',
      }, {
        metaName: 'Launch stream',
      })

      assert.equal(calls.length, 1)
      assert.equal(calls[0]?.url, 'https://api.cloudflare.com/client/v4/accounts/acc-123/stream/live_inputs')
      assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
        meta: { name: 'Launch stream' },
        recording: { mode: 'automatic' },
      })
      assert.equal(result.uid, 'live-uid-123')
      assert.equal(result.rtmpUrl, 'rtmps://live.cloudflare.com:443/live/')
      assert.equal(result.streamKey, 'secret-stream-key')
      assert.equal(result.playbackHls, 'https://customer-customer-code.cloudflarestream.com/live-uid-123/manifest/video.m3u8')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('uses explicit playback URL from API response when present', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      success: true,
      result: {
        uid: 'abc',
        rtmps: {
          url: 'rtmps://live.cloudflare.com:443/live/',
          streamKey: 'stream-key',
        },
        playback: {
          hls: 'https://example.com/custom-live.m3u8',
        },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    try {
      const result = await createCloudflareLivestream({
        CF_ACCOUNT_ID: 'acc-123',
        CF_API_TOKEN: 'token-123',
        CF_STREAM_CUSTOMER_CODE: 'ignored-because-response-has-playback',
      }, {
        metaName: 'Live with explicit playback',
        recordingMode: 'off',
      })
      assert.equal(result.playbackHls, 'https://example.com/custom-live.m3u8')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
