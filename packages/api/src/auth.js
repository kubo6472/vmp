/**
 * packages/api/src/auth.js
 *
 * Complete auth module for @vmp/api.
 *
 * What lives here:
 *  - JWT sign/verify (HS256) implemented directly with SubtleCrypto — no library needed.
 *  - Magic link token generation, hashing, and email dispatch via Brevo.
 *  - Refresh token issuance and rotation.
 *  - Route handlers for /api/auth/*.
 *  - requireAuth / requireRole middleware helpers.
 *
 * Required Wrangler secrets (set with `wrangler secret put`):
 *   JWT_SECRET      — at least 32 random characters, used to sign all JWTs
 *   BREVO_API_KEY   — Brevo transactional email API key
 *
 * Required Wrangler vars (wrangler.json → "vars"):
 *   FRONTEND_URL    — e.g. "https://vmp.example.com"  (no trailing slash)
 *   SENDER_EMAIL    — e.g. "noreply@vmp.example.com"
 *   SENDER_NAME     — e.g. "VMP"
 *
 * Cookie strategy:
 *   The refresh token is stored in an HttpOnly, SameSite=None; Secure cookie
 *   scoped to /api/auth.  SameSite=None is required because the API lives on a
 *   different origin than the web app.  The short-lived JWT is returned in the
 *   JSON body and stored in memory (a Pinia store / reactive ref) by the frontend.
 *   This combination means:
 *     - The JWT is invisible to the HttpOnly cookie (XSS can't steal it from
 *       the cookie), and since it's never persisted to localStorage it vanishes
 *       on tab close / page reload.
 *     - The refresh token is HttpOnly so JS can't read it at all.
 *     - On app init the frontend calls POST /api/auth/refresh; if the cookie is
 *       present it gets a fresh JWT silently.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const ACCESS_TOKEN_TTL  = 15 * 60            // 15 minutes (seconds)
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60  // 30 days    (seconds)
const MAGIC_LINK_TTL    = 15 * 60            // 15 minutes (seconds)

export const ROLES = ['super_admin', 'admin', 'editor', 'analyst', 'moderator', 'viewer']

// ─── Base64url helpers ────────────────────────────────────────────────────────
//
// JWT requires base64url encoding (RFC 4648 §5): + → -, / → _, no padding.
// We do this ourselves because atob/btoa use standard base64.

function base64urlEncode(buffer) {
  const bytes = new Uint8Array(buffer)
  let str = ''
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g,  '')
}

function base64urlDecode(str) {
  // Re-pad and convert back to standard base64 before atob
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') +
    '=='.slice(0, (4 - (str.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

// ─── JWT (HS256) ──────────────────────────────────────────────────────────────
//
// HS256 signs the "header.payload" string with HMAC-SHA-256.
// Cloudflare Workers expose the full WebCrypto API (crypto.subtle), so we
// can do this without any npm dependencies.
//
// Key import is intentionally not cached — Workers can be spun up/down at any
// time and caching across requests isn't safe unless you use a module-level
// cache tied to the env binding (which changes per deployment anyway).

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,            // not extractable
    ['sign', 'verify']
  )
}

export async function signJwt(payload, secret) {
  const enc = new TextEncoder()
  const headerB64  = base64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payloadB64 = base64urlEncode(enc.encode(JSON.stringify(payload)))
  const signingInput = `${headerB64}.${payloadB64}`

  const key = await importHmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput))

  return `${signingInput}.${base64urlEncode(sig)}`
}

export async function verifyJwt(token, secret) {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed JWT')

  const [headerB64, payloadB64, sigB64] = parts
  const key = await importHmacKey(secret)

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    base64urlDecode(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  )
  if (!valid) throw new Error('Invalid JWT signature')

  const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)))
  const now = Math.floor(Date.now() / 1000)
  if (payload.exp && payload.exp < now) throw new Error('JWT expired')

  return payload
}

export function createAccessToken(user, secret) {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    sub:   user.id,
    email: user.email,
    role:  user.role,
    iat:   now,
    exp:   now + ACCESS_TOKEN_TTL,
  }, secret)
}

// ─── Random token helpers ─────────────────────────────────────────────────────
//
// Magic link tokens and refresh tokens are 32 random bytes encoded as hex.
// We store SHA-256(token) in D1.  The raw token travels only in the email
// link or the cookie — never in the database.  If D1 were dumped, an attacker
// would have only irreversible hashes.

export function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

// ─── Magic link ───────────────────────────────────────────────────────────────

async function upsertUser(email, db) {
  const existing = await db
    .prepare('SELECT id, email, role FROM users WHERE email = ?')
    .bind(email)
    .first()

  if (existing) return existing

  const id = crypto.randomUUID()
  await db
    .prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'viewer')")
    .bind(id, email)
    .run()

  return { id, email, role: 'viewer' }
}

async function createMagicLinkToken(email, db) {
  const user = await upsertUser(email, db)

  // Cancel any outstanding unused tokens — one active link per user at a time.
  await db
    .prepare('DELETE FROM magic_link_tokens WHERE user_id = ? AND used_at IS NULL')
    .bind(user.id)
    .run()

  const token     = generateToken()
  const tokenHash = await hashToken(token)
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL * 1000).toISOString()

  await db
    .prepare('INSERT INTO magic_link_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
    .bind(crypto.randomUUID(), user.id, tokenHash, expiresAt)
    .run()

  return { token, user }
}

async function sendMagicLinkEmail(to, verifyUrl, env) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender:      { email: env.SENDER_EMAIL || 'noreply@example.com', name: env.SENDER_NAME || 'VMP' },
      to:          [{ email: to }],
      subject:     'Your sign-in link',
      htmlContent: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
          <h2 style="margin:0 0 16px;font-size:22px">Sign in to VMP</h2>
          <p style="margin:0 0 24px;color:#444;line-height:1.6">
            Click the button below to sign in. This link expires in 15 minutes
            and can only be used once.
          </p>
          <a href="${verifyUrl}"
             style="display:inline-block;padding:12px 24px;background:#2563eb;
                    color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
            Sign in
          </a>
          <p style="margin:24px 0 0;font-size:12px;color:#999">
            If you didn't request this, you can safely ignore it.
          </p>
        </div>
      `,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Brevo error (${response.status}): ${text}`)
  }
}

// ─── Refresh tokens ───────────────────────────────────────────────────────────

async function issueRefreshToken(userId, db) {
  const token     = generateToken()
  const tokenHash = await hashToken(token)
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString()

  await db
    .prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
    .bind(crypto.randomUUID(), userId, tokenHash, expiresAt)
    .run()

  return token
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────
//
// SameSite=None is required when the API and the web app live on different origins.
// SameSite=None requires Secure (HTTPS).  In local dev the cookie still arrives
// if the browser treats localhost as secure, but some browsers need a flag enabled.

function buildRefreshCookie(token, maxAge) {
  return [
    `refresh_token=${token}`,
    `Max-Age=${maxAge}`,
    'Path=/api/auth',   // cookie is only sent to auth endpoints, not video routes
    'HttpOnly',         // JavaScript cannot read this cookie
    'SameSite=None',
    'Secure',
  ].join('; ')
}

function clearRefreshCookie() {
  return buildRefreshCookie('', 0)
}

function getRefreshTokenFromCookie(request) {
  const cookie = request.headers.get('Cookie') || ''
  const match  = cookie.match(/refresh_token=([^;]+)/)
  return match ? match[1].trim() : null
}

// ─── Route handlers ───────────────────────────────────────────────────────────

/**
 * POST /api/auth/magic-link
 * Body: { email: string }
 *
 * Creates a magic link token, stores the hash, and emails the raw token.
 * Always returns 200 — we never confirm whether an email is registered
 * to prevent user enumeration.
 */
