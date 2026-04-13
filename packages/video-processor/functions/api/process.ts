import type { D1Database, ExecutionContext, R2Bucket } from '@cloudflare/workers-types'
import type { RequestContext } from './_types.js'

interface ProcessEnv {
  VIDEO_BUCKET: R2Bucket
  video_subscription_db?: D1Database
  VIDEO_SUBSCRIPTION_DB?: D1Database
  DB?: D1Database
  PROCESS_API_TOKEN?: string
  ALLOWED_ORIGINS?: string
  // Explicit local-only escape hatch for dev environments without PROCESS_API_TOKEN.
  LOCAL_DEV_ALLOW_UNAUTH_PROCESS_API?: string | boolean
}

type Visibility = 'private' | 'unlisted' | 'public'
interface ExistingMetadata {
  durationSeconds?: unknown
}
const VIDEO_ID_RE = /^[A-Za-z0-9_-]+$/

export async function onRequest(context: RequestContext<ProcessEnv>) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return withCors(new Response(null, { status: 204 }), request, env)
  }

  // Gate writes behind a static bearer token configured per deployment.
  const expectedToken = env.PROCESS_API_TOKEN?.trim()
  const allowUnauthenticatedLocalDev = envFlagEnabled(env.LOCAL_DEV_ALLOW_UNAUTH_PROCESS_API)
  if (!expectedToken && !allowUnauthenticatedLocalDev) {
    return withCors(json({ error: 'Unauthorized' }, 401), request, env)
  }
  if (expectedToken) {
    const authHeader = request.headers.get('Authorization') || ''
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!bearer) {
      return withCors(json({ error: 'Unauthorized' }, 401), request, env)
    }

    // Constant-time comparison to prevent timing attacks
    const encoder = new TextEncoder()
    const expectedBytes = encoder.encode(expectedToken)
    const bearerBytes = encoder.encode(bearer)

    if (expectedBytes.length !== bearerBytes.length) {
      return withCors(json({ error: 'Unauthorized' }, 401), request, env)
    }

    let mismatch = 0
    for (let i = 0; i < expectedBytes.length; i++) {
      mismatch |= expectedBytes[i]! ^ bearerBytes[i]!
    }

    if (mismatch !== 0) {
      return withCors(json({ error: 'Unauthorized' }, 401), request, env)
    }
  }

  if (request.method !== 'POST') {
    return withCors(json({ error: 'Method not allowed' }, 405), request, env)
  }

  if (!env.VIDEO_BUCKET) {
    return withCors(json({ error: 'VIDEO_BUCKET binding is required' }, 500), request, env)
  }

  try {
    const bodyRaw = await request.json().catch(() => null)
    if (!bodyRaw || typeof bodyRaw !== 'object' || Array.isArray(bodyRaw)) {
      return withCors(json({ error: 'Invalid JSON body' }, 400), request, env)
    }
    const body = bodyRaw as Record<string, unknown>

    const videoId = typeof body.videoId === 'string' ? body.videoId.trim() : ''
    if (!videoId || !VIDEO_ID_RE.test(videoId)) {
      return withCors(json({ error: 'videoId must be a non-empty alphanumeric identifier' }, 400), request, env)
    }

    if (body.visibility !== undefined && typeof body.visibility !== 'string') {
      return withCors(json({ error: 'visibility must be a string when provided' }, 400), request, env)
    }

    const visibility = sanitizeVisibility(body.visibility)
    let validateDash = false
    if (body.validateDash !== undefined) {
      const rawValidateDash = body.validateDash
      if (typeof rawValidateDash === 'boolean') {
        validateDash = rawValidateDash
      } else if (rawValidateDash === 'true') {
        validateDash = true
      } else if (rawValidateDash === 'false') {
        validateDash = false
      } else {
        return withCors(json({ error: 'validateDash must be a boolean or "true"/"false"' }, 400), request, env)
      }
    }

    const metadataKey = `videos/${videoId}/metadata.json`;
    const processedAt = new Date().toISOString();

    const existingMetadataObject = await env.VIDEO_BUCKET.get(metadataKey);
    const existingMetadata = existingMetadataObject
      ? await existingMetadataObject.json<ExistingMetadata>().catch(() => null)
      : null;
    let durationSeconds = toNumberOrNull(existingMetadata?.durationSeconds);

    // Try flat layout (shell-script output) first, then the processed/hls/ path
    const hlsMasterCandidates = [
      `videos/${videoId}/master.m3u8`,
      `videos/${videoId}/processed/hls/master.m3u8`,
    ];
    let hlsMasterKey = null;
    let hlsMaster = null;
    for (const candidate of hlsMasterCandidates) {
      const obj = await env.VIDEO_BUCKET.get(candidate);
      if (obj) { hlsMasterKey = candidate; hlsMaster = obj; break; }
    }
    if (!hlsMaster) {
      return withCors(json({ error: `Missing required HLS master playlist. Tried: ${hlsMasterCandidates.join(', ')}` }, 404), request, env)
    }

    const hlsMasterContent = await hlsMaster.text();
    const { variants, audioGroups } = parseHlsMasterPlaylist(hlsMasterContent);

    // Derive duration by summing #EXTINF from the first variant media playlist
    // when metadata.json has no durationSeconds (e.g. shell-script uploads)
    if (durationSeconds === null && variants.length > 0) {
      const firstUri = variants[0]?.uri;
      if (firstUri) {
        const masterDir = hlsMasterKey!.slice(0, hlsMasterKey!.lastIndexOf('/') + 1);
        const variantKey = firstUri.startsWith('videos/') ? firstUri : `${masterDir}${firstUri}`;
        const variantObj = await env.VIDEO_BUCKET.get(variantKey);
        if (variantObj) {
          const text = await variantObj.text();
          const total = text.split('\n')
            .filter((l: string) => l.trim().startsWith('#EXTINF:'))
            .reduce((s: number, l: string) => {
              const n = Number.parseFloat(l.trim().slice('#EXTINF:'.length))
              return Number.isFinite(n) ? s + n : s
            }, 0)
          if (total > 0) durationSeconds = total;
        }
      }
    }

    // Try flat layout for DASH manifest, then processed/dash/
    const dashManifestCandidates = [
      `videos/${videoId}/manifest.mpd`,
      `videos/${videoId}/processed/dash/manifest.mpd`,
    ];
    let dashManifestKey = null;
    for (const c of dashManifestCandidates) {
      const obj = await env.VIDEO_BUCKET.get(c);
      if (obj) { dashManifestKey = c; break; }
    }
    const dashManifest = dashManifestKey ? true : null;
    if (validateDash && !dashManifest) {
      return withCors(json({ error: `DASH validation requested but manifest not found. Tried: ${dashManifestCandidates.join(', ')}` }, 404), request, env)
    }

    const resolvedDashManifestKey = dashManifestKey ?? null;

    const metadata: {
      videoId: string
      packaging: 'cmaf'
      hlsMasterKey: string | null
      dashManifestKey: string | null
      variants: Variant[]
      processedAt: string
      visibility: 'private' | 'unlisted' | 'public'
      status: 'processed'
      durationSeconds?: number
      audioGroups?: AudioGroup[]
    } = {
      videoId,
      packaging: 'cmaf',
      hlsMasterKey,
      dashManifestKey: resolvedDashManifestKey,
      variants,
      processedAt,
      visibility,
      status: 'processed'
    }

    if (durationSeconds !== null) metadata.durationSeconds = durationSeconds
    if (audioGroups.length > 0) metadata.audioGroups = audioGroups

    await env.VIDEO_BUCKET.put(metadataKey, JSON.stringify(metadata, null, 2), {
      httpMetadata: { contentType: 'application/json' }
    })

    let durationSync: {
      success: boolean
      updated: boolean
      changes?: number
      durationSeconds?: number
      reason?: string
      error?: string
    }
    try {
      const syncResult = await syncVideoDurationToDb({ db: getVideoDatabaseBinding(env), videoId, durationSeconds })
      durationSync = { success: true, ...syncResult }
    } catch (syncError: unknown) {
      console.error('Failed to sync video duration to DB', syncError)
      durationSync = {
        success: false,
        updated: false,
        error: 'VIDEO_DURATION_SYNC_ERROR',
      }
    }

    return withCors(json({
      ok: true,
      videoId,
      packaging: metadata.packaging,
      hlsMasterKey,
      dashManifestKey: resolvedDashManifestKey,
      variants,
      audioGroups: audioGroups.length > 0 ? audioGroups : undefined,
      metadataKey,
      processedAt,
      visibility,
      status: metadata.status,
      durationSeconds,
      durationSync
    }), request, env)
  } catch (error) {
    console.error('Failed to process video metadata registration', error)
    return withCors(json({ error: 'Failed to process video' }, 500), request, env)
  }
}

