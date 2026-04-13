/**
 * packages/api/src/thumbnails.js
 *
 * Thumbnail upload and delete handlers for Step 7.
 *
 * R2 storage layout (same bucket as video assets, separate prefix):
 *   thumbnails/{videoId}/original.{ext}  — source file as uploaded (kept for re-processing)
 *   thumbnails/{videoId}/large.jpg       — 1280×720, quality 85
 *   thumbnails/{videoId}/medium.jpg      —  640×360, quality 82
 *   thumbnails/{videoId}/small.jpg       —  320×180, quality 80
 *
 * The original is stored with its actual MIME type and extension (.jpg or .png).
 * The three resized variants are always stored as JPEG regardless of the source format.
 *
 * D1: videos.thumbnail_url is updated to point at the large.jpg variant,
 * e.g. https://<R2_BASE_URL>/thumbnails/{videoId}/large.jpg.
 *
 * Image resizing uses OffscreenCanvas + createImageBitmap, both available in
 * Cloudflare Workers' Chromium runtime.  If either API is absent the upload
 * still succeeds — all four size keys are stored as the original file and a
 * warning is logged.  This is a known limitation noted below.
 */

import { requireRole } from './auth.js'
import type { D1Database, R2Bucket } from '@cloudflare/workers-types'

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_BYTES = 10 * 1024 * 1024 // 10 MB

const SIZES = [
  { key: 'large',  width: 1280, height: 720, quality: 85 },
  { key: 'medium', width:  640, height: 360, quality: 82 },
  { key: 'small',  width:  320, height: 180, quality: 80 },
]

interface ThumbUrls {
  original?: string
  large?: string
  medium?: string
  small?: string
  [key: string]: string | undefined
}

interface Env {
  DB?: D1Database
  video_subscription_db?: D1Database
  BUCKET: R2Bucket
  R2_BASE_URL?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown | Record<string, unknown>, status: number, corsHeaders: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

function getDb(env: Env) {
  const db = env.DB || env.video_subscription_db
  if (!db) throw new Error('Database binding not configured')
  return db
}

/**
 * Derive a safe file extension and content-type from the uploaded MIME type.
 * Falls back to '.img' / 'application/octet-stream' for anything unexpected
 * (the MIME validation gate above should prevent this path in practice).
 */
function extensionForMime(mimeType: string) {
  if (mimeType === 'image/jpeg') return { ext: 'jpg', contentType: 'image/jpeg' }
  if (mimeType === 'image/png')  return { ext: 'png', contentType: 'image/png' }
  return { ext: 'img', contentType: 'application/octet-stream' }
}

/**
 * Resize an image buffer to targetWidth × targetHeight at the given JPEG quality.
 *
 * Known limitation: createImageBitmap / OffscreenCanvas may not be available in
 * all Cloudflare Worker runtime versions.  The caller should catch errors from
 * this function and fall back to storing the original bytes unchanged.
 *
 * @param {ArrayBuffer} sourceBuffer
 * @param {string}      sourceMime    — MIME type of the source bytes
 * @param {number}      targetWidth
 * @param {number}      targetHeight
 * @param {number}      quality  — integer 0–100; divided by 100 for the Canvas API
 * @returns {Promise<Blob>}
 */
async function resizeImage(sourceBuffer: ArrayBuffer, sourceMime: string, targetWidth: number, targetHeight: number, quality: number) {
  const blob   = new Blob([sourceBuffer], { type: sourceMime })
  const bitmap = await createImageBitmap(blob, {
    resizeWidth:   targetWidth,
    resizeHeight:  targetHeight,
    resizeQuality: 'high',
  })
  const canvas = new OffscreenCanvas(targetWidth, targetHeight)
  const ctx    = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context is unavailable')
  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight)
  // Sized variants are always output as JPEG regardless of the source format.
  return canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 })
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/videos/:id/thumbnail
 *
 * Accepts multipart/form-data with a single field "thumbnail" (JPEG or PNG,
 * max 10 MB).  Resizes to four variants, uploads all to R2, and updates D1.
 *
 * Returns:
 *   { ok: true, thumbnails: { original, large, medium, small } }
 */
