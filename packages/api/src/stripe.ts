/**
 * Provider-agnostic payments orchestration (Stripe + GoCardless).
 */

import { requireAuth, requireRole } from './auth.js'
import { isAdministrativeRole } from './roles.js'
import { getSetting, setSettings } from './settingsStore.js'
import {
  removeSubscriberFromNewsletter,
  syncNewsletterForStripeSubscription,
} from './brevo.js'
import {
  applyPromoRedemption,
  resolvePromoCodeForCheckout,
} from './promotions.js'
import { normalizeStripeStatus, stripeGet, stripePost, verifyStripeWebhook } from './stripeClient.js'
export { normalizeStripeStatus } from './stripeClient.js'
import {
  gocardlessGet,
  gocardlessPost,
  getGoCardlessInterval,
  normalizeGoCardlessStatus,
  verifyGoCardlessWebhook,
} from './gocardless.js'
export { normalizeGoCardlessStatus } from './gocardless.js'

type PlanType = 'monthly' | 'yearly' | 'club'
type PaymentProvider = 'stripe' | 'gocardless'
type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'cancelled'

async function getAllowedPlans(env: any): Promise<PlanType[]> {
  const raw = String(await getSetting(env, 'allowed_plans', { defaultValue: 'monthly,yearly,club' }) ?? 'monthly,yearly,club')
  const plans = raw
    .split(',')
    .map((v: string) => v.trim().toLowerCase())
    .filter((v: string): v is PlanType => v === 'monthly' || v === 'yearly' || v === 'club')
  return plans.length > 0 ? plans : ['monthly', 'yearly', 'club']
}

async function getPaymentProviderOrder(env: any): Promise<PaymentProvider[]> {
  const stored = await getSetting(env, 'payment_provider_order', { defaultValue: 'stripe,gocardless' })
  const raw = String(stored ?? 'stripe,gocardless').trim()
  const providers = (raw ? raw : 'stripe,gocardless')
    .split(',')
    .map((v: string) => v.trim().toLowerCase())
    .filter((v: string): v is PaymentProvider => v === 'stripe' || v === 'gocardless')
  return providers.length > 0 ? providers : ['stripe', 'gocardless']
}

/** Gateways enabled in admin_settings (used for public pricing + UI). */
async function getConfiguredProviders(env: any): Promise<PaymentProvider[]> {
  const stored = await getSetting(env, 'payments_enabled_providers', { defaultValue: 'stripe' })
  const raw = String(stored ?? 'stripe').trim()
  let configured = (raw ? raw : 'stripe')
    .split(',')
    .map((v: string) => v.trim().toLowerCase())
    .filter((v: string): v is PaymentProvider => v === 'stripe' || v === 'gocardless')
  if (configured.length === 0) configured = ['stripe']
  return configured
}

/** Gateways that can actually run checkout in this environment (requires provider credentials). */
async function getRunnableProviders(env: any): Promise<PaymentProvider[]> {
  const configured = await getConfiguredProviders(env)
  const available = configured.filter((provider) => {
    if (provider === 'stripe') return Boolean(env.STRIPE_SECRET_KEY)
    return Boolean(env.GOCARDLESS_ACCESS_TOKEN && env.GOCARDLESS_CREDITOR_ID)
  })
  if (available.length > 0) return available
  return Boolean(env.STRIPE_SECRET_KEY) ? ['stripe'] : []
}

async function getPricingSettings(env: any, provider?: PaymentProvider) {
  const prefix = provider ? `${provider}_` : ''
  const [monthly, yearly, club] = await Promise.all([
    getSetting(env, `${prefix}monthly_price_eur`, { ttlSeconds: 300 }),
    getSetting(env, `${prefix}yearly_price_eur`, { ttlSeconds: 300 }),
    getSetting(env, `${prefix}club_price_eur`, { ttlSeconds: 300 }),
  ])
  return {
    monthly: monthly == null ? null : Number(monthly),
    yearly: yearly == null ? null : Number(yearly),
    club: club == null ? null : Number(club),
  }
}

async function getEffectivePricingSettings(env: any, provider: PaymentProvider) {
  const [providerPricing, fallbackPricing] = await Promise.all([
    getPricingSettings(env, provider),
    getPricingSettings(env),
  ])
  return {
    monthly: providerPricing.monthly ?? fallbackPricing.monthly,
    yearly: providerPricing.yearly ?? fallbackPricing.yearly,
    club: providerPricing.club ?? fallbackPricing.club,
  }
}

