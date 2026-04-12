/**
 * packages/api/src/stripe.js
 *
 * Stripe Payments integration for VMP.
 *
 * All Stripe API calls use fetch() with application/x-www-form-urlencoded bodies —
 * the Stripe Node.js SDK does not run in Cloudflare Workers.
 * Webhook signatures are verified with SubtleCrypto HMAC-SHA256 (no library needed).
 *
 * Exported route handlers:
 *   GET  /api/account/pricing      — public; returns plan prices from admin_settings
 *   POST /api/payments/checkout    — protected; creates a Stripe Checkout Session
 *   POST /api/payments/webhook     — Stripe calls this; verifies signature, handles events
 *   GET  /api/account/subscription — protected; returns current subscription for the user
 *   POST /api/payments/portal      — protected; creates a Stripe Customer Portal session
 */

import { requireAuth } from './auth.js'
import { isAdministrativeRole } from './roles.js'
import { getSetting } from './settingsStore.js'
import {
  removeSubscriberFromNewsletter,
  syncNewsletterForStripeSubscription,
} from './brevo.js'

// ─── Stripe API helpers ───────────────────────────────────────────────────────

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

async function stripePost(path: any, body: any, env: any) {
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
    return res.json()
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

async function stripeGet(path: any, env: any) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      signal: controller.signal,
    })
    return res.json()
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

// ─── Webhook verification ─────────────────────────────────────────────────────

/**
 * Verify a Stripe webhook signature.
 *
 * Stripe sends: Stripe-Signature: t=<timestamp>,v1=<hex_sig>
 * Signed payload: "<timestamp>.<rawBody>"
 * Algorithm: HMAC-SHA256 keyed with STRIPE_WEBHOOK_SECRET
 */