async function syncVideoDurationToDb({
  db,
  videoId,
  durationSeconds
}: {
  db: D1Database | null
  videoId: string
  durationSeconds: number | null
}) {
  if (!db) return { updated: false, reason: 'missing-d1-binding' }
  if (durationSeconds === null) return { updated: false, reason: 'missing-duration-seconds' }

  const normalizedDuration = Math.round(durationSeconds)
  const result = await db.prepare('UPDATE videos SET full_duration = ? WHERE id = ?').bind(normalizedDuration, videoId).run()

  return {
    updated: Number(result.meta?.changes || 0) > 0,
    changes: Number(result.meta?.changes || 0),
    durationSeconds: normalizedDuration
  }
}

interface AudioGroup {
  type: string | null
  groupId: string | null
  name: string | null
  language: string | null
  default: boolean
  autoselect: boolean
  channels: string | null
  uri: string | null
}

interface Variant {
  uri: string | null
  bandwidth: number | null
  averageBandwidth: number | null
  codecs: string | null
  resolution: string | null
  frameRate: number | null
  audioGroupId: string | null
  subtitlesGroupId: string | null
  closedCaptions: string | null
}

function parseHlsMasterPlaylist(content: string): { variants: Variant[]; audioGroups: AudioGroup[] } {
  const lines = content.split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean)
  const variants: Variant[] = []
  const audioGroups: AudioGroup[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line) continue

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attributes = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length))
      if (attributes.TYPE === 'AUDIO') {
        audioGroups.push({
          type: attributes.TYPE,
          groupId: attributes['GROUP-ID'] ?? null,
          name: attributes.NAME ?? null,
          language: attributes.LANGUAGE ?? null,
          default: attributes.DEFAULT === 'YES',
          autoselect: attributes.AUTOSELECT === 'YES',
          channels: attributes.CHANNELS ?? null,
          uri: attributes.URI ?? null
        })
      }
      continue
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attributes = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length))
      const nextLine = lines[i + 1]
      const uri = nextLine && !nextLine.startsWith('#') ? nextLine : null

      variants.push({
        uri,
        bandwidth: toNumberOrNull(attributes.BANDWIDTH),
        averageBandwidth: toNumberOrNull(attributes['AVERAGE-BANDWIDTH']),
        codecs: attributes.CODECS ?? null,
        resolution: attributes.RESOLUTION ?? null,
        frameRate: toNumberOrNull(attributes['FRAME-RATE']),
        audioGroupId: attributes.AUDIO ?? null,
        subtitlesGroupId: attributes.SUBTITLES ?? null,
        closedCaptions: attributes['CLOSED-CAPTIONS'] ?? null
      })
    }
  }

  return { variants, audioGroups }
}

