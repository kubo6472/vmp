/**
 * Path-keyed Cache API helpers for /api/video-proxy media.
 *
 * Signed `vt` query params change on every video-access mint, so the full request
 * URL cannot be used as a CDN/cache key. After auth succeeds we cache immutable
 * VOD objects by object path only so prefetches and plays share colo storage.
 */

const CACHE_HOST = 'https://vmp-video-proxy-cache.internal';

export function isImmutableVideoProxyObject(objectPath: string): boolean {
  return objectPath.endsWith('.m4s') || /(^|\/)init[^/]*\.mp4$/i.test(objectPath);
}

/** Cache key ignores vt / previewUntil / Range — auth already ran on the live request. */
export function videoProxyObjectCacheKey(normalizedPath: string): Request {
  const path = normalizedPath.replace(/^\/+/, '');
  return new Request(`${CACHE_HOST}/${path}`, { method: 'GET' });
}

export function getVideoProxyCache(): Cache | null {
  const maybeDefault = (caches as unknown as { default?: Cache }).default;
  return maybeDefault ?? null;
}

export function withVideoProxyCacheHeader(
  headers: Headers,
  status: 'HIT' | 'MISS' | 'BYPASS',
): Headers {
  const next = new Headers(headers);
  next.set('X-VMP-Cache', status);
  return next;
}
