import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeScheduledPublishAt } from '../src/index.js'

describe('normalizeScheduledPublishAt', () => {
  it('accepts ISO timestamp with timezone', () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString()
    const normalized = normalizeScheduledPublishAt(future, { allowNull: true })
    assert.equal(normalized.invalid, false)
    assert.equal(typeof normalized.value, 'string')
  })

  it('accepts SQL-style timestamp without timezone and treats it as UTC', () => {
    const normalized = normalizeScheduledPublishAt('2099-12-30 08:15:00', { allowNull: true })
    assert.equal(normalized.invalid, false)
    assert.equal(normalized.value, '2099-12-30 08:15:00')
  })

  it('accepts SQL-style timestamp with T separator and milliseconds', () => {
    const normalized = normalizeScheduledPublishAt('2099-12-30T08:15:00.5', { allowNull: true })
    assert.equal(normalized.invalid, false)
    assert.equal(normalized.value, '2099-12-30 08:15:00')
  })

  it('rejects invalid values', () => {
    const normalized = normalizeScheduledPublishAt('not-a-date', { allowNull: true })
    assert.equal(normalized.invalid, true)
    assert.equal(normalized.value, null)
  })

  it('marks past timestamps as upload backdate (draft scheduling path)', () => {
    const normalized = normalizeScheduledPublishAt('2000-01-01 00:00:00', { allowNull: true })
    assert.equal(normalized.invalid, false)
    assert.equal(normalized.value, '2000-01-01 00:00:00')
    assert.equal(normalized.backdatesUpload, true)
  })

  it('does not set backdatesUpload when allowPast is true', () => {
    const normalized = normalizeScheduledPublishAt('2000-01-01 00:00:00', { allowNull: true, allowPast: true })
    assert.equal(normalized.invalid, false)
    assert.equal(normalized.backdatesUpload, false)
  })
})
