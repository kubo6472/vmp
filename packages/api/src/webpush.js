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
 *   FRONTEND_URL       — used as the VAPID subject (mailto: or https: URI)
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
    out.set(new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer), offset)
    offset += buf.byteLength
  }
  return out
}

// ─── VAPID JWT (ES256) ────────────────────────────────────────────────────────

async function importVapidPrivateKey(b64urlPrivate) {
  // The VAPID private key is stored as raw 32 bytes in base64url.
  // We must import it as a JWK so SubtleCrypto can use it for ES256 signing.
  const rawPrivate = b64urlToUint8(b64urlPrivate)

  // Build JWK for a P-256 private key (x/y come from the public key).
  // We derive x/y by performing a scalar multiplication — easiest via
  // importing the key as pkcs8 (DER-encoded) using the ECDH import path
  // and then re-exporting as JWK to get x/y, but that requires us to
  // construct a DER manually.
  //
  // Simpler: the SubtleCrypto spec allows importing raw private key bytes
  // directly for ECDSA via JWK with x/y computed. However, SubtleCrypto
  // does NOT support raw P-256 private key import for ECDSA directly.
  //
  // Solution: build a minimal PKCS#8 DER structure for the EC private key.
  // PKCS#8 for P-256: a well-known fixed byte header + the 32-byte private key.

  // PKCS#8 DER prefix for EC P-256 private key (RFC 5958 OneAsymmetricKey):
  // SEQUENCE {
  //   INTEGER 0 (version)
  //   SEQUENCE { OID ecPublicKey, OID prime256v1 }
  //   OCTET STRING { SEC1 ECPrivateKey { INTEGER 1, OCTET STRING <privkey> } }
  // }
  const pkcs8Header = new Uint8Array([
    0x30, 0x41, // SEQUENCE, 65 bytes total
      0x02, 0x01, 0x00, // INTEGER 0 (version)
      0x30, 0x13, // SEQUENCE, 19 bytes
        0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID ecPublicKey
        0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // OID prime256v1
      0x04, 0x27, // OCTET STRING, 39 bytes
        0x30, 0x25, // SEQUENCE (SEC1 ECPrivateKey), 37 bytes
          0x02, 0x01, 0x01, // INTEGER 1 (version)
          0x04, 0x20, // OCTET STRING, 32 bytes (the private key follows)
  ])
  const pkcs8 = concatBuffers(pkcs8Header, rawPrivate)

  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

async function signVapidJwt(audience, subject, vapidPrivateKeyB64, expiresIn = 43200) {
  const now = Math.floor(Date.now() / 1000)
  const header = { typ: 'JWT', alg: 'ES256' }
  const payload = { aud: audience, exp: now + expiresIn, sub: subject }

  const enc = new TextEncoder()
  const headerB64 = uint8ToB64url(enc.encode(JSON.stringify(header)))
  const payloadB64 = uint8ToB64url(enc.encode(JSON.stringify(payload)))
  const signingInput = `${headerB64}.${payloadB64}`

  const key = await importVapidPrivateKey(vapidPrivateKeyB64)
  const sigDer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(signingInput),
  )

  // SubtleCrypto returns DER-encoded signature for ECDSA; JWT requires raw r||s (64 bytes)
  const sig = derToRaw(new Uint8Array(sigDer))
  return `${signingInput}.${uint8ToB64url(sig)}`
}

