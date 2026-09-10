import { computed, onBeforeUnmount, provide, type Ref } from 'vue';
import { prefetchHlsStartup } from '~/utils/hlsStartupPrefetch';

/** Anonymous video-access warmups per page session (leave headroom under rate_limit_anon). */
export const ANON_STARTUP_PREFETCH_BUDGET = 4;

/** Default media segments to warm per video (init + first N). */
export const DEFAULT_STARTUP_SEGMENT_COUNT = 3;

/**
 * Shared catalog HLS warmup queue.
 *
 * Strategy (opposite of “disable HLS preload”): aggressively warm the cheapest
 * ladder rung for above-the-fold cards + a bit beyond, async/low-priority.
 * Logged-in users are uncapped; anonymous callers share a small session budget
 * so homepage warming does not burn `rate_limit_anon`.
 */
export function useVideoStartupPrefetch(options: {
  apiUrl: string;
  authHeaders: () => Record<string, string>;
  isLoggedIn: Ref<boolean>;
  segmentCount?: number;
  anonBudget?: number;
}) {
  const warmed = new Set<string>();
  const inFlight = new Map<string, AbortController>();
  const anonBudget = options.anonBudget ?? ANON_STARTUP_PREFETCH_BUDGET;
  let anonAttempts = 0;
  let active = 0;
  const queue: string[] = [];

  // Always observe visibility — hover alone is too late for “above the fold”.
  const mode = computed<'visible' | 'hover'>(() => 'visible');

  const maxConcurrent = () => (options.isLoggedIn.value ? 4 : 2);

  const anonBudgetRemaining = () => {
    if (options.isLoggedIn.value) return Number.POSITIVE_INFINITY;
    return Math.max(0, anonBudget - anonAttempts);
  };

  const runNext = () => {
    while (active < maxConcurrent() && queue.length) {
      if (anonBudgetRemaining() <= 0 && !options.isLoggedIn.value) {
        queue.length = 0;
        break;
      }
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
    if (!options.isLoggedIn.value && anonBudgetRemaining() <= 0) return;
    queue.push(videoKey);
    runNext();
  };

  /** Eagerly enqueue an ordered list (homepage/category above-the-fold). */
  const enqueueMany = (videoKeys: string[]) => {
    for (const key of videoKeys) enqueue(key);
  };

  const warmVideo = async (videoKey: string) => {
    if (warmed.has(videoKey)) return;
    if (!options.isLoggedIn.value) {
      if (anonAttempts >= anonBudget) return;
      anonAttempts += 1;
    }
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
        anonAttempts = anonBudget;
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as { video?: { playlistUrl?: string } };
      const playlistUrl = data.video?.playlistUrl;
      if (!playlistUrl) return;
      await prefetchHlsStartup(playlistUrl, {
        segmentCount: options.segmentCount ?? DEFAULT_STARTUP_SEGMENT_COUNT,
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

  return {
    enqueue,
    enqueueMany,
    mode,
    /** Test/inspection helper */
    getAnonAttempts: () => anonAttempts,
    getAnonBudget: () => anonBudget,
  };
}
