import { requireAuth, requireRole } from './auth.js'
import { getSetting, setSettings } from './settingsStore.js'

type RewardType = 'free_month' | 'free_year' | 'discount_percent'
type PopupBehavior = 'default' | 'highlight_campaign' | 'hide_standard' | 'isic_first'

function getDb(env: any) {
  const db = env.DB || env.video_subscription_db
  if (!db) throw new Error('D1 binding not found')
  return db
}

function jsonResponse(data: any, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

function normalizeCode(raw: any) {
  if (typeof raw !== 'string') return ''
  return raw.trim().toUpperCase().replace(/[^A-Z0-9-_]/g, '')
}

function normalizeRewardType(raw: any): RewardType {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (value === 'free_year') return 'free_year'
  if (value === 'discount_percent') return 'discount_percent'
  return 'free_month'
}

async function getAllowedPlansFromSettings(env: any): Promise<string[]> {
  const raw = String(await getSetting(env, 'allowed_plans') ?? 'monthly,yearly,club')
  const plans = raw
    .split(',')
    .map((v: string) => v.trim().toLowerCase())
    .filter((v: string) => v.length > 0)
  return plans.length > 0 ? Array.from(new Set(plans)) : ['monthly', 'yearly', 'club']
}

function parseAllowedPlanTypes(raw: any, allowedPlans: string[]) {
  if (Array.isArray(raw) && raw.length === 0) return []
  const rawStr = String(raw ?? '')
  if (!Array.isArray(raw) && (raw == null || rawStr.trim() === '')) return allowedPlans
  const values = Array.isArray(raw) ? raw : rawStr.split(',')
  const normalized = values
    .map((v: any) => String(v).trim().toLowerCase())
    .filter((v: string) => allowedPlans.includes(v))
  return normalized.length ? Array.from(new Set(normalized)) : allowedPlans
}

function clampInt(raw: any, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function clampPercent(raw: any, fallback = 0) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(100, Math.max(0, value))
}

function parseOptionalIsoDate(raw: any) {
  if (raw == null || raw === '') return { value: null, invalid: false }
  const date = new Date(String(raw))
  if (Number.isNaN(date.getTime())) return { value: null, invalid: true }
  return { value: date.toISOString(), invalid: false }
}

function randomCode(length = 10) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += alphabet[bytes[i]! % alphabet.length]
  }
  return out
}

async function ensureStripeCouponId(env: any, promoCode: any) {
  if (promoCode.reward_type !== 'discount_percent') return ''
  const trimmed = String(promoCode.stripe_coupon_id ?? '').trim()
  if (!trimmed) {
    throw new Error('Stripe coupon ID is required for discount_percent promo codes')
  }
  return trimmed
}

async function getCodeByValue(db: any, code: string) {
  return db.prepare(`
    SELECT
      pc.id,
      pc.campaign_id,
      pc.code,
      pc.reward_type,
      pc.max_uses,
      pc.used_count,
      pc.is_active,
      pc.allowed_plan_types,
      pc.stripe_coupon_id,
      pc.expires_at,
      pc.created_at,
      pc.updated_at,
      c.name AS campaign_name,
      c.is_active AS campaign_is_active
    FROM promo_codes pc
    INNER JOIN promo_campaigns c ON c.id = pc.campaign_id
    WHERE pc.code = ?
    LIMIT 1
  `).bind(code).first()
}

