import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeGoCardlessStatus } from '../src/gocardless.js'
import { normalizeStripeStatus } from '../src/stripeClient.js'

describe('normalizeStripeStatus', () => {
  it('maps active lifecycle statuses', () => {
    assert.equal(normalizeStripeStatus('active'), 'active')
    assert.equal(normalizeStripeStatus('trialing'), 'trialing')
    assert.equal(normalizeStripeStatus('past_due'), 'past_due')
  })

  it('maps terminal statuses to cancelled', () => {
    assert.equal(normalizeStripeStatus('canceled'), 'cancelled')
    assert.equal(normalizeStripeStatus('cancelled'), 'cancelled')
    assert.equal(normalizeStripeStatus('incomplete_expired'), 'cancelled')
    assert.equal(normalizeStripeStatus('paused'), 'cancelled')
  })

  it('maps recoverable failures to past_due', () => {
    assert.equal(normalizeStripeStatus('unpaid'), 'past_due')
    assert.equal(normalizeStripeStatus('incomplete'), 'past_due')
  })

  it('falls back unknown or non-normalized values to cancelled', () => {
    assert.equal(normalizeStripeStatus('ACTIVE'), 'cancelled')
    assert.equal(normalizeStripeStatus('unexpected_state'), 'cancelled')
  })
})

describe('normalizeGoCardlessStatus', () => {
  it('maps approved and active subscriptions to active', () => {
    assert.equal(normalizeGoCardlessStatus('active'), 'active')
    assert.equal(normalizeGoCardlessStatus('customer_approval_granted'), 'active')
  })

  it('maps pre-activation states to trialing', () => {
    assert.equal(normalizeGoCardlessStatus('pending_customer_approval'), 'trialing')
    assert.equal(normalizeGoCardlessStatus('submitted'), 'trialing')
  })

  it('maps payment risk states to past_due', () => {
    assert.equal(normalizeGoCardlessStatus('failed'), 'past_due')
    assert.equal(normalizeGoCardlessStatus('late_failure_settled'), 'past_due')
  })

  it('maps terminal states to cancelled', () => {
    assert.equal(normalizeGoCardlessStatus('cancelled'), 'cancelled')
    assert.equal(normalizeGoCardlessStatus('finished'), 'cancelled')
    assert.equal(normalizeGoCardlessStatus('unknown_state'), 'cancelled')
    assert.equal(normalizeGoCardlessStatus('  CANCELED '), 'cancelled')
  })
})
