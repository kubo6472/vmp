/**
 * Homepage video placement (PR B — deterministic rules engine)
 *
 * Ordering timestamp (single rule for the whole module):
 *   `placementTimestampMs` = parse(published_at) if present, else parse(upload_date).
 *   Tie-break: lexicographic `id` descending so results are stable.
 *
 * Featured hero (max one VideoRef):
 *   - `featuredMode === 'specific'` and `featuredVideoId` set → that video if it appears
 *     in the published input set; otherwise fall back as in automatic mode below.
 *   - `featuredMode === 'latest'` (automatic): if `featuredVideoIds[0]` is set (legacy) and
 *     that id is in the published set → use as pinned hero; else newest published video
 *     that has a category assignment (`category_id` non-null); if none → empty (no
 *     fallback to global newest — keeps the 2×2 grid able to show four uncategorized).
 *
 * Recent 2×2 (exactly four slots): pool = published videos without category, excluding
 *   the featured id, newest first; array length is always 4 (pad with null for empty slots
 *   if fewer than four uncategorized videos).
 *
 * Category blocks: categories ordered by `sort_order` then `name`. For each category,
 *   take published videos in that category not already assigned to featured/recent/earlier
 *   rows, sort by `direction` on the same placement timestamp, split into
 *   `visible` (first 3) and `overflow` (rest).
 *
 * Exclusivity: a video id appears at most once across featured, recent slots, and any
 *   category visible/overflow list. Priority when building: featured → recent 2×2 →
 *   categories in order.
 */

type VideoRef = { id: string }
type PublishedVideoInput = {
  id: string
  published_at?: string | null
  upload_date?: string | null
  category_id?: string | null
}
type CategoryInput = {
  id: string
  slug: string
  name: string
  sort_order: number
  direction: 'asc' | 'desc'
}
interface HomepageConfigInput {
  featuredMode?: unknown
  featuredVideoId?: unknown
  featuredVideoIds?: unknown
}
interface NormalizedHomepagePlacementConfig {
  featuredMode: 'latest' | 'specific'
  featuredVideoId: string | null
  featuredVideoIds: string[]
}

/**
 * Subset of persisted `admin_settings.homepage` JSON used by placement only.
 * @param {unknown} config
 */
export function normalizeHomepagePlacementConfig(config: unknown): NormalizedHomepagePlacementConfig {
  const c: HomepageConfigInput = config && typeof config === 'object' ? config as HomepageConfigInput : {}
  return {
    featuredMode: c.featuredMode === 'specific' ? 'specific' : 'latest',
    featuredVideoId: typeof c.featuredVideoId === 'string' ? c.featuredVideoId : null,
    featuredVideoIds: Array.isArray(c.featuredVideoIds)
      ? c.featuredVideoIds.filter((id): id is string => typeof id === 'string').slice(0, 4)
      : [],
  };
}