async function verifyStripeWebhook(rawBody: any, sigHeader: any, secret: any) {
  if (!sigHeader || !secret) return false

  // Parse "t=<timestamp>,v1=<sig1>,v1=<sig2>" — multiple v1= values are valid
  // when Stripe rotates webhook signing secrets.
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

  // Reject events older than 5 minutes to prevent replay attacks
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

  // Constant-time comparison against each signature in the header
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

// ─── D1 / admin_settings helpers ─────────────────────────────────────────────

function getDb(env: any) {
  const db = env.DB || env.video_subscription_db
  if (!db) throw new Error('D1 binding not found')
  return db
}

/**
 * Resolve plan_type ('monthly'|'yearly'|'club') from a Stripe price ID
 * by comparing against the price IDs stored in admin_settings.
 */
async function resolvePlanType(db: any, stripePriceId: any, env: any) {
  const keys = ['stripe_price_monthly', 'stripe_price_yearly', 'stripe_price_club']
  const planNames = ['monthly', 'yearly', 'club']
  for (let i = 0; i < keys.length; i++) {
    const stored = await getSetting(env, keys[i], { ttlSeconds: 300 })
    if (stored && stored === stripePriceId) return planNames[i]
  }
  return 'monthly' // fallback
}

/**
 * Upsert a subscription row in D1 from a Stripe subscription object.
 * Uses ON CONFLICT(stripe_subscription_id) so repeated webhook deliveries are idempotent.
 */
async function upsertSubscription(db: any, userId: any, stripeSub: any, env: any) {
  const priceId = stripeSub.items?.data?.[0]?.price?.id ?? null
  const planType = priceId ? await resolvePlanType(db, priceId, env ?? {}) : 'monthly'
  const status = normalizeStripeStatus(stripeSub.status)
  const currentPeriodEnd = stripeSub.current_period_end
    ? new Date(stripeSub.current_period_end * 1000).toISOString()
    : null

  await db.prepare(`
    INSERT INTO subscriptions
      (id, user_id, plan_type, status, stripe_subscription_id, stripe_customer_id, current_period_end, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(stripe_subscription_id) DO UPDATE SET
      status             = excluded.status,
      plan_type          = excluded.plan_type,
      current_period_end = excluded.current_period_end,
      stripe_customer_id = excluded.stripe_customer_id,
      updated_at         = CURRENT_TIMESTAMP
  `).bind(
    crypto.randomUUID(),
    userId,
    planType,
    status,
    stripeSub.id,
    stripeSub.customer ?? null,
    currentPeriodEnd,
  ).run()
}

/** Map Stripe subscription statuses to our internal values. */
function normalizeStripeStatus(stripeStatus: string): 'active' | 'trialing' | 'past_due' | 'cancelled' {
  const statusMap: Record<string, 'active' | 'trialing' | 'past_due' | 'cancelled'> = {
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

// ─── Route handlers ───────────────────────────────────────────────────────────

/**
 * GET /api/account/pricing — PUBLIC
 * Returns the display prices (EUR) from admin_settings.
 */
export async function handleGetPricing(request: any, env: any, corsHeaders: any) {
  try {
    const db = getDb(env)
    const [monthly, yearly, club] = await Promise.all([
      getSetting(env, 'monthly_price_eur', { ttlSeconds: 300 }),
      getSetting(env, 'yearly_price_eur', { ttlSeconds: 300 }),
      getSetting(env, 'club_price_eur', { ttlSeconds: 300 }),
    ])
    if (monthly == null || yearly == null || club == null) {
      return jsonResponse({
        monthly: null,
        yearly: null,
        club: null,
        pricing_not_configured: true,
      }, 200, corsHeaders)
    }
    return jsonResponse({
      monthly: Number(monthly),
      yearly:  Number(yearly),
      club:    Number(club),
    }, 200, corsHeaders)
  } catch (err) {
    console.error('handleGetPricing error:', err)
    return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders)
  }
}

/**
 * POST /api/payments/checkout — protected
 * Body: { planType: 'monthly'|'yearly'|'club' }
 * Creates a Stripe Checkout Session and returns { checkoutUrl }.
 */
export async function handleCheckout(request: any, env: any, corsHeaders: any) {
  let user
  try {
    user = await requireAuth(request, env)
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const body = await request.json().catch(() => null)
  const validPlans = ['monthly', 'yearly', 'club']
  if (!body?.planType || !validPlans.includes(body.planType)) {
    return jsonResponse({ error: 'planType must be one of: monthly, yearly, club' }, 400, corsHeaders)
  }

  try {
    const db = getDb(env)

    // Guard: don't create a new checkout session if the user already has an
    // active or trialing subscription. Return a 409 pointing them to the portal.
    const existingSub = await db.prepare(`
      SELECT id FROM subscriptions
      WHERE user_id = ? AND status IN ('active', 'trialing', 'past_due')
      LIMIT 1
    `).bind(user.sub).first()
    if (existingSub) {
      return jsonResponse({
        error: 'You already have an active subscription. Use the customer portal to manage it.',
        code: 'subscription_exists',
      }, 409, corsHeaders)
    }

    const priceId = await getSetting(env, `stripe_price_${body.planType}`, { ttlSeconds: 300 })
    if (!priceId) {
      return jsonResponse({
        error: 'Stripe prices not yet configured. Ask an admin to set stripe_price_* in admin_settings.',
        code: 'prices_not_configured',
      }, 503, corsHeaders)
    }

    const frontendUrl = env.FRONTEND_URL ?? 'http://localhost:3000'
    const session = await stripePost('/checkout/sessions', {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: user.email,
      metadata: { userId: user.sub },
      success_url: `${frontendUrl}/account?subscribed=1`,
      cancel_url: frontendUrl,
    }, env)

    if (session.error || !session.url) {
      console.error('Stripe checkout session error:', session.error)
      return jsonResponse({ error: 'Failed to create checkout session' }, 502, corsHeaders)
    }

    return jsonResponse({ checkoutUrl: session.url }, 200, corsHeaders)
  } catch (err) {
    console.error('handleCheckout error:', err)
    return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders)
  }
}

/**
 * POST /api/payments/webhook — NO auth (Stripe calls this directly)
 * Verifies Stripe signature and handles subscription lifecycle events.
 */
export async function handleWebhook(request: any, env: any, corsHeaders: any) {
  // Read raw body as text — must be done before any parsing to keep the
  // exact bytes Stripe used when generating the signature.
  const rawBody = await request.text()
  const sigHeader = request.headers.get('Stripe-Signature') ?? ''

  const valid = await verifyStripeWebhook(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET)
  if (!valid) {
    return jsonResponse({ error: 'Invalid webhook signature' }, 400, corsHeaders)
  }

  let event
  try {
    event = JSON.parse(rawBody)
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders)
  }

  try {
    const db = getDb(env)

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const userId = session.metadata?.userId
        if (!userId || !session.subscription) break

        // Fetch the full subscription object to get current_period_end and plan
        const stripeSub = await stripeGet(`/subscriptions/${session.subscription}`, env)
        if (stripeSub.id) {
          await upsertSubscription(db, userId, stripeSub, env)
          try {
            await syncNewsletterForStripeSubscription(db, userId, stripeSub.status, env)
          } catch (brevoErr) {
            console.error(
              '[stripe webhook] syncNewsletterForStripeSubscription failed',
              { fn: 'syncNewsletterForStripeSubscription', userId, stripeStatus: stripeSub.status, err: brevoErr },
            )
          }
        }
        break
      }

      case 'customer.subscription.updated': {
        const stripeSub = event.data.object
        // Find our user_id via stripe_subscription_id
        const existing = await db.prepare(
          'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ? LIMIT 1'
        ).bind(stripeSub.id).first()
        if (existing) {
          await upsertSubscription(db, existing.user_id, stripeSub, env)
          try {
            await syncNewsletterForStripeSubscription(db, existing.user_id, stripeSub.status, env)
          } catch (brevoErr) {
            console.error(
              '[stripe webhook] syncNewsletterForStripeSubscription failed',
              { fn: 'syncNewsletterForStripeSubscription', userId: existing.user_id, stripeStatus: stripeSub.status, err: brevoErr },
            )
          }
        }
        break
      }

      case 'invoice.paid': {
        const invoice = event.data.object
        if (!invoice.subscription) break
        const stripeSub = await stripeGet(`/subscriptions/${invoice.subscription}`, env)
        if (!stripeSub.id) break
        const existing = await db.prepare(
          'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ? LIMIT 1'
        ).bind(stripeSub.id).first()
        if (existing) {
          await upsertSubscription(db, existing.user_id, stripeSub, env)
          try {
            await syncNewsletterForStripeSubscription(db, existing.user_id, stripeSub.status, env)
          } catch (brevoErr) {
            console.error(
              '[stripe webhook] syncNewsletterForStripeSubscription failed',
              { fn: 'syncNewsletterForStripeSubscription', userId: existing.user_id, stripeStatus: stripeSub.status, err: brevoErr },
            )
          }
        }
        break
      }

      case 'customer.subscription.deleted': {
        const stripeSub = event.data.object
        const row = await db.prepare(
          'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ? LIMIT 1'
        ).bind(stripeSub.id).first()
        await db.prepare(`
          UPDATE subscriptions
          SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
          WHERE stripe_subscription_id = ?
        `).bind(stripeSub.id).run()
        if (row?.user_id) {
          try {
            await removeSubscriberFromNewsletter(db, row.user_id, env)
          } catch (brevoErr) {
            console.error(
              '[stripe webhook] removeSubscriberFromNewsletter failed',
              { fn: 'removeSubscriberFromNewsletter', userId: row.user_id, err: brevoErr },
            )
          }
        }
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object
        if (invoice.subscription) {
          const existing = await db.prepare(
            'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ? LIMIT 1'
          ).bind(invoice.subscription).first()
          await db.prepare(`
            UPDATE subscriptions
            SET status = 'past_due', updated_at = CURRENT_TIMESTAMP
            WHERE stripe_subscription_id = ?
          `).bind(invoice.subscription).run()
          if (existing?.user_id) {
            try {
              await removeSubscriberFromNewsletter(db, existing.user_id, env)
            } catch (brevoErr) {
              console.error(
                '[stripe webhook] removeSubscriberFromNewsletter failed',
                { fn: 'removeSubscriberFromNewsletter', userId: existing.user_id, err: brevoErr },
              )
            }
          }
        }
        break
      }

      default:
        // Unhandled event type — acknowledge receipt so Stripe doesn't retry
        break
    }

    return jsonResponse({ ok: true }, 200, corsHeaders)
  } catch (err) {
    console.error('handleWebhook error:', err)
    // Return 500 so Stripe retries the event on transient failures
    return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders)
  }
}

