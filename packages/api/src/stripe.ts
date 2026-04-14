/**
 * Provider-agnostic payments orchestration (Stripe + GoCardless).
 */

import { requireAuth } from './auth.js'
import { isAdministrativeRole } from './roles.js'
import { getSetting } from './settingsStore.js'
import {
  removeSubscriberFromNewsletter,
  syncNewsletterForStripeSubscription,
} from './brevo.js'

type PlanType = 'monthly' | 'yearly' | 'club'
type PaymentProvider = 'stripe' | 'gocardless'
type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'cancelled'

const VALID_PLANS: PlanType[] = ['monthly', 'yearly', 'club']
const PROVIDER_ORDER: PaymentProvider[] = ['stripe', 'gocardless']

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

async function stripePost(path: any, body: any, env: any): Promise<any> {
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

async function stripeGet(path: any, env: any): Promise<any> {
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

// ─── GoCardless API helpers ───────────────────────────────────────────────────

async function gocardlessFetch(path: string, method: string, payload: unknown, env: any): Promise<any> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(`https://api.gocardless.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GOCARDLESS_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'GoCardless-Version': '2015-07-06',
      },
      body: payload == null ? null : JSON.stringify(payload),
      signal: controller.signal,
    })
    const json = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, data: json }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      const err = new Error('GoCardless request timed out')
      Object.assign(err, { status: 504, code: 'gocardless_timeout' })
      throw err
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function gocardlessPost(path: string, payload: unknown, env: any): Promise<any> {
  return gocardlessFetch(path, 'POST', payload, env)
}

async function gocardlessGet(path: string, env: any): Promise<any> {
  return gocardlessFetch(path, 'GET', null, env)
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

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function verifyGoCardlessWebhook(rawBody: string, sigHeader: string, secret: string) {
  if (!sigHeader || !secret) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  const bytes = new Uint8Array(digest)
  const expectedHex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  const expectedBase64 = btoa(String.fromCharCode(...bytes))
  const candidate = sigHeader.trim()
  return constantTimeEqual(candidate, expectedHex) || constantTimeEqual(candidate, expectedBase64)
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
async function resolvePlanType(db: any, stripePriceId: any, env: any): Promise<PlanType> {
  const keys = ['stripe_price_monthly', 'stripe_price_yearly', 'stripe_price_club'] as const
  const planNames: PlanType[] = ['monthly', 'yearly', 'club']
  for (let i = 0; i < keys.length; i++) {
    const stored = await getSetting(env, keys[i], { ttlSeconds: 300 })
    if (stored && stored === stripePriceId) return planNames[i] ?? 'monthly'
  }
  return 'monthly' // fallback
}

function normalizePlanType(planType: string): PlanType {
  if (planType === 'yearly' || planType === 'club') return planType
  return 'monthly'
}

async function upsertSubscriptionRow(
  db: any,
  params: {
    userId: string
    planType: PlanType
    status: SubscriptionStatus
    provider: PaymentProvider
    providerSubscriptionId: string | null
    providerCustomerId: string | null
    stripeSubscriptionId?: string | null
    stripeCustomerId?: string | null
    currentPeriodEnd?: string | null
  },
) {
  await db.prepare(`
    INSERT INTO subscriptions
      (
        id,
        user_id,
        plan_type,
        status,
        provider,
        provider_subscription_id,
        provider_customer_id,
        stripe_subscription_id,
        stripe_customer_id,
        current_period_end,
        updated_at
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider, provider_subscription_id) DO UPDATE SET
      user_id                  = excluded.user_id,
      status                   = excluded.status,
      plan_type                = excluded.plan_type,
      provider_customer_id     = excluded.provider_customer_id,
      stripe_subscription_id   = excluded.stripe_subscription_id,
      stripe_customer_id       = excluded.stripe_customer_id,
      current_period_end       = excluded.current_period_end,
      updated_at               = CURRENT_TIMESTAMP
  `).bind(
    crypto.randomUUID(),
    params.userId,
    params.planType,
    params.status,
    params.provider,
    params.providerSubscriptionId,
    params.providerCustomerId,
    params.stripeSubscriptionId ?? null,
    params.stripeCustomerId ?? null,
    params.currentPeriodEnd ?? null,
  ).run()
}

async function upsertStripeSubscription(db: any, userId: string, stripeSub: any, env: any) {
  const priceId = stripeSub.items?.data?.[0]?.price?.id ?? null
  const planType = priceId ? await resolvePlanType(db, priceId, env ?? {}) : 'monthly'
  const status = normalizeStripeStatus(stripeSub.status)
  const currentPeriodEnd = stripeSub.current_period_end
    ? new Date(stripeSub.current_period_end * 1000).toISOString()
    : null

  await upsertSubscriptionRow(db, {
    userId,
    planType: normalizePlanType(planType),
    status,
    provider: 'stripe',
    providerSubscriptionId: stripeSub.id ?? null,
    providerCustomerId: stripeSub.customer ?? null,
    stripeSubscriptionId: stripeSub.id ?? null,
    stripeCustomerId: stripeSub.customer ?? null,
    currentPeriodEnd,
  })
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

export function normalizeGoCardlessStatus(status: string): SubscriptionStatus {
  const normalized = String(status ?? '').trim().toLowerCase()
  const statusMap: Record<string, SubscriptionStatus> = {
    active: 'active',
    customer_approval_granted: 'active',
    pending_customer_approval: 'trialing',
    submitted: 'trialing',
    cancelled: 'cancelled',
    canceled: 'cancelled',
    finished: 'cancelled',
    failed: 'past_due',
    late_failure_settled: 'past_due',
  }
  return statusMap[normalized] ?? 'cancelled'
}

async function getEnabledProviders(env: any): Promise<PaymentProvider[]> {
  const raw = String(await getSetting(env, 'payments_enabled_providers', { defaultValue: 'stripe' }) ?? 'stripe')
  const configured = raw
    .split(',')
    .map((v: string) => v.trim().toLowerCase())
    .filter((v: string): v is PaymentProvider => v === 'stripe' || v === 'gocardless')

  const available = configured.filter((provider) => {
    if (provider === 'stripe') return Boolean(env.STRIPE_SECRET_KEY)
    return Boolean(env.GOCARDLESS_ACCESS_TOKEN && env.GOCARDLESS_CREDITOR_ID)
  })
  if (available.length > 0) return available
  return Boolean(env.STRIPE_SECRET_KEY) ? ['stripe'] : []
}

async function getPricingSettings(env: any) {
  const [monthly, yearly, club] = await Promise.all([
    getSetting(env, 'monthly_price_eur', { ttlSeconds: 300 }),
    getSetting(env, 'yearly_price_eur', { ttlSeconds: 300 }),
    getSetting(env, 'club_price_eur', { ttlSeconds: 300 }),
  ])
  return {
    monthly: monthly == null ? null : Number(monthly),
    yearly: yearly == null ? null : Number(yearly),
    club: club == null ? null : Number(club),
  }
}

function getGoCardlessInterval(planType: PlanType): { interval: number, intervalUnit: 'monthly' | 'yearly' } {
  if (planType === 'monthly') return { interval: 1, intervalUnit: 'monthly' }
  return { interval: 1, intervalUnit: 'yearly' }
}

function moneyToMinorUnits(amount: number) {
  return Math.max(0, Math.round(amount * 100))
}

// ─── Route handlers ───────────────────────────────────────────────────────────

/**
 * GET /api/account/pricing — PUBLIC
 * Returns the display prices (EUR) from admin_settings.
 */
export async function handleGetPricing(request: any, env: any, corsHeaders: any) {
  try {
    const pricing = await getPricingSettings(env)
    const enabledProviders = await getEnabledProviders(env)
    if (pricing.monthly == null || pricing.yearly == null || pricing.club == null) {
      return jsonResponse({
        monthly: null,
        yearly: null,
        club: null,
        pricing_not_configured: true,
        enabledProviders,
      }, 200, corsHeaders)
    }
    return jsonResponse({
      monthly: pricing.monthly,
      yearly: pricing.yearly,
      club: pricing.club,
      enabledProviders,
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
  if (!body?.planType || !VALID_PLANS.includes(body.planType)) {
    return jsonResponse({ error: 'planType must be one of: monthly, yearly, club' }, 400, corsHeaders)
  }
  const planType = normalizePlanType(body.planType)

  try {
    const db = getDb(env)
    const enabledProviders = await getEnabledProviders(env)
    const selectedProvider = String(body?.provider ?? '').trim().toLowerCase() as PaymentProvider
    const provider: PaymentProvider = selectedProvider && PROVIDER_ORDER.includes(selectedProvider)
      ? selectedProvider
      : (enabledProviders[0] ?? 'stripe')

    if (!enabledProviders.includes(provider)) {
      return jsonResponse({
        error: 'Requested payment provider is not enabled.',
        code: 'provider_not_enabled',
      }, 400, corsHeaders)
    }

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

    const frontendUrl = env.FRONTEND_URL ?? 'http://localhost:3000'
    if (provider === 'stripe') {
      const priceId = await getSetting(env, `stripe_price_${planType}`, { ttlSeconds: 300 })
      if (!priceId) {
        return jsonResponse({
          error: 'Stripe prices not yet configured. Ask an admin to set stripe_price_* in admin_settings.',
          code: 'prices_not_configured',
        }, 503, corsHeaders)
      }

      const session = await stripePost('/checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        customer_email: user.email,
        metadata: { userId: user.sub, provider: 'stripe', planType },
        success_url: `${frontendUrl}/account?subscribed=1`,
        cancel_url: frontendUrl,
      }, env)

      if (session.error || !session.url) {
        console.error('Stripe checkout session error:', session.error)
        return jsonResponse({ error: 'Failed to create checkout session' }, 502, corsHeaders)
      }

      return jsonResponse({ checkoutUrl: session.url, provider }, 200, corsHeaders)
    }

    const checkoutToken = crypto.randomUUID()
    const sessionToken = crypto.randomUUID().replaceAll('-', '')
    const checkoutSessionId = crypto.randomUUID()
    await db.prepare(`
      INSERT INTO payment_checkout_sessions
        (id, user_id, provider, plan_type, checkout_token, session_token, status, updated_at)
      VALUES (?, ?, 'gocardless', ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    `).bind(checkoutSessionId, user.sub, planType, checkoutToken, sessionToken).run()

    const flowResponse = await gocardlessPost('/redirect_flows', {
      redirect_flows: {
        description: `VMP ${planType} subscription`,
        session_token: sessionToken,
        success_redirect_url: `${frontendUrl}/account?gocardless_redirect_flow_id={redirect_flow_id}&gocardless_checkout_token=${checkoutToken}`,
        prefilled_customer: { email: user.email },
        metadata: {
          userId: user.sub,
          planType,
          checkoutToken,
        },
        links: {
          creditor: env.GOCARDLESS_CREDITOR_ID,
        },
      },
    }, env)

    const redirectFlow = flowResponse?.data?.redirect_flows
    if (!flowResponse.ok || !redirectFlow?.id || !redirectFlow?.redirect_url) {
      console.error('GoCardless redirect flow error:', flowResponse?.data)
      return jsonResponse({ error: 'Failed to create GoCardless checkout flow' }, 502, corsHeaders)
    }

    await db.prepare(`
      UPDATE payment_checkout_sessions
      SET provider_checkout_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(redirectFlow.id, checkoutSessionId).run()

    return jsonResponse({
      checkoutUrl: redirectFlow.redirect_url,
      provider,
    }, 200, corsHeaders)
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
          await upsertStripeSubscription(db, userId, stripeSub, env)
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
          await upsertStripeSubscription(db, existing.user_id, stripeSub, env)
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
          await upsertStripeSubscription(db, existing.user_id, stripeSub, env)
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
 * POST /api/payments/webhook/gocardless — NO auth (GoCardless calls this directly)
 */
export async function handleGoCardlessWebhook(request: any, env: any, corsHeaders: any) {
  const rawBody = await request.text()
  const signature = request.headers.get('Webhook-Signature') ?? ''
  const valid = await verifyGoCardlessWebhook(rawBody, signature, String(env.GOCARDLESS_WEBHOOK_SECRET ?? ''))
  if (!valid) {
    return jsonResponse({ error: 'Invalid webhook signature' }, 400, corsHeaders)
  }

  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders)
  }

  const events = Array.isArray(payload?.events) ? payload.events : []
  if (events.length === 0) return jsonResponse({ ok: true }, 200, corsHeaders)

  try {
    const db = getDb(env)
    for (const event of events) {
      const resourceType = String(event?.resource_type ?? '')
      const action = String(event?.action ?? '')
      const subscriptionId = String(event?.links?.subscription ?? '').trim()
      if (resourceType !== 'subscriptions' || !subscriptionId) continue

      const existing = await db.prepare(`
        SELECT user_id, plan_type
        FROM subscriptions
        WHERE provider = 'gocardless' AND provider_subscription_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).bind(subscriptionId).first()
      if (!existing?.user_id) continue

      const subResponse = await gocardlessGet(`/subscriptions/${subscriptionId}`, env)
      const gocardlessSub = subResponse?.data?.subscriptions
      const status = normalizeGoCardlessStatus(gocardlessSub?.status || action)
      const currentPeriodEnd = gocardlessSub?.upcoming_payments?.[0]?.charge_date
        ? new Date(`${gocardlessSub.upcoming_payments[0].charge_date}T00:00:00.000Z`).toISOString()
        : null
      const planType = normalizePlanType(String(existing.plan_type || gocardlessSub?.metadata?.planType || 'monthly'))
      const customerId = String(gocardlessSub?.links?.customer ?? gocardlessSub?.links?.mandate ?? '')

      await upsertSubscriptionRow(db, {
        userId: existing.user_id,
        planType,
        status,
        provider: 'gocardless',
        providerSubscriptionId: subscriptionId,
        providerCustomerId: customerId || null,
        currentPeriodEnd,
      })
      if (status === 'active' || status === 'trialing') {
        await syncNewsletterForStripeSubscription(db, existing.user_id, 'active', env)
      } else if (status === 'cancelled' || status === 'past_due') {
        await removeSubscriberFromNewsletter(db, existing.user_id, env)
      }
    }
    return jsonResponse({ ok: true }, 200, corsHeaders)
  } catch (err) {
    console.error('handleGoCardlessWebhook error:', err)
    return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders)
  }
}

/**
 * POST /api/payments/gocardless/complete — protected
 * Completes a redirect flow after bank authorization and creates the recurring subscription.
 */
export async function handleGoCardlessComplete(request: any, env: any, corsHeaders: any) {
  let user: any
  try {
    user = await requireAuth(request, env)
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const body = await request.json().catch(() => null)
  const redirectFlowId = String(body?.redirectFlowId ?? '').trim()
  const checkoutToken = String(body?.checkoutToken ?? '').trim()
  if (!redirectFlowId || !checkoutToken) {
    return jsonResponse({ error: 'redirectFlowId and checkoutToken are required' }, 400, corsHeaders)
  }

  try {
    const db = getDb(env)
    const checkoutSession = await db.prepare(`
      SELECT id, user_id, plan_type, session_token, provider_checkout_id, status
      FROM payment_checkout_sessions
      WHERE provider = 'gocardless'
        AND user_id = ?
        AND checkout_token = ?
        AND provider_checkout_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(user.sub, checkoutToken, redirectFlowId).first()

    if (!checkoutSession || checkoutSession.status === 'completed') {
      return jsonResponse({ error: 'Checkout session not found or already completed' }, 404, corsHeaders)
    }

    const completeResponse = await gocardlessPost(
      `/redirect_flows/${redirectFlowId}/actions/complete`,
      { data: { session_token: checkoutSession.session_token } },
      env,
    )
    const redirectFlow = completeResponse?.data?.redirect_flows
    if (!completeResponse.ok || !redirectFlow?.links?.mandate) {
      console.error('GoCardless complete flow error:', completeResponse?.data)
      return jsonResponse({ error: 'Failed to complete GoCardless authorization' }, 502, corsHeaders)
    }

    const pricing = await getPricingSettings(env)
    const planType = normalizePlanType(String(checkoutSession.plan_type || 'monthly'))
    const amountEur = pricing[planType]
    if (amountEur == null || !Number.isFinite(amountEur)) {
      return jsonResponse({ error: 'Pricing is not configured for selected plan' }, 503, corsHeaders)
    }

    const interval = getGoCardlessInterval(planType)
    const currencyRaw = await getSetting(env, 'gocardless_currency', { defaultValue: 'EUR' })
    const currency = String(currencyRaw || 'EUR').toUpperCase()
    const planNameRaw = await getSetting(env, `gocardless_plan_${planType}`, { defaultValue: `VMP ${planType}` })
    const planName = String(planNameRaw || `VMP ${planType}`)
    const subscriptionResponse = await gocardlessPost('/subscriptions', {
      subscriptions: {
        amount: moneyToMinorUnits(amountEur),
        currency,
        name: planName,
        interval: interval.interval,
        interval_unit: interval.intervalUnit,
        day_of_month: 1,
        links: {
          mandate: redirectFlow.links.mandate,
        },
        metadata: {
          userId: user.sub,
          planType,
          checkoutToken,
        },
      },
    }, env)
    const gocardlessSub = subscriptionResponse?.data?.subscriptions
    if (!subscriptionResponse.ok || !gocardlessSub?.id) {
      console.error('GoCardless create subscription error:', subscriptionResponse?.data)
      return jsonResponse({ error: 'Failed to create GoCardless subscription' }, 502, corsHeaders)
    }

    const status = normalizeGoCardlessStatus(String(gocardlessSub.status ?? 'pending_customer_approval'))
    const currentPeriodEnd = gocardlessSub?.upcoming_payments?.[0]?.charge_date
      ? new Date(`${gocardlessSub.upcoming_payments[0].charge_date}T00:00:00.000Z`).toISOString()
      : null
    const providerCustomerId = String(gocardlessSub?.links?.customer ?? redirectFlow?.links?.customer ?? redirectFlow?.links?.mandate ?? '')
    await upsertSubscriptionRow(db, {
      userId: user.sub,
      planType,
      status,
      provider: 'gocardless',
      providerSubscriptionId: gocardlessSub.id,
      providerCustomerId: providerCustomerId || null,
      currentPeriodEnd,
    })
    if (status === 'active' || status === 'trialing') {
      await syncNewsletterForStripeSubscription(db, user.sub, 'active', env)
    }

    await db.prepare(`
      UPDATE payment_checkout_sessions
      SET status = 'completed',
          provider_subscription_id = ?,
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(gocardlessSub.id, checkoutSession.id).run()

    return jsonResponse({
      ok: true,
      provider: 'gocardless',
      subscriptionStatus: status,
      subscriptionId: gocardlessSub.id,
    }, 200, corsHeaders)
  } catch (err) {
    console.error('handleGoCardlessComplete error:', err)
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
          provider:            'staff',
          providerCustomerId:  null,
          stripeCustomerId:    null,
          currentPeriodEnd:    null,
          createdAt:           now,
          updatedAt:           now,
        },
      }, 200, corsHeaders)
    }

    const sub = await db.prepare(`
      SELECT id, user_id, plan_type, status, provider, provider_customer_id, stripe_customer_id,
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
        provider:            sub.provider ?? 'stripe',
        providerCustomerId:  sub.provider_customer_id ?? null,
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
      SELECT provider, stripe_customer_id FROM subscriptions
      WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).bind(user.sub).first()

    if (!sub) {
      return jsonResponse({ error: 'No active subscription found' }, 404, corsHeaders)
    }
    if ((sub.provider ?? 'stripe') !== 'stripe') {
      const manageUrl = String(await getSetting(env, 'gocardless_manage_subscription_url', { defaultValue: '' }) ?? '').trim()
      if (manageUrl) return jsonResponse({ portalUrl: manageUrl }, 200, corsHeaders)
      return jsonResponse({
        error: 'Customer portal is not available for this payment provider.',
        code: 'portal_not_supported',
      }, 409, corsHeaders)
    }
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