/** @param {PublishedVideoInput} v */
export function placementTimestampMs(v: any) {
  const primary = v.published_at
  const fallback = v.upload_date
  const s = (typeof primary === 'string' && primary.trim()) ? primary.trim()
    : (typeof fallback === 'string' && fallback.trim()) ? fallback.trim()
      : null
  if (!s) return 0
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

/**
 * @param {PublishedVideoInput} a
 * @param {PublishedVideoInput} b
 */
function compareNewestFirst(a: any, b: any) {
  const dt = placementTimestampMs(b) - placementTimestampMs(a)
  if (dt !== 0) return dt
  if (a.id > b.id) return -1
  if (a.id < b.id) return 1
  return 0
}

/**
 * @param {PublishedVideoInput} a
 * @param {PublishedVideoInput} b
 * @param {'asc' | 'desc'} direction
 */
function compareByDirection(a: any, b: any, direction: any) {
  const ta = placementTimestampMs(a)
  const tb = placementTimestampMs(b)
  if (direction === 'asc') {
    if (ta !== tb) return ta - tb
  } else {
    if (ta !== tb) return tb - ta
  }
  if (a.id < b.id) return direction === 'asc' ? -1 : 1
  if (a.id > b.id) return direction === 'asc' ? 1 : -1
  return 0
}

/**
 * @param {string} id
 * @param {Map<string, PublishedVideoInput>} byId
 * @returns {VideoRef | null}
 */
function refFor(id: any, byId: any) {
  const row = byId.get(id)
  return row ? { id: row.id } : null
}

/**
 * @param {{ videos: PublishedVideoInput[], categories: CategoryInput[], homepage: HomepageConfigInput }} input
 */
export function placeHomepageVideos(input: any) {
  const rawVideos = Array.isArray(input.videos) ? input.videos : []
  const categories = Array.isArray(input.categories) ? [...input.categories] : []
  const homepage: NormalizedHomepagePlacementConfig = input.homepage && typeof input.homepage === 'object'
    ? input.homepage
    : normalizeHomepagePlacementConfig(null)

  const byId = new Map()
  for (const v of rawVideos) {
    if (v && typeof v.id === 'string') byId.set(v.id, v)
  }

  const sortedAll = [...byId.values()].sort(compareNewestFirst)

  const categorized = sortedAll.filter(v => v.category_id != null && v.category_id !== '')
  const mode = homepage.featuredMode === 'specific' ? 'specific' : 'latest'
  const featuredVideoId = typeof homepage.featuredVideoId === 'string' ? homepage.featuredVideoId : null
  const legacyIds = Array.isArray(homepage.featuredVideoIds) ? homepage.featuredVideoIds : []
  const legacyPin = typeof legacyIds[0] === 'string' ? legacyIds[0] : null

  /** @type {VideoRef[]} */
  let featured = []

  if (mode === 'specific' && featuredVideoId) {
    const pin = refFor(featuredVideoId, byId)
    featured = pin ? [pin] : pickAutomaticFeatured(categorized)
  } else if (mode === 'latest' && legacyPin) {
    const pin = refFor(legacyPin, byId)
    featured = pin ? [pin] : pickAutomaticFeatured(categorized)
  } else {
    featured = pickAutomaticFeatured(categorized)
  }

  const featuredId = featured[0]?.id ?? null
  const assigned = new Set()
  if (featuredId) assigned.add(featuredId)

  const uncategorizedPool = sortedAll.filter(v => (!v.category_id || v.category_id === '') && !assigned.has(v.id))
  /** @type {(VideoRef | null)[]} */
  const recentGrid = []
  for (let i = 0; i < 4; i += 1) {
    const v = uncategorizedPool[i]
    if (v) {
      recentGrid.push({ id: v.id })
      assigned.add(v.id)
    } else {
      recentGrid.push(null)
    }
  }

  categories.sort((a, b) => {
    const so = (a.sort_order ?? 0) - (b.sort_order ?? 0)
    if (so !== 0) return so
    const an = typeof a.name === 'string' ? a.name : ''
    const bn = typeof b.name === 'string' ? b.name : ''
    if (an < bn) return -1
    if (an > bn) return 1
    return 0
  })

  /** @type {Array<{ category: { id: string, slug: string, name: string, direction: 'asc' | 'desc' }, visible: VideoRef[], overflow: VideoRef[] }>} */
  const categoryBlocks = []

  for (const cat of categories) {
    if (!cat || typeof cat.id !== 'string') continue
    const direction = cat.direction === 'asc' ? 'asc' : 'desc'
    const inCat = sortedAll
      .filter(v => v.category_id === cat.id && !assigned.has(v.id))
      .sort((a, b) => compareByDirection(a, b, direction))

    const visibleRaw = inCat.slice(0, 3)
    const overflowRaw = inCat.slice(3)

    const visible = visibleRaw.map(v => ({ id: v.id }))
    const overflow = overflowRaw.map(v => ({ id: v.id }))

    for (const v of visibleRaw) assigned.add(v.id)
    for (const v of overflowRaw) assigned.add(v.id)

    categoryBlocks.push({
      category: {
        id: cat.id,
        slug: typeof cat.slug === 'string' ? cat.slug : '',
        name: typeof cat.name === 'string' ? cat.name : '',
        direction,
      },
      visible,
      overflow,
    })
  }

  return { featured, recentGrid, categoryBlocks }
}

/**
 * Newest categorized published video, or empty if none.
 * @param {PublishedVideoInput[]} categorizedSorted
 */
function pickAutomaticFeatured(categorizedSorted: any) {
  if (categorizedSorted.length) {
    const top = categorizedSorted[0]
    return top ? [{ id: top.id }] : []
  }
  return []
}