export async function handleThumbnailUpload(request: Request, env: Env, corsHeaders: HeadersInit) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Forbidden' }, 403, corsHeaders)
  }

  const url   = new URL(request.url)
  const match = url.pathname.match(/^\/api\/admin\/videos\/([^/]+)\/thumbnail$/)
  if (!match) return jsonResponse({ error: 'Not Found' }, 404, corsHeaders)
  let videoId: string
  try {
    videoId = decodeURIComponent(match[1]!)
  } catch {
    return jsonResponse({ error: 'Invalid video id encoding.' }, 400, corsHeaders)
  }

  // ── Verify the video exists in D1 before doing any work ──────────────────
  // This check must happen before reading the request body so we fail fast
  // and never write orphaned R2 objects for a non-existent video.
  const db = getDb(env)
  const existing = await db.prepare('SELECT id FROM videos WHERE id = ?').bind(videoId).first()
  if (!existing) {
    return jsonResponse({ error: 'Video not found.' }, 404, corsHeaders)
  }

  // Reject obviously-oversized requests before reading the body.
  const contentLength = parseInt(request.headers.get('content-length') || '0', 10)
  if (contentLength > MAX_BYTES) {
    return jsonResponse({ error: 'File too large. Maximum size is 10 MB.' }, 413, corsHeaders)
  }

  let formData
  try {
    formData = await request.formData()
  } catch {
    return jsonResponse({ error: 'Invalid multipart form data.' }, 400, corsHeaders)
  }

  const file = formData.get('thumbnail')
  if (!file || typeof file === 'string') {
    return jsonResponse({ error: 'Missing "thumbnail" field in form data.' }, 400, corsHeaders)
  }

  // Only JPEG and PNG are accepted.
  if (!['image/jpeg', 'image/png'].includes(file.type)) {
    return jsonResponse(
      { error: `Unsupported file type "${file.type}". Only image/jpeg and image/png are accepted.` },
      415,
      corsHeaders,
    )
  }

  // Secondary size guard (Content-Length header may be absent or spoofed).
  const sourceBuffer = await file.arrayBuffer()
  if (sourceBuffer.byteLength > MAX_BYTES) {
    return jsonResponse({ error: 'File too large. Maximum size is 10 MB.' }, 413, corsHeaders)
  }

  const r2BaseUrl = (env.R2_BASE_URL || '').replace(/\/$/, '')
  // Change the URL on each upload so CDN/browser caches cannot serve stale images.
  const cacheVersion = Date.now().toString()

  // Derive the correct extension and content-type from the uploaded file's MIME type.
  const { ext: origExt, contentType: origContentType } = extensionForMime(file.type)
  const origKey = `thumbnails/${videoId}/original.${origExt}`

  // Detect Canvas API availability once before the loop.
  // Only when the APIs are absent do we fall back to storing original bytes for
  // the sized variants.  Errors thrown by a present createImageBitmap (e.g. a
  // corrupt or mislabeled image) are NOT capability failures — they propagate to
  // the outer try/catch which cleans up any partial R2 writes.
  const canResize = typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function'
  if (!canResize) {
    console.warn('[thumbnails] OffscreenCanvas/createImageBitmap unavailable — storing original bytes for all size variants.')
  }

  // Track which R2 keys we write so we can clean them up on any failure.
  const writtenKeys = []
  const thumbUrls: ThumbUrls = {}

  try {
    // Store the original with its actual MIME type / extension.
    await env.BUCKET.put(origKey, sourceBuffer, { httpMetadata: { contentType: origContentType } })
    writtenKeys.push(origKey)
    thumbUrls.original = `${r2BaseUrl}/${origKey}?v=${cacheVersion}`

    // Resize to each size variant.
    // When the Canvas API is unavailable the original bytes are stored instead
    // (fallback), preserving the source MIME type in httpMetadata.
    // When the Canvas API IS present but throws (decode error, corrupt image),
    // the error propagates out of this try block so partial writes are cleaned up.
    for (const { key, width, height, quality } of SIZES) {
      let blob
      if (canResize) {
        blob = await resizeImage(sourceBuffer, file.type, width, height, quality)
      } else {
        blob = new Blob([sourceBuffer], { type: file.type })
      }

      const variantKey = `thumbnails/${videoId}/${key}.jpg`
      await env.BUCKET.put(
        variantKey,
        await blob.arrayBuffer(),
        // Use the blob's actual MIME type so the fallback (PNG source) is served
        // with the correct Content-Type header, not a hardcoded image/jpeg.
        { httpMetadata: { contentType: blob.type || 'image/jpeg' } },
      )
      writtenKeys.push(variantKey)
      thumbUrls[key] = `${r2BaseUrl}/${variantKey}?v=${cacheVersion}`
    }

    // Update D1 to point at the large variant.
    // Guard against zero affected rows (race: video deleted between SELECT and UPDATE).
    const result = await db
      .prepare('UPDATE videos SET thumbnail_url = ? WHERE id = ?')
      .bind(thumbUrls.large, videoId)
      .run()

    const rowsChanged = Number(result.meta?.changes ?? 0)
    if (rowsChanged === 0) {
      await Promise.allSettled(writtenKeys.map(k => env.BUCKET.delete(k)))
      return jsonResponse({ error: 'Video not found or could not be updated.' }, 404, corsHeaders)
    }
  } catch (err) {
    // Best-effort cleanup of any R2 objects written before the failure.
    await Promise.allSettled(writtenKeys.map(k => env.BUCKET.delete(k)))
    console.error('[thumbnails] Upload failed, R2 cleanup attempted:', err)
    return jsonResponse({ error: 'Failed to process thumbnail.' }, 500, corsHeaders)
  }

  return jsonResponse({ ok: true, thumbnails: thumbUrls }, 200, corsHeaders)
}

