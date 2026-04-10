/**
 * Newsletter hardening — Brevo helpers and safe retry behavior.
 * Run: npm test --workspace=@vmp/api
 */
import { describe, it, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampNewsletterPollIntervalMs,
  isNewsletterSendFinished,
  fetchBrevoEmailCampaignsWithRetry,
  DEFAULT_NEWSLETTER_POLL_INTERVAL_MS,
} from '../src/brevo.js'

describe('clampNewsletterPollIntervalMs', () => {
  it('defaults when missing or too small', () => {
    assert.equal(clampNewsletterPollIntervalMs(null), DEFAULT_NEWSLETTER_POLL_INTERVAL_MS)
    assert.equal(clampNewsletterPollIntervalMs(''), DEFAULT_NEWSLETTER_POLL_INTERVAL_MS)
    assert.equal(clampNewsletterPollIntervalMs(59_999), DEFAULT_NEWSLETTER_POLL_INTERVAL_MS)
  })

  it('clamps to max 24h', () => {
    assert.equal(clampNewsletterPollIntervalMs(99_000_000), 86_400_000)
  })

  it('accepts valid range', () => {
    assert.equal(clampNewsletterPollIntervalMs(120_000), 120_000)
    assert.equal(clampNewsletterPollIntervalMs('900000'), 900_000)
  })
})

describe('isNewsletterSendFinished', () => {
  it('is true only when both sent_at and campaign_id present', () => {
    assert.equal(isNewsletterSendFinished(null), false)
    assert.equal(isNewsletterSendFinished({}), false)
    assert.equal(isNewsletterSendFinished({ sent_at: '2026-01-01', campaign_id: null }), false)
    assert.equal(isNewsletterSendFinished({ sent_at: null, campaign_id: 1 }), false)
    assert.equal(isNewsletterSendFinished({ sent_at: '2026-01-01', campaign_id: 42 }), true)
  })
})

describe('fetchBrevoEmailCampaignsWithRetry', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('retries once on 504 then returns success body', async () => {
    const okBody = { campaigns: [{ id: 1, name: 'x' }] }
    let calls = 0
    globalThis.fetch = mock.fn(async () => {
      calls += 1
      if (calls === 1) {
        return new Response(JSON.stringify({ message: 'timeout' }), { status: 504, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify(okBody), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const env = { BREVO_API_KEY: 'k' }
    const res = await fetchBrevoEmailCampaignsWithRetry(env)
    assert.equal(res.ok, true)
    assert.equal(calls, 2)
    const json = await res.json()
    assert.deepEqual(json.campaigns, okBody.campaigns)
  })
})