async function validatePromoForPlan(env: any, promoCode: any, planType: string) {
  if (!promoCode) return { ok: false, error: 'Promo code not found', code: 'promo_not_found', status: 404 }
  if (!promoCode.is_active || !promoCode.campaign_is_active) {
    return { ok: false, error: 'Promo code is not active', code: 'promo_inactive', status: 400 }
  }
  if (Number(promoCode.used_count || 0) >= Number(promoCode.max_uses || 0)) {
    return { ok: false, error: 'Promo code usage limit reached', code: 'promo_exhausted', status: 409 }
  }
  if (promoCode.expires_at) {
    const expiry = new Date(String(promoCode.expires_at)).getTime()
    if (Number.isFinite(expiry) && expiry <= Date.now()) {
      return { ok: false, error: 'Promo code expired', code: 'promo_expired', status: 409 }
    }
  }
  const allowedPlansFromSettings = await getAllowedPlansFromSettings(env)
  const allowedPlans = parseAllowedPlanTypes(promoCode.allowed_plan_types, allowedPlansFromSettings)
  if (!allowedPlans.includes(planType)) {
    return { ok: false, error: 'Promo code does not apply to this plan', code: 'promo_plan_mismatch', status: 400 }
  }
  return { ok: true }
}

export async function resolvePromoCodeForCheckout(env: any, codeInput: any, planType: string) {
  const code = normalizeCode(codeInput)
  if (!code) return { ok: false, reason: 'empty' }
  const db = getDb(env)
  const promoCode = await getCodeByValue(db, code)
  const valid = await validatePromoForPlan(env, promoCode, planType)
  if (!valid.ok) return { ok: false, reason: valid.code, status: valid.status, error: valid.error }
  const stripeCouponId = await ensureStripeCouponId(env, promoCode)
  return {
    ok: true,
    promoCode,
    checkoutMeta: {
      promoCodeId: promoCode.id,
      promoCode: promoCode.code,
      rewardType: promoCode.reward_type,
      stripeCouponId,
    },
  }
}

export async function applyPromoRedemption(env: any, params: {
  promoCodeId: string
  userId: string
  provider: string
  planType: string
  providerSubscriptionId?: string | null
  grantedUntil?: string | null
}) {
  const db = getDb(env)
  const promoCode = await db.prepare(`
    SELECT id, max_uses, used_count, is_active
    FROM promo_codes
    WHERE id = ?
    LIMIT 1
  `).bind(params.promoCodeId).first()
  if (!promoCode || !promoCode.is_active) return
  if (Number(promoCode.used_count || 0) >= Number(promoCode.max_uses || 0)) return

  const incrementResult = await db.prepare(`
    UPDATE promo_codes
    SET used_count = used_count + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND used_count < max_uses
  `).bind(params.promoCodeId).run()

  if ((incrementResult?.meta?.changes ?? 0) === 0) return

  await db.prepare(`
    INSERT INTO promo_redemptions (
      id, promo_code_id, user_id, subscription_id, provider, plan_type, granted_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(promo_code_id, user_id) DO NOTHING
  `).bind(
    crypto.randomUUID(),
    params.promoCodeId,
    params.userId,
    params.providerSubscriptionId ?? null,
    params.provider,
    params.planType,
    params.grantedUntil ?? null,
  ).run()
}

