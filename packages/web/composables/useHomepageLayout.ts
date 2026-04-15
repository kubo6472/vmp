export type HomepageBlockType = 'hero' | 'featured_row' | 'cta' | 'text_split' | 'video_grid' | 'video_grid_legacy'

export interface HomepageLayoutBlock {
  id: string
  type: HomepageBlockType
  title: string
  body: string
}

export interface HomepageCategory {
  id: string
  slug: string
  name: string
  direction?: 'asc' | 'desc'
  sort_order?: number
  priority_bucket?: 'p0' | 'standard'
}

export interface HomepagePlacementResponse {
  featured: Array<{ id: string }>
  recentGrid: Array<{ id: string } | null>
  categoryBlocks: Array<{
    category: HomepageCategory
    visible: Array<{ id: string }>
    overflow: Array<{ id: string }>
  }>
}

export function buildHomepageRenderModel({
  videos,
  layoutBlocks,
  placement,
}: {
  videos: any[]
  layoutBlocks: HomepageLayoutBlock[]
  placement: HomepagePlacementResponse | null
}) {
  const safeLayoutBlocks = Array.isArray(layoutBlocks) ? layoutBlocks : []
  const renderedBlocks = safeLayoutBlocks.length
    ? safeLayoutBlocks
    : [{ id: 'fallback-grid', type: 'video_grid', title: 'Available Videos', body: '' } as HomepageLayoutBlock]
  const heroBlock = renderedBlocks.find((block) => block.type === 'hero') ?? null
  const hasVideoGridBlock = renderedBlocks.some((block) => block.type === 'video_grid' || block.type === 'video_grid_legacy')
  const videoById = new Map((videos ?? []).map((video) => [video.id, video]))
  const categoryAssignedIds = new Set<string>()
  for (const video of videos ?? []) {
    if (video?.category_id) categoryAssignedIds.add(video.id)
  }

  const featuredIdList = Array.isArray(placement?.featured)
    ? placement.featured.map((ref) => ref?.id).filter(Boolean)
    : []
  const featuredVideos = featuredIdList
    .slice(0, 4)
    .map((id) => videoById.get(id))
    .filter(Boolean)
  const recentTwoByTwoVideos = (placement?.recentGrid ?? [])
    .map((slot) => (slot ? videoById.get(slot.id) : null))
    .filter(Boolean)

  const categorySections = (placement?.categoryBlocks ?? []).map((block) => {
    const combinedIds = [...block.visible, ...block.overflow].map((ref) => ref.id)
    const allVideos = combinedIds.map((id) => videoById.get(id)).filter(Boolean)
    const variantPool = ['featured_hero', 'two_by_two', 'side_mini', 'three_by_one'] as const
    const slug = typeof block.category?.slug === 'string' ? block.category.slug : ''
    const hash = slug.split('').reduce((n, ch) => n + ch.charCodeAt(0), 0)
    const variant = variantPool[Math.abs(hash) % variantPool.length]
    const visibleCount = variant === 'two_by_two' || variant === 'side_mini' ? 4 : 3
    return {
      category: block.category,
      allVideos,
      visible: allVideos.slice(0, visibleCount),
      overflowCount: Math.max(0, allVideos.length - visibleCount),
      variant,
    }
  }).filter((section) => section.allVideos.length > 0)

  return {
    renderedBlocks,
    heroBlock,
    hasVideoGridBlock,
    categoryAssignedIds,
    featuredVideos,
    recentTwoByTwoVideos,
    categorySections,
  }
}