function moneyToMinorUnits(amount: number) {
  return Math.max(0, Math.round(amount * 100))
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

// ─── Route handlers ───────────────────────────────────────────────────────────

/**
 * GET /api/account/pricing — PUBLIC
 * Returns the display prices (EUR) from admin_settings.
 */
export async function handleGetPricing(request: any, env: any, corsHeaders: any) {
  try {
    const configuredProviders = await getConfiguredProviders(env)
    const providerOrder = await getPaymentProviderOrder(env)
    const orderedEnabled = [
      ...providerOrder.filter((p) => configuredProviders.includes(p)),
      ...configuredProviders.filter((p) => !providerOrder.includes(p)),
    ]
    const enabledProviders = orderedEnabled
    const [stripePricing, gocardlessPricing] = await Promise.all([
      getEffectivePricingSettings(env, 'stripe'),
      getEffectivePricingSettings(env, 'gocardless'),
    ])
    const primary = enabledProviders[0] ?? 'stripe'
    const activePricing = primary === 'gocardless' ? gocardlessPricing : stripePricing
    const pricingNotConfigured = configuredProviders.some((provider) => {
      const pricing = provider === 'gocardless' ? gocardlessPricing : stripePricing
      return pricing.monthly == null || pricing.yearly == null || pricing.club == null
    })
    if (pricingNotConfigured) {
      return jsonResponse({
        monthly: activePricing.monthly,
        yearly: activePricing.yearly,
        club: activePricing.club,
        pricesByProvider: {
          stripe: stripePricing,
          gocardless: gocardlessPricing,
        },
        pricing_not_configured: true,
        enabledProviders,
      }, 200, corsHeaders)
    }
    return jsonResponse({
      monthly: activePricing.monthly,
      yearly: activePricing.yearly,
      club: activePricing.club,
      pricesByProvider: {
        stripe: stripePricing,
        gocardless: gocardlessPricing,
      },
      enabledProviders,
    }, 200, corsHeaders)
  } catch (err) {
    console.error('handleGetPricing error:', err)
    return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders)
  }
}

function parseCsvList(input: unknown, allowValues: string[]) {
  if (Array.isArray(input)) {
    return input.map((v) => String(v).trim().toLowerCase()).filter((v) => allowValues.includes(v))
  }
  return String(input ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter((v) => allowValues.includes(v))
}

function parseOptionalPositiveNumber(input: unknown) {
  if (input === '' || input == null) return ''
  const numeric = Number(input)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('Prices must be positive numbers')
  }
  return String(numeric)
}

