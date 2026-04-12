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
import type { RequestContext } from '../_types.js'

export async function onRequest(context: RequestContext) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return tusResponse(null, 204, {}, request, TUS_UPLOAD_ALLOW_METHODS, env)
  }

  if (!env.VIDEO_BUCKET) {
    return json({ error: 'VIDEO_BUCKET binding is required' }, 500, request, TUS_UPLOAD_ALLOW_METHODS, env)
  }

  if (request.method !== 'POST') {
    return tusResponse(null, 405, { Allow: 'POST,OPTIONS' }, request, TUS_UPLOAD_ALLOW_METHODS, env)
  }

  const tusVersion = request.headers.get('Tus-Resumable')
  if (tusVersion !== TUS_VERSION) {
    return tusResponse(jsonString({ error: 'Missing or invalid Tus-Resumable header' }), 412, {}, request, TUS_UPLOAD_ALLOW_METHODS, env)
  }

  const uploadLengthRaw = request.headers.get('Upload-Length')
  if (!uploadLengthRaw || !/^\d+$/.test(uploadLengthRaw)) {
    return tusResponse(jsonString({ error: 'Upload-Length header is required and must be > 0' }), 400, {}, request, TUS_UPLOAD_ALLOW_METHODS, env)
  }
  const uploadLength = Number(uploadLengthRaw)
  if (!Number.isSafeInteger(uploadLength) || uploadLength <= 0) {
    return tusResponse(jsonString({ error: 'Upload-Length header is required and must be > 0' }), 400, {}, request, TUS_UPLOAD_ALLOW_METHODS, env)
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

  const multipartUpload = await env.VIDEO_BUCKET.createMultipartUpload(sourceKey, {
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

  return tusResponse(null, 201, {
    Location: `/api/uploads/${videoId}`,
    'Upload-Offset': '0',
    'Upload-Length': String(uploadLength),
  }, request, TUS_UPLOAD_ALLOW_METHODS, env)
}