export async function handleAdminPromoCampaigns(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  const db = getDb(env)

  if (request.method === 'GET') {
    const rows = await db.prepare(`
      SELECT c.id, c.name, c.description, c.is_active, c.created_at, c.updated_at,
             COUNT(pc.id) AS code_count,
             COALESCE(SUM(pc.used_count), 0) AS total_redemptions
      FROM promo_campaigns c
      LEFT JOIN promo_codes pc ON pc.campaign_id = c.id
      GROUP BY c.id
      ORDER BY datetime(c.created_at) DESC
    `).all()
    return jsonResponse({ campaigns: rows?.results ?? [] }, 200, corsHeaders)
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) return jsonResponse({ error: 'name is required' }, 400, corsHeaders)
    const id = crypto.randomUUID()
    await db.prepare(`
      INSERT INTO promo_campaigns (id, name, description, is_active)
      VALUES (?, ?, ?, ?)
    `).bind(
      id,
      name,
      typeof body?.description === 'string' ? body.description.trim() : null,
      body?.isActive === false ? 0 : 1,
    ).run()
    return jsonResponse({ ok: true, id }, 201, corsHeaders)
  }

  if (request.method === 'PATCH') {
    const body = await request.json().catch(() => null)
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (!id) return jsonResponse({ error: 'id is required' }, 400, corsHeaders)
    const updates = []
    const values = []
    if (typeof body?.name === 'string') {
      const next = body.name.trim()
      if (!next) return jsonResponse({ error: 'name must not be empty' }, 400, corsHeaders)
      updates.push('name = ?')
      values.push(next)
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'description')) {
      const next = body?.description == null ? null : String(body.description).trim()
      updates.push('description = ?')
      values.push(next)
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'isActive')) {
      updates.push('is_active = ?')
      values.push(body.isActive ? 1 : 0)
    }
    if (!updates.length) return jsonResponse({ error: 'No fields to update' }, 400, corsHeaders)
    values.push(id)
    await db.prepare(`
      UPDATE promo_campaigns
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(...values).run()
    return jsonResponse({ ok: true }, 200, corsHeaders)
  }

  return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
}

export async function handleAdminPromoCodes(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  const db = getDb(env)

  if (request.method === 'GET') {
    const rows = await db.prepare(`
      SELECT
        pc.id,
        pc.campaign_id,
        c.name AS campaign_name,
        pc.code,
        pc.reward_type,
        pc.max_uses,
        pc.used_count,
        pc.is_active,
        pc.allowed_plan_types,
        pc.stripe_coupon_id,
        pc.expires_at,
        pc.created_at,
        pc.updated_at
      FROM promo_codes pc
      INNER JOIN promo_campaigns c ON c.id = pc.campaign_id
      ORDER BY datetime(pc.created_at) DESC
    `).all()
    return jsonResponse({ codes: rows?.results ?? [] }, 200, corsHeaders)
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const campaignId = typeof body?.campaignId === 'string' ? body.campaignId.trim() : ''
    if (!campaignId) return jsonResponse({ error: 'campaignId is required' }, 400, corsHeaders)
    const campaign = await db.prepare('SELECT id FROM promo_campaigns WHERE id = ? LIMIT 1').bind(campaignId).first()
    if (!campaign) return jsonResponse({ error: 'Campaign not found', code: 'campaign_not_found' }, 404, corsHeaders)

    const quantity = clampInt(body?.quantity, 1, 1, 200)
    const baseCode = normalizeCode(body?.code)
    const rewardType = normalizeRewardType(body?.rewardType)
    const maxUses = clampInt(body?.maxUses, 1, 1, 100000)
    const allowedPlansFromSettings = await getAllowedPlansFromSettings(env)
    const allowedPlans = parseAllowedPlanTypes(body?.allowedPlanTypes, allowedPlansFromSettings)
    const expiresAtParsed = parseOptionalIsoDate(body?.expiresAt)
    if (expiresAtParsed.invalid) return jsonResponse({ error: 'expiresAt must be a valid datetime' }, 400, corsHeaders)
    const expiresAt = expiresAtParsed.value
    const isActive = body?.isActive === false ? 0 : 1
    const stripeCouponId = typeof body?.stripeCouponId === 'string' ? body.stripeCouponId.trim() : ''
    if (rewardType === 'discount_percent' && !stripeCouponId) {
      return jsonResponse({ error: 'Stripe coupon ID is required for discount_percent promo codes' }, 400, corsHeaders)
    }

    const insertStmt = db.prepare(`
      INSERT INTO promo_codes (
        id, campaign_id, code, reward_type, max_uses, used_count, is_active,
        allowed_plan_types, stripe_coupon_id, expires_at
      )
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `)
    const statements = []
    const createdCodes = []
    for (let i = 0; i < quantity; i += 1) {
      const candidate = quantity === 1 && baseCode
        ? baseCode
        : `${baseCode || randomCode(6)}-${randomCode(4)}`
      const code = normalizeCode(candidate)
      statements.push(insertStmt.bind(
        crypto.randomUUID(),
        campaignId,
        code,
        rewardType,
        maxUses,
        isActive,
        allowedPlans.join(','),
        stripeCouponId || null,
        expiresAt,
      ))
      createdCodes.push(code)
    }
    if (statements.length) await db.batch(statements)
    return jsonResponse({ ok: true, created: createdCodes.length, codes: createdCodes }, 201, corsHeaders)
  }

  if (request.method === 'PATCH') {
    const body = await request.json().catch(() => null)
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (!id) return jsonResponse({ error: 'id is required' }, 400, corsHeaders)

    const existing = await db.prepare('SELECT reward_type, stripe_coupon_id FROM promo_codes WHERE id = ? LIMIT 1').bind(id).first()
    if (!existing) return jsonResponse({ error: 'Promo code not found' }, 404, corsHeaders)

    let currentRewardType = String(existing.reward_type || 'free_month')
    let currentStripeCouponId = String(existing.stripe_coupon_id || '').trim()

    const updates = []
    const values = []
    if (typeof body?.code === 'string') {
      const next = normalizeCode(body.code)
      if (!next) return jsonResponse({ error: 'code must not be empty' }, 400, corsHeaders)
      updates.push('code = ?')
      values.push(next)
    }
    if (typeof body?.rewardType === 'string') {
      currentRewardType = normalizeRewardType(body.rewardType)
      updates.push('reward_type = ?')
      values.push(currentRewardType)
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'maxUses')) {
      updates.push('max_uses = ?')
      values.push(clampInt(body.maxUses, 1, 1, 100000))
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'isActive')) {
      updates.push('is_active = ?')
      values.push(body.isActive ? 1 : 0)
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'allowedPlanTypes')) {
      const allowedPlansFromSettings = await getAllowedPlansFromSettings(env)
      updates.push('allowed_plan_types = ?')
      values.push(parseAllowedPlanTypes(body.allowedPlanTypes, allowedPlansFromSettings).join(','))
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'stripeCouponId')) {
      currentStripeCouponId = body?.stripeCouponId ? String(body.stripeCouponId).trim() : ''
      updates.push('stripe_coupon_id = ?')
      values.push(currentStripeCouponId || null)
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'expiresAt')) {
      const nextParsed = parseOptionalIsoDate(body?.expiresAt)
      if (nextParsed.invalid) return jsonResponse({ error: 'expiresAt must be a valid datetime' }, 400, corsHeaders)
      const next = nextParsed.value
      updates.push('expires_at = ?')
      values.push(next)
    }
    if (!updates.length) return jsonResponse({ error: 'No fields to update' }, 400, corsHeaders)

    if (currentRewardType === 'discount_percent' && !currentStripeCouponId) {
      return jsonResponse({ error: 'Stripe coupon ID is required for discount_percent promo codes' }, 400, corsHeaders)
    }
    values.push(id)
    await db.prepare(`
      UPDATE promo_codes
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(...values).run()
    return jsonResponse({ ok: true }, 200, corsHeaders)
  }

  return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
}

