/**
 * PR B placement matrix — uses node:test (Node 20+).
 * Run: npm test --workspace=@vmp/api
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { placeHomepageVideos, placementTimestampMs, sortCategoriesForHomepage } from '../src/homepagePlacement.js'

const T = {
  t1: '2026-01-01T12:00:00.000Z',
  t2: '2026-01-02T12:00:00.000Z',
  t3: '2026-01-03T12:00:00.000Z',
  t4: '2026-01-04T12:00:00.000Z',
  t5: '2026-01-05T12:00:00.000Z',
}

function cat(id: any, name: any, sortOrder: any, direction = 'desc') {
  return { id, slug: id, name, sort_order: sortOrder, direction }
}

describe('placementTimestampMs', () => {
  it('prefers published_at over upload_date', () => {
    const ms = placementTimestampMs({
      id: 'x',
      published_at: '2026-06-01T00:00:00.000Z',
      upload_date: '2020-01-01T00:00:00.000Z',
    })
    assert.equal(ms, Date.parse('2026-06-01T00:00:00.000Z'))
  })

  it('sorts deterministic tie-breaker by id when timestamps match', () => {
    const homepage = { featuredMode: 'latest', featuredVideoId: null, featuredVideoIds: [] }
    const videos = [
      { id: 'b', published_at: T.t1, upload_date: T.t1, category_id: null },
      { id: 'a', published_at: T.t1, upload_date: T.t1, category_id: null },
    ]
    const out = placeHomepageVideos({ videos, categories: [], homepage })
    assert.deepEqual(out.recentGrid, [{ id: 'b' }, { id: 'a' }, null, null])
  })
})

describe('placeHomepageVideos matrix', () => {
  it('1 — reassign A → B: video appears only under B (not A)', () => {
    const homepage = { featuredMode: 'latest', featuredVideoId: null, featuredVideoIds: [] }
    const categories = [cat('c-a', 'A', 0), cat('c-b', 'B', 1)]
    // Two in A so the older is not featured and still lands in category A visible.
    const vNew = { id: 'v-new', published_at: T.t3, upload_date: T.t3, category_id: 'c-a' }
    const vMove = { id: 'v-move', published_at: T.t1, upload_date: T.t1, category_id: 'c-a' }
    const before = placeHomepageVideos({ videos: [vNew, vMove], categories, homepage })
    assert.ok(before.categoryBlocks.find(b => b.category.id === 'c-a')?.visible.some(v => v.id === 'v-move'))
    assert.equal(before.categoryBlocks.find(b => b.category.id === 'c-b')?.visible.length ?? 0, 0)

    const afterReassign = { ...vMove, category_id: 'c-b' }
    const after = placeHomepageVideos({ videos: [vNew, afterReassign], categories, homepage })
    assert.equal(after.categoryBlocks.find(b => b.category.id === 'c-a')?.visible.some(v => v.id === 'v-move'), false)
    assert.ok(after.categoryBlocks.find(b => b.category.id === 'c-b')?.visible.some(v => v.id === 'v-move'))
  })

  it('2 — automatic featured: newest categorized published is featured', () => {
    const homepage = { featuredMode: 'latest', featuredVideoId: null, featuredVideoIds: [] }
    const categories = [cat('c1', 'One', 0)]
    const videos = [
      { id: 'old', published_at: T.t1, upload_date: T.t1, category_id: 'c1' },
      { id: 'new', published_at: T.t3, upload_date: T.t3, category_id: 'c1' },
    ]
    const out = placeHomepageVideos({ videos, categories, homepage })
    assert.deepEqual(out.featured, [{ id: 'new' }])
  })

  it('3 — specific featuredVideoId overrides recency', () => {
    const homepage = { featuredMode: 'specific', featuredVideoId: 'old', featuredVideoIds: [] }
    const categories = [cat('c1', 'One', 0)]
    const videos = [
      { id: 'old', published_at: T.t1, upload_date: T.t1, category_id: 'c1' },
      { id: 'new', published_at: T.t3, upload_date: T.t3, category_id: 'c1' },
    ]
    const out = placeHomepageVideos({ videos, categories, homepage })
    assert.deepEqual(out.featured, [{ id: 'old' }])
  })

  it('4 — four uncategorized, no featured: all four in 2×2 order', () => {
    const homepage = { featuredMode: 'latest', featuredVideoId: null, featuredVideoIds: [] }
    const videos = [
      { id: 'a', published_at: T.t1, upload_date: T.t1, category_id: null },
      { id: 'b', published_at: T.t2, upload_date: T.t2, category_id: null },
      { id: 'c', published_at: T.t3, upload_date: T.t3, category_id: null },
      { id: 'd', published_at: T.t4, upload_date: T.t4, category_id: null },
    ]
    const out = placeHomepageVideos({ videos, categories: [], homepage })
    assert.deepEqual(out.featured, [])
    assert.deepEqual(out.recentGrid.map(s => s && s.id), ['d', 'c', 'b', 'a'])
  })

  it('5 — newest categorized is featured; next four uncategorized fill 2×2', () => {
    const homepage = { featuredMode: 'latest', featuredVideoId: null, featuredVideoIds: [] }
    const categories = [cat('c1', 'One', 0)]
    const videos = [
      { id: 'feat', published_at: T.t5, upload_date: T.t5, category_id: 'c1' },
      { id: 'u1', published_at: T.t4, upload_date: T.t4, category_id: null },
      { id: 'u2', published_at: T.t3, upload_date: T.t3, category_id: null },
      { id: 'u3', published_at: T.t2, upload_date: T.t2, category_id: null },
      { id: 'u4', published_at: T.t1, upload_date: T.t1, category_id: null },
    ]
    const out = placeHomepageVideos({ videos, categories, homepage })
    assert.deepEqual(out.featured, [{ id: 'feat' }])
    assert.deepEqual(out.recentGrid.map(s => s && s.id), ['u1', 'u2', 'u3', 'u4'])
  })

  it('6 — four in one category: 3 visible, overflow 1; direction respected (asc)', () => {
    const homepage = { featuredMode: 'latest', featuredVideoId: null, featuredVideoIds: [] }
    const categories = [cat('c1', 'One', 0, 'asc')]
    const videos = [
      { id: 'v1', published_at: T.t1, upload_date: T.t1, category_id: 'c1' },
      { id: 'v2', published_at: T.t2, upload_date: T.t2, category_id: 'c1' },
      { id: 'v3', published_at: T.t3, upload_date: T.t3, category_id: 'c1' },
      { id: 'v4', published_at: T.t4, upload_date: T.t4, category_id: 'c1' },
    ]
    // Pin featured to an older id so v4 isn't removed as featured.
    const out = placeHomepageVideos({
      videos,
      categories,
      homepage: { ...homepage, featuredMode: 'specific', featuredVideoId: 'v1', featuredVideoIds: [] },
    })
    const block = out.categoryBlocks[0]
    assert.ok(block, 'expected first category block to exist')
    assert.deepEqual(block.visible.map(v => v.id), ['v2', 'v3', 'v4'])
    assert.deepEqual(block.overflow.map(v => v.id), [])
  })

  it('7 — no video in both featured and 2×2 or category visible', () => {
    const homepage = { featuredMode: 'latest', featuredVideoId: null, featuredVideoIds: [] }
    const categories = [cat('c1', 'One', 0)]
    const videos = [
      { id: 'f', published_at: T.t5, upload_date: T.t5, category_id: 'c1' },
      { id: 'u1', published_at: T.t4, upload_date: T.t4, category_id: null },
      { id: 'x', published_at: T.t3, upload_date: T.t3, category_id: 'c1' },
    ]
    const out = placeHomepageVideos({ videos, categories, homepage })
    const seen = new Set()
    const take = (id: any) => {
      assert.ok(!seen.has(id), `duplicate placement for ${id}`)
      seen.add(id)
    }
    for (const r of out.featured) take(r.id)
    for (const r of out.recentGrid) {
      if (r) take(r.id)
    }
    for (const b of out.categoryBlocks) {
      for (const r of b.visible) take(r.id)
      for (const r of b.overflow) take(r.id)
    }
  })

  it('8 — fewer than 4 uncategorized: partial slots (null padding)', () => {
    const homepage = { featuredMode: 'latest', featuredVideoId: null, featuredVideoIds: [] }
    const videos = [
      { id: 'u1', published_at: T.t2, upload_date: T.t2, category_id: null },
      { id: 'u2', published_at: T.t1, upload_date: T.t1, category_id: null },
    ]
    const out = placeHomepageVideos({ videos, categories: [], homepage })
    assert.deepEqual(out.recentGrid, [{ id: 'u1' }, { id: 'u2' }, null, null])
  })

  it('specific mode: invalid id falls back to automatic (newest categorized)', () => {
    const homepage = { featuredMode: 'specific', featuredVideoId: 'missing', featuredVideoIds: [] }
    const categories = [cat('c1', 'One', 0)]
    const videos = [{ id: 'only', published_at: T.t1, upload_date: T.t1, category_id: 'c1' }]
    const out = placeHomepageVideos({ videos, categories, homepage })
    assert.deepEqual(out.featured, [{ id: 'only' }])
  })

  it('legacy featuredVideoIds[0] pins hero in latest mode', () => {
    const homepage = { featuredMode: 'latest', featuredVideoId: null, featuredVideoIds: ['pin'] }
    const videos = [
      { id: 'pin', published_at: T.t1, upload_date: T.t1, category_id: null },
      { id: 'newer', published_at: T.t5, upload_date: T.t5, category_id: 'c1' },
    ]
    const categories = [cat('c1', 'One', 0)]
    const out = placeHomepageVideos({ videos, categories, homepage })
    assert.deepEqual(out.featured, [{ id: 'pin' }])
  })

  it('category ordering prioritizes P0 buckets before standard', () => {
    const ordered = sortCategoriesForHomepage([
      cat('std-2', 'Zeta', 2),
      cat('p0-1', 'Alpha', 0),
      cat('p0-2', 'Beta', -2),
      cat('std-1', 'Delta', 1),
    ])
    assert.deepEqual(
      ordered.map((c: any) => `${c.id}:${c.priority_bucket}`),
      ['p0-2:p0', 'p0-1:p0', 'std-1:standard', 'std-2:standard'],
    )
  })
})