/**
 * GET /api/account/subscription — protected
 * Returns the most recent subscription row for the authenticated user.
 */
export async function handleGetSubscription(request: any, env: any, corsHeaders: any) {
  let user
  try {
    user = await requireAuth(request, env)
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  try {
    const db = getDb(env)
    if (isAdministrativeRole(user.role)) {
      const now = new Date().toISOString()
      return jsonResponse({
        subscription: {
          id:                  `role:${user.role}`,
          planType:            'staff',
          status:              'active',
          stripeCustomerId:    null,
          currentPeriodEnd:    null,
          createdAt:           now,
          updatedAt:           now,
        },
      }, 200, corsHeaders)
    }

    const sub = await db.prepare(`
      SELECT id, user_id, plan_type, status, stripe_customer_id,
             current_period_end, created_at, updated_at
      FROM subscriptions
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(user.sub).first()

    if (!sub) {
      return jsonResponse({ subscription: null }, 200, corsHeaders)
    }

    return jsonResponse({
      subscription: {
        id:                  sub.id,
        planType:            sub.plan_type,
        status:              sub.status,
        stripeCustomerId:    sub.stripe_customer_id,
        currentPeriodEnd:    sub.current_period_end,
        createdAt:           sub.created_at,
        updatedAt:           sub.updated_at,
      },
    }, 200, corsHeaders)
  } catch (err) {
    console.error('handleGetSubscription error:', err)
    return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders)
  }
}

/**
 * POST /api/payments/portal — protected
 * Creates a Stripe Customer Portal session so users can manage their subscription.
 * Returns { portalUrl }.
 */
export async function handlePortal(request: any, env: any, corsHeaders: any) {
  let user
  try {
    user = await requireAuth(request, env)
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  try {
    const db = getDb(env)
    const sub = await db.prepare(`
      SELECT stripe_customer_id FROM subscriptions
      WHERE user_id = ? AND stripe_customer_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).bind(user.sub).first()

    if (!sub?.stripe_customer_id) {
      return jsonResponse({ error: 'No active subscription found' }, 404, corsHeaders)
    }

    const frontendUrl = env.FRONTEND_URL ?? 'http://localhost:3000'
    const portalSession = await stripePost('/billing_portal/sessions', {
      customer:   sub.stripe_customer_id,
      return_url: `${frontendUrl}/account`,
    }, env)

    if (portalSession.error || !portalSession.url) {
      console.error('Stripe portal session error:', portalSession.error)
      return jsonResponse({ error: 'Failed to create portal session' }, 502, corsHeaders)
    }

    return jsonResponse({ portalUrl: portalSession.url }, 200, corsHeaders)
  } catch (err) {
    console.error('handlePortal error:', err)
    return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders)
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function jsonResponse(data: any, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}