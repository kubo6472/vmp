interface SmokeEnv {
  DEPLOY_SMOKE_AUTH_TOKEN?: string
}

type SmokeAuthCode = 'not_configured' | 'missing_token' | 'invalid_token'

interface SmokeAuthResult {
  ok: boolean
  code?: SmokeAuthCode
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i += 1) mismatch |= (a[i]! ^ b[i]!)
  return mismatch === 0
}

export function authenticateSmokeRequest(request: Request, env: SmokeEnv): SmokeAuthResult {
  const expected = typeof env.DEPLOY_SMOKE_AUTH_TOKEN === 'string' ? env.DEPLOY_SMOKE_AUTH_TOKEN.trim() : ''
  if (!expected) return { ok: false, code: 'not_configured' }

  const provided = request.headers.get('x-smoke-token')?.trim() ?? ''
  if (!provided) return { ok: false, code: 'missing_token' }

  const expectedBytes = new TextEncoder().encode(expected)
  const providedBytes = new TextEncoder().encode(provided)
  if (!timingSafeEqual(expectedBytes, providedBytes)) return { ok: false, code: 'invalid_token' }

  return { ok: true }
}

export function handleAdminSmokeAuth(request: Request, env: SmokeEnv, corsHeaders: Record<string, string>) {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed', code: 'method_not_allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }

  const result = authenticateSmokeRequest(request, env)
  if (!result.ok) {
    const status = result.code === 'not_configured' ? 503 : 401
    return new Response(JSON.stringify({ error: 'Unauthorized', code: result.code }), {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}
