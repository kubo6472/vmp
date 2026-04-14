type PlanType = 'monthly' | 'yearly' | 'club'
type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'cancelled'

async function gocardlessFetch(
  path: string,
  method: string,
  payload: unknown,
  env: any,
  extraHeaders?: Record<string, string>,
): Promise<any> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(`https://api.gocardless.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GOCARDLESS_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'GoCardless-Version': '2015-07-06',
        ...(extraHeaders ?? {}),
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

export async function gocardlessPost(
  path: string,
  payload: unknown,
  env: any,
  extraHeaders?: Record<string, string>,
): Promise<any> {
  return gocardlessFetch(path, 'POST', payload, env, extraHeaders)
}

export async function gocardlessGet(path: string, env: any): Promise<any> {
  return gocardlessFetch(path, 'GET', null, env)
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifyGoCardlessWebhook(rawBody: string, sigHeader: string, secret: string) {
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

export function getGoCardlessInterval(planType: PlanType): { interval: number, intervalUnit: 'monthly' | 'yearly' } {
  if (planType === 'monthly') return { interval: 1, intervalUnit: 'monthly' }
  return { interval: 1, intervalUnit: 'yearly' }
}
