import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getAdminVideoIdFromPath } from '../src/index.js'

describe('getAdminVideoIdFromPath', () => {
  it('decodes URL-encoded spaces in admin video path segment', () => {
    const videoId = getAdminVideoIdFromPath('/api/admin/videos/axe%20capital%201')
    assert.equal(videoId, 'axe capital 1')
  })

  it('decodes URL-encoded path for nested admin video routes', () => {
    const videoId = getAdminVideoIdFromPath('/api/admin/videos/axe%20capital%201/notify')
    assert.equal(videoId, 'axe capital 1')
  })

  it('returns null when the encoded segment is invalid', () => {
    const videoId = getAdminVideoIdFromPath('/api/admin/videos/%E0%A4%A')
    assert.equal(videoId, null)
  })
})