/** Convert DER-encoded ECDSA signature to raw r||s (64 bytes) */
function derToRaw(der) {
  // DER: 0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>
  let offset = 2 // skip 0x30 <totalLen>
  offset++ // skip 0x02
  const rLen = der[offset++]
  const r = der.slice(offset, offset + rLen)
  offset += rLen
  offset++ // skip 0x02
  const sLen = der[offset++]
  const s = der.slice(offset, offset + sLen)

  // r and s may have a leading 0x00 padding byte (to avoid sign bit ambiguity)
  const rPadded = r.length > 32 ? r.slice(r.length - 32) : r
  const sPadded = s.length > 32 ? s.slice(s.length - 32) : s

  const raw = new Uint8Array(64)
  raw.set(rPadded, 32 - rPadded.length)
  raw.set(sPadded, 64 - sPadded.length)
  return raw
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

  // 7. HKDF (SHA-256) — Extract+Expand per RFC 8291 Section 3.3
  //    Step a: IKM = HKDF-Extract(auth, ECDH-shared-secret)
  //    Step b: PRK = HKDF-Expand(IKM, "WebPush: info\x00" || receiver_public || sender_public, 32)
  //    Step c: CEK = HKDF-Expand(PRK, "Content-Encoding: aes128gcm\x00", 16)
  //    Step d: Nonce = HKDF-Expand(PRK, "Content-Encoding: nonce\x00", 12)

  const enc = new TextEncoder()

  // IKM = HKDF-Extract(salt=auth, ikm=sharedSecret)
  const ikmBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: new Uint8Array(0) },
    await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']),
    256,
  )
  const ikm = new Uint8Array(ikmBits)

  // info for PRK derivation: "WebPush: info\0" || receiver_pub || sender_pub
  const prkInfo = concatBuffers(
    enc.encode('WebPush: info\x00'),
    subscriberPublicKeyBytes,
    ephemeralPublicKeyRaw,
  )
  // PRK: HKDF-Extract(salt=salt, ikm=ikm) using standard HKDF
  const prk = await hkdfExpand(ikm, salt, prkInfo, 32)

  // CEK: HKDF-Expand(PRK, "Content-Encoding: aes128gcm\0", 16)
  const cekInfo = enc.encode('Content-Encoding: aes128gcm\x00')
  const cek = await hkdfExpand(prk, salt, cekInfo, 16)

  // Nonce: HKDF-Expand(PRK, "Content-Encoding: nonce\0", 12)
  const nonceInfo = enc.encode('Content-Encoding: nonce\x00')
  const nonce = await hkdfExpand(prk, salt, nonceInfo, 12)

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
 * HKDF-Expand(prk, salt, info, length) using HMAC-SHA-256.
 * Note: We use SubtleCrypto's HKDF in expand-only mode by setting
 *       salt as the HMAC key and info as the context.
 */
async function hkdfExpand(prk, salt, info, length) {
  // Use SubtleCrypto HKDF: deriveBits with the PRK as key material,
  // salt as the HKDF salt, and info as the HKDF info.
  const key = await crypto.subtle.importKey('raw', prk, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
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
    console.warn('VAPID keys not configured, skipping push notification')
    return
  }

  // Audience = origin of the push service endpoint
  const endpointUrl = new URL(endpoint)
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`
  const subject = `mailto:${env.SENDER_EMAIL || 'noreply@example.com'}`

  const vapidJwt = await signVapidJwt(audience, subject, env.VAPID_PRIVATE_KEY)
  const vapidAuthHeader = `vapid t=${vapidJwt},k=${env.VAPID_PUBLIC_KEY}`

  const payloadJson = JSON.stringify(payload)
  const encrypted = await encryptPayload(payloadJson, p256dh, auth)

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Authorization': vapidAuthHeader,
      'TTL': '86400',
    },
    body: encrypted,
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.error(`Push delivery failed for ${endpoint}: ${response.status} ${body}`)
    // 410 Gone = subscription expired; caller may clean up the row
    if (response.status === 410 || response.status === 404) {
      throw Object.assign(new Error('Push subscription expired'), { code: 'subscription_gone' })
    }
  }
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
  let subscriptions
  try {
    const result = await db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all()
    subscriptions = result.results || []
  } catch (err) {
    console.error('Failed to fetch push subscriptions:', err)
    return
  }

  const payload = {
    title: 'New video published',
    body: videoTitle,
    url: `${env.FRONTEND_URL}/watch/${videoId}`,
  }

  const staleEndpoints = []

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await sendPushNotification(sub, payload, env)
      } catch (err) {
        if (err.code === 'subscription_gone') {
          staleEndpoints.push(sub.endpoint)
        } else {
          console.error('Push error:', err)
        }
      }
    }),
  )

  // Clean up expired subscriptions
  for (const endpoint of staleEndpoints) {
    await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
      .bind(endpoint).run().catch(e => console.error('Cleanup error:', e))
  }
}
