import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getProxyVideoIdFromPath } from '../src/index.js'

describe('getProxyVideoIdFromPath', () => {
  it('decodes URL-encoded spaces in video proxy path segment', () => {
    const videoId = getProxyVideoIdFromPath('videos/axe%20capital%201/master.m3u8')
    assert.equal(videoId, 'axe capital 1')
  })

  it('returns null for malformed encoded proxy path segment', () => {
    const videoId = getProxyVideoIdFromPath('videos/%E0%A4%A/master.m3u8')
    assert.equal(videoId, null)
  })

  it('returns null when proxy path does not include a video id segment', () => {
    const videoId = getProxyVideoIdFromPath('videos')
    assert.equal(videoId, null)
  })
})