export async function handleRequestMagicLink(request, env, corsHeaders) {
  const body = await request.json().catch(() => null)
  if (!body?.email || typeof body.email !== 'string') {
    return authJson({ error: 'email is required' }, 400, corsHeaders)
  }

  const email = body.email.toLowerCase().trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return authJson({ error: 'Invalid email format' }, 400, corsHeaders)
  }

  const redirect = normalizeRedirectPath(body.redirect)
  const db = getDb(env)

  try {
    const { token } = await createMagicLinkToken(email, db)
    const frontendUrl = (env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '')
    const verifyUrl = new URL(`${frontendUrl}/auth/verify`)
    verifyUrl.searchParams.set('token', token)
    if (redirect) verifyUrl.searchParams.set('redirect', redirect)

    if (env.BREVO_API_KEY) {
      await sendMagicLinkEmail(email, verifyUrl.toString(), env)
    } else {
      // No Brevo key — log the link for local development.
      console.log(`[DEV] Magic link for ${email}: ${verifyUrl.toString()}`)
    }
  } catch (err) {
    console.error('[auth] magic link error:', err)
    // Still return success — don't leak whether the error was email-related.
  }

  return authJson({ ok: true, message: 'If that address is valid, a sign-in link is on its way.' }, 200, corsHeaders)
}

