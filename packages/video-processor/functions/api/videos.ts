import type { D1Database, R2Bucket, R2Object } from '@cloudflare/workers-types'
import type { RequestContext, WorkerEnv } from './_types.js'

type Visibility = 'public' | 'unlisted' | 'private'
type PackagingMode = 'modern' | 'legacy' | 'invalid'

interface VideosEnv extends WorkerEnv {
  VIDEO_BUCKET?: R2Bucket
  ALLOWED_ORIGINS?: string
  DB?: D1Database
  video_subscription_db?: D1Database
  VIDEO_SUBSCRIPTION_DB?: D1Database
}

type VideosRequestContext = RequestContext<VideosEnv>

interface PackagingState {
  mode: PackagingMode
  isValid: boolean
  hasHlsMaster: boolean
  hasDashManifest: boolean
  hasLegacyPlaylist: boolean
  hasVariantMedia: boolean
}

interface VideoEntry {
  videoId: string
  hasSource: boolean
  hasAnyProcessedArtifact: boolean
  sourceKey: string | null
  visibility: Visibility | null
  updatedAt: string | null
  packaging: PackagingState
}

interface VideoResponseEntry {
  videoId: string
  status: 'processed' | 'uploaded'
  needsProcessing: boolean
  packaging: PackagingState
  visibility: Visibility
  sourceKey: string | null
  updatedAt: string
}

interface MetadataPackagingState {
  hasHlsMaster: boolean
  hasDashManifest: boolean
  hasLegacyPlaylist: boolean
  hasVariantMedia: boolean
}

interface MetadataValue {
  visibility?: unknown
  processedAt?: unknown
}

type CorsHeaders = Record<string, string>

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://vmp-web.pages.dev',
]

const METADATA_HYDRATE_BATCH_SIZE = 50
const D1_DELETE_BIND_LIMIT = 100

export async function onRequestOptions(context: VideosRequestContext): Promise<Response> {
  const corsHeaders = buildCorsHeaders(context.request, context.env)
  return new Response(null, { status: 204, headers: corsHeaders })
}

export async function onRequestGet(context: VideosRequestContext): Promise<Response> {
  const { env, request } = context
  const corsHeaders = buildCorsHeaders(request, env)

  if (!env.VIDEO_BUCKET) {
    return json({ error: 'VIDEO_BUCKET binding is required' }, 500, corsHeaders)
  }

  const objects = await listAllVideoObjects(env.VIDEO_BUCKET)
  const byVideoId = new Map<string, VideoEntry>()

  for (const object of objects) {
    const videoId = getVideoIdFromKey(object.key)
    if (!videoId) continue

    const entry = byVideoId.get(videoId) ?? newVideoEntry(videoId)
    hydrateVideoEntry(entry, object)
    byVideoId.set(videoId, entry)
  }

  await hydrateMetadata(byVideoId, env)

  const nowIso = new Date().toISOString()
  const entries: VideoResponseEntry[] = Array.from(byVideoId.values())
    .filter((entry) => entry.hasSource || entry.hasAnyProcessedArtifact)
    .map((entry) => {
      const needsProcessing = !entry.packaging.isValid
      return {
        videoId: entry.videoId,
        status: entry.packaging.isValid ? 'processed' : 'uploaded',
        needsProcessing,
        packaging: entry.packaging,
        visibility: entry.visibility ?? 'private',
        sourceKey: entry.sourceKey,
        updatedAt: entry.updatedAt ?? nowIso,
      }
    })

  await syncVideosTable(entries, env)

  entries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

  return json({ videos: entries }, 200, corsHeaders)
}

// ─── R2 listing ───────────────────────────────────────────────────────────────

async function listAllVideoObjects(bucket: R2Bucket): Promise<R2Object[]> {
  const objects: R2Object[] = []
  let cursor: string | undefined

  do {
    const listOptions = cursor
      ? { prefix: 'videos/', limit: 1000, cursor }
      : { prefix: 'videos/', limit: 1000 }
    const result = await bucket.list(listOptions)
    objects.push(...result.objects)
    cursor = result.truncated ? result.cursor : undefined
  } while (cursor)

  return objects
}

