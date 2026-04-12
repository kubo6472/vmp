/**
 * D1 Sessions API helper for read-replication.
 *
 * We keep writes on the primary DB object and use sessions for read-heavy,
 * KV-tolerant workflows where sequential consistency is sufficient.
 */

export function getDb(env: any) {
  const db = env.DB || env.video_subscription_db
  if (!db) throw new Error('D1 binding not found')
  return db
}

export function getReadSession(env: any, request: any) {
  const db = getDb(env)
  // If withSession is unavailable, callers keep working on primary.
  if (typeof db.withSession !== 'function') return { session: db, bookmark: null }
  const bookmark = request.headers.get('x-d1-bookmark') ?? 'first-unconstrained'
  const session = db.withSession(bookmark)
  return { session, bookmark }
}

export function applySessionBookmark(responseHeaders: any, session: any) {
  try {
    const bookmark = typeof session?.getBookmark === 'function' ? session.getBookmark() : null
    if (bookmark) responseHeaders.set('x-d1-bookmark', bookmark)
  } catch {
    // Non-fatal: response remains valid without bookmark propagation.
  }
}
