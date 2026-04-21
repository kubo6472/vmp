export type HomepageBlockType = 'featured_row' | 'category' | 'top_video' | 'split_horizontal' | 'split_vertical'
export type HomepageLeafBlockType = 'featured_row' | 'category' | 'top_video'

export interface HomepageLayoutChildBlock {
  id?: string
  type: HomepageLeafBlockType
  title?: string
  body?: string
  categoryId?: string | null
}

export interface HomepageLayoutBlock {
  id: string
  type: HomepageBlockType
  title?: string
  body?: string
  categoryId?: string | null
  childBlocks?: HomepageLayoutChildBlock[]
}

export interface HomepageCategory {
  id: string
  slug: string
  name: string
  direction?: 'asc' | 'desc'
  sort_order?: number
  priority_bucket?: 'p0' | 'standard'
  homepage_layout_variant?: 'three_by_one' | 'side_mini'
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

export interface HomepageRenderLeafBlock {
  id: string
  type: HomepageLeafBlockType
  title: string
  body: string
  categoryId: string | null
  videos: any[]
  categorySection: {
    category: HomepageCategory
    allVideos: any[]
    visible: any[]
    overflowCount: number
    variant: 'three_by_one' | 'side_mini'
  } | null
}

export interface HomepageRenderSplitBlock {
  id: string
  type: 'split_horizontal' | 'split_vertical'
  title: string
  body: string
  children: HomepageRenderLeafBlock[]
}

export type HomepageRenderBlock = HomepageRenderLeafBlock | HomepageRenderSplitBlock

export function isSplitRenderBlock(block: HomepageRenderBlock): block is HomepageRenderSplitBlock {
  return block.type === 'split_horizontal' || block.type === 'split_vertical'
}

export function isLeafRenderBlock(block: HomepageRenderBlock): block is HomepageRenderLeafBlock {
  return !isSplitRenderBlock(block)
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
  const renderedBlocks = safeLayoutBlocks
  const videoById = new Map((videos ?? []).map((video) => [video.id, video]))
  const sortedByNewest = [...(videos ?? [])].sort((a: any, b: any) => {
    const at = Date.parse(a?.published_at || a?.upload_date || 0)
    const bt = Date.parse(b?.published_at || b?.upload_date || 0)
    return bt - at
  })
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
    const variant = block.category?.homepage_layout_variant === 'side_mini' ? 'side_mini' : 'three_by_one'
    const visibleCount = variant === 'side_mini' ? 2 : 3
    return {
      category: block.category,
      allVideos,
      visible: allVideos.slice(0, visibleCount),
      overflowCount: Math.max(0, allVideos.length - visibleCount),
      variant: variant as 'three_by_one' | 'side_mini',
    }
  }).filter((section) => section.allVideos.length > 0)

  const sectionByCategoryId = new Map(categorySections.map((section) => [section.category.id, section]))
  const topVideo = sortedByNewest[0] ?? null

  const buildLeafBlock = (block: HomepageLayoutChildBlock, id: string): HomepageRenderLeafBlock | null => {
    const type = block?.type
    if (type !== 'featured_row' && type !== 'category' && type !== 'top_video') return null
    const title = typeof block?.title === 'string' ? block.title : ''
    const body = typeof block?.body === 'string' ? block.body : ''
    const categoryId = typeof block?.categoryId === 'string' && block.categoryId.trim() ? block.categoryId : null
    if (type === 'featured_row') {
      return {
        id,
        type,
        title,
        body,
        categoryId: null,
        videos: featuredVideos.slice(0, 4),
        categorySection: null,
      }
    }
    if (type === 'top_video') {
      return {
        id,
        type,
        title,
        body,
        categoryId: null,
        videos: topVideo ? [topVideo] : [],
        categorySection: null,
      }
    }
    const section = categoryId ? sectionByCategoryId.get(categoryId) ?? null : null
    return {
      id,
      type,
      title,
      body,
      categoryId,
      videos: section?.allVideos ?? [],
      categorySection: section,
    }
  }

  const blockItems = renderedBlocks.map((block): HomepageRenderBlock | null => {
    const blockType = block?.type
    if (blockType === 'split_horizontal' || blockType === 'split_vertical') {
      const children = Array.isArray(block?.childBlocks)
        ? block.childBlocks
          .map((child, idx) => buildLeafBlock(child, `${block.id}:child:${idx}`))
          .filter((child): child is HomepageRenderLeafBlock => Boolean(child))
          .slice(0, 2)
        : []
      return {
        id: block.id,
        type: blockType,
        title: typeof block?.title === 'string' ? block.title : '',
        body: typeof block?.body === 'string' ? block.body : '',
        children,
      } as HomepageRenderSplitBlock
    }
    return buildLeafBlock(block as HomepageLayoutChildBlock, block.id)
  }).filter((item): item is HomepageRenderBlock => Boolean(item))

  const hasFeaturedRowBlock = blockItems.some((item: any) =>
    item?.type === 'featured_row'
    || (item?.type === 'split_horizontal' || item?.type === 'split_vertical')
      && Array.isArray(item?.children)
      && item.children.some((child: HomepageRenderLeafBlock) => child.type === 'featured_row'),
  )

  return {
    renderedBlocks,
    featuredVideos,
    recentTwoByTwoVideos: featuredVideos.slice(0, 4),
    categorySections,
    blockItems,
    hasFeaturedRowBlock,
    topVideo,
  }
}