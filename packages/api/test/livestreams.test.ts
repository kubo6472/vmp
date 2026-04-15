import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeLivestreamStatus } from '../src/livestreams.js'

describe('normalizeLivestreamStatus', () => {
  it('keeps known statuses', () => {
    assert.equal(normalizeLivestreamStatus('scheduled'), 'scheduled')
    assert.equal(normalizeLivestreamStatus('live'), 'live')
    assert.equal(normalizeLivestreamStatus('ended'), 'ended')
    assert.equal(normalizeLivestreamStatus('vod_attached'), 'vod_attached')
    assert.equal(normalizeLivestreamStatus('replaced_with_vod'), 'replaced_with_vod')
  })

  it('normalizes casing and whitespace', () => {
    assert.equal(normalizeLivestreamStatus('  LIVE '), 'live')
  })

  it('returns fallback for unknown statuses', () => {
    assert.equal(normalizeLivestreamStatus('unknown'), 'scheduled')
    assert.equal(normalizeLivestreamStatus('unknown', 'ended'), 'ended')
    assert.equal(normalizeLivestreamStatus(null, 'scheduled'), 'scheduled')
  })

  it('uses custom fallback for non-string statuses', () => {
    assert.equal(normalizeLivestreamStatus(undefined, 'vod_attached'), 'vod_attached')
  })
})