export async function handleAdminPaymentSettings(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  if (request.method === 'GET') {
    const keys = [
      'payments_enabled_providers',
      'payment_provider_order',
      'allowed_plans',
      'monthly_price_eur',
      'yearly_price_eur',
      'club_price_eur',
      'stripe_monthly_price_eur',
      'stripe_yearly_price_eur',
      'stripe_club_price_eur',
      'gocardless_monthly_price_eur',
      'gocardless_yearly_price_eur',
      'gocardless_club_price_eur',
      'stripe_price_monthly',
      'stripe_price_yearly',
      'stripe_price_club',
    ] as const
    const values = await Promise.all(keys.map((key) => getSetting(env, key)))
    const valueByKey = Object.fromEntries(keys.map((key, index) => [key, values[index]]))
    return jsonResponse({
      enabledProviders: parseCsvList(valueByKey.payments_enabled_providers ?? 'stripe', ['stripe', 'gocardless']),
      providerOrder: parseCsvList(valueByKey.payment_provider_order ?? 'stripe,gocardless', ['stripe', 'gocardless']),
      allowedPlans: parseCsvList(valueByKey.allowed_plans ?? 'monthly,yearly,club', ['monthly', 'yearly', 'club']),
      basePrices: {
        monthly: valueByKey.monthly_price_eur ?? '',
        yearly: valueByKey.yearly_price_eur ?? '',
        club: valueByKey.club_price_eur ?? '',
      },
      providerPrices: {
        stripe: {
          monthly: valueByKey.stripe_monthly_price_eur ?? '',
          yearly: valueByKey.stripe_yearly_price_eur ?? '',
          club: valueByKey.stripe_club_price_eur ?? '',
        },
        gocardless: {
          monthly: valueByKey.gocardless_monthly_price_eur ?? '',
          yearly: valueByKey.gocardless_yearly_price_eur ?? '',
          club: valueByKey.gocardless_club_price_eur ?? '',
        },
      },
      stripePriceIds: {
        monthly: valueByKey.stripe_price_monthly ?? '',
        yearly: valueByKey.stripe_price_yearly ?? '',
        club: valueByKey.stripe_price_club ?? '',
      },
    }, 200, corsHeaders)
  }

  if (request.method !== 'PATCH') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  }

    const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'Request body is required' }, 400, corsHeaders)
  }

  try {
    const enabledProviders = parseCsvList(body.enabledProviders ?? 'stripe', ['stripe', 'gocardless'])
    if (!enabledProviders.length) {
      return jsonResponse({ error: 'At least one payment provider must be enabled' }, 400, corsHeaders)
    }
    const providerOrder = parseCsvList(body.providerOrder ?? enabledProviders, ['stripe', 'gocardless'])
    const allowedPlans = parseCsvList(body.allowedPlans ?? 'monthly,yearly,club', ['monthly', 'yearly', 'club'])
    const basePrices = body.basePrices ?? {}
    const providerPrices = body.providerPrices ?? {}
    const stripePriceIds = body.stripePriceIds ?? {}

    const updates: [string, string][] = [
      ['payments_enabled_providers', enabledProviders.join(',')],
      ['payment_provider_order', providerOrder.join(',')],
      ['allowed_plans', (allowedPlans.length ? allowedPlans : ['monthly', 'yearly', 'club']).join(',')],
      ['monthly_price_eur', parseOptionalPositiveNumber(basePrices.monthly)],
      ['yearly_price_eur', parseOptionalPositiveNumber(basePrices.yearly)],
      ['club_price_eur', parseOptionalPositiveNumber(basePrices.club)],
      ['stripe_monthly_price_eur', parseOptionalPositiveNumber(providerPrices?.stripe?.monthly)],
      ['stripe_yearly_price_eur', parseOptionalPositiveNumber(providerPrices?.stripe?.yearly)],
      ['stripe_club_price_eur', parseOptionalPositiveNumber(providerPrices?.stripe?.club)],
      ['gocardless_monthly_price_eur', parseOptionalPositiveNumber(providerPrices?.gocardless?.monthly)],
      ['gocardless_yearly_price_eur', parseOptionalPositiveNumber(providerPrices?.gocardless?.yearly)],
      ['gocardless_club_price_eur', parseOptionalPositiveNumber(providerPrices?.gocardless?.club)],
      ['stripe_price_monthly', String(stripePriceIds.monthly ?? '').trim()],
      ['stripe_price_yearly', String(stripePriceIds.yearly ?? '').trim()],
      ['stripe_price_club', String(stripePriceIds.club ?? '').trim()],
    ]

    await setSettings(env, updates)
    return jsonResponse({ ok: true }, 200, corsHeaders)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid settings'
    return jsonResponse({ error: message }, 400, corsHeaders)
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
  const allowedPlans = await getAllowedPlans(env)
  if (!body?.planType || !allowedPlans.includes(body.planType)) {
    return jsonResponse({ error: `planType must be one of: ${allowedPlans.join(', ')}` }, 400, corsHeaders)
  }
  const planType = normalizePlanType(body.planType)

  try {
    const db = getDb(env)
    const configuredProviders = await getConfiguredProviders(env)
    const runnableProviders = await getRunnableProviders(env)
    const providerOrder = await getPaymentProviderOrder(env)
    const orderedRunnable = [
      ...providerOrder.filter((p) => runnableProviders.includes(p)),
      ...runnableProviders.filter((p) => !providerOrder.includes(p)),
    ]
    const defaultProvider: PaymentProvider = orderedRunnable[0] ?? 'stripe'
    const selectedProvider = String(body?.provider ?? '').trim().toLowerCase() as PaymentProvider
    const provider: PaymentProvider = selectedProvider && providerOrder.includes(selectedProvider)
      ? selectedProvider
      : defaultProvider

    const promoResolution = provider === 'stripe'
      ? await resolvePromoCodeForCheckout(env, body?.promoCode, planType)
      : { ok: false, reason: 'empty' }
    const promoMeta = promoResolution.ok ? promoResolution.checkoutMeta : null
    if (!promoResolution.ok && promoResolution.reason !== 'empty') {
      return jsonResponse({
        error: promoResolution.error ?? 'Promo code is not valid',
        code: promoResolution.reason ?? 'invalid_promo',
      }, promoResolution.status ?? 400, corsHeaders)
    }

    if (!configuredProviders.includes(provider)) {
      return jsonResponse({
        error: 'Requested payment provider is not enabled.',
        code: 'provider_not_enabled',
      }, 400, corsHeaders)
    }
    if (!runnableProviders.includes(provider)) {
      return jsonResponse({
        error: 'This payment provider is enabled in settings but is not configured on the server (missing API credentials).',
        code: 'provider_not_configured',
      }, 503, corsHeaders)
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

      const sessionPayload: any = {
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        customer_email: user.email,
        metadata: {
          userId: user.sub,
          provider: 'stripe',
          planType,
          promoCodeId: promoMeta?.promoCodeId ?? '',
          promoCode: promoMeta?.promoCode ?? '',
          promoRewardType: promoMeta?.rewardType ?? '',
        },
        success_url: `${frontendUrl}/account?subscribed=1`,
        cancel_url: frontendUrl,
      }
      if (promoMeta?.stripeCouponId) {
        sessionPayload.discounts = [{ coupon: promoMeta.stripeCouponId }]
      }
      const session = await stripePost('/checkout/sessions', sessionPayload, env)

      if (session.error || !session.url) {
        console.error('Stripe checkout session error:', session.error)
        return jsonResponse({ error: 'Failed to create checkout session' }, 502, corsHeaders)
      }

      return jsonResponse({ checkoutUrl: session.url, provider }, 200, corsHeaders)
    }

    const promoCodeInput = typeof body?.promoCode === 'string' ? body.promoCode.trim() : ''
    let promoCodeId: string | null = null
    if (promoCodeInput) {
      const promoValidation = await resolvePromoCodeForCheckout(env, promoCodeInput, planType)
      if (!promoValidation.ok) {
        return jsonResponse({
          error: promoValidation.error ?? 'Promo code is not valid',
          code: promoValidation.reason ?? 'invalid_promo',
        }, promoValidation.status ?? 400, corsHeaders)
      }
      promoCodeId = promoValidation.checkoutMeta?.promoCodeId ?? null
    }

    const checkoutToken = crypto.randomUUID()
    const sessionToken = crypto.randomUUID().replaceAll('-', '')
    const checkoutSessionId = crypto.randomUUID()
    await db.prepare(`
      INSERT INTO payment_checkout_sessions
        (id, user_id, provider, plan_type, checkout_token, session_token, status, promo_code_id, updated_at)
      VALUES (?, ?, 'gocardless', ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP)
    `).bind(checkoutSessionId, user.sub, planType, checkoutToken, sessionToken, promoCodeId).run()

    const flowResponse = await gocardlessPost('/redirect_flows', {
      redirect_flows: {
        description: `VMP ${planType} subscription`,
        session_token: sessionToken,
        success_redirect_url: `${frontendUrl}/account?gocardless_checkout_token=${checkoutToken}`,
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
          const promoCodeId = typeof session?.metadata?.promoCodeId === 'string' ? session.metadata.promoCodeId.trim() : ''
          if (promoCodeId) {
            await applyPromoRedemption(env, {
              promoCodeId,
              userId,
              provider: 'stripe',
              planType: String(session?.metadata?.planType || 'monthly'),
              providerSubscriptionId: stripeSub.id ?? null,
              grantedUntil: stripeSub.current_period_end
                ? new Date(stripeSub.current_period_end * 1000).toISOString()
                : null,
            })
          }
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
      if (!subResponse?.ok || !subResponse?.data?.subscriptions) {
        console.error('GoCardless webhook: failed to fetch subscription', { subscriptionId, response: subResponse })
        return jsonResponse({ error: 'Failed to fetch subscription from GoCardless' }, 500, corsHeaders)
      }

      const gocardlessSub = subResponse.data.subscriptions
      const status = normalizeGoCardlessStatus(gocardlessSub?.status)
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
      SELECT id, user_id, plan_type, session_token, provider_checkout_id, status, promo_code_id
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
      { 'Idempotency-Key': `gocardless-complete:${checkoutToken}` },
    )
    const redirectFlow = completeResponse?.data?.redirect_flows
    if (!completeResponse.ok || !redirectFlow?.links?.mandate) {
      console.error('GoCardless complete flow error:', completeResponse?.data)
      return jsonResponse({ error: 'Failed to complete GoCardless authorization' }, 502, corsHeaders)
    }

    const pricing = await getEffectivePricingSettings(env, 'gocardless')
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
    }, env, { 'Idempotency-Key': checkoutToken })
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
    if (checkoutSession.promo_code_id) {
      await applyPromoRedemption(env, {
        promoCodeId: String(checkoutSession.promo_code_id),
        userId: user.sub,
        provider: 'gocardless',
        planType,
        providerSubscriptionId: gocardlessSub.id,
        grantedUntil: currentPeriodEnd,
      })
    }

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