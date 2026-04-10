import { ref, watch, onUnmounted, type Ref } from 'vue'

/**
 * Polls Brevo campaign list while the Newsletter admin tab is active.
 * Uses brevoNewsletterPollIntervalMs from settings (default 10 min); shorter in dev via import.meta.dev.
 * Backs off on errors (caps interval growth).
 */
export function useAdminNewsletterPolling(options: {
  pollIntervalMs: Ref<number>
  isActive: Ref<boolean>
  isAdmin: Ref<boolean>
  loadCampaigns: () => Promise<void>
}) {
  const { pollIntervalMs, isActive, isAdmin, loadCampaigns } = options

  const lastCampaignsOkAt = ref<string | null>(null)
  const lastCampaignsError = ref<string | null>(null)
  const pollAttempt = ref(0)

  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false

  const baseMs = () => {
    const raw = pollIntervalMs.value
    const n = Number.isFinite(raw) && raw >= 60_000 ? raw : 600_000
    if (import.meta.dev) return Math.min(n, 120_000)
    return n
  }

  const schedule = (delay: number) => {
    if (timer != null) clearTimeout(timer)
    timer = setTimeout(() => {
      void tick()
    }, delay)
  }

  const tick = async () => {
    if (cancelled || !isActive.value || !isAdmin.value) return
    try {
      await loadCampaigns()
      lastCampaignsError.value = null
      lastCampaignsOkAt.value = new Date().toISOString()
      pollAttempt.value = 0
      schedule(baseMs())
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      lastCampaignsError.value = msg
      pollAttempt.value += 1
      const backoff = Math.min(300_000, baseMs() * 2 ** Math.min(pollAttempt.value, 4))
      schedule(backoff)
    }
  }

  const start = () => {
    cancelled = false
    void tick()
  }

  const stop = () => {
    cancelled = true
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
  }

  watch(
    [isActive, isAdmin, pollIntervalMs],
    () => {
      stop()
      if (isActive.value && isAdmin.value) start()
    },
    { immediate: true },
  )

  onUnmounted(() => {
    stop()
  })

  return {
    lastCampaignsOkAt,
    lastCampaignsError,
  }
}
