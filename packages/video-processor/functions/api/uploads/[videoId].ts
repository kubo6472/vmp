import type { R2Bucket } from '@cloudflare/workers-types'
import type { RequestContext, WorkerEnv } from '../_types.js'
import { json, jsonString, tusResponse, TUS_CHUNK_ALLOW_METHODS, type UploadSession } from './_utils.js'

const TUS_VERSION = '1.0.0'

interface UploadChunkEnv extends WorkerEnv {
  VIDEO_BUCKET: R2Bucket
}

interface UploadChunkContext extends RequestContext<UploadChunkEnv> {
  params?: Record<string, string>
}

export async function onRequest(context: UploadChunkContext) {
  const { request, env, params } = context

  if (request.method === 'OPTIONS') {
    return tusResponse(null, 204, {}, request, TUS_CHUNK_ALLOW_METHODS, env)
  }

  if (!env.VIDEO_BUCKET) {
    return json({ error: 'VIDEO_BUCKET binding is required' }, 500, request, TUS_CHUNK_ALLOW_METHODS, env)
  }

  const videoId = params?.videoId
  if (!videoId) {
    return tusResponse(null, 400, {}, request, TUS_CHUNK_ALLOW_METHODS, env)
  }

  const sessionKey = `videos/${videoId}/upload-session.json`

  if (request.method === 'HEAD') {
    const session = await readSession(env, sessionKey)
    if (!session) return tusResponse(null, 404, {}, request, TUS_CHUNK_ALLOW_METHODS, env)

    return tusResponse(null, 200, {
      'Upload-Offset': String(session.offset),
      'Upload-Length': String(session.uploadLength)
    }, request, TUS_CHUNK_ALLOW_METHODS, env)
  }

  if (request.method === 'PATCH') {
    if (request.headers.get('Tus-Resumable') !== TUS_VERSION) {
      return tusResponse(null, 412, {}, request, TUS_CHUNK_ALLOW_METHODS, env)
    }

    const sessionObject = await env.VIDEO_BUCKET.get(sessionKey)
    if (!sessionObject) return tusResponse(null, 404, {}, request, TUS_CHUNK_ALLOW_METHODS, env)
    const session = await sessionObject.json<UploadSession>()
    if (!session) return tusResponse(null, 404, {}, request, TUS_CHUNK_ALLOW_METHODS, env)

    const requestedOffset = Number(request.headers.get('Upload-Offset'))
    if (!Number.isFinite(requestedOffset) || requestedOffset !== session.offset) {
      return tusResponse(null, 409, { 'Upload-Offset': String(session.offset) }, request, TUS_CHUNK_ALLOW_METHODS, env)
    }

    const chunk = await request.arrayBuffer()
    if (!chunk.byteLength) return tusResponse(null, 400, {}, request, TUS_CHUNK_ALLOW_METHODS, env)
    if (session.offset + chunk.byteLength > session.uploadLength) return tusResponse(null, 413, {}, request, TUS_CHUNK_ALLOW_METHODS, env)

    const multipart = env.VIDEO_BUCKET.resumeMultipartUpload(session.sourceKey, session.uploadId)
    const uploadedPart = await multipart.uploadPart(session.partNumber, chunk)

    session.parts.push({
      partNumber: session.partNumber,
      etag: uploadedPart.etag,
      size: chunk.byteLength
    })

    session.partNumber += 1
    session.offset += chunk.byteLength

    if (session.offset === session.uploadLength) {
      await multipart.complete(session.parts.map(({ partNumber, etag }) => ({ partNumber, etag })))
      await env.VIDEO_BUCKET.delete(sessionKey)

      return tusResponse(null, 204, {
        'Upload-Offset': String(session.offset),
        'Upload-Complete': '?1',
        'Upload-Result': JSON.stringify({
          ok: true,
          videoId,
          fileName: session.fileName,
          sourceKey: session.sourceKey,
          visibility: session.visibility
        })
      }, request, TUS_CHUNK_ALLOW_METHODS, env)
    }

    const persisted = await env.VIDEO_BUCKET.put(sessionKey, JSON.stringify(session), {
      onlyIf: { etagMatches: sessionObject.etag },
      httpMetadata: { contentType: 'application/json' }
    })
    if (!persisted) {
      // CAS failure: another request updated the session concurrently.
      // Abort the multipart part we just uploaded to avoid orphaned R2 parts.
      try {
        await multipart.abort()
      } catch (abortErr) {
        console.error('Failed to abort orphaned multipart upload part:', abortErr)
      }
      return tusResponse(jsonString({ error: 'Upload session changed concurrently, retry with latest Upload-Offset' }), 409, {
        'Upload-Offset': String(session.offset - chunk.byteLength),
      }, request, TUS_CHUNK_ALLOW_METHODS, env)
    }

    return tusResponse(null, 204, { 'Upload-Offset': String(session.offset) }, request, TUS_CHUNK_ALLOW_METHODS, env)
  }

  return tusResponse(null, 405, { Allow: 'HEAD,PATCH,OPTIONS' }, request, TUS_CHUNK_ALLOW_METHODS, env)
}

async function readSession(env: UploadChunkEnv, key: string): Promise<UploadSession | null> {
  const obj = await env.VIDEO_BUCKET.get(key)
  if (!obj) return null
  return obj.json() as Promise<UploadSession>
}