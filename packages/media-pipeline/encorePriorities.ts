/**
 * Encore job priorities for Redis priority queues.
 *
 * With `encore-settings.concurrency: 2` (Compose default):
 *   priority 50–100 → queue 0 (high)
 *   priority 0–49   → queue 1 (low)
 *
 * Fast-lane 720p must land in queue 0 so full-ladder work cannot starve preview.
 * Docs: https://svt.github.io/encore/deployment/#priority-to-queue-mapping
 */
export const ENCORE_JOB_PRIORITY = {
  /** Fast-lane 720p preview encode — high queue. */
  FAST_LANE_720P: 80,
  /** Full ABR ladder (phase 2 or full_ladder-only inbox). */
  FULL_LADDER: 30,
  /** Podcast MP3 sidecar. */
  PODCAST: 20,
  /** Short podcast preview MP3. */
  PREVIEW_MP3: 25,
  /** Legacy per-rendition 720p path. */
  RENDITION_720P: 80,
  /** Legacy per-rendition non-720p path. */
  RENDITION_OTHER: 30,
} as const;

/** Queue index for a job priority when concurrency === 2. */
export function encoreQueueForPriority(
  priority: number,
  concurrency = 2,
): number {
  if (concurrency !== 2) {
    throw new Error(
      `encoreQueueForPriority only models concurrency=2 (got ${concurrency})`,
    );
  }
  return priority >= 50 ? 0 : 1;
}
