/**
 * Stripe HTTP client, webhook verification, and subscription status normalization.
 */

type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'cancelled'

/**
 * Recursively URL-encode an object into Stripe's expected format.
 * Nested objects become bracket notation: { a: { b: 1 } } → "a[b]=1"
 * Arrays become indexed: { a: [1,2] } → "a[0]=1&a[1]=2"
 */
// @ts-expect-error TS(7023): 'encodeStripeBody' implicitly has return type 'any... Remove this comment to see the full error message
function encodeStripeBody(obj: any, prefix = '') {
  const parts = []
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue
    const fullKey = prefix ? `${prefix}[${key}]` : key
    if (typeof value === 'object' && !Array.isArray(value)) {
      parts.push(encodeStripeBody(value, fullKey))
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'object') {
          parts.push(encodeStripeBody(item, `${fullKey}[${i}]`))
        } else {
          parts.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(item)}`)
        }
      })
    } else {
      // @ts-expect-error TS(2345): Argument of type 'unknown' is not assignable to pa... Remove this comment to see the full error message
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(value)}`)
    }
  }
  return parts.join('&')
}

export async function stripePost(path: any, body: any, env: any): Promise<any> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: encodeStripeBody(body),
      signal: controller.signal,
    })
    return (await res.json()) as any
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      const err = new Error('Stripe request timed out')
      Object.assign(err, { status: 504, code: 'stripe_timeout' })
      throw err
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function stripeGet(path: any, env: any): Promise<any> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      signal: controller.signal,
    })
    return (await res.json()) as any
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      const err = new Error('Stripe request timed out')
      Object.assign(err, { status: 504, code: 'stripe_timeout' })
      throw err
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Verify a Stripe webhook signature.
 *
 * Stripe sends: Stripe-Signature: t=<timestamp>,v1=<hex_sig>
 * Signed payload: "<timestamp>.<rawBody>"
 * Algorithm: HMAC-SHA256 keyed with STRIPE_WEBHOOK_SECRET
 */
export async function verifyStripeWebhook(rawBody: any, sigHeader: any, secret: any) {
  if (!sigHeader || !secret) return false

  let ts = null
  const v1s = []
  for (const segment of sigHeader.split(',')) {
    const eq = segment.indexOf('=')
    if (eq === -1) continue
    const k = segment.slice(0, eq)
    const v = segment.slice(eq + 1)
    if (k === 't') ts = Number(v)
    else if (k === 'v1') v1s.push(v)
  }
  if (!ts || v1s.length === 0) return false

  if (Math.abs(Date.now() / 1000 - ts) > 300) return false

  const signedPayload = `${ts}.${rawBody}`

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBytes = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(signedPayload),
  )
  const expected = [...new Uint8Array(sigBytes)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  for (const candidate of v1s) {
    if (expected.length !== candidate.length) continue
    let diff = 0
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ candidate.charCodeAt(i)
    }
    if (diff === 0) return true
  }
  return false
}

/** Map Stripe subscription statuses to our internal values. */
export function normalizeStripeStatus(stripeStatus: string): SubscriptionStatus {
  const statusMap: Record<string, SubscriptionStatus> = {
    active: 'active',
    trialing: 'trialing',
    past_due: 'past_due',
    canceled: 'cancelled',
    cancelled: 'cancelled',
    unpaid: 'past_due',
    incomplete: 'past_due',
    incomplete_expired: 'cancelled',
    paused: 'cancelled',
  }
  return statusMap[stripeStatus] ?? 'cancelled'
}
