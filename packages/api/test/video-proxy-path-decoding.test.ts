import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getProxyVideoIdFromPath } from '../src/index.js'

describe('getProxyVideoIdFromPath', () => {
  it('decodes URL-encoded spaces in video proxy path segment', () => {
    const videoId = getProxyVideoIdFromPath('videos/axe%20capital%201/master.m3u8')
    assert.equal(videoId, 'axe capital 1')
  })

  it('decodes URL-encoded spaces for full proxy request path', () => {
    const videoId = getProxyVideoIdFromPath('/api/video-proxy/videos/axe%20capital%201/master.m3u8')
    assert.equal(videoId, 'axe capital 1')
  })

  it('returns null for malformed encoded proxy path segment', () => {
    // Intentionally malformed percent-encoding (%E0%A4%A: incomplete UTF-8) to verify invalid input handling.
    const videoId = getProxyVideoIdFromPath('videos/%E0%A4%A/master.m3u8')
    assert.equal(videoId, null)
  })

  it('returns null when encoded segment decodes to a slash-containing id', () => {
    const videoId = getProxyVideoIdFromPath('videos/foo%2Fbar/master.m3u8')
    assert.equal(videoId, null)
  })

  it('returns null when proxy path does not include a video id segment', () => {
    const videoId = getProxyVideoIdFromPath('videos')
    assert.equal(videoId, null)
  })
})
