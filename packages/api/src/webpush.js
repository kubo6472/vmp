/**
 * packages/api/src/webpush.js
 *
 * Web Push notification delivery using SubtleCrypto only (no npm libraries).
 *
 * Implements:
 *   - RFC 8291: Message Encryption for Web Push (AES-128-GCM, HKDF)
 *   - RFC 8292: Voluntary Application Server Identification (VAPID / ES256)
 *
 * Required env vars:
 *   VAPID_PRIVATE_KEY  — base64url-encoded raw 32-byte EC P-256 private key
 *                        (set via `wrangler secret put VAPID_PRIVATE_KEY`)
 *   VAPID_PUBLIC_KEY   — base64url-encoded uncompressed 65-byte EC P-256 public key
 *                        (set in wrangler.json vars)
 *   SENDER_EMAIL       — used as the VAPID subject (mailto: URI)
 */

// ─── Encoding helpers ─────────────────────────────────────────────────────────

function b64urlToUint8(b64url) {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/')
    + '=='.slice(0, (4 - (b64url.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}

function uint8ToB64url(bytes) {
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function concatBuffers(...bufs) {
  const total = bufs.reduce((n, b) => n + b.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const buf of bufs) {
    // Use the typed array view directly so byteOffset/byteLength are respected
    out.set(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf, offset)
    offset += buf.byteLength
  }
  return out
}

// ─── VAPID JWT (ES256) ────────────────────────────────────────────────────────

async function importVapidPrivateKey(b64urlPrivate, b64urlPublic) {
  // VAPID keys are provided as raw base64url values:
  // - private key: 32-byte scalar (d)
  // - public key: uncompressed 65-byte point (0x04 || X || Y)
  //
  // Import as JWK so SubtleCrypto signs with the exact key pair used by clients.
  const rawPrivate = b64urlToUint8(b64urlPrivate)
  const rawPublic = b64urlToUint8(b64urlPublic)

  if (rawPrivate.length !== 32) {
    throw new Error('Invalid VAPID private key length')
  }
  if (rawPublic.length !== 65 || rawPublic[0] !== 0x04) {
    throw new Error('Invalid VAPID public key format')
  }

  const x = uint8ToB64url(rawPublic.slice(1, 33))
  const y = uint8ToB64url(rawPublic.slice(33, 65))
  const d = uint8ToB64url(rawPrivate)

  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x,
      y,
      d,
      ext: false,
      key_ops: ['sign'],
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

async function signVapidJwt(audience, subject, vapidPrivateKeyB64, vapidPublicKeyB64, expiresIn = 43200) {
  const now = Math.floor(Date.now() / 1000)
  const header = { typ: 'JWT', alg: 'ES256' }
  const payload = { aud: audience, exp: now + expiresIn, sub: subject }

  const enc = new TextEncoder()
  const headerB64 = uint8ToB64url(enc.encode(JSON.stringify(header)))
  const payloadB64 = uint8ToB64url(enc.encode(JSON.stringify(payload)))
  const signingInput = `${headerB64}.${payloadB64}`

  const key = await importVapidPrivateKey(vapidPrivateKeyB64, vapidPublicKeyB64)
  const sigDer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(signingInput),
  )

  // JWT ES256 requires JOSE raw r||s (64 bytes).
  const sig = ecdsaSignatureToJose(new Uint8Array(sigDer))
  return `${signingInput}.${uint8ToB64url(sig)}`
}

function parseDerLength(bytes, offset) {
  if (offset >= bytes.length) throw new Error('Invalid DER length')
  const first = bytes[offset]
  if (first < 0x80) return { length: first, nextOffset: offset + 1 }
  const octets = first & 0x7f
  if (octets < 1 || octets > 2 || offset + 1 + octets > bytes.length) {
    throw new Error('Invalid DER length')
  }
  let length = 0
  for (let i = 0; i < octets; i++) {
    length = (length << 8) | bytes[offset + 1 + i]
  }
  return { length, nextOffset: offset + 1 + octets }
}

function parseDerInteger(bytes, offset) {
  if (bytes[offset] !== 0x02) throw new Error('Invalid DER integer tag')
  const { length, nextOffset } = parseDerLength(bytes, offset + 1)
  const end = nextOffset + length
  if (end > bytes.length) throw new Error('Invalid DER integer length')
  return { value: bytes.slice(nextOffset, end), nextOffset: end }
}

/** Convert ECDSA signature to JOSE raw r||s (64 bytes). */
function ecdsaSignatureToJose(signature) {
  // Some runtimes already return IEEE-P1363 raw signatures.
  if (signature.length === 64) return signature

  // DER fallback: SEQUENCE(INTEGER(r), INTEGER(s))
  if (signature.length < 8 || signature[0] !== 0x30) {
    throw new Error('Unsupported ECDSA signature format')
  }

  const seq = parseDerLength(signature, 1)
  let offset = seq.nextOffset
  if (offset + seq.length !== signature.length) {
    throw new Error('Invalid DER sequence length')
  }

  const rParsed = parseDerInteger(signature, offset)
  const sParsed = parseDerInteger(signature, rParsed.nextOffset)
  if (sParsed.nextOffset !== signature.length) {
    throw new Error('Trailing bytes in DER signature')
  }

  let r = rParsed.value
  let s = sParsed.value
  if (r.length > 32) {
    if (r.length === 33 && r[0] === 0x00) {
      r = r.slice(1)
    } else {
      throw new Error('Invalid DER integer length')
    }
  }
  if (s.length > 32) {
    if (s.length === 33 && s[0] === 0x00) {
      s = s.slice(1)
    } else {
      throw new Error('Invalid DER integer length')
    }
  }

  const out = new Uint8Array(64)
  out.set(r, 32 - r.length)
  out.set(s, 64 - s.length)
  return out
}

// ─── RFC 8291: Web Push Message Encryption ───────────────────────────────────

/**
 * Encrypt a plaintext payload for delivery to a push subscription.
 *
 * Returns the ciphertext bytes and the ephemeral sender public key (uncompressed)
 * plus the salt, all of which go into the Content-Encoding: aes128gcm header.
 */
async function encryptPayload(plaintext, p256dhB64, authB64) {
  // 1. Import the subscriber's public key (P-256, uncompressed 65-byte)
  const subscriberPublicKeyBytes = b64urlToUint8(p256dhB64)
  const subscriberPublicKey = await crypto.subtle.importKey(
    'raw',
    subscriberPublicKeyBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  )

  // 2. Generate an ephemeral ECDH key pair
  const ephemeralKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits'],
  )

  // 3. Export the ephemeral public key (uncompressed, 65 bytes)
  const ephemeralPublicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeralKeyPair.publicKey),
  )

  // 4. Derive the ECDH shared secret
  const sharedSecretBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: subscriberPublicKey },
    ephemeralKeyPair.privateKey,
    256,
  )
  const sharedSecret = new Uint8Array(sharedSecretBits)

  // 5. Generate a random 16-byte salt
  const salt = crypto.getRandomValues(new Uint8Array(16))

  // 6. auth secret from the subscription
  const authSecret = b64urlToUint8(authB64)

  // 7. HKDF key derivation — RFC 8291 Section 3.3
  //    PRK_key = HKDF-Extract(salt=authSecret, ikm=sharedSecret)
  //    IKM     = HKDF-Expand(PRK_key, "WebPush: info\0" || ua_pub || as_pub, 32)
  //    PRK     = HKDF-Extract(salt=content_salt, ikm=IKM)
  //    CEK     = HKDF-Expand(PRK, "Content-Encoding: aes128gcm\0", 16)
  //    Nonce   = HKDF-Expand(PRK, "Content-Encoding: nonce\0", 12)

  const enc = new TextEncoder()

  // Step 1: PRK_key = HKDF-Extract(salt=authSecret, ikm=sharedSecret)
  const prkKey = await hkdfExtract(authSecret, sharedSecret)

  // Step 2: IKM = HKDF-Expand(PRK_key, "WebPush: info\0" || ua_pub || as_pub, 32)
  const prkInfo = concatBuffers(
    enc.encode('WebPush: info\x00'),
    subscriberPublicKeyBytes,
    ephemeralPublicKeyRaw,
  )
  const ikm = await hkdfExpand(prkKey, prkInfo, 32)

  // Step 3: PRK = HKDF-Extract(salt=content_salt, ikm=IKM)
  const prk = await hkdfExtract(salt, ikm)

  // Step 4: CEK = HKDF-Expand(PRK, "Content-Encoding: aes128gcm\0", 16)
  const cek = await hkdfExpand(prk, enc.encode('Content-Encoding: aes128gcm\x00'), 16)

  // Step 5: Nonce = HKDF-Expand(PRK, "Content-Encoding: nonce\0", 12)
  const nonce = await hkdfExpand(prk, enc.encode('Content-Encoding: nonce\x00'), 12)

  // 8. Encrypt with AES-128-GCM
  //    Payload format per RFC 8291: data || 0x02 (padding delimiter)
  const plaintextBytes = enc.encode(plaintext)
  const paddedPlaintext = concatBuffers(plaintextBytes, new Uint8Array([0x02]))

  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt'])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, paddedPlaintext),
  )

  // 9. Build Content-Encoding: aes128gcm record
  //    Header: salt (16) + rs (4, big-endian uint32) + keyid_len (1) + keyid (65)
  //    Then: ciphertext
  const rs = 4096 // record size
  const rsBytes = new Uint8Array(4)
  new DataView(rsBytes.buffer).setUint32(0, rs, false)

  const header = concatBuffers(
    salt,
    rsBytes,
    new Uint8Array([ephemeralPublicKeyRaw.length]),
    ephemeralPublicKeyRaw,
  )

  return concatBuffers(header, ciphertext)
}