function newVideoEntry(videoId: string): VideoEntry {
  return {
    videoId,
    hasSource: false,
    hasAnyProcessedArtifact: false,
    sourceKey: null,
    visibility: null,
    updatedAt: null,
    packaging: {
      mode: 'invalid',
      isValid: false,
      hasHlsMaster: false,
      hasDashManifest: false,
      hasLegacyPlaylist: false,
      hasVariantMedia: false,
    },
  }
}

function hydrateVideoEntry(entry: VideoEntry, object: R2Object): void {
  const sourcePrefix = `videos/${entry.videoId}/source/`
  const processedPrefix = `videos/${entry.videoId}/processed/`

  if (object.key.startsWith(sourcePrefix)) {
    entry.hasSource = true
    if (!entry.sourceKey || object.key < entry.sourceKey) {
      entry.sourceKey = object.key
    }
  }

  if (object.key.startsWith(processedPrefix)) {
    entry.hasAnyProcessedArtifact = true
    if (object.key.endsWith('/hls/master.m3u8')) entry.packaging.hasHlsMaster = true
    if (object.key.endsWith('/dash/manifest.mpd')) entry.packaging.hasDashManifest = true
    if (object.key.endsWith('/playlist.m3u8')) entry.packaging.hasLegacyPlaylist = true
    if (/\.m4s$|\.mp4$/i.test(object.key) && /\/processed\//.test(object.key)) {
      entry.packaging.hasVariantMedia = true
    }
  }

  // Flat layout — shell script rclones TMP_DIR directly into videos/{id}/.
  if (object.key === `videos/${entry.videoId}/master.m3u8`) {
    entry.hasAnyProcessedArtifact = true
    entry.packaging.hasHlsMaster = true
  }
  const isNotSource = !object.key.startsWith(`videos/${entry.videoId}/source/`)
  if (isNotSource && (/\.m4s$/i.test(object.key) || /\/init_[^/]+\.mp4$/i.test(object.key))) {
    entry.hasAnyProcessedArtifact = true
    entry.packaging.hasVariantMedia = true
  }

  entry.updatedAt = maxDate(entry.updatedAt, asIsoDate(object.uploaded))
}

