import {
  TUS_VERSION,
  parseUploadMetadata,
  sanitizeFileName,
  sanitizeVisibility,
  tusResponse,
  json,
  jsonString,
  type UploadSession,
  TUS_UPLOAD_ALLOW_METHODS,
} from './_utils.js'
import type { R2Bucket } from '@cloudflare/workers-types'
import type { RequestContext, WorkerEnv } from '../_types.js'

const DEFAULT_MAX_UPLOAD_LENGTH = 10 * 1024 * 1024 * 1024 // 10 GiB

interface UploadsEnv extends WorkerEnv {
  VIDEO_BUCKET: R2Bucket
  MAX_UPLOAD_LENGTH?: string | number
}

export async function onRequest(context: RequestContext<UploadsEnv>) {
  const { request, env } = context
  const maxUploadLength = resolveMaxUploadLength(env.MAX_UPLOAD_LENGTH)

  if (request.method === 'OPTIONS') {
    return tusResponse(null, 204, {
      'Tus-Version': TUS_VERSION,
      'Tus-Extension': '',
      'Tus-Max-Size': String(maxUploadLength),
    }, request, TUS_UPLOAD_ALLOW_METHODS, env)
  }

  if (!env.VIDEO_BUCKET) {
    return json({ error: 'VIDEO_BUCKET binding is required' }, 500, request, TUS_UPLOAD_ALLOW_METHODS, env)
  }

  if (request.method !== 'POST') {
    return tusResponse(null, 405, { Allow: 'POST,OPTIONS' }, request, TUS_UPLOAD_ALLOW_METHODS, env)
  }

  const tusVersion = request.headers.get('Tus-Resumable')
  if (tusVersion !== TUS_VERSION) {
    return tusResponse(jsonString({ error: 'Missing or invalid Tus-Resumable header' }), 412, {
      'Tus-Version': TUS_VERSION,
    }, request, TUS_UPLOAD_ALLOW_METHODS, env)
  }

  const uploadLengthRaw = request.headers.get('Upload-Length')
  if (!uploadLengthRaw || !/^\d+$/.test(uploadLengthRaw)) {
    return tusResponse(jsonString({ error: 'Upload-Length header is required and must be > 0' }), 400, {}, request, TUS_UPLOAD_ALLOW_METHODS, env)
  }
  const uploadLength = Number(uploadLengthRaw)
  if (!Number.isSafeInteger(uploadLength) || uploadLength <= 0) {
    return tusResponse(jsonString({ error: 'Upload-Length header is required and must be > 0' }), 400, {}, request, TUS_UPLOAD_ALLOW_METHODS, env)
  }
  if (uploadLength > maxUploadLength) {
    return tusResponse(
      jsonString({ error: `Upload-Length exceeds maximum allowed size (${maxUploadLength} bytes)` }),
      413,
      {},
      request,
      TUS_UPLOAD_ALLOW_METHODS,
      env,
    )
  }

  const metadata = parseUploadMetadata(request.headers.get('Upload-Metadata'))
  const fileName = sanitizeFileName(metadata.filename || 'upload.bin')
  const contentType = (metadata.filetype || 'application/octet-stream').toLowerCase()
  if (!contentType.startsWith('video/')) {
    return tusResponse(jsonString({ error: 'Only video uploads are allowed' }), 400, {}, request, TUS_UPLOAD_ALLOW_METHODS, env)
  }

  const visibility = sanitizeVisibility(metadata.visibility)
  const videoId = crypto.randomUUID()
  const sourceKey = `videos/${videoId}/source/${fileName}`
  const sessionKey = `videos/${videoId}/upload-session.json`

  let multipartUpload
  try {
    multipartUpload = await env.VIDEO_BUCKET.createMultipartUpload(sourceKey, {
      httpMetadata: { contentType },
      customMetadata: {
        status: 'uploading',
        visibility,
        uploadedAt: new Date().toISOString(),
      },
    })

    const session = {
      videoId,
      sourceKey,
      uploadId: multipartUpload.uploadId,
      uploadLength,
      offset: 0,
      partNumber: 1,
      parts: [],
      visibility,
      fileName,
      contentType,
      createdAt: new Date().toISOString(),
    } satisfies UploadSession

    await env.VIDEO_BUCKET.put(sessionKey, JSON.stringify(session), {
      httpMetadata: { contentType: 'application/json' },
    })
  } catch (error) {
    console.error('R2 operation failed:', error)
    if (multipartUpload) {
      try {
        await multipartUpload.abort()
      } catch (abortError) {
        console.error('Failed to abort multipart upload:', abortError)
      }
    }
    return tusResponse(jsonString({ error: 'Failed to initialize upload' }), 500, {}, request, TUS_UPLOAD_ALLOW_METHODS, env)
  }

  return tusResponse(null, 201, {
    Location: `/api/uploads/${videoId}`,
    'Upload-Offset': '0',
    'Upload-Length': String(uploadLength),
  }, request, TUS_UPLOAD_ALLOW_METHODS, env)
}

function resolveMaxUploadLength(raw: string | number | undefined): number {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const parsed = Number(raw.trim())
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_MAX_UPLOAD_LENGTH
}