/**
 * HKDF-Extract(salt, ikm) per RFC 5869 — returns a 32-byte PRK.
 * Implemented as HMAC-SHA-256(key=salt, data=ikm).
 */
async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey(
    'raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm))
}

/**
 * HKDF-Expand(prk, info, length) per RFC 5869 — length must be ≤ 32 for SHA-256.
 * T(1) = HMAC-SHA-256(key=prk, data=info || 0x01), output first `length` bytes.
 */
async function hkdfExpand(prk, info, length) {
  if (length > 32) throw new RangeError('hkdfExpand: length must be ≤ 32 (single SHA-256 round)')
  const key = await crypto.subtle.importKey(
    'raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const t1 = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, concatBuffers(info, new Uint8Array([0x01]))),
  )
  return t1.slice(0, length)
}

// ─── Send a single Web Push notification ─────────────────────────────────────

/**
 * @param {{ endpoint: string, p256dh: string, auth: string }} subscription
 * @param {{ title: string, body: string, url?: string }} payload
 * @param {object} env - Worker env bindings
 */
export async function sendPushNotification(subscription, payload, env) {
  const { endpoint, p256dh, auth } = subscription

  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) {
    throw Object.assign(new Error('VAPID keys not configured'), { code: 'vapid_not_configured' })
  }

  // Audience = origin of the push service endpoint
  const endpointUrl = new URL(endpoint)
  const endpointHost = endpointUrl.host
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`
  const subject = `mailto:${env.SENDER_EMAIL || 'noreply@example.com'}`

  const vapidJwt = await signVapidJwt(audience, subject, env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY)
  const vapidAuthHeader = `vapid t=${vapidJwt},k=${env.VAPID_PUBLIC_KEY}`
  const webPushAuthHeader = `WebPush ${vapidJwt}`

  const payloadJson = JSON.stringify(payload)
  const encrypted = await encryptPayload(payloadJson, p256dh, auth)

  // 10-second timeout — prevents a slow/unresponsive endpoint from blocking
  // the entire batch inside Promise.allSettled().
  let response
  const send = (authorizationValue) => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 10_000)
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Authorization': authorizationValue,
        // Historically required by some push gateways (including older FCM paths)
        // when validating VAPID identity.
        'Crypto-Key': `p256ecdsa=${env.VAPID_PUBLIC_KEY}`,
        'TTL': '86400',
      },
      body: encrypted,
      signal: abort.signal,
    }).finally(() => clearTimeout(timer))
  }

  try {
    response = await send(vapidAuthHeader)
    // Compatibility fallback for browsers routed through FCM endpoints that
    // reject the RFC 8292 "vapid t=...,k=..." Authorization syntax.
    if (!response.ok && (response.status === 400 || response.status === 401 || response.status === 403)) {
      const originalStatus = response.status
      console.log(JSON.stringify({
        event: 'webpush_auth_fallback_attempted',
        originalStatus,
        endpointHost,
      }))
      response = await send(webPushAuthHeader)
      const fallbackSuccess = response.ok
      console.log(JSON.stringify({
        event: 'webpush_auth_fallback_result',
        originalStatus,
        endpointHost,
        success: fallbackSuccess,
        finalStatus: response.status,
      }))
    }
  } catch (err) {
    console.error(JSON.stringify({
      event: 'webpush_delivery_failed',
      endpointHost,
      statusClass: 'network_error',
      reason: err?.name === 'AbortError' ? 'timeout_or_abort' : 'fetch_error',
      message: err?.message || 'unknown fetch error',
    }))
    throw Object.assign(
      new Error(`Push fetch error: ${err.message}`),
      { code: 'push_failed', statusClass: 'network_error', endpointHost },
    )
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    const statusClass = `${Math.floor(response.status / 100)}xx`
    const responseSnippet = errBody.slice(0, 200)
    console.error(JSON.stringify({
      event: 'webpush_delivery_failed',
      endpointHost,
      status: response.status,
      statusClass,
      responseSnippet,
    }))
    if (response.status === 410 || response.status === 404) {
      // Subscription expired — caller cleans up the row
      throw Object.assign(
        new Error('Push subscription expired'),
        { code: 'subscription_gone', status: response.status, statusClass, responseSnippet, endpointHost },
      )
    }
    // All other non-ok responses (429, 500, …) are propagated so the caller knows
    throw Object.assign(
      new Error(`Push delivery failed: ${response.status}`),
      { code: 'push_failed', status: response.status, statusClass, responseSnippet, endpointHost },
    )
  }

  return { ok: true, status: response.status, statusClass: `${Math.floor(response.status / 100)}xx`, endpointHost }
}

/**
 * Send a "new video published" push to every subscribed user.
 * Called with ctx.waitUntil() so it doesn't block the HTTP response.
 *
 * @param {string} videoTitle
 * @param {string} videoId
 * @param {object} env
 * @param {object} db - D1 database binding
 */
export async function sendPushToAllSubscribers(videoTitle, videoId, env, db) {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) {
    throw Object.assign(new Error('VAPID keys not configured'), { code: 'vapid_not_configured' })
  }

  let subscriptions
  try {
    const result = await db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all()
    subscriptions = result.results || []
  } catch (err) {
    console.error('Failed to fetch push subscriptions:', err)
    return { attempted: 0, succeeded: 0, failed: 0, stale: 0 }
  }

  const payload = {
    title: 'New video published',
    body: videoTitle,
    url: `${env.FRONTEND_URL}/watch/${videoId}`,
  }

  const staleEndpoints = []
  const batchSize = 50
  let succeeded = 0
  let failed = 0
  let stale = 0

  for (let i = 0; i < subscriptions.length; i += batchSize) {
    const results = await Promise.allSettled(
      subscriptions.slice(i, i + batchSize).map(async (sub) => {
        try {
          await sendPushNotification(sub, payload, env)
        } catch (err) {
          if (err.code === 'subscription_gone') {
            staleEndpoints.push(sub.endpoint)
            stale++
            return
          }
          throw err
        }
      }),
    )
    for (const r of results) {
      if (r.status === 'fulfilled') succeeded++
      else failed++
    }
  }

  // Batch-delete expired subscriptions in one query
  if (staleEndpoints.length > 0) {
    const placeholders = staleEndpoints.map(() => '?').join(',')
    await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint IN (${placeholders})`)
      .bind(...staleEndpoints).run().catch(e => console.error('Cleanup error:', e))
  }

  return { attempted: subscriptions.length, succeeded, failed, stale }
}