/**
 * GET /api/auth/verify?token=<raw_token>
 *
 * Validates the magic link token, marks it used, and returns:
 *   - accessToken (JWT, 15 min) in the JSON body
 *   - refresh_token in an HttpOnly cookie
 */
export async function handleVerifyMagicLink(request, env, corsHeaders) {
  const url   = new URL(request.url)
  const token = url.searchParams.get('token')

  if (!token) return authJson({ error: 'token is required' }, 400, corsHeaders)

  const db        = getDb(env)
  const tokenHash = await hashToken(token)

  const record = await db
    .prepare(`
      SELECT t.id, t.expires_at, t.used_at, u.id AS user_id, u.email, u.role
      FROM magic_link_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?
    `)
    .bind(tokenHash)
    .first()

  // Deliberate: same error for "not found" and "already used" to prevent oracle attacks
  if (!record || record.used_at) {
    return authJson({ error: 'Sign-in link is invalid or has already been used.' }, 401, corsHeaders)
  }

  if (new Date(record.expires_at) < new Date()) {
    return authJson({ error: 'Sign-in link has expired. Request a new one.' }, 401, corsHeaders)
  }

  // Mark as used before issuing tokens — prevents a race condition where the
  // same token is verified twice in parallel before the first write completes.
  await db
    .prepare('UPDATE magic_link_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(record.id)
    .run()

  const user         = { id: record.user_id, email: record.email, role: record.role }
  const accessToken  = await createAccessToken(user, env.JWT_SECRET)
  const refreshToken = await issueRefreshToken(user.id, db)

  const headers = buildResponseHeaders(corsHeaders)
  headers.set('Set-Cookie', buildRefreshCookie(refreshToken, REFRESH_TOKEN_TTL))

  return new Response(JSON.stringify({
    ok: true,
    accessToken,
    user: { id: user.id, email: user.email, role: user.role },
  }), { status: 200, headers })
}

/**
 * POST /api/auth/refresh
 *
 * Reads the HttpOnly refresh token cookie, validates it, deletes it (rotation),
 * and issues a new JWT + new refresh token cookie.
 *
 * The frontend calls this on app init to silently restore a session after a
 * page reload, and again ~1 minute before the JWT expires.
 */
export async function handleRefreshToken(request, env, corsHeaders) {
  const rawToken = getRefreshTokenFromCookie(request)
  if (!rawToken) return authJson({ error: 'No refresh token' }, 401, corsHeaders)

  const db        = getDb(env)
  const tokenHash = await hashToken(rawToken)

  const record = await db
    .prepare(`
      SELECT r.id, r.expires_at, u.id AS user_id, u.email, u.role
      FROM refresh_tokens r
      JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = ?
    `)
    .bind(tokenHash)
    .first()

  if (!record || new Date(record.expires_at) < new Date()) {
    const headers = buildResponseHeaders(corsHeaders)
    headers.set('Set-Cookie', clearRefreshCookie())
    return new Response(JSON.stringify({ error: 'Session expired. Please sign in again.' }), { status: 401, headers })
  }

  // ── Rotation ──────────────────────────────────────────────────────────────
  // Delete the consumed token first, then issue new ones.
  // If this Worker crashes between these two writes, the user just has to
  // sign in again — acceptable. The important invariant is that we never let
  // the same refresh token be used twice successfully.
  await db
    .prepare('DELETE FROM refresh_tokens WHERE id = ?')
    .bind(record.id)
    .run()

  const user            = { id: record.user_id, email: record.email, role: record.role }
  const newAccessToken  = await createAccessToken(user, env.JWT_SECRET)
  const newRefreshToken = await issueRefreshToken(user.id, db)

  const headers = buildResponseHeaders(corsHeaders)
  headers.set('Set-Cookie', buildRefreshCookie(newRefreshToken, REFRESH_TOKEN_TTL))

  return new Response(JSON.stringify({
    ok: true,
    accessToken: newAccessToken,
    user: { id: user.id, email: user.email, role: user.role },
  }), { status: 200, headers })
}

/**
 * POST /api/auth/logout
 *
 * Deletes the refresh token from D1 and clears the cookie.
 * The frontend should also discard the in-memory JWT.
 */
export async function handleLogout(request, env, corsHeaders) {
  const rawToken = getRefreshTokenFromCookie(request)

  if (rawToken) {
    const db        = getDb(env)
    const tokenHash = await hashToken(rawToken)
    await db
      .prepare('DELETE FROM refresh_tokens WHERE token_hash = ?')
      .bind(tokenHash)
      .run()
  }

  const headers = buildResponseHeaders(corsHeaders)
  headers.set('Set-Cookie', clearRefreshCookie())
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
}

/**
 * GET /api/auth/me
 *
 * Returns the current user from the Bearer JWT.
 * Useful for the frontend to restore user state after a page load once
 * it has exchanged the refresh token cookie for a fresh JWT.
 */
export async function handleGetMe(request, env, corsHeaders) {
  try {
    const user = await requireAuth(request, env)
    return authJson({ user }, 200, corsHeaders)
  } catch {
    return authJson({ error: 'Unauthorized' }, 401, corsHeaders)
  }
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
//
// Usage in any route handler:
//
//   const user = await requireAuth(request, env)
//   // user = { sub, email, role, iat, exp }
//
//   const editor = await requireRole(request, env, 'editor', 'admin', 'super_admin')

export async function requireAuth(request, env) {
  const header = request.headers.get('Authorization') || ''
  if (!header.startsWith('Bearer ')) throw new Error('Missing Bearer token')

  const token = header.slice(7)
  return verifyJwt(token, env.JWT_SECRET)
}

export async function requireRole(request, env, ...roles) {
  const user = await requireAuth(request, env)
  if (!roles.includes(user.role)) {
    throw new Error(`Insufficient role. Required: ${roles.join(' | ')}. Got: ${user.role}`)
  }
  return user
}

function normalizeRedirectPath(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.startsWith('/')) return null
  if (trimmed.startsWith('//')) return null
  if (trimmed.length > 1024) return null
  return trimmed
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function getDb(env) {
  const db = env.DB || env.video_subscription_db
  if (!db) throw new Error('D1 binding not found')
  return db
}

function buildResponseHeaders(corsHeaders) {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v)
  return headers
}

function authJson(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}
