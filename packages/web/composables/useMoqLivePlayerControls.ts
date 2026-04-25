import { ref, shallowRef, type ShallowRef } from 'vue'
import type { Broadcast, MultiBackend } from '@moq/watch'

type Dispose = () => void

/**
 * UI state + actions for @moq/watch MultiBackend live playback (canvas + WebAudio).
 */
export function useMoqLivePlayerControls() {
  const shellRef = ref<HTMLElement | null>(null)
  const backend = shallowRef<MultiBackend | null>(null)
  const broadcast = shallowRef<Broadcast | null>(null)

  const isPaused = ref(false)
  const volume01 = ref(0.85)
  const isMuted = ref(false)

  const disposers: Dispose[] = []

  const clearSubscriptions = () => {
    while (disposers.length) {
      disposers.pop()?.()
    }
  }

  const attach = (b: MultiBackend, br: Broadcast) => {
    clearSubscriptions()
    backend.value = b
    broadcast.value = br
    disposers.push(
      b.paused.subscribe((v) => {
        isPaused.value = v
      })
    )
    disposers.push(
      b.audio.volume.subscribe((v) => {
        volume01.value = v
      })
    )
    disposers.push(
      b.audio.muted.subscribe((v) => {
        isMuted.value = v
      })
    )
  }

  const detach = () => {
    clearSubscriptions()
    backend.value = null
    broadcast.value = null
  }

  const togglePause = () => {
    const b = backend.value
    if (!b) return
    b.paused.update((p) => !p)
  }

  /** Resume A/V and pulse catalog reload to catch up to the live edge. */
  const goLive = () => {
    const b = backend.value
    const br = broadcast.value
    if (!b || !br) return
    b.paused.set(false)
    br.reload.set(true)
    queueMicrotask(() => {
      br.reload.set(false)
    })
  }

  const toggleMute = () => {
    const b = backend.value
    if (!b) return
    b.audio.muted.update((m) => !m)
  }

  const setVolume = (v: number) => {
    const b = backend.value
    if (!b) return
    const clamped = Math.min(1, Math.max(0, v))
    b.audio.volume.set(clamped)
    if (clamped > 0 && b.audio.muted.peek()) b.audio.muted.set(false)
  }

  const toggleFullscreen = async () => {
    const el = shellRef.value
    if (!el) return
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen()
      } else {
        await el.requestFullscreen()
      }
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn('toggleFullscreen failed in useMoqLivePlayerControls', {
          shellRef: shellRef.value,
          err
        })
      }
    }
  }

  return {
    shellRef,
    backend: backend as ShallowRef<MultiBackend | null>,
    broadcast: broadcast as ShallowRef<Broadcast | null>,
    isPaused,
    volume01,
    isMuted,
    attach,
    detach,
    togglePause,
    goLive,
    toggleMute,
    setVolume,
    toggleFullscreen
  }
}

export function isLiveRecommendation(rec: { livestream_provider?: string | null }): boolean {
  return Boolean(rec?.livestream_provider)
}
