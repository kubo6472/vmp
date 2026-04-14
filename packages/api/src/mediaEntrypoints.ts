/**
 * packages/api/src/mediaEntrypoints.js
 *
 * Shared helpers to resolve which HLS entrypoint exists in R2 and to build
 * proxy URLs that point at /api/video-proxy.
 */

export function buildEntrypointCandidates(base: any, videoId: any, options: any = {}) {
  const preferPodcast = options?.preferPodcast === true
  const candidates = []
  if (preferPodcast) {
    candidates.push(
      `${base}/videos/${videoId}/podcast.mp3`,
      `${base}/videos/${videoId}/processed/podcast.mp3`,
      `${base}/videos/${videoId}/processed/audio/podcast.mp3`,
    )
  }
  candidates.push(
    `${base}/videos/${videoId}/master.m3u8`,
    `${base}/videos/${videoId}/processed/hls/master.m3u8`,
    `${base}/videos/${videoId}/processed/playlist.m3u8`,
  )
  return candidates
}

export async function resolveMediaEntrypointUrl({
  env,
  videoId,
  preferPodcast = false,
}: any) {
  const base = env.R2_BASE_URL
  const candidates = buildEntrypointCandidates(base, videoId, { preferPodcast })
  for (const c of candidates) {
    if (await canLoadEntrypoint(c)) return c
  }
  return candidates[0]
}

export function buildProxyPlaylistUrl(request: any, playlistUrl: any, previewUntilSeconds: any) {
  const origin = new URL(request.url).origin
  const upstream = new URL(playlistUrl)
  const u = new URL(`${origin}/api/video-proxy${upstream.pathname}`)
  if (typeof previewUntilSeconds === 'number' && previewUntilSeconds >= 0) {
    u.searchParams.set('previewUntil', String(Math.floor(previewUntilSeconds)))
  }
  return u.toString()
}

async function canLoadEntrypoint(url: any) {
  try { return (await fetch(url, { method: 'HEAD' })).ok } catch { return false }
}