export async function handlePromoValidate(request: any, env: any, corsHeaders: any) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  }
  try {
    await requireAuth(request, env)
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  const body = await request.json().catch(() => null)
  const planType = String(body?.planType ?? 'monthly').trim().toLowerCase()
  if (!['monthly', 'yearly', 'club'].includes(planType)) {
    return jsonResponse({ error: 'planType must be one of monthly, yearly, club' }, 400, corsHeaders)
  }
  const resolved = await resolvePromoCodeForCheckout(env, body?.promoCode, planType)
  if (!resolved.ok) {
    return jsonResponse({
      valid: false,
      error: resolved.error ?? 'Promo code is not valid',
      code: resolved.reason ?? 'invalid_promo',
    }, resolved.status ?? 400, corsHeaders)
  }
  return jsonResponse({
    valid: true,
    promo: {
      code: resolved.promoCode.code,
      rewardType: resolved.promoCode.reward_type,
      campaignName: resolved.promoCode.campaign_name,
      maxUses: resolved.promoCode.max_uses,
      usedCount: resolved.promoCode.used_count,
    },
  }, 200, corsHeaders)
}

function normalizePopupBehavior(raw: any): PopupBehavior {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (value === 'highlight_campaign') return 'highlight_campaign'
  if (value === 'hide_standard') return 'hide_standard'
  if (value === 'isic_first') return 'isic_first'
  return 'default'
}

