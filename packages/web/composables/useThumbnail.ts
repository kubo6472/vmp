/**
 * packages/web/composables/useThumbnail.ts
 *
 * Helpers for picking the right thumbnail size variant.
 *
 * R2 layout:
 *   thumbnails/{videoId}/large.jpg   — 1280×720
 *   thumbnails/{videoId}/medium.jpg  —  640×360
 *   thumbnails/{videoId}/small.jpg   —  320×180
 *
 * D1 stores the large.jpg URL in videos.thumbnail_url.
 * The frontend substitutes the size token to request the appropriate variant.
 */

import type { Ref } from 'vue'

type ThumbnailSize = 'large' | 'medium' | 'small'

// Match size token in the path, allowing an optional query string (e.g. ?t=123)
// so cache-busted URLs like ".../large.jpg?t=123" still get rewritten.
const SIZE_RE = /(\/)(large|medium|small)(\.jpg)(\?.*)?$/

/**
 * Pure helper — swap the size token in a thumbnail URL.
 * Safe to call in v-for loops or outside of setup contexts.
 */
export function sizeUrl(url: string | null | undefined, size: ThumbnailSize): string | null {
  if (!url) return null
  return url.replace(
    SIZE_RE,
    (_match, slash: string, _currentSize: string, ext: string, query: string | undefined) =>
      `${slash}${size}${ext}${query ?? ''}`,
  )
}

/**
 * Composable variant — wraps a reactive thumbnail URL ref.
 * Use in component <script setup> blocks where the URL is a Ref.
 */
export function useThumbnail(thumbnailUrl: Ref<string | null | undefined>) {
  function sizedUrl(size: ThumbnailSize): string | null {
    return sizeUrl(thumbnailUrl.value, size)
  }

  return { sizedUrl }
}
