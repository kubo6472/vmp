import type { D1Database, ExecutionContext, R2Bucket } from '@cloudflare/workers-types'
import type { RequestContext } from './_types.js'

interface ProcessEnv {
  VIDEO_BUCKET: R2Bucket
  video_subscription_db?: D1Database
  VIDEO_SUBSCRIPTION_DB?: D1Database
  DB?: D1Database
  PROCESS_API_TOKEN?: string
}

type Visibility = 'private' | 'unlisted' | 'public'
interface ExistingMetadata {
  durationSeconds?: unknown
}

export async function onRequest(context: RequestContext<ProcessEnv>) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return withCors(new Response(null, { status: 204 }), request)
  }

  // Gate writes behind a static bearer token configured per deployment.
  const expectedToken = env.PROCESS_API_TOKEN?.trim()
  if (expectedToken) {
    const authHeader = request.headers.get('Authorization') || ''
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!bearer || bearer !== expectedToken) {
      return withCors(json({ error: 'Unauthorized' }, 401), request)
    }
  }

  if (request.method !== 'POST') {
    return withCors(json({ error: 'Method not allowed' }, 405), request)
  }

  if (!env.VIDEO_BUCKET) {
    return withCors(json({ error: 'VIDEO_BUCKET binding is required' }, 500), request)
  }

  try {
    const body = await request.json().catch(() => null);
    if (!body?.videoId) {
      return withCors(json({ error: 'videoId is required' }, 400), request)
    }

    const videoId = body.videoId
    const visibility = sanitizeVisibility(body.visibility)
    const validateDash = Boolean(body.validateDash)

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
      return withCors(json({ error: `Missing required HLS master playlist. Tried: ${hlsMasterCandidates.join(', ')}` }, 404), request)
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
      return withCors(json({ error: `DASH validation requested but manifest not found. Tried: ${dashManifestCandidates.join(', ')}` }, 404), request)
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

    const durationSync = await syncVideoDurationToDb({ db: getVideoDatabaseBinding(env), videoId, durationSeconds })

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
    }), request)
  } catch (error) {
    console.error('Failed to process video metadata registration', error)
    return withCors(json({ error: 'Failed to process video' }, 500), request)
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

function getVideoDatabaseBinding(env: ProcessEnv): D1Database | null {
  return env.video_subscription_db || env.VIDEO_SUBSCRIPTION_DB || env.DB || null
}

const PROCESS_ALLOWED_ORIGINS = new Set<string>([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://vmp-web.pages.dev',
])

function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers)
  const origin = request.headers.get('Origin')
  const isAllowed = Boolean(origin && PROCESS_ALLOWED_ORIGINS.has(origin))
  if (isAllowed && origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Credentials', 'true')
    headers.set('Vary', 'Origin')
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
