const LIVESTREAM_STATUSES = new Set([
  // New lifecycle states used by Cloudflare provisioning flow.
  'draft',
  'provisioning',
  'ready',
  'live',
  'ended',
  'failed',
  // Legacy statuses retained for backward compatibility with older rows.
  'scheduled',
  'vod_attached',
  'replaced_with_vod',
])

export function normalizeLivestreamStatus(value: unknown, fallback = 'draft') {
  if (typeof value !== 'string') return fallback
  const status = value.trim().toLowerCase()
  return LIVESTREAM_STATUSES.has(status) ? status : fallback
}

interface CloudflareStreamResponse {
  success?: boolean
  errors?: Array<{ message?: string }>
  result?: unknown
  data?: unknown
}

interface ProvisionedLivestream {
  uid: string
  rtmpUrl: string
  streamKey: string
  playbackHls: string
  raw: CloudflareStreamResponse
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

function maybePick(value: unknown, ...paths: string[]): string | null {
  for (const path of paths) {
    const parts = path.split('.')
    let node: any = value
    for (const part of parts) {
      if (!node || typeof node !== 'object') {
        node = null
        break
      }
      node = node[part]
    }
    const picked = asNonEmptyString(node)
    if (picked) return picked
  }
  return null
}

function buildStreamApiBase(env: any): string {
  if (asNonEmptyString(env.CF_REALTIME_BASE_URL)) {
    return String(env.CF_REALTIME_BASE_URL).replace(/\/+$/, '')
  }
  const accountId = asNonEmptyString(env.CF_ACCOUNT_ID)
  if (!accountId) throw new Error('Cloudflare livestream provisioning is not configured: CF_ACCOUNT_ID is missing')
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream`
}

function buildPlaybackUrl(env: any, uid: string, root: unknown): string | null {
  const fromResponse = maybePick(root, 'playback.hls', 'playback.hlsUrl', 'playback.url')
  if (fromResponse) return fromResponse

  const customerCode = asNonEmptyString(env.CF_STREAM_CUSTOMER_CODE)
  if (customerCode) {
    return `https://customer-${customerCode}.cloudflarestream.com/${uid}/manifest/video.m3u8`
  }
  return null
}

export async function createCloudflareLivestream(env: any, payload: { metaName: string, recordingMode?: string | null }): Promise<ProvisionedLivestream> {
  const apiToken = asNonEmptyString(env.CF_API_TOKEN)
  if (!apiToken) throw new Error('Cloudflare livestream provisioning is not configured: CF_API_TOKEN is missing')

  const endpoint = `${buildStreamApiBase(env)}/live_inputs`
  const requestBody = {
    meta: { name: payload.metaName },
    recording: { mode: payload.recordingMode ?? 'automatic' },
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify(requestBody),
  })

  let raw: CloudflareStreamResponse = {}
  try {
    raw = await response.json()
  } catch {
    raw = {}
  }

  const root = raw.result ?? raw.data ?? raw
  const uid = maybePick(root, 'uid', 'id')
  const rtmpUrl = maybePick(root, 'rtmps.url', 'rtmp.url', 'ingest.rtmp.url')
  const streamKey = maybePick(root, 'rtmps.streamKey', 'rtmps.stream_key', 'rtmp.streamKey', 'rtmp.stream_key', 'ingest.rtmp.streamKey')
  const playbackHls = uid ? buildPlaybackUrl(env, uid, root) : null

  if (!response.ok) {
    const cfError = raw?.errors?.[0]?.message ?? `HTTP ${response.status}`
    throw new Error(`Cloudflare livestream provisioning failed: ${cfError}`)
  }
  if (!uid || !rtmpUrl || !streamKey || !playbackHls) {
    throw new Error('Cloudflare livestream provisioning failed: malformed response (missing uid/ingest/playback fields)')
  }

  return { uid, rtmpUrl, streamKey, playbackHls, raw }
}

export function sanitizeCloudflareLivestreamResponse(raw: unknown) {
  if (!raw || typeof raw !== 'object') return raw
  const copy = JSON.parse(JSON.stringify(raw))
  const redactPaths = [
    ['result', 'rtmps', 'streamKey'],
    ['result', 'rtmps', 'stream_key'],
    ['result', 'rtmp', 'streamKey'],
    ['result', 'rtmp', 'stream_key'],
    ['result', 'streamKey'],
    ['data', 'rtmps', 'streamKey'],
    ['data', 'rtmps', 'stream_key'],
    ['data', 'rtmp', 'streamKey'],
    ['data', 'rtmp', 'stream_key'],
    ['data', 'streamKey'],
    ['ingest', 'rtmp', 'streamKey'],
    ['ingest', 'rtmp', 'stream_key'],
    ['ingest', 'rtmps', 'streamKey'],
    ['ingest', 'rtmps', 'stream_key'],
    ['streamKey'],
    ['stream_key'],
  ]
  for (const path of redactPaths) {
    let node: any = copy
    for (let i = 0; i < path.length - 1; i += 1) {
      const key = path[i]
      if (!key) {
        node = null
        break
      }
      if (!node || typeof node !== 'object' || !(key in node)) {
        node = null
        break
      }
      node = node[key]
    }
    const leaf = path[path.length - 1]
    if (node && typeof node === 'object' && leaf) {
      if (leaf in node && node[leaf] != null) node[leaf] = '[REDACTED]'
    }
  }
  return copy
}