export async function handleAdminIsicCampaigns(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  const db = getDb(env)
  if (request.method === 'GET') {
    const [campaignRows, settingsRows] = await Promise.all([
      db.prepare(`
        SELECT id, name, description, is_active, free_slots_limit, discount_percent, renewal_months, popup_behavior, country_scope, created_at, updated_at
        FROM isic_campaigns
        ORDER BY datetime(created_at) DESC
      `).all(),
      Promise.all([
        getSetting(env, 'isic_api_enabled'),
        getSetting(env, 'isic_api_base_url'),
      ]),
    ])
    const [isicApiEnabled, isicApiBaseUrl] = settingsRows
    return jsonResponse({
      campaigns: campaignRows?.results ?? [],
      apiConfig: {
        enabled: String(isicApiEnabled ?? '0') === '1',
        baseUrl: String(isicApiBaseUrl ?? ''),
        hasApiKey: Boolean(String(await getSetting(env, 'isic_api_key') ?? '').trim()),
      },
    }, 200, corsHeaders)
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) return jsonResponse({ error: 'name is required' }, 400, corsHeaders)
    const id = crypto.randomUUID()
    await db.prepare(`
      INSERT INTO isic_campaigns (
        id, name, description, is_active, free_slots_limit, discount_percent, renewal_months, popup_behavior, country_scope
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      name,
      typeof body?.description === 'string' ? body.description.trim() : null,
      body?.isActive === false ? 0 : 1,
      clampInt(body?.freeSlotsLimit, 0, 0, 1_000_000),
      clampPercent(body?.discountPercent, 0),
      clampInt(body?.renewalMonths, 12, 1, 36),
      normalizePopupBehavior(body?.popupBehavior),
      typeof body?.countryScope === 'string' && body.countryScope.trim() ? body.countryScope.trim().toUpperCase() : 'CZ,SK',
    ).run()
    return jsonResponse({ ok: true, id }, 201, corsHeaders)
  }

  if (request.method === 'PATCH') {
    const body = await request.json().catch(() => null)
    if (body?.apiConfig && typeof body.apiConfig === 'object') {
      const updates: [string, string][] = []
      if (Object.prototype.hasOwnProperty.call(body.apiConfig, 'enabled')) {
        updates.push(['isic_api_enabled', body.apiConfig.enabled ? '1' : '0'])
      }
      if (Object.prototype.hasOwnProperty.call(body.apiConfig, 'baseUrl')) {
        updates.push(['isic_api_base_url', String(body.apiConfig.baseUrl ?? '').trim()])
      }
      if (Object.prototype.hasOwnProperty.call(body.apiConfig, 'apiKey')) {
        updates.push(['isic_api_key', String(body.apiConfig.apiKey ?? '').trim()])
      }
      if (!updates.length) return jsonResponse({ error: 'No API config fields to update' }, 400, corsHeaders)
      await setSettings(env, updates)
      return jsonResponse({ ok: true, updatedApiConfig: true }, 200, corsHeaders)
    }
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (!id) return jsonResponse({ error: 'id is required' }, 400, corsHeaders)
    const updates = []
    const values = []
    if (typeof body?.name === 'string') {
      const next = body.name.trim()
      if (!next) return jsonResponse({ error: 'name must not be empty' }, 400, corsHeaders)
      updates.push('name = ?')
      values.push(next)
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'description')) {
      updates.push('description = ?')
      values.push(body?.description == null ? null : String(body.description).trim())
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'isActive')) {
      updates.push('is_active = ?')
      values.push(body.isActive ? 1 : 0)
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'freeSlotsLimit')) {
      updates.push('free_slots_limit = ?')
      values.push(clampInt(body.freeSlotsLimit, 0, 0, 1_000_000))
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'discountPercent')) {
      updates.push('discount_percent = ?')
      values.push(clampPercent(body.discountPercent, 0))
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'renewalMonths')) {
      updates.push('renewal_months = ?')
      values.push(clampInt(body.renewalMonths, 12, 1, 36))
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'popupBehavior')) {
      updates.push('popup_behavior = ?')
      values.push(normalizePopupBehavior(body.popupBehavior))
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'countryScope')) {
      updates.push('country_scope = ?')
      values.push(String(body.countryScope ?? 'CZ,SK').trim().toUpperCase() || 'CZ,SK')
    }
    if (!updates.length) return jsonResponse({ error: 'No fields to update' }, 400, corsHeaders)
    values.push(id)
    await db.prepare(`
      UPDATE isic_campaigns
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(...values).run()
    return jsonResponse({ ok: true }, 200, corsHeaders)
  }

  return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
}

