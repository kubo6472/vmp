export const TUS_VERSION = '1.0.0'
export const TUS_UPLOAD_ALLOW_METHODS = 'POST,OPTIONS'
export const TUS_CHUNK_ALLOW_METHODS = 'HEAD,PATCH,OPTIONS'

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://vmp-web.pages.dev',
]

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map(o => o.trim())
    .filter(Boolean)
}

export interface UploadSessionPart {
  partNumber: number
  etag: string
  size: number
}

export interface UploadSession {
  videoId: string
  sourceKey: string
  uploadId: string
  uploadLength: number
  offset: number
  partNumber: number
  parts: UploadSessionPart[]
  visibility: 'public' | 'unlisted' | 'private'
  fileName: string
  contentType: string
  createdAt: string
}

export function parseUploadMetadata(headerValue: string | null | undefined): Record<string, string> {
  if (!headerValue) return {}
  const result: Record<string, string> = {}
  const entries = headerValue.split(',')

  for (const entry of entries) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const [rawKey, rawValue] = trimmed.split(' ')
    if (!rawKey || !rawValue) continue

    try {
      result[rawKey] = atob(rawValue)
    } catch {
      continue
    }
  }

  return result
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

export function sanitizeVisibility(value: string | undefined): 'public' | 'unlisted' | 'private' {
  return value === 'public' || value === 'unlisted' ? value : 'private'
}

export interface UploadEnv {
  ALLOWED_ORIGINS?: string
}

export function withCors(response: Response, request: Request, allowMethods: string, env?: UploadEnv): Response {
  const headers = new Headers(response.headers)
  const origin = request.headers.get('Origin')
  const allowedOrigins = parseAllowedOrigins(env?.ALLOWED_ORIGINS)
  const allowSet = new Set<string>(allowedOrigins.length ? allowedOrigins : DEFAULT_ALLOWED_ORIGINS)
  const isAllowedOrigin = Boolean(origin && allowSet.has(origin))
  if (isAllowedOrigin && origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Credentials', 'true')
  } else {
    headers.set('Access-Control-Allow-Origin', '*')
    headers.delete('Access-Control-Allow-Credentials')
  }
  if (origin) {
    const varyHeader = headers.get('Vary')
    const varyValues = varyHeader
      ? varyHeader.split(',').map((value) => value.trim()).filter(Boolean)
      : []
    if (!varyValues.includes('Origin')) varyValues.push('Origin')
    headers.set('Vary', varyValues.join(', '))
  }
  headers.set('Access-Control-Allow-Methods', allowMethods)
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Tus-Resumable, Upload-Length, Upload-Offset, Upload-Metadata')
  headers.set('Access-Control-Expose-Headers', 'Tus-Resumable, Upload-Offset, Upload-Length, Location, Upload-Complete, Upload-Result')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export function tusResponse(
  body: BodyInit | null,
  status = 200,
  extraHeaders: Record<string, string> = {},
  request: Request,
  allowMethods: string,
  env?: UploadEnv,
): Response {
  return withCors(new Response(body, {
    status,
    headers: {
      'Tus-Resumable': TUS_VERSION,
      ...extraHeaders,
    },
  }), request, allowMethods, env)
}

export function json(data: unknown, status = 200, request: Request, allowMethods: string, env?: UploadEnv): Response {
  return withCors(new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  }), request, allowMethods, env)
}

export function jsonString(data: unknown): string {
  return JSON.stringify(data)
}