const LIVESTREAM_STATUSES = new Set(['scheduled', 'live', 'ended', 'vod_attached', 'replaced_with_vod'])

export function normalizeLivestreamStatus(value: unknown, fallback = 'scheduled') {
  if (typeof value !== 'string') return fallback
  const status = value.trim().toLowerCase()
  return LIVESTREAM_STATUSES.has(status) ? status : fallback
}