/**
 * DELETE /api/admin/videos/:id/thumbnail
 *
 * Removes all R2 keys for the video's thumbnails and clears
 * videos.thumbnail_url in D1.
 *
 * The original may have been stored as either .jpg or .png depending on the
 * source file's MIME type.  Both are attempted; R2 delete is a no-op for
 * keys that don't exist so this is always safe.
 *
 * Returns: { ok: true }
 */
export async function handleThumbnailDelete(request: Request, env: Env, corsHeaders: HeadersInit) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Forbidden' }, 403, corsHeaders)
  }

  const url   = new URL(request.url)
  const match = url.pathname.match(/^\/api\/admin\/videos\/([^/]+)\/thumbnail$/)
  if (!match) return jsonResponse({ error: 'Not Found' }, 404, corsHeaders)
  let videoId: string
  try {
    videoId = decodeURIComponent(match[1]!)
  } catch {
    return jsonResponse({ error: 'Invalid video id encoding.' }, 400, corsHeaders)
  }

  const db = getDb(env)

  // Delete all known R2 keys in parallel.
  // original.jpg and original.png are both attempted because the extension
  // depends on what was uploaded; R2 silently ignores deletes for missing keys.
  await Promise.all([
    env.BUCKET.delete(`thumbnails/${videoId}/original.jpg`),
    env.BUCKET.delete(`thumbnails/${videoId}/original.png`),
    env.BUCKET.delete(`thumbnails/${videoId}/large.jpg`),
    env.BUCKET.delete(`thumbnails/${videoId}/medium.jpg`),
    env.BUCKET.delete(`thumbnails/${videoId}/small.jpg`),
  ])

  // Clear thumbnail_url in D1.
  await db
    .prepare('UPDATE videos SET thumbnail_url = NULL WHERE id = ?')
    .bind(videoId)
    .run()

  return jsonResponse({ ok: true }, 200, corsHeaders)
}
