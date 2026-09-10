import { computed, onBeforeUnmount, provide, type Ref } from 'vue';
import { prefetchHlsStartup } from '~/utils/hlsStartupPrefetch';

/**
 * Shared catalog HLS warmup queue. Cards call `enqueue` on intersect (logged-in)
 * or hover (anonymous) so we do not burn `rate_limit_anon` on every tile.
 */
export function useVideoStartupPrefetch(options: {
  apiUrl: string;
  authHeaders: () => Record<string, string>;
  isLoggedIn: Ref<boolean>;
  segmentCount?: number;
}) {
  const warmed = new Set<string>();
  const inFlight = new Map<string, AbortController>();
  let maxConcurrent = 2;
  let active = 0;
  const queue: string[] = [];

  const mode = computed<'visible' | 'hover'>(() =>
    options.isLoggedIn.value ? 'visible' : 'hover',
  );

  const runNext = () => {
    maxConcurrent = options.isLoggedIn.value ? 3 : 1;
    while (active < maxConcurrent && queue.length) {
      const key = queue.shift();
      if (!key || warmed.has(key)) continue;
      active += 1;
      void warmVideo(key).finally(() => {
        active -= 1;
        runNext();
      });
    }
  };

  const enqueue = (videoKey: string) => {
    if (!videoKey || warmed.has(videoKey) || inFlight.has(videoKey) || queue.includes(videoKey)) {
      return;
    }
    queue.push(videoKey);
    runNext();
  };

  const warmVideo = async (videoKey: string) => {
    if (warmed.has(videoKey)) return;
    const controller = new AbortController();
    inFlight.set(videoKey, controller);
    try {
      const res = await fetch(
        `${options.apiUrl}/api/video-access/${encodeURIComponent(videoKey)}`,
        {
          headers: { ...options.authHeaders() },
          signal: controller.signal,
          priority: 'low',
        } as RequestInit,
      );
      if (res.status === 429) {
        queue.length = 0;
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as { video?: { playlistUrl?: string } };
      const playlistUrl = data.video?.playlistUrl;
      if (!playlistUrl) return;
      await prefetchHlsStartup(playlistUrl, {
        segmentCount: options.segmentCount ?? 2,
        signal: controller.signal,
        priority: 'low',
      });
      warmed.add(videoKey);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    } finally {
      inFlight.delete(videoKey);
    }
  };

  provide('enqueueVideoStartupPrefetch', enqueue);
  provide('videoStartupPrefetchMode', mode);

  onBeforeUnmount(() => {
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
    queue.length = 0;
  });

  return { enqueue, mode };
}