export async function handleIsicValidate(request: any, env: any, corsHeaders: any) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)

  const isicAuthSecret = String(await getSetting(env, 'isic_api_secret') ?? '').trim()
  const providedAuth = request.headers.get('X-ISIC-Auth') ?? ''
  if (!isicAuthSecret || providedAuth !== isicAuthSecret) {
    return jsonResponse({ error: 'Unauthorized', code: 'unauthorized' }, 401, corsHeaders)
  }

  const body = await request.json().catch(() => null)
  const token = typeof body?.isicToken === 'string' ? body.isicToken.trim() : ''
  const campaignId = typeof body?.campaignId === 'string' ? body.campaignId.trim() : ''
  if (!token) return jsonResponse({ error: 'isicToken is required' }, 400, corsHeaders)
  if (!campaignId) return jsonResponse({ error: 'campaignId is required' }, 400, corsHeaders)

  const enabled = String(await getSetting(env, 'isic_api_enabled') ?? '0') === '1'
  const baseUrl = String(await getSetting(env, 'isic_api_base_url') ?? '').trim()
  const apiKey = String(await getSetting(env, 'isic_api_key') ?? '').trim()
  if (!enabled || !baseUrl || !apiKey) {
    return jsonResponse({
      valid: false,
      mode: 'not_configured',
      error: 'ISIC validation API is not configured',
      code: 'isic_not_configured',
    }, 503, corsHeaders)
  }

  try {
    const validationUrl = `${baseUrl.replace(/\/+$/, '')}/validate`
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)
    const upstream = await fetch(validationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ token, campaignId }),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    const data: any = await upstream.json().catch(() => ({}))
    if (!upstream.ok) {
      return jsonResponse({
        valid: false,
        error: 'ISIC validation failed',
        code: 'isic_validation_failed',
      }, 502, corsHeaders)
    }
    return jsonResponse({
      valid: Boolean(data?.valid),
      role: typeof data?.role === 'string' ? data.role : null,
      expiresAt: data?.expiresAt ?? null,
    }, 200, corsHeaders)
  } catch (error) {
    console.error('handleIsicValidate error:', error)
    return jsonResponse({ valid: false, error: 'ISIC validation service unavailable', code: 'isic_validation_failed' }, 500, corsHeaders)
  }
}

export async function handleIsicCampaignPublic(request: any, env: any, corsHeaders: any) {
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const db = getDb(env)
  const rows = await db.prepare(`
    SELECT id, name, description, free_slots_limit, discount_percent, renewal_months, popup_behavior, country_scope
    FROM isic_campaigns
    WHERE is_active = 1
    ORDER BY datetime(created_at) DESC
  `).all()
  return jsonResponse({ campaigns: rows?.results ?? [] }, 200, corsHeaders)
}