function getVideoIdFromKey(key: string): string | null {
  const match = key.match(/^videos\/([^/]+)\//)
  return match?.[1] ?? null
}

function asIsoDate(input: unknown): string | null {
  if (input instanceof Date) return input.toISOString()
  if (typeof input === 'string' && Number.isFinite(Date.parse(input))) return input
  return null
}

function maxDate(previousDate: string | null, nextDate: string | null): string | null {
  if (!previousDate) return nextDate
  if (!nextDate) return previousDate
  return new Date(nextDate).getTime() > new Date(previousDate).getTime() ? nextDate : previousDate
}

// ─── Metadata hydration ───────────────────────────────────────────────────────

async function hydrateMetadata(byVideoId: Map<string, VideoEntry>, env: VideosEnv): Promise<void> {
  if (!env.VIDEO_BUCKET) return
  const entries = Array.from(byVideoId.values())

  for (let i = 0; i < entries.length; i += METADATA_HYDRATE_BATCH_SIZE) {
    const batch = entries.slice(i, i + METADATA_HYDRATE_BATCH_SIZE)
    await Promise.all(batch.map(async (entry) => {
      const metadataKey = `videos/${entry.videoId}/metadata.json`
      try {
        const metadataObject = await env.VIDEO_BUCKET!.get(metadataKey)
        if (!metadataObject) {
          finalizePackaging(entry)
          return
        }

        const metadata = await metadataObject.json<MetadataValue>().catch(() => null)
        if (!metadata || typeof metadata !== 'object') {
          finalizePackaging(entry)
          return
        }

        if (isVisibility(metadata.visibility)) {
          entry.visibility = metadata.visibility
        }

        const processedAt = asIsoDate(metadata.processedAt)
        if (processedAt) {
          entry.updatedAt = maxDate(entry.updatedAt, processedAt)
        }

        const metadataPackaging = getPackagingStateFromMetadata(metadata, entry.videoId)
        entry.packaging.hasHlsMaster ||= metadataPackaging.hasHlsMaster
        entry.packaging.hasDashManifest ||= metadataPackaging.hasDashManifest
        entry.packaging.hasLegacyPlaylist ||= metadataPackaging.hasLegacyPlaylist
        entry.packaging.hasVariantMedia ||= metadataPackaging.hasVariantMedia
      } catch (error) {
        console.warn('Failed to hydrate metadata for video', entry.videoId, error)
      } finally {
        finalizePackaging(entry)
      }
    }))
  }
}

function finalizePackaging(entry: VideoEntry): void {
  const hasModernPackaging = entry.packaging.hasHlsMaster && entry.packaging.hasVariantMedia
  const isValid = hasModernPackaging || entry.packaging.hasLegacyPlaylist

  entry.packaging.mode = hasModernPackaging
    ? 'modern'
    : entry.packaging.hasLegacyPlaylist
      ? 'legacy'
      : 'invalid'
  entry.packaging.isValid = isValid
}

function getPackagingStateFromMetadata(metadata: unknown, videoId: string): MetadataPackagingState {
  const processedPrefix = `videos/${videoId}/processed/`
  const hlsMasterKey = `${processedPrefix}hls/master.m3u8`
  const dashManifestKey = `${processedPrefix}dash/manifest.mpd`
  const legacyPlaylistKey = `${processedPrefix}playlist.m3u8`
  const variantMediaPattern = new RegExp(`^videos/${escapeRegExp(videoId)}/processed/[^/]+/.+(?:\\.m4s|\\.mp4)$`)

  const allStringValues = Array.from(collectStringValues(metadata))
  const allProcessedKeys = allStringValues.filter((v) => v.startsWith(processedPrefix))
  const keys = new Set(allProcessedKeys)

  // Also accept flat-layout master/manifest keys written by process.ts.
  const flatHlsMasterKey = `videos/${videoId}/master.m3u8`
  const flatDashManifestKey = `videos/${videoId}/manifest.mpd`

  return {
    hasHlsMaster: keys.has(hlsMasterKey) || allStringValues.includes(flatHlsMasterKey),
    hasDashManifest: keys.has(dashManifestKey) || allStringValues.includes(flatDashManifestKey),
    hasLegacyPlaylist: keys.has(legacyPlaylistKey),
    hasVariantMedia: allProcessedKeys.some((key) => variantMediaPattern.test(key)),
  }
}

// ─── D1 sync ──────────────────────────────────────────────────────────────────

async function syncVideosTable(entries: VideoResponseEntry[], env: VideosEnv): Promise<void> {
  const db = getVideoDatabaseBinding(env)
  if (!db) return

  try {
    const columnSet = await getVideosTableColumnSet(db)
    if (!columnSet.size) return

    for (const entry of entries) {
      await upsertVideoRow(db, entry, columnSet)
    }

    if (columnSet.has('managed_by_r2')) {
      if (!entries.length) {
        await db.prepare('DELETE FROM videos WHERE managed_by_r2 = 1').run()
      } else {
        const currentManagedIds = new Set(entries.map((entry) => entry.videoId))
        const existingManaged = await db.prepare('SELECT id FROM videos WHERE managed_by_r2 = 1').all<{ id?: unknown }>()
        const staleIds = (existingManaged.results ?? [])
          .map((row) => row.id)
          .filter((id): id is string => typeof id === 'string')
          .filter((id) => !currentManagedIds.has(id))

        for (const staleBatch of chunkArray(staleIds, D1_DELETE_BIND_LIMIT)) {
          const placeholders = staleBatch.map(() => '?').join(',')
          await db.prepare(`DELETE FROM videos WHERE managed_by_r2 = 1 AND id IN (${placeholders})`)
            .bind(...staleBatch)
            .run()
        }
      }
    }
  } catch (error) {
    console.error('Video D1 sync skipped due to error', error)
  }
}

async function getVideosTableColumnSet(db: D1Database): Promise<Set<string>> {
  const result = await db.prepare('PRAGMA table_info(videos)').all<{ name?: unknown }>()
  const rows = Array.isArray(result.results) ? result.results : []
  const names = rows
    .map((row) => (typeof row.name === 'string' ? row.name : null))
    .filter((name): name is string => Boolean(name))
  return new Set(names)
}

async function upsertVideoRow(db: D1Database, entry: VideoResponseEntry, columnSet: Set<string>): Promise<void> {
  const sourceName = entry.sourceKey?.split('/').pop() || entry.videoId
  const inferredTitle = sourceName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || `Uploaded video ${entry.videoId}`
  const status = entry.needsProcessing ? 'uploaded' : 'processed'
  const now = entry.updatedAt || new Date().toISOString()

  const insertColumns = ['id', 'title', 'description', 'thumbnail_url', 'full_duration', 'preview_duration', 'upload_date', 'created_at']
  const insertValues = ['?', '?', "''", 'NULL', '0', '0', '?', "COALESCE((SELECT created_at FROM videos WHERE id = ?), ?)"]
  const bindValues: Array<string | number | null> = [entry.videoId, inferredTitle, now, entry.videoId, now]

  if (columnSet.has('source_key')) {
    insertColumns.push('source_key')
    insertValues.push('?')
    bindValues.push(entry.sourceKey)
  }
  if (columnSet.has('visibility')) {
    insertColumns.push('visibility')
    insertValues.push('?')
    bindValues.push(entry.visibility ?? 'private')
  }
  if (columnSet.has('status')) {
    insertColumns.push('status')
    insertValues.push('?')
    bindValues.push(status)
  }
  if (columnSet.has('updated_at')) {
    insertColumns.push('updated_at')
    insertValues.push('?')
    bindValues.push(now)
  }
  if (columnSet.has('processed_at')) {
    insertColumns.push('processed_at')
    insertValues.push(status === 'processed' ? '?' : 'NULL')
    if (status === 'processed') bindValues.push(now)
  }
  if (columnSet.has('managed_by_r2')) {
    insertColumns.push('managed_by_r2')
    insertValues.push('1')
  }

  const updates = [
    "title = CASE WHEN videos.title IS NULL OR videos.title = '' THEN excluded.title ELSE videos.title END",
    'upload_date = excluded.upload_date',
  ]

  if (columnSet.has('source_key')) updates.push('source_key = excluded.source_key')
  if (columnSet.has('visibility')) updates.push('visibility = COALESCE(videos.visibility, excluded.visibility)')
  if (columnSet.has('status')) updates.push('status = excluded.status')
  if (columnSet.has('updated_at')) updates.push('updated_at = excluded.updated_at')
  if (columnSet.has('processed_at')) {
    updates.push("processed_at = CASE WHEN excluded.status = 'processed' THEN COALESCE(videos.processed_at, excluded.processed_at) ELSE NULL END")
  }
  if (columnSet.has('managed_by_r2')) updates.push('managed_by_r2 = 1')

  const sql = `
    INSERT INTO videos (${insertColumns.join(', ')})
    VALUES (${insertValues.join(', ')})
    ON CONFLICT(id) DO UPDATE SET ${updates.join(',\n      ')}
  `

  await db.prepare(sql).bind(...bindValues).run()
}

function getVideoDatabaseBinding(env: VideosEnv): D1Database | null {
  return env.video_subscription_db || env.VIDEO_SUBSCRIPTION_DB || env.DB || null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildCorsHeaders(request: Request, env: VideosEnv): CorsHeaders {
  const origin = request.headers.get('Origin')
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS)
  const allowSet = new Set<string>(allowedOrigins.length ? allowedOrigins : DEFAULT_ALLOWED_ORIGINS)

  if (origin && allowSet.has(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      Vary: 'Origin',
    }
  }

  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function isVisibility(value: unknown): value is Visibility {
  return value === 'public' || value === 'unlisted' || value === 'private'
}

function* collectStringValues(value: unknown): Generator<string, void, unknown> {
  if (typeof value === 'string') {
    yield value
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* collectStringValues(item)
    return
  }
  if (value && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) yield* collectStringValues(nestedValue)
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize))
  }
  return chunks
}

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  })
}