function parseAttributeList(rawAttributes: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const regex = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/g
  for (const match of rawAttributes.matchAll(regex)) {
    const key = match[1]
    const rawValue = match[2]
    if (!key || rawValue === undefined) continue
    attributes[key] = stripQuotes(rawValue)
  }
  return attributes
}

function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  return value
}

function toNumberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function sanitizeVisibility(value: unknown): Visibility {
  return value === 'public' || value === 'unlisted' ? value : 'private'
}

function envFlagEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

function getVideoDatabaseBinding(env: ProcessEnv): D1Database | null {
  return env.video_subscription_db || env.VIDEO_SUBSCRIPTION_DB || env.DB || null
}

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

function withCors(response: Response, request: Request, env: ProcessEnv): Response {
  const headers = new Headers(response.headers)
  const origin = request.headers.get('Origin')
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS)
  const allowSet = new Set<string>(allowedOrigins.length ? allowedOrigins : DEFAULT_ALLOWED_ORIGINS)
  const isAllowed = Boolean(origin && allowSet.has(origin))
  headers.set('Vary', 'Origin')
  if (isAllowed && origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Credentials', 'true')
  } else {
    headers.set('Access-Control-Allow-Origin', '*')
    headers.delete('Access-Control-Allow-Credentials')
  }
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}