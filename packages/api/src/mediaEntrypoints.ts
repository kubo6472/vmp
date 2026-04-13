/**
 * packages/api/src/mediaEntrypoints.js
 *
 * Shared helpers to resolve which HLS entrypoint exists in R2 and to build
 * proxy URLs that point at /api/video-proxy.
 */

export function buildEntrypointCandidates(base: any, videoId: any) {
  return [
    `${base}/videos/${videoId}/master.m3u8`,
    `${base}/videos/${videoId}/processed/hls/master.m3u8`,
    `${base}/videos/${videoId}/processed/playlist.m3u8`,
  ]
}

export async function resolveMediaEntrypointUrl({
  env,
  videoId
}: any) {
  const base = env.R2_BASE_URL
  const candidates = buildEntrypointCandidates(base, videoId)
  for (const c of candidates) {
    if (await canLoadEntrypoint(c)) return c
  }
  return candidates[0]
}

export function buildProxyPlaylistUrl(request: any, playlistUrl: any, previewUntilSeconds: any) {
  const origin = new URL(request.url).origin
  const upstream = new URL(playlistUrl)
  const u = new URL(`${origin}/api/video-proxy${upstream.pathname}`)
  if (previewUntilSeconds && previewUntilSeconds > 0) u.searchParams.set('previewUntil', String(Math.floor(previewUntilSeconds)))
  return u.toString()
}

async function canLoadEntrypoint(url: any) {
  try { return (await fetch(url, { method: 'HEAD' })).ok } catch { return false }
}

