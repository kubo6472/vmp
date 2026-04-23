/**
 * packages/api/src/index.js
 *
 * Main Cloudflare Worker entry point.
 * Auth routes added; CORS updated to support credentials (required for
 * the HttpOnly refresh-token cookie to be sent cross-origin).
 */

import {
  handleRequestMagicLink,
  handleVerifyMagicLink,
  handleRefreshToken,
  handleLogout,
  handleGetMe,
  handleTotpSetup,
  handleTotpConfirm,
  handleTotpVerify,
  requireAuth,
  requireRole,
} from './auth.js'
import { checkAnonymousRateLimit } from './rateLimit.js'
import { sendPushNotification, sendPushToAllSubscribers } from './webpush.js'
import {
  handleAdminPaymentSettings,
  handleGetPricing,
  handleCheckout,
  handleWebhook,
  handleGoCardlessWebhook,
  handleGoCardlessComplete,
  handleGetSubscription,
  handlePortal,
} from './payments.js'
import { isAdministrativeRole } from './roles.js'
import { buildEntrypointCandidates, resolveMediaEntrypointUrl, buildProxyPlaylistUrl } from './mediaEntrypoints.js'
import { handleThumbnailUpload, handleThumbnailDelete } from './thumbnails.js'
import {
  handleAdminNewsletterSend,
  handleAdminNewsletterSettings,
  handleAdminNewsletterCampaigns,
  handleAdminNewsletterTemplates,
  handleAdminNewsletterTemplateById,
  handleAdminNewsletterSync,
} from './brevo.js'
import { signVideoToken, verifyVideoToken } from './videoTokens.js'
import { handlePublicFeed, handlePersonalFeed } from './feed.js'
import { handleGetAccountRss } from './rssAccount.js'
import { handleRssPodcastPreviewRebuildNotify, handleRssPodcastWebhookConfig } from './rssPodcastAdmin.js'
import {
  handleHomepageContent,
  handleHomepageContentPublic,
  handlePillsPublic,
  handlePillsUpdate,
  handleAdminPills,
  handleAdminPillsSettings,
  handleCategoryVideosBySlug,
  handleAdminUsers,
  handleAdminUserImportCsv,
  handleAdminAnalytics,
  ensurePillsApiKeySetting,
  logSegmentEvent,
} from './adminExtras.js'
import {
  handleAdminPromoCampaigns,
  handleAdminPromoCodes,
  handleAdminIsicCampaigns,
  handlePromoValidate,
  handleIsicValidate,
  handleIsicCampaignPublic,
} from './promotions.js'
import { handleAdminSmokeAuth } from './smokeAuth.js'
import { handleSiteSettings } from './siteSettings.js'
import { getReadSession, applySessionBookmark } from './d1Session.js'
import { placeHomepageVideos, normalizeHomepagePlacementConfig } from './homepagePlacement.js'
import { ensureAdminSettingsTable } from './adminSettingsTable.js'
import {
  normalizeLivestreamStatus,
  createCloudflareLivestream,
  sanitizeCloudflareLivestreamResponse,
} from './livestreams.js'
import type { DurableObjectState, ExecutionContext } from '@cloudflare/workers-types'

type CorsHeaders = Record<string, string>

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getPublicErrorMessage(fallback = 'Internal server error'): string {
  return fallback
}

function getErrorField(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined
  return (error as Record<string, unknown>)[key]
}

interface SegmentRateLimitBody {
  identifier?: string
  videoId?: string
  avgSegDur?: number | null
}

// ─── Durable Object for atomic segment rate limiting (Step 4c) ───────────────
// Binding is configured in wrangler.json under durable_objects.bindings.
// Used conditionally: only active when env.SEGMENT_RATE_LIMITER is present.

export class SegmentRateLimiterDO {
  env: Record<string, unknown>
  state: DurableObjectState
  constructor(state: DurableObjectState, env: Record<string, unknown>) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as SegmentRateLimitBody
    const identifier = body.identifier ?? 'unknown'
    const videoId = body.videoId ?? 'unknown'
    const avgSegDur = body.avgSegDur ?? null

    const segDur = avgSegDur ?? 6 // default 6-second segments
    const threshold = Math.ceil(60 / segDur) * 3

    const minute = Math.floor(Date.now() / 60000)
    const countKey = `${identifier}:${videoId}:${minute}`

    // Atomically increment the count
    let count = Number((await this.state.storage.get<number>(countKey)) ?? 0)
    count += 1
    await this.state.storage.put(countKey, count)

    // Schedule cleanup of old keys (after 2 minutes) using alarm API.
    // Keep a set of pending keys instead of a single slot to avoid overwriting
    // when multiple requests hit before alarm() runs.
    const pending = (await this.state.storage.get<string[]>('pendingCleanupKeys')) ?? []
    if (!pending.includes(countKey)) {
      pending.push(countKey)
      await this.state.storage.put('pendingCleanupKeys', pending)
    }
    await this.state.storage.setAlarm(Date.now() + 120000)

    const exceeded = count > threshold

    return new Response(JSON.stringify({ count, threshold, exceeded }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async alarm(): Promise<void> {
    // Alarm handler - cleanup all pending count keys accumulated since last run.
    const countKeys = (await this.state.storage.get<string[]>('pendingCleanupKeys')) ?? []
    if (countKeys.length) {
      await Promise.all(countKeys.map((key) => this.state.storage.delete(key)))
      await this.state.storage.delete('pendingCleanupKeys')
    }
  }
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const url = new URL(request.url)
    ctx.waitUntil(maybeRunScheduledPublishJobsInRequest(env))
    await maybeSyncPillsApiKey(env)

    // ── CORS ──────────────────────────────────────────────────────────────────
    //
    // When a request includes credentials (cookies), the browser requires:
    //   1. Access-Control-Allow-Origin must be a specific origin, never "*"
    //   2. Access-Control-Allow-Credentials: true
    //
    // We maintain an allowlist of origins in the ALLOWED_ORIGINS env var
    // (comma-separated).  If the request origin is in the list we reflect it
    // back.  Unknown origins get a non-credentialed response, which is fine
    // for public endpoints like /api/videos.
    const corsHeaders = buildCorsHeaders(request, env)

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range, x-d1-bookmark',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    // ── Auth routes ───────────────────────────────────────────────────────────
    if (url.pathname === '/api/auth/magic-link' && request.method === 'POST') {
      return handleRequestMagicLink(request, env, corsHeaders)
    }
    if (url.pathname === '/api/auth/verify' && request.method === 'GET') {
      return handleVerifyMagicLink(request, env, corsHeaders)
    }
    if (url.pathname === '/api/auth/refresh' && request.method === 'POST') {
      return handleRefreshToken(request, env, corsHeaders)
    }
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      return handleLogout(request, env, corsHeaders)
    }
    if (url.pathname === '/api/auth/me' && request.method === 'GET') {
      return handleGetMe(request, env, corsHeaders)
    }
    if (url.pathname === '/api/auth/2fa/setup' && request.method === 'GET') {
      return handleTotpSetup(request, env, corsHeaders)
    }
    if (url.pathname === '/api/auth/2fa/confirm' && request.method === 'POST') {
      return handleTotpConfirm(request, env, corsHeaders)
    }
    if (url.pathname === '/api/auth/2fa/verify' && request.method === 'POST') {
      return handleTotpVerify(request, env, corsHeaders)
    }

    // ── Existing routes ───────────────────────────────────────────────────────
    if (url.pathname === '/api/videos') {
      return handleVideosList(request, env, corsHeaders)
    }
    if (url.pathname === '/api/homepage/placement' && request.method === 'GET') {
      return handleHomepagePlacement(request, env, corsHeaders)
    }
    if (url.pathname === '/api/feed/public') {
      return handlePublicFeed(request, env, corsHeaders)
    }
    if (url.pathname.match(/^\/api\/feed\/[^/]+\/[^/]+$/)) {
      return handlePersonalFeed(request, env, corsHeaders)
    }
    if (url.pathname.startsWith('/api/video-access/')) {
      return handleVideoAccess(request, env, corsHeaders)
    }
    if (url.pathname.startsWith('/api/video-proxy/')) {
      return handleVideoProxy(request, env, corsHeaders, ctx)
    }
    if (url.pathname === '/api/admin/bootstrap' && request.method === 'POST') {
      return handleBootstrap(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/config') {
      return handleAdminConfig(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/categories' && ['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) {
      return handleAdminCategories(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/preview-locks') {
      return handlePreviewLocks(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/videos') {
      return handleAdminVideosList(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/videos/livestreams' && request.method === 'POST') {
      return handleAdminLivestreamCreate(request, env, corsHeaders)
    }
    if (url.pathname.match(/^\/api\/admin\/videos\/[^/]+\/thumbnail$/) && request.method === 'POST') {
      return handleThumbnailUpload(request, env, corsHeaders)
    }
    if (url.pathname.match(/^\/api\/admin\/videos\/[^/]+\/thumbnail$/) && request.method === 'DELETE') {
      return handleThumbnailDelete(request, env, corsHeaders)
    }
    if (url.pathname.match(/^\/api\/admin\/videos\/[^/]+\/livestream$/) && request.method === 'PATCH') {
      return handleAdminLivestreamUpdate(request, env, corsHeaders)
    }
    if (url.pathname.match(/^\/api\/admin\/videos\/[^/]+\/livestream\/provision$/) && request.method === 'POST') {
      return handleAdminLivestreamProvision(request, env, corsHeaders)
    }
    if (url.pathname.startsWith('/api/admin/videos/') && request.method === 'PATCH') {
      return handleAdminVideoUpdate(request, env, ctx, corsHeaders)
    }
    if (url.pathname.match(/^\/api\/admin\/videos\/[^/]+$/) && request.method === 'DELETE') {
      return handleAdminVideoDelete(request, env, corsHeaders)
    }
    if (url.pathname.match(/^\/api\/admin\/videos\/[^/]+\/notify$/) && request.method === 'POST') {
      return handleAdminVideoNotify(request, env, ctx, corsHeaders)
    }
    if (url.pathname.match(/^\/api\/admin\/videos\/[^/]+\/swap$/) && request.method === 'POST') {
      return handleVideoSwap(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/push/test' && request.method === 'POST') {
      return handleAdminPushTest(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/newsletter/settings' && (request.method === 'GET' || request.method === 'PATCH')) {
      return handleAdminNewsletterSettings(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/newsletter/send' && request.method === 'POST') {
      return handleAdminNewsletterSend(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/newsletter/campaigns' && request.method === 'GET') {
      return handleAdminNewsletterCampaigns(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/payments/settings' && ['GET', 'PATCH'].includes(request.method)) {
      return handleAdminPaymentSettings(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/promotions/campaigns' && ['GET', 'POST', 'PATCH'].includes(request.method)) {
      return handleAdminPromoCampaigns(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/promotions/codes' && ['GET', 'POST', 'PATCH'].includes(request.method)) {
      return handleAdminPromoCodes(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/isic/campaigns' && ['GET', 'POST', 'PATCH'].includes(request.method)) {
      return handleAdminIsicCampaigns(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/site-settings' && ['GET', 'PATCH'].includes(request.method)) {
      return handleSiteSettings(request, env, corsHeaders)
    }
    {
      const templateById = url.pathname.match(/^\/api\/admin\/newsletter\/templates\/([^/]+)$/)
      if (templateById && (request.method === 'PATCH' || request.method === 'DELETE')) {
        return handleAdminNewsletterTemplateById(request, env, corsHeaders, templateById[1])
      }
    }
    if (url.pathname === '/api/admin/newsletter/templates' && (request.method === 'GET' || request.method === 'POST')) {
      return handleAdminNewsletterTemplates(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/newsletter/sync' && request.method === 'POST') {
      return handleAdminNewsletterSync(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/rss/podcast-rebuild-webhook' && ['GET', 'PATCH'].includes(request.method)) {
      return handleRssPodcastWebhookConfig(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/rss/podcast-preview-rebuild' && request.method === 'POST') {
      return handleRssPodcastPreviewRebuildNotify(request, env, corsHeaders)
    }
    if (url.pathname === '/api/homepage/content' && request.method === 'GET') {
      return handleHomepageContentPublic(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/homepage/content' && (request.method === 'GET' || request.method === 'PATCH')) {
      return handleHomepageContent(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/users' && (request.method === 'GET' || request.method === 'PATCH' || request.method === 'POST')) {
      return handleAdminUsers(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/users/import-csv' && request.method === 'POST') {
      return handleAdminUserImportCsv(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/analytics' && request.method === 'GET') {
      return handleAdminAnalytics(request, env, corsHeaders)
    }
    if (url.pathname === '/api/site-settings' && request.method === 'GET') {
      return handleSiteSettings(request, env, corsHeaders)
    }
    if (url.pathname === '/api/pills' && request.method === 'GET') {
      return handlePillsPublic(request, env, corsHeaders)
    }
    if (url.pathname === '/api/pills/update' && request.method === 'POST') {
      return handlePillsUpdate(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/pills' && ['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) {
      return handleAdminPills(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/pills/settings' && ['GET', 'PATCH'].includes(request.method)) {
      return handleAdminPillsSettings(request, env, corsHeaders)
    }
    if (url.pathname === '/api/admin/smoke-auth' && request.method === 'GET') {
      return handleAdminSmokeAuth(request, env, corsHeaders)
    }
    if (url.pathname.match(/^\/api\/categories\/[^/]+\/videos$/) && request.method === 'GET') {
      return handleCategoryVideosBySlug(request, env, corsHeaders)
    }
    if (url.pathname === '/api/account/pricing' && request.method === 'GET') {
      return handleGetPricing(request, env, corsHeaders)
    }
    if (url.pathname === '/api/payments/checkout' && request.method === 'POST') {
      return handleCheckout(request, env, corsHeaders)
    }
    if (url.pathname === '/api/payments/webhook' && request.method === 'POST') {
      return handleWebhook(request, env, corsHeaders)
    }
    if (url.pathname === '/api/payments/webhook/gocardless' && request.method === 'POST') {
      return handleGoCardlessWebhook(request, env, corsHeaders)
    }
    if (url.pathname === '/api/account/subscription' && request.method === 'GET') {
      return handleGetSubscription(request, env, corsHeaders)
    }
    if (url.pathname === '/api/account/promotions/validate' && request.method === 'POST') {
      return handlePromoValidate(request, env, corsHeaders)
    }
    if (url.pathname === '/api/account/isic/validate' && request.method === 'POST') {
      return handleIsicValidate(request, env, corsHeaders)
    }
    if (url.pathname === '/api/account/isic/campaigns' && request.method === 'GET') {
      return handleIsicCampaignPublic(request, env, corsHeaders)
    }
    if (url.pathname === '/api/account/rss' && request.method === 'GET') {
      return handleGetAccountRss(request, env, corsHeaders)
    }
    if (url.pathname === '/api/payments/portal' && request.method === 'POST') {
      return handlePortal(request, env, corsHeaders)
    }
    if (url.pathname === '/api/payments/gocardless/complete' && request.method === 'POST') {
      return handleGoCardlessComplete(request, env, corsHeaders)
    }
    // ── Push notification routes ──────────────────────────────────────────────
    if (url.pathname === '/api/push/vapid-public-key' && request.method === 'GET') {
      return handleGetVapidPublicKey(request, env, corsHeaders)
    }
    if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
      return handlePushSubscribe(request, env, corsHeaders)
    }
    if (url.pathname === '/api/push/subscribe' && request.method === 'DELETE') {
      return handlePushUnsubscribe(request, env, corsHeaders)
    }
    if (url.pathname === '/api/health') {
      return jsonResponse({ status: 'healthy' }, 200, corsHeaders)
    }

    return jsonResponse({ error: 'Not Found' }, 404, corsHeaders)
  },

  async scheduled(event: any, env: any, ctx: ExecutionContext) {
    try {
      await runScheduledPublishJobs(env)
    } catch (err) {
      console.error('Scheduled publish sweep failed:', err)
    }
  },
}

// ─── CORS helpers ─────────────────────────────────────────────────────────────

function buildCorsHeaders(request: any, env: any) {
  const requestOrigin  = request.headers.get('Origin') || ''
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS)

  if (allowedOrigins.includes(requestOrigin)) {
    // Credentialed CORS — required for the cookie to be sent/received
    return {
      'Access-Control-Allow-Origin':      requestOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Expose-Headers':    'Accept-Ranges, Content-Length, Content-Range, Content-Type, x-d1-bookmark',
      'Vary':                              'Origin',
    }
  }

  // Public CORS — no credentials, matches any origin (e.g. curl, public consumers)
  return {
    'Access-Control-Allow-Origin':   '*',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type, x-d1-bookmark',
  }
}

function parseAllowedOrigins(envValue: any) {
  if (!envValue) return []
  return envValue.split(',').map((o: any) => o.trim()).filter(Boolean);
}

// ─── Existing handler implementations (unchanged) ─────────────────────────────

async function handleHomepagePlacement(request: any, env: any, corsHeaders: any) {
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  try {
    const db = getDatabaseBinding(env)
    await ensureAdminSettingsTable(db)
    const [videoRows, catRows, homepageRow] = await Promise.all([
      db.prepare(`
        SELECT v.id, v.published_at, v.upload_date, vca.category_id
        FROM videos v
        LEFT JOIN video_category_assignments vca ON vca.video_id = v.id
        WHERE v.publish_status = 'published'
          AND (v.scheduled_publish_at IS NULL OR datetime(v.scheduled_publish_at) <= CURRENT_TIMESTAMP)
      `).all(),
      db.prepare(`
        SELECT id, slug, name, sort_order, direction, homepage_layout_variant
        FROM video_categories
      `).all(),
      db.prepare('SELECT value FROM admin_settings WHERE key = ? LIMIT 1').bind('homepage').first(),
    ])
    const homepage = normalizeHomepagePlacementConfig(safeJsonParse(homepageRow?.value, defaultHomepageConfig()))
    const placement = placeHomepageVideos({
      videos: videoRows.results || [],
      categories: catRows.results || [],
      homepage,
    })
    return jsonResponse(placement, 200, corsHeaders)
  } catch (error) {
    console.error('handleHomepagePlacement:', error)
    return jsonResponse({ error: getPublicErrorMessage('Internal server error') }, 500, corsHeaders)
  }
}

async function handleVideosList(request: any, env: any, corsHeaders: any) {
  try {
    const { session } = getReadSession(env, request)

    // Editors and above see all statuses; everyone else only sees published videos.
    let isEditor = false
    try {
      await requireRole(request, env, 'editor', 'admin', 'super_admin')
      isEditor = true
    } catch {
      isEditor = false
    }

    const query = isEditor
      ? `SELECT v.id, v.title, v.description, v.thumbnail_url, v.full_duration, v.preview_duration, v.upload_date, v.publish_status, v.slug,
                v.published_at, v.scheduled_publish_at, v.notified_at,
                vc.id AS category_id,
                vc.name AS category_name,
                vc.slug AS category_slug,
                ls.provider AS livestream_provider,
                ls.status AS livestream_status,
                ls.playback_url AS livestream_playback_url,
                ls.recording_video_id AS livestream_recording_video_id
         FROM videos v
         LEFT JOIN video_category_assignments vca ON vca.video_id = v.id
         LEFT JOIN video_categories vc ON vc.id = vca.category_id
         LEFT JOIN livestreams ls ON ls.video_id = v.id
         ORDER BY v.upload_date DESC`
      : `SELECT v.id, v.title, v.description, v.thumbnail_url, v.full_duration, v.preview_duration, v.upload_date, v.publish_status, v.slug,
                v.published_at, v.scheduled_publish_at, v.notified_at,
                vc.id AS category_id,
                vc.name AS category_name,
                vc.slug AS category_slug,
                ls.provider AS livestream_provider,
                ls.status AS livestream_status,
                ls.playback_url AS livestream_playback_url,
                ls.recording_video_id AS livestream_recording_video_id
         FROM videos v
         LEFT JOIN video_category_assignments vca ON vca.video_id = v.id
         LEFT JOIN video_categories vc ON vc.id = vca.category_id
         LEFT JOIN livestreams ls ON ls.video_id = v.id
         WHERE v.publish_status = 'published'
           AND (v.scheduled_publish_at IS NULL OR datetime(v.scheduled_publish_at) <= CURRENT_TIMESTAMP)
         ORDER BY v.upload_date DESC`

    const videos = await session.prepare(query).all()

    // Best-effort duration hydration for legacy rows where full_duration=0.
    // Cached in KV so this stays cheap for repeated list loads.
    const results = videos.results || []
    if (env.R2_BASE_URL) {
      await Promise.all(results.map(async (v: any) => {
        if (!v || typeof v.id !== 'string') return
        if (typeof v.full_duration === 'number' && v.full_duration > 0) return
        const resolved = await resolveVideoDurationSeconds(v.id, env)
        if (resolved && resolved > 0) v.full_duration = resolved
      }))
    }

    const response = jsonResponse({ videos: results }, 200, corsHeaders)
    applySessionBookmark(response.headers, session)
    return response
  } catch (error) {
    console.error('Error:', error)
    return jsonResponse({ error: getPublicErrorMessage('Internal server error') }, 500, corsHeaders)
  }
}

async function handleVideoAccess(request: any, env: any, corsHeaders: any) {
  try {
    const url = new URL(request.url)
    const pathParts = url.pathname.split('/').filter(Boolean)

    // Supports both:
    //   /api/video-access/{videoId}                 (preferred; user from JWT)
    //   /api/video-access/{userId}/{videoId}        (legacy fallback)
    let legacyUserId = null
    let requestedVideoId = null

    if (pathParts.length === 3) {
      requestedVideoId = decodeURIComponent(pathParts[2] ?? '')
    } else if (pathParts.length === 4) {
      // DEPRECATED: Legacy callers still send /api/video-access/{userId}/{videoId}.
      // Keep this temporarily for backward compatibility while clients migrate
      // to /api/video-access/{videoId} with Authorization header when available.
      legacyUserId = pathParts[2]
      requestedVideoId = decodeURIComponent(pathParts[3] ?? '')
      // Log deprecation warning without raw user identifiers to comply with privacy/retention policies
      // Suppress warning for 'anonymous' userId to avoid log spam from admin UI
      if (legacyUserId !== 'anonymous') {
        console.warn('DEPRECATED_API_CALL /api/video-access/{userId}/{videoId} - Legacy path format still in use')
      }
    } else {
      return jsonResponse({ error: 'Invalid path format. Expected: /api/video-access/{videoId}' }, 400, corsHeaders)
    }

    const videoId = normalizeVideoId(requestedVideoId)

    let authUser = null
    let userId = legacyUserId

    // Legacy non-anonymous callers must now authenticate.
    if (legacyUserId && legacyUserId !== 'anonymous') {
      try {
        authUser = await requireAuth(request, env)
      } catch {
        return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
      }
      userId = authUser?.sub
    } else {
      try {
        authUser = await requireAuth(request, env)
      } catch {
        authUser = null
      }
      if (authUser?.sub) userId = authUser.sub
    }

    // ── Anonymous rate limiting ────────────────────────────────────────────────
    // Only applied when there is no authenticated user (anonymous viewer).
    // Logged-in users — even on the free plan — are never rate-limited here.
    const isAnonymous = !authUser && (!userId || userId === 'anonymous')
    if (isAnonymous) {
      const rateLimitResult = await checkAnonymousRateLimit(request, env)
      if (rateLimitResult?.limited) {
        return new Response(
          JSON.stringify({
            error: 'rate_limit_exceeded',
            retryAfter: rateLimitResult.retryAfter,
            loginPrompt: true,
            current: rateLimitResult.current,
            limit: rateLimitResult.limit,
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(rateLimitResult.retryAfter),
              ...corsHeaders,
            },
          }
        )
      }
    }
    const db = getDatabaseBinding(env)

    const subscription = userId
      ? await db.prepare(`
          SELECT * FROM subscriptions
          WHERE user_id = ? AND status IN ('active', 'trialing')
            AND (current_period_end IS NULL OR datetime(current_period_end) > CURRENT_TIMESTAMP)
          ORDER BY created_at DESC
          LIMIT 1
        `).bind(userId).first()
      : null

    // Resolve by ID first, then by vanity slug so /watch/<slug> works transparently.
    const video = await resolveVideoByIdOrSlug(db, videoId)
    // Use the canonical database ID for all downstream operations (R2 paths, token signing).
    const resolvedVideoId = video?.id ?? videoId
    const livestream = video
      ? await db.prepare(`
          SELECT video_id, provider, stream_id, stream_key, ingest_url, playback_url, status, recording_video_id, started_at, ended_at
          FROM livestreams
          WHERE video_id = ?
          LIMIT 1
        `).bind(resolvedVideoId).first()
      : null

    // Treat all non-viewer staff roles as premium-equivalent entitlements.
    const hasElevatedRole = isAdministrativeRole(authUser?.role)

    // Reject unpublished videos for non-staff so drafts/archived videos can't
    // receive signed playlist tokens via a slug or ID they happen to know.
    if (video && video.publish_status !== 'published' && !hasElevatedRole) {
      return jsonResponse({ error: 'Video not found' }, 404, corsHeaders)
    }

    // Any active monthly/yearly/club subscription grants full access
    const hasPremiumSubscription = Boolean(subscription)
    const hasPremiumAccess = hasElevatedRole || hasPremiumSubscription

    const hasVideoMetadata = Boolean(video)
    const hasAccess = hasPremiumAccess || !hasVideoMetadata
    const previewDuration = video?.preview_duration ?? video?.full_duration ?? 0
    const isLivestream = Boolean(livestream)
    const livestreamStatus = normalizeLivestreamStatus(livestream?.status, 'draft')
    const hasLivestreamPlaybackUrl = typeof livestream?.playback_url === 'string' && livestream.playback_url.trim().length > 0
    const livestreamPlaybackUrl = hasLivestreamPlaybackUrl ? livestream.playback_url.trim() : null
    const livestreamRecordingId = typeof livestream?.recording_video_id === 'string' && livestream.recording_video_id.trim().length > 0
      ? livestream.recording_video_id.trim()
      : null

    const shouldPreferVodRecording = Boolean(livestreamRecordingId) && ['ended', 'vod_attached', 'replaced_with_vod'].includes(livestreamStatus)
    let resolvedEntrypointUrl = await resolveMediaEntrypointUrl({ env, videoId: resolvedVideoId })
    if (shouldPreferVodRecording && livestreamRecordingId) {
      resolvedEntrypointUrl = await resolveMediaEntrypointUrl({ env, videoId: livestreamRecordingId })
    }
    const basePlaylistUrl = buildProxyPlaylistUrl(request, resolvedEntrypointUrl, hasPremiumAccess ? null : previewDuration)
    // Unify duration logic with the frontend: if D1 has 0/unknown duration,
    // attempt to resolve from the HLS playlist stored in R2.
    let fullDuration = video?.full_duration ?? previewDuration
    // Avoid racing the video-processor duration sync while a video is still in the
    // "uploaded" (not yet processed) state.
    const isProcessingInFlight = Boolean(video && video.status && video.status !== 'processed')
    if ((!fullDuration || fullDuration === 0) && env.R2_BASE_URL && !isProcessingInFlight) {
      const resolved = await resolveVideoDurationSeconds(resolvedVideoId, env)
      if (resolved && resolved > 0) {
        fullDuration = resolved
        // Best-effort: backfill D1 so list endpoints and cards stop showing "--".
        if (video && (video.full_duration == null || video.full_duration === 0)) {
          try {
            await db.prepare(
              `UPDATE videos
               SET full_duration = ?,
                   preview_duration = CASE
                     WHEN preview_duration IS NULL THEN 0
                     WHEN preview_duration <= 0 THEN preview_duration
                     ELSE MIN(preview_duration, ?)
                   END,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status = 'processed'`
            ).bind(fullDuration, fullDuration, resolvedVideoId).run()
          } catch (e) {
            console.warn(`Duration backfill failed for ${resolvedVideoId}:`, getErrorMessage(e))
          }
        }
      }
    }

    // Sign the playlist URL with a short-lived video token so the proxy can
    // authenticate every subsequent manifest and segment request.
    const effectiveUserId = authUser?.sub ?? userId ?? 'anonymous'
    let playlistUrl: string | null = basePlaylistUrl
    if (isLivestream) {
      const shouldUseLivePlayback = ['live', 'ready', 'provisioning', 'scheduled', 'draft'].includes(livestreamStatus)
      if (shouldUseLivePlayback && livestreamPlaybackUrl && hasPremiumAccess) {
        playlistUrl = livestreamPlaybackUrl
      } else if (!livestreamPlaybackUrl && !shouldPreferVodRecording) {
        playlistUrl = null
      }
    }
    if (env.JWT_SECRET) {
      const shouldSignProxyUrl = typeof playlistUrl === 'string' && playlistUrl.startsWith(new URL(request.url).origin)
      if (shouldSignProxyUrl && playlistUrl) {
        const vt = await signVideoToken(effectiveUserId, resolvedVideoId, env.JWT_SECRET, hasPremiumAccess ? null : previewDuration)
        playlistUrl = playlistUrl.includes('?')
          ? `${playlistUrl}&vt=${vt}`
          : `${playlistUrl}?vt=${vt}`
      }
    }

    const response = {
      userId: userId ?? null,
      videoId: resolvedVideoId,
      hasAccess,
      subscription: {
        planType: subscription ? subscription.plan_type : 'free',
        status: subscription ? subscription.status : 'none',
        expiresAt: subscription ? subscription.current_period_end : null,
      },
      video: {
        title: video?.title ?? `Uploaded Video ${videoId}`,
        fullDuration,
        previewDuration,
        playlistUrl,
        isLivestream,
        livestreamStatus,
        livestreamProvider: livestream?.provider ?? null,
        livestreamPlaybackUrl,
        livestreamRecordingVideoId: livestreamRecordingId,
        livestreamUnavailableReason: isLivestream && !playlistUrl
          ? 'Live stream is not yet attached. Add a playback URL or swap in the recorded VOD.'
          : null,
      },
      chapters: [
        { title: 'Preview', startTime: 0, endTime: previewDuration, accessible: true },
        { title: 'Full Content', startTime: previewDuration, endTime: fullDuration, accessible: hasAccess },
      ],
    }
    return jsonResponse(response, 200, corsHeaders)
  } catch (error) {
    console.error('Error:', error)
    return jsonResponse({ error: getPublicErrorMessage('Internal server error') }, 500, corsHeaders)
  }
}

async function handleVideoProxy(request: any, env: any, corsHeaders: any, ctx: any) {
  const requestUrl = new URL(request.url)
  const proxyPrefix = '/api/video-proxy/'
  const objectPath = requestUrl.pathname.slice(proxyPrefix.length)
  const previewUntil = Number.parseFloat(requestUrl.searchParams.get('previewUntil') ?? '')
  const previewUntilSeconds = Number.isFinite(previewUntil) && previewUntil >= 0 ? previewUntil : null
  if (!objectPath) return jsonResponse({ error: 'Missing proxied object path' }, 400, corsHeaders)

  // This platform is HLS-only. Explicitly reject DASH manifest requests (.mpd)
  // so they fail clearly rather than passing through the proxy unprocessed
  // (where preview limits would not be enforced).
  if (objectPath.endsWith('.mpd')) {
    return jsonResponse({ error: 'DASH streaming is not supported. Use HLS.' }, 410, corsHeaders)
  }

  // Normalize the path to resolve any dot-segments, leading slashes, etc.
  // This prevents rewritten URLs from rewriteSegmentPath() that produce root-relative
  // or dot-containing paths from bypassing the subtree check.
  let normalizedPath
  try {
    // Use WHATWG URL to normalize the path (resolves dots and removes leading slash)
    const tempUrl = new URL(objectPath, 'http://dummy')
    normalizedPath = tempUrl.pathname.replace(/^\/+/, '') // strip leading slashes
  } catch {
    return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders)
  }

  // Enforce that the normalized path is within the videos/ subtree
  if (!normalizedPath.startsWith('videos/')) {
    return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders)
  }

  // Reject dot-segment traversal in the normalized path
  // Decoding catches percent-encoded forms like %2e%2e
  const pathSegments = normalizedPath.split('/')
  for (const seg of pathSegments) {
    let decoded
    try { decoded = decodeURIComponent(seg) } catch {
      return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders)
    }
    if (decoded === '.' || decoded === '..') {
      return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders)
    }
  }

  // ── Step 4a: Validate the signed video token ──────────────────────────────
  // Every proxy request must carry a valid short-lived HMAC token issued by
  // handleVideoAccess.  This prevents direct enumeration / bulk downloading of
  // R2 segment URLs without going through the access-control layer.
  let tokenClaims = null
  if (env.JWT_SECRET) {
    const vtParam = requestUrl.searchParams.get('vt')
    if (!vtParam) {
      return new Response(JSON.stringify({ error: 'Missing video token' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }
    try {
      tokenClaims = await verifyVideoToken(vtParam, env.JWT_SECRET)
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid or expired video token' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }
  }

  // Extract and decode videoId from path (videos/{id}/...). URL paths preserve
  // percent-encoding (e.g. spaces as %20), while signed tokens use decoded IDs.
  const proxyVideoId = getProxyVideoIdFromPath(normalizedPath)
  if (!proxyVideoId) {
    return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders)
  }

  // Verify token claims match the requested video
  if (tokenClaims && tokenClaims.videoId !== proxyVideoId) {
    return new Response(JSON.stringify({ error: 'Video token does not match requested video' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }

  // Enforce previewUntil from token claims
  let effectivePreviewUntil = previewUntilSeconds
  if (tokenClaims && tokenClaims.previewUntil !== null && tokenClaims.previewUntil !== undefined) {
    // Token has a preview limit - enforce it
    effectivePreviewUntil = tokenClaims.previewUntil
  } else if (tokenClaims && (tokenClaims.previewUntil === null || tokenClaims.previewUntil === undefined)) {
    // Token grants full access (no preview limit)
    effectivePreviewUntil = null
  }

  // Strip vt from the upstream URL — R2 doesn't need it
  const upstreamUrl = new URL(`${env.R2_BASE_URL}/${objectPath}`)
  const upstreamHeaders = new Headers()
  const rangeHeader = request.headers.get('Range')
  if (rangeHeader) upstreamHeaders.set('Range', rangeHeader)

  // vt to propagate to rewritten manifest/segment URLs
  const vtForRewrite = requestUrl.searchParams.get('vt') ?? null

  const isSegment = objectPath.endsWith('.m4s')
  let segmentDurationForAnalytics = null

  // ── Step 4c: Segment count rate limiting ─────────────────────────────────
  if (isSegment && env.RATE_LIMIT_KV) {
    let authUser = null
    try { authUser = await requireAuth(request, env) } catch { /* anonymous */ }
    const identifier = authUser?.sub ?? request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const avgDur = await getAvgSegmentDuration(proxyVideoId, env)
    segmentDurationForAnalytics = avgDur
    const limited = await checkSegmentRateLimit(identifier, proxyVideoId, avgDur, env)
    if (limited) {
      return new Response(JSON.stringify({ error: 'Too many segment requests. Slow down.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '30', ...corsHeaders },
      })
    }
  }

  const upstreamResponse = await fetch(upstreamUrl, { method: request.method, headers: upstreamHeaders })

  if (isSegment) {
    const referer = request.headers.get('referer') || ''
    let sourceHost = null
    try { sourceHost = referer ? (new URL(referer)).host : null } catch {}
    // Segment filenames are usually ordinal indexes (e.g. segment-42.m4s), not
    // wall-clock playback seconds, unless a specific packager naming scheme is used.
    const segmentMatch = normalizedPath.match(/(\d+)(?:\.\w+)?$/)
    const segmentIndex = segmentMatch ? Number(segmentMatch[1]) : null
    const rawIp = request.headers.get('CF-Connecting-IP')
    const ipHash = rawIp ? await sha256Hex(rawIp) : null
    ctx?.waitUntil?.(logSegmentEvent(env, {
      videoId: proxyVideoId,
      userId: tokenClaims?.userId || null,
      requestPath: normalizedPath,
      eventType: 'segment',
      segmentIndex,
      segmentDurationSeconds: segmentDurationForAnalytics,
      referer,
      sourceHost,
      ipHash,
    }))
  }

  const manifestType = getManifestType(objectPath, upstreamResponse)
  if (manifestType === 'hls') {
    const manifest = await upstreamResponse.text()
    const rewrittenManifest = rewriteManifestForProxyWithPreview(manifest, effectivePreviewUntil, objectPath, vtForRewrite)
    const headers = new Headers(upstreamResponse.headers)
    headers.set('Content-Type', 'application/vnd.apple.mpegurl')
    const cacheControl = getVideoProxyCacheControl(objectPath, manifestType)
    if (cacheControl) headers.set('Cache-Control', cacheControl)
    headers.delete('Content-Length')
    for (const [k, v] of Object.entries(corsHeaders as CorsHeaders)) headers.set(k, v)
    return new Response(rewrittenManifest, { status: upstreamResponse.status, headers })
  }
  const headers = new Headers(upstreamResponse.headers)
  const cacheControl = getVideoProxyCacheControl(objectPath, manifestType)
  if (cacheControl) headers.set('Cache-Control', cacheControl)
  for (const [k, v] of Object.entries(corsHeaders as CorsHeaders)) headers.set(k, v)
  return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers })
}

async function handleBootstrap(request: any, env: any, corsHeaders: any) {
  const body = await request.json().catch(() => null)
  if (!body?.email || typeof body.email !== 'string') {
    return jsonResponse({ error: 'email is required' }, 400, corsHeaders)
  }
  const email = body.email.toLowerCase().trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: 'Invalid email format' }, 400, corsHeaders)
  }

  const db = getDatabaseBinding(env)

  // Guard: only allow bootstrap when no super_admin exists
  const existingAdmin = await db
    .prepare("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1")
    .first()
  if (existingAdmin) {
    return jsonResponse({ error: 'Bootstrap already completed — a super_admin already exists.' }, 409, corsHeaders)
  }

  // Upsert: promote existing user or create new one
  const existingUser = await db
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first()
  if (existingUser) {
    await db
      .prepare("UPDATE users SET role = 'super_admin' WHERE id = ?")
      .bind(existingUser.id)
      .run()
  } else {
    await db
      .prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'super_admin')")
      .bind(crypto.randomUUID(), email)
      .run()
  }

  return jsonResponse({ ok: true, message: `${email} is now super_admin. Sign in via magic link to access admin features.` }, 200, corsHeaders)
}

async function handleAdminConfig(request: any, env: any, corsHeaders: any) {
  const db = getDatabaseBinding(env)
  await ensureAdminSettingsTable(db)

  if (request.method === 'GET') {
    const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ? LIMIT 1').bind('homepage').first()
    const value = normalizeHomepageConfig(safeJsonParse(row?.value, defaultHomepageConfig()))
    return jsonResponse({ config: value }, 200, corsHeaders)
  }

  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch (error) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const body = await request.json().catch(() => null)
  if (!body?.config || typeof body.config !== 'object') return jsonResponse({ error: 'config object is required' }, 400, corsHeaders)
  const normalized = normalizeHomepageConfig(body.config)
  await db.prepare(`INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind('homepage', JSON.stringify(normalized)).run()
  return jsonResponse({ ok: true, config: normalized }, 200, corsHeaders)
}

async function handlePreviewLocks(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch (error) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const body = await request.json().catch(() => null)
  if (!Array.isArray(body?.locks)) return jsonResponse({ error: 'locks array is required' }, 400, corsHeaders)
  const db = getDatabaseBinding(env)
  for (const lockEntry of body.locks) {
    if (!lockEntry || typeof lockEntry.videoId !== 'string') continue
    const lockSeconds = Number.parseInt(lockEntry.previewDuration, 10)
    if (!Number.isFinite(lockSeconds) || lockSeconds < 0) continue
    // When full_duration = 0 (unprocessed draft), MIN would clamp preview to 0.
    // Treat 0 as "unknown duration" and store the requested value as-is.
    await db.prepare(`
      UPDATE videos
      SET preview_duration = CASE WHEN full_duration = 0 THEN ? ELSE MIN(full_duration, ?) END
      WHERE id = ?
    `).bind(lockSeconds, lockSeconds, lockEntry.videoId).run()
  }
  return jsonResponse({ ok: true }, 200, corsHeaders)
}

async function handleAdminCategories(request: any, env: any, corsHeaders: any) {
  try {
    const method = request.method
    const db = getDatabaseBinding(env)

    if (method === 'GET') {
      try {
        await requireRole(request, env, 'editor', 'admin', 'super_admin')
      } catch {
        return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
      }
      const rows = await db.prepare(`
        SELECT vc.id, vc.slug, vc.name, vc.sort_order, vc.direction, vc.homepage_layout_variant, COUNT(vca.video_id) AS video_count
        FROM video_categories vc
        LEFT JOIN video_category_assignments vca ON vca.category_id = vc.id
        GROUP BY vc.id
        ORDER BY vc.sort_order ASC, vc.name ASC
      `).all()
      return jsonResponse({ categories: rows?.results ?? [] }, 200, corsHeaders)
    }

    try {
      await requireRole(request, env, 'admin', 'super_admin')
    } catch {
      return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return jsonResponse({ error: 'Request body is required' }, 400, corsHeaders)
    }

    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const slug = typeof body.slug === 'string' ? sanitizeSlug(body.slug) : ''
      const sortOrder = Number.isInteger(body.sortOrder) ? body.sortOrder : 0
      const direction = body.direction === 'asc' ? 'asc' : 'desc'
      const homepageLayoutVariant = normalizeHomepageLayoutVariant(body.homepageLayoutVariant)
      if (!name) return jsonResponse({ error: 'name is required' }, 400, corsHeaders)
      if (!isValidSlug(slug)) return jsonResponse({ error: 'slug must be lowercase alphanumeric words separated by hyphens' }, 400, corsHeaders)
      try {
        await db.prepare(`
          INSERT INTO video_categories (id, slug, name, sort_order, direction, homepage_layout_variant)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(crypto.randomUUID(), slug, name, sortOrder, direction, homepageLayoutVariant).run()
        return jsonResponse({ ok: true }, 201, corsHeaders)
      } catch (err) {
        if (getErrorMessage(err).includes('UNIQUE')) {
          return jsonResponse({ error: 'Category slug already exists' }, 409, corsHeaders)
        }
        throw err
      }
    }

    if (method === 'PATCH') {
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!id) return jsonResponse({ error: 'id is required' }, 400, corsHeaders)
      const updates = []
      const values = []
      if (typeof body.name === 'string') {
        const name = body.name.trim()
        if (!name) return jsonResponse({ error: 'name must not be empty' }, 400, corsHeaders)
        updates.push('name = ?')
        values.push(name)
      }
      if (typeof body.slug === 'string') {
        const slug = sanitizeSlug(body.slug)
        if (!isValidSlug(slug)) return jsonResponse({ error: 'slug must be lowercase alphanumeric words separated by hyphens' }, 400, corsHeaders)
        updates.push('slug = ?')
        values.push(slug)
      }
      if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
        if (!Number.isInteger(body.sortOrder)) return jsonResponse({ error: 'sortOrder must be an integer' }, 400, corsHeaders)
        updates.push('sort_order = ?')
        values.push(body.sortOrder)
      }
      if (Object.prototype.hasOwnProperty.call(body, 'direction')) {
        if (!['asc', 'desc'].includes(body.direction)) return jsonResponse({ error: 'direction must be asc or desc' }, 400, corsHeaders)
        updates.push('direction = ?')
        values.push(body.direction)
      }
      if (Object.prototype.hasOwnProperty.call(body, 'homepageLayoutVariant')) {
        updates.push('homepage_layout_variant = ?')
        values.push(normalizeHomepageLayoutVariant(body.homepageLayoutVariant))
      }
      if (!updates.length) return jsonResponse({ error: 'No category fields to update' }, 400, corsHeaders)
      values.push(id)
      try {
        const result = await db.prepare(`UPDATE video_categories SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run()
        const changes = result.meta?.changes ?? result.changes ?? 0
        if (!changes) {
          const existing = await db.prepare('SELECT id FROM video_categories WHERE id = ?').bind(id).first()
          if (!existing) return jsonResponse({ error: 'Category not found' }, 404, corsHeaders)
          return jsonResponse({ ok: true, updated: false }, 200, corsHeaders)
        }
        return jsonResponse({ ok: true }, 200, corsHeaders)
      } catch (err) {
        if (getErrorMessage(err).includes('UNIQUE')) {
          return jsonResponse({ error: 'Category slug already exists' }, 409, corsHeaders)
        }
        throw err
      }
    }

    if (method === 'DELETE') {
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      const reassignToCategoryId = typeof body.reassignToCategoryId === 'string' && body.reassignToCategoryId.trim()
        ? body.reassignToCategoryId.trim()
        : null
      if (!id) return jsonResponse({ error: 'id is required' }, 400, corsHeaders)

      const category = await db.prepare('SELECT id FROM video_categories WHERE id = ?').bind(id).first()
      if (!category) return jsonResponse({ error: 'Category not found' }, 404, corsHeaders)

      if (reassignToCategoryId) {
        if (reassignToCategoryId === id) return jsonResponse({ error: 'reassignToCategoryId must be different from deleted category' }, 400, corsHeaders)
        const reassignCategory = await db.prepare('SELECT id FROM video_categories WHERE id = ?').bind(reassignToCategoryId).first()
        if (!reassignCategory) return jsonResponse({ error: 'Reassignment category not found' }, 404, corsHeaders)
      const reassignStmt = db.prepare(`
          UPDATE video_category_assignments
          SET category_id = ?
          WHERE category_id = ?
        `).bind(reassignToCategoryId, id)
      const deleteStmt = db.prepare('DELETE FROM video_categories WHERE id = ?').bind(id)
      const [, deleteResult] = await db.batch([reassignStmt, deleteStmt])
      const deleteChanges = deleteResult.meta?.changes ?? deleteResult.changes ?? 0
      if (!deleteChanges) return jsonResponse({ error: 'Category not found' }, 404, corsHeaders)
        return jsonResponse({ ok: true }, 200, corsHeaders)
      }

      const deleteResult = await db.prepare(`
        DELETE FROM video_categories
        WHERE id = ?
          AND NOT EXISTS (
            SELECT 1 FROM video_category_assignments WHERE category_id = ?
          )
      `).bind(id, id).run()
      const changes = deleteResult.meta?.changes ?? deleteResult.changes ?? 0
      if (!changes) {
        return jsonResponse({ error: 'Category has assigned videos. Reassign them before deletion.' }, 409, corsHeaders)
      }
      return jsonResponse({ ok: true }, 200, corsHeaders)
    }

    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  } catch (err) {
    const codeField = getErrorField(err, 'code')
    console.error('handleVideoCategories error:', err)
    return jsonResponse({
      error: getPublicErrorMessage('Internal Server Error'),
      code: typeof codeField === 'string' ? codeField : 'internal_error',
    }, 500, corsHeaders)
  }
}

async function handleAdminVideosList(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const db = getDatabaseBinding(env)
  try {
    // ── 1. Auto-register any R2 uploads that have no D1 row ──────────────────
    if (env.BUCKET) {
      const listed = await env.BUCKET.list({ prefix: 'videos/', delimiter: '/' })
      const r2VideoIds = (listed.delimitedPrefixes ?? []).map((prefix: any) => {
        // prefix looks like "videos/abc123/" — extract the folder name
        const parts = prefix.replace(/\/$/, '').split('/')
        return parts[parts.length - 1]
      }).filter(Boolean)

      for (const r2Id of r2VideoIds) {
        // Register every R2 video folder as a draft regardless of whether
        // processed artifacts exist yet — source-only and mid-processing
        // videos should still appear in the admin list.
        await db.prepare(`
          INSERT OR IGNORE INTO videos (id, title, publish_status, upload_date, full_duration, preview_duration)
          VALUES (?, 'Untitled upload', 'draft', CURRENT_TIMESTAMP, 0, 0)
        `).bind(r2Id).run()
      }
    }

    // ── 2. Fetch all videos from D1 ──────────────────────────────────────────
    let videos
    videos = await db.prepare(`
      WITH view_counts AS (
        SELECT
          video_id,
          COUNT(DISTINCT COALESCE(
            session_key,
            CASE
              WHEN user_id IS NOT NULL THEN 'u:' || user_id
              WHEN ip_hash IS NOT NULL THEN 'i:' || ip_hash
              ELSE 'path:' || request_path
            END
          )) AS total_views
        FROM video_segment_events
        WHERE event_type = 'segment'
        GROUP BY video_id
      )
      SELECT v.id, v.title, v.description, v.thumbnail_url, v.full_duration, v.preview_duration,
             v.upload_date, v.status, v.publish_status, v.published_at, v.updated_at, v.slug,
             v.scheduled_publish_at, v.notified_at,
             vca.category_id, COALESCE(vc.total_views, 0) AS total_views,
             ls.provider AS livestream_provider,
             ls.status AS livestream_status,
             ls.stream_id AS livestream_stream_id,
             ls.stream_key AS livestream_stream_key,
             ls.ingest_url AS livestream_ingest_url,
             ls.playback_url AS livestream_playback_url,
             ls.recording_video_id AS livestream_recording_video_id
      FROM videos v
      LEFT JOIN video_category_assignments vca ON vca.video_id = v.id
      LEFT JOIN view_counts vc ON vc.video_id = v.id
      LEFT JOIN livestreams ls ON ls.video_id = v.id
      ORDER BY v.upload_date DESC
    `).all()

    // ── 3. Annotate each row with r2_exists ──────────────────────────────────
    const annotated = await Promise.all((videos.results || []).map(async (video: any) => {
      let r2Exists = null
      if (video?.livestream_provider) {
        r2Exists = true
      } else if (env.BUCKET) {
        r2Exists = await hasProcessedPlaybackArtifact(env.BUCKET, video.id)
      }
      return { ...video, r2_exists: r2Exists }
    }))

    return jsonResponse({ videos: annotated }, 200, corsHeaders)
  } catch (error) {
    console.error('Error:', error)
    return jsonResponse({ error: getPublicErrorMessage('Internal server error') }, 500, corsHeaders)
  }
}

async function handleAdminLivestreamCreate(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return jsonResponse({ error: 'Request body is required' }, 400, corsHeaders)

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) return jsonResponse({ error: 'title is required' }, 400, corsHeaders)

  const description = typeof body.description === 'string' ? body.description.trim() : null
  const slug = typeof body.slug === 'string' && body.slug.trim() ? sanitizeSlug(body.slug) : null
  const publishStatus = typeof body.publishStatus === 'string' ? body.publishStatus : 'draft'
  if (!['draft', 'published', 'archived'].includes(publishStatus)) {
    return jsonResponse({ error: 'publishStatus must be one of: draft, published, archived' }, 400, corsHeaders)
  }
  if (slug && !isValidSlug(slug)) {
    return jsonResponse({ error: 'slug must be lowercase alphanumeric words separated by hyphens' }, 400, corsHeaders)
  }

  const provider = 'cloudflare_realtime'
  const livestreamStatus = normalizeLivestreamStatus(body.status, 'provisioning')

  const categoryId = typeof body.categoryId === 'string' && body.categoryId.trim() ? body.categoryId.trim() : null
  const db = getDatabaseBinding(env)
  if (categoryId) {
    const category = await db.prepare(`SELECT id FROM video_categories WHERE id = ?`).bind(categoryId).first()
    if (!category) {
      return jsonResponse({ error: 'Category not found', code: 'category_not_found' }, 404, corsHeaders)
    }
  }
  if (slug) {
    const conflict = await db.prepare('SELECT 1 FROM videos WHERE slug = ? OR id = ? LIMIT 1').bind(slug, slug).first()
    if (conflict) return jsonResponse({ error: 'Slug already in use or conflicts with an existing video ID' }, 409, corsHeaders)
  }

  const videoId = crypto.randomUUID()
  const publishedAt = publishStatus === 'published' ? new Date().toISOString() : null

  await db.prepare(`
    INSERT INTO videos (
      id, title, description, full_duration, preview_duration, status, publish_status, published_at, slug, upload_date, updated_at
    )
    VALUES (?, ?, ?, 0, 0, 'processed', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(videoId, title, description, publishStatus, publishedAt, slug).run()

  await db.prepare(`
    INSERT INTO livestreams (
      video_id, provider, stream_id, stream_key, ingest_url, playback_url, status, started_at, ended_at, updated_at
    )
    VALUES (?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, CURRENT_TIMESTAMP)
  `).bind(videoId, provider, livestreamStatus).run()

  if (categoryId) {
    await db.prepare(`
      INSERT INTO video_category_assignments (video_id, category_id, assigned_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(video_id) DO UPDATE SET category_id = excluded.category_id, assigned_at = CURRENT_TIMESTAMP
    `).bind(videoId, categoryId).run()
  }

  const provisionResult = await provisionLivestreamForVideo({
    db,
    env,
    videoId,
    livestreamTitle: title,
    force: false,
  })

  const livestreamVideo = await getAdminVideoById(db, videoId)
  return jsonResponse({
    ok: true,
    video: livestreamVideo,
    provisioning: provisionResult.ok
      ? { ok: true, skipped: ('skipped' in provisionResult) ? Boolean(provisionResult.skipped) : false }
      : { ok: false, code: provisionResult.code, error: provisionResult.error },
  }, 201, corsHeaders)
}

async function getAdminVideoById(db: any, videoId: string) {
  return db.prepare(`
    SELECT v.id, v.title, v.description, v.thumbnail_url, v.full_duration, v.preview_duration,
           v.upload_date, v.status, v.publish_status, v.published_at, v.updated_at, v.slug, vca.category_id,
           ls.provider AS livestream_provider,
           ls.status AS livestream_status,
           ls.stream_id AS livestream_stream_id,
           ls.stream_key AS livestream_stream_key,
           ls.ingest_url AS livestream_ingest_url,
           ls.playback_url AS livestream_playback_url,
           ls.recording_video_id AS livestream_recording_video_id
    FROM videos v
    LEFT JOIN video_category_assignments vca ON vca.video_id = v.id
    LEFT JOIN livestreams ls ON ls.video_id = v.id
    WHERE v.id = ?
    LIMIT 1
  `).bind(videoId).first()
}

async function provisionLivestreamForVideo({
  db,
  env,
  videoId,
  livestreamTitle,
  force,
}: {
  db: any
  env: any
  videoId: string
  livestreamTitle: string
  force: boolean
}) {
  const row = await db.prepare(`
    SELECT stream_id, status
    FROM livestreams
    WHERE video_id = ?
    LIMIT 1
  `).bind(videoId).first()
  if (!row) return { ok: false, error: 'Livestream not found', code: 'livestream_not_found' as const }

  const existingStreamId = typeof row.stream_id === 'string' && row.stream_id.trim() ? row.stream_id.trim() : null
  if (existingStreamId && !force) {
    return { ok: true, skipped: true, reason: 'already_provisioned' as const }
  }

  await db.prepare(`
    UPDATE livestreams
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE video_id = ?
  `).bind('provisioning', videoId).run()

  try {
    const provisioned = await createCloudflareLivestream(env, { metaName: livestreamTitle || `livestream-${videoId}` })
    console.info('Cloudflare livestream provisioned', JSON.stringify({
      videoId,
      provider: 'cloudflare_realtime',
      response: sanitizeCloudflareLivestreamResponse(provisioned.raw),
    }))
    await db.prepare(`
      UPDATE livestreams
      SET provider = ?,
          stream_id = ?,
          stream_key = ?,
          ingest_url = ?,
          playback_url = ?,
          status = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE video_id = ?
    `).bind(
      'cloudflare_realtime',
      provisioned.uid,
      provisioned.streamKey,
      provisioned.rtmpUrl,
      provisioned.playbackHls,
      'ready',
      videoId,
    ).run()
    return { ok: true, skipped: false }
  } catch (error) {
    await db.prepare(`
      UPDATE livestreams
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE video_id = ?
    `).bind('failed', videoId).run()
    console.error('Cloudflare livestream provisioning failed', {
      videoId,
      error: getErrorMessage(error),
    })
    return {
      ok: false,
      error: getErrorMessage(error),
      code: 'provisioning_failed' as const,
    }
  }
}

async function handleAdminLivestreamUpdate(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const url = new URL(request.url)
  const videoId = getAdminVideoIdFromPath(url.pathname)
  if (!videoId) return jsonResponse({ error: 'Missing videoId' }, 400, corsHeaders)

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return jsonResponse({ error: 'Request body is required' }, 400, corsHeaders)

  const updates = []
  const values = []
  if (typeof body.provider === 'string') {
    updates.push('provider = ?')
    values.push(body.provider.trim() || 'cloudflare_realtime')
  }
  if (Object.prototype.hasOwnProperty.call(body, 'streamId')) {
    updates.push('stream_id = ?')
    values.push(typeof body.streamId === 'string' && body.streamId.trim() ? body.streamId.trim() : null)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'streamKey')) {
    updates.push('stream_key = ?')
    values.push(typeof body.streamKey === 'string' && body.streamKey.trim() ? body.streamKey.trim() : null)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'ingestUrl')) {
    updates.push('ingest_url = ?')
    values.push(typeof body.ingestUrl === 'string' && body.ingestUrl.trim() ? body.ingestUrl.trim() : null)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'playbackUrl')) {
    const playbackUrl = typeof body.playbackUrl === 'string' && body.playbackUrl.trim() ? body.playbackUrl.trim() : null
    if (playbackUrl) {
      try {
        const parsed = new URL(playbackUrl)
        if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('invalid_protocol')
      } catch {
        return jsonResponse({ error: 'playbackUrl must be a valid http(s) URL' }, 400, corsHeaders)
      }
    }
    updates.push('playback_url = ?')
    values.push(playbackUrl)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    updates.push('status = ?')
    values.push(normalizeLivestreamStatus(body.status, 'draft'))
  }
  if (Object.prototype.hasOwnProperty.call(body, 'recordingVideoId')) {
    const recordingVideoId = typeof body.recordingVideoId === 'string' && body.recordingVideoId.trim()
      ? body.recordingVideoId.trim()
      : null
    if (recordingVideoId) {
      const db = getDatabaseBinding(env)
      const recordingVideo = await db.prepare('SELECT id FROM videos WHERE id = ?').bind(recordingVideoId).first()
      if (!recordingVideo) {
        return jsonResponse({ error: 'recordingVideoId must reference an existing video' }, 400, corsHeaders)
      }
    }
    updates.push('recording_video_id = ?')
    values.push(recordingVideoId)
  }

  if (!updates.length) return jsonResponse({ error: 'No livestream fields to update' }, 400, corsHeaders)

  const db = getDatabaseBinding(env)
  values.push(videoId)
  const result = await db.prepare(`
    UPDATE livestreams
    SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
    WHERE video_id = ?
  `).bind(...values).run()

  const changes = result.meta?.changes ?? result.changes ?? 0
  if (!changes) return jsonResponse({ error: 'Livestream not found' }, 404, corsHeaders)

  const livestreamVideo = await getAdminVideoById(db, videoId)

  return jsonResponse({ ok: true, video: livestreamVideo }, 200, corsHeaders)
}

async function handleAdminLivestreamProvision(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  const url = new URL(request.url)
  const videoId = getAdminVideoIdFromPath(url.pathname)
  if (!videoId) return jsonResponse({ error: 'Missing videoId' }, 400, corsHeaders)

  const db = getDatabaseBinding(env)
  const video = await db.prepare('SELECT id, title FROM videos WHERE id = ? LIMIT 1').bind(videoId).first()
  if (!video) return jsonResponse({ error: 'Video not found' }, 404, corsHeaders)
  const livestream = await db.prepare('SELECT video_id FROM livestreams WHERE video_id = ? LIMIT 1').bind(videoId).first()
  if (!livestream) return jsonResponse({ error: 'Livestream not found' }, 404, corsHeaders)

  const result = await provisionLivestreamForVideo({
    db,
    env,
    videoId,
    livestreamTitle: video.title ?? `livestream-${videoId}`,
    force: true,
  })
  const updatedVideo = await getAdminVideoById(db, videoId)
  if (!result.ok) {
    return jsonResponse({
      error: result.error || 'Provisioning failed',
      code: result.code || 'provisioning_failed',
      video: updatedVideo,
    }, 502, corsHeaders)
  }
  return jsonResponse({ ok: true, video: updatedVideo }, 200, corsHeaders)
}

async function handleAdminVideoUpdate(request: any, env: any, ctx: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const url = new URL(request.url)
  const videoId = getAdminVideoIdFromPath(url.pathname)
  if (!videoId) return jsonResponse({ error: 'Missing videoId' }, 400, corsHeaders)

  const body = await request.json().catch(() => null)
  if (!body) return jsonResponse({ error: 'Request body is required' }, 400, corsHeaders)

  const allowedStatuses = ['draft', 'published', 'archived']
  const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status')
  const hasTitle  = Object.prototype.hasOwnProperty.call(body, 'title')
  const hasSlug   = Object.prototype.hasOwnProperty.call(body, 'slug')
  const hasCategoryId = Object.prototype.hasOwnProperty.call(body, 'categoryId')
  const hasDescription = Object.prototype.hasOwnProperty.call(body, 'description')
  const hasScheduledPublishAt = Object.prototype.hasOwnProperty.call(body, 'scheduledPublishAt')
  const hasPublishedAt = Object.prototype.hasOwnProperty.call(body, 'publishedAt')
  const hasUploadDate = Object.prototype.hasOwnProperty.call(body, 'uploadDate')

  if (!hasStatus && !hasTitle && !hasSlug && !hasCategoryId && !hasDescription && !hasScheduledPublishAt && !hasPublishedAt && !hasUploadDate) {
    return jsonResponse({ error: 'At least one of status, title, slug, description, categoryId, scheduledPublishAt, publishedAt, or uploadDate must be provided' }, 400, corsHeaders)
  }
  if (hasTitle && (typeof body.title !== 'string' || body.title.trim().length === 0)) {
    return jsonResponse({ error: 'title must not be empty' }, 400, corsHeaders)
  }
  if (hasStatus && !allowedStatuses.includes(body.status)) {
    return jsonResponse({ error: 'status must be one of: draft, published, archived' }, 400, corsHeaders)
  }
  const normalizedSlug = hasSlug && body.slug !== null
    ? (typeof body.slug === 'string' ? sanitizeSlug(body.slug) : null)
    : null
  if (hasSlug && body.slug !== null && !normalizedSlug) {
    return jsonResponse({ error: 'slug must be lowercase alphanumeric words separated by hyphens (e.g. my-video-title), or null to clear it' }, 400, corsHeaders)
  }
  if (normalizedSlug && !isValidSlug(normalizedSlug)) {
    return jsonResponse({ error: 'slug must be lowercase alphanumeric words separated by hyphens (e.g. my-video-title), or null to clear it' }, 400, corsHeaders)
  }
  const scheduledPublishAt = normalizeScheduledPublishAt(body.scheduledPublishAt, { allowNull: true })
  if (hasScheduledPublishAt && scheduledPublishAt.invalid) {
    return jsonResponse({ error: 'scheduledPublishAt must be a valid ISO timestamp, or null to clear schedule' }, 400, corsHeaders)
  }
  const uploadDateNorm = normalizePublishedAt(body.uploadDate, { allowNull: false })
  if (hasUploadDate && uploadDateNorm.invalid) {
    return jsonResponse({ error: 'uploadDate must be a valid ISO timestamp and may not be null' }, 400, corsHeaders)
  }
  const publishedAt = normalizePublishedAt(body.publishedAt, { allowNull: true })
  if (hasPublishedAt && publishedAt.invalid) {
    return jsonResponse({ error: 'publishedAt must be a valid ISO timestamp, or null to clear it' }, 400, corsHeaders)
  }
  if (hasScheduledPublishAt && body.scheduledPublishAt !== null && hasStatus && body.status === 'published') {
    return jsonResponse({
      error: 'Conflicting payload: scheduledPublishAt cannot be provided when status is published',
      code: 'invalid_payload',
    }, 400, corsHeaders)
  }
  if (hasScheduledPublishAt && body.scheduledPublishAt !== null && hasPublishedAt && body.publishedAt !== null) {
    return jsonResponse({
      error: 'Conflicting payload: scheduledPublishAt cannot be combined with publishedAt',
      code: 'invalid_payload',
    }, 400, corsHeaders)
  }
  if (hasScheduledPublishAt && scheduledPublishAt.backdatesUpload && hasUploadDate) {
    return jsonResponse({
      error: 'Conflicting payload: backdating scheduledPublishAt cannot be combined with uploadDate',
      code: 'invalid_payload',
    }, 400, corsHeaders)
  }

  const db = getDatabaseBinding(env)
  const videoExists = await db.prepare('SELECT publish_status FROM videos WHERE id = ?').bind(videoId).first()
  if (!videoExists) return jsonResponse({ error: 'Video not found' }, 404, corsHeaders)
  if (hasPublishedAt && body.publishedAt !== null) {
    const nextPublished = hasStatus ? body.status === 'published' : videoExists.publish_status === 'published'
    if (!nextPublished) {
      return jsonResponse({ error: 'publishedAt can only be set for published videos' }, 400, corsHeaders)
    }
  }
  const livestreamRow = await db.prepare('SELECT video_id FROM livestreams WHERE video_id = ? LIMIT 1').bind(videoId).first()
  const isLivestreamVideo = Boolean(livestreamRow)

  // Guard: refuse to publish if the processed playlist is missing from R2.
  // Livestream videos are allowed to publish without an uploaded VOD.
  if (hasStatus && body.status === 'published' && env.BUCKET && !isLivestreamVideo) {
    const exists = await hasProcessedPlaybackArtifact(env.BUCKET, videoId)
    if (!exists) {
      return jsonResponse({
        error: 'Cannot publish: processed media not found in R2. Upload and process the video first.',
        code: 'r2_missing',
      }, 422, corsHeaders)
    }
  }
  let validatedCategoryId = null
  if (hasCategoryId) {
    if (body.categoryId === null) {
      validatedCategoryId = null
    } else if (typeof body.categoryId === 'string' && body.categoryId.trim()) {
      validatedCategoryId = body.categoryId.trim()
      const category = await db.prepare(`SELECT id FROM video_categories WHERE id = ?`).bind(validatedCategoryId).first()
      if (!category) {
        return jsonResponse({ error: 'Category not found', code: 'category_not_found' }, 404, corsHeaders)
      }
    } else {
      return jsonResponse({ error: 'categoryId must be a string or null' }, 400, corsHeaders)
    }
  }

  // Guard: reject a slug that equals another video's id — resolveVideoByIdOrSlug
  // resolves by id before slug, so the slug would become permanently shadowed.
  if (hasSlug && normalizedSlug) {
    const idCollision = await db.prepare(
      'SELECT 1 FROM videos WHERE id = ? AND id != ? LIMIT 1'
    ).bind(normalizedSlug, videoId).first()
    if (idCollision) {
      return jsonResponse({ error: 'Slug conflicts with an existing video ID' }, 409, corsHeaders)
    }
  }

  try {
    // When both title and slug are supplied, write them atomically so a slug
    // constraint violation cannot leave the title committed but the slug not.
    if (hasTitle || hasSlug) {
      try {
        if (hasTitle && hasSlug) {
          await db.prepare(`UPDATE videos SET title = ?, slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .bind(body.title.trim(), normalizedSlug ?? null, videoId).run()
        } else if (hasTitle) {
          await db.prepare(`UPDATE videos SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .bind(body.title.trim(), videoId).run()
        } else {
          await db.prepare(`UPDATE videos SET slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .bind(normalizedSlug ?? null, videoId).run()
        }
      } catch (err) {
        if (getErrorMessage(err).includes('UNIQUE')) {
          return jsonResponse({ error: 'Slug already in use by another video' }, 409, corsHeaders)
        }
        throw err
      }
    }

    if (hasDescription) {
      const desc = typeof body.description === 'string' ? body.description.trim() : ''
      await db.prepare(`UPDATE videos SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(desc, videoId).run()
    }

    if (hasCategoryId) {
      if (validatedCategoryId === null) {
        await db.prepare(`DELETE FROM video_category_assignments WHERE video_id = ?`).bind(videoId).run()
      } else {
        await db.prepare(`
          INSERT INTO video_category_assignments (video_id, category_id, assigned_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(video_id) DO UPDATE SET category_id = excluded.category_id, assigned_at = CURRENT_TIMESTAMP
        `).bind(videoId, validatedCategoryId).run()
      }
    }
    if (hasScheduledPublishAt) {
      if (scheduledPublishAt.value) {
        const expectedPublishStatus = videoExists.publish_status
        const staleStatusPayload = {
          error: 'Cannot backdate scheduledPublishAt for a published video. Use uploadDate instead.',
          code: 'invalid_payload',
        }
        const concurrentChangePayload = {
          error: 'Video state changed concurrently, please retry',
          code: 'conflict',
        }
        if (scheduledPublishAt.backdatesUpload) {
          if (expectedPublishStatus === 'published') {
            return jsonResponse(staleStatusPayload, 409, corsHeaders)
          }
        }
        const setClause = scheduledPublishAt.backdatesUpload
          ? 'upload_date = ?, scheduled_publish_at = NULL'
          : 'scheduled_publish_at = ?'
        const result = await db.prepare(`
          UPDATE videos
          SET ${setClause},
              publish_status = CASE WHEN publish_status = 'archived' THEN 'archived' ELSE 'draft' END,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND publish_status = ?
        `).bind(scheduledPublishAt.value, videoId, expectedPublishStatus).run()
        const changes = result.meta?.changes ?? result.changes ?? 0
        if (changes === 0) {
          return jsonResponse(concurrentChangePayload, 409, corsHeaders)
        }
      } else {
        await db.prepare(`
          UPDATE videos
          SET scheduled_publish_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(videoId).run()
      }
    }
    if (hasUploadDate && uploadDateNorm?.value) {
      await db.prepare(`
        UPDATE videos
        SET upload_date = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(uploadDateNorm.value, videoId).run()
    }
    if (hasPublishedAt) {
      await db.prepare(`
        UPDATE videos
        SET published_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(publishedAt.value, videoId).run()
    }

    let transitionedToPublished = false
    if (hasStatus) {
      if (body.status === 'published') {
        // Atomic transition: the WHERE clause ensures we only update (and fire push)
        // when the row was NOT already published, eliminating the TOCTOU race.
        const result = await db.prepare(`
          UPDATE videos
          SET publish_status = 'published',
              published_at = COALESCE(published_at, CURRENT_TIMESTAMP),
              scheduled_publish_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND publish_status != 'published'
        `).bind(videoId).run()
        transitionedToPublished = (result.meta?.changes ?? result.changes ?? 0) > 0
        // If the row was already published, still run a no-op update to get consistent
        // state for the SELECT below — this is a read guard, not a second write
      } else {
        await db.prepare(`
          UPDATE videos
          SET publish_status = ?,
              scheduled_publish_at = CASE WHEN ? = 'published' THEN NULL ELSE scheduled_publish_at END,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(body.status, body.status, videoId).run()
      }
    }

    const video = await db.prepare(`
      SELECT v.id, v.title, v.description, v.status, v.publish_status, v.published_at, v.scheduled_publish_at, v.notified_at, v.updated_at, v.slug, v.upload_date, vca.category_id,
             ls.provider AS livestream_provider,
             ls.status AS livestream_status,
             ls.stream_id AS livestream_stream_id,
             ls.stream_key AS livestream_stream_key,
             ls.ingest_url AS livestream_ingest_url,
             ls.playback_url AS livestream_playback_url,
             ls.recording_video_id AS livestream_recording_video_id
      FROM videos v
      LEFT JOIN video_category_assignments vca ON vca.video_id = v.id
      LEFT JOIN livestreams ls ON ls.video_id = v.id
      WHERE v.id = ?
    `).bind(videoId).first()
    if (!video) return jsonResponse({ error: 'Video not found' }, 404, corsHeaders)

    // Automatic notifications on publish are intentionally disabled.
    void transitionedToPublished

    return jsonResponse({ ok: true, video }, 200, corsHeaders)
  } catch (error) {
    console.error('Error:', error)
    return jsonResponse({ error: getPublicErrorMessage('Internal server error') }, 500, corsHeaders)
  }
}

async function handleAdminVideoDelete(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const url = new URL(request.url)
  const videoId = getAdminVideoIdFromPath(url.pathname)
  if (!videoId) return jsonResponse({ error: 'Missing videoId' }, 400, corsHeaders)

  try {
    const db = getDatabaseBinding(env)
    // Guard: ensure admin_settings exists on fresh/migration-lagged deployments
    // before the homepage cleanup query below tries to read from it.
    await ensureAdminSettingsTable(db)

    const video = await db.prepare(`SELECT id FROM videos WHERE id = ?`).bind(videoId).first()
    if (!video) return jsonResponse({ error: 'Video not found' }, 404, corsHeaders)
    // Delete all R2 objects under videos/{videoId}/ (paginated)
    let deletedR2Objects = 0
    if (env.BUCKET) {
      let cursor
      do {
        // @ts-expect-error TS(7022): 'listed' implicitly has type 'any' because it does... Remove this comment to see the full error message
        const listed = await env.BUCKET.list({ prefix: `videos/${videoId}/`, cursor })
        const keys = listed.objects.map((obj: any) => obj.key)
        if (keys.length > 0) {
          // Use R2 bulk delete to keep Worker-to-R2 API calls low.
          await env.BUCKET.delete(keys)
          deletedR2Objects += keys.length
        }
        cursor = listed.truncated ? listed.cursor : undefined
      } while (cursor)
    }

    // Evict the deleted ID from the persisted homepage featured-slots config so
    // a subsequent page load doesn't rehydrate a stale or empty featured card.
    const homepageRow = await db.prepare(
      'SELECT value FROM admin_settings WHERE key = ? LIMIT 1'
    ).bind('homepage').first()
    if (homepageRow?.value) {
      const homepage = safeJsonParse(homepageRow.value, defaultHomepageConfig())
      const before = Array.isArray(homepage.featuredVideoIds) ? homepage.featuredVideoIds : []
      const after  = before.filter((id: any) => id !== videoId)
      if (after.length !== before.length) {
        homepage.featuredVideoIds = after
        await db.prepare(`
          INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).bind('homepage', JSON.stringify(homepage)).run()
      }
    }

    // Delete the D1 row
    await db.prepare(`DELETE FROM videos WHERE id = ?`).bind(videoId).run()

    return jsonResponse({ ok: true, deletedR2Objects }, 200, corsHeaders)
  } catch (error) {
    console.error(`handleAdminVideoDelete [videoId:${videoId}]:`, error)
    return jsonResponse({ error: getPublicErrorMessage('Internal server error') }, 500, corsHeaders)
  }
}

async function handleAdminVideoNotify(request: any, env: any, ctx: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const url = new URL(request.url)
  const videoId = getAdminVideoIdFromPath(url.pathname)
  if (!videoId) return jsonResponse({ error: 'Missing videoId' }, 400, corsHeaders)

  const db = getDatabaseBinding(env)
  const video = await db.prepare(
    `SELECT id, title, publish_status FROM videos WHERE id = ?`
  ).bind(videoId).first()

  if (!video) return jsonResponse({ error: 'Video not found' }, 404, corsHeaders)
  if (video.publish_status !== 'published') {
    return jsonResponse({ error: 'Only published videos can trigger notifications' }, 422, corsHeaders)
  }

  // KV-based cooldown: prevent accidental spam from double-clicks or repeated sends.
  // TTL matches the cooldown window so the key auto-expires.
  const NOTIFY_COOLDOWN_SECONDS = 300 // 5 minutes
  if (env.RATE_LIMIT_KV) {
    const cooldownKey = `notify:video:${videoId}`
    const lastSent = await env.RATE_LIMIT_KV.get(cooldownKey)
    if (lastSent) {
      const secondsAgo = Math.floor((Date.now() - Number(lastSent)) / 1000)
      const retryAfter = NOTIFY_COOLDOWN_SECONDS - secondsAgo
      return jsonResponse(
        { error: 'Notification cooldown active — wait 5 minutes between sends.', code: 'cooldown', retryAfter },
        429,
        corsHeaders,
      )
    }
    await env.RATE_LIMIT_KV.put(cooldownKey, String(Date.now()), { expirationTtl: NOTIFY_COOLDOWN_SECONDS })
  }

  const responseTimestamp = new Date().toISOString()
  const notifiedResult = await db.prepare(`
    UPDATE videos
    SET notified_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND notified_at IS NULL
  `).bind(responseTimestamp, videoId).run()
  const notifiedChanges = Number(notifiedResult.meta?.changes ?? notifiedResult.changes ?? 0)
  if (!notifiedChanges) {
    return jsonResponse({ error: 'Video already notified', code: 'already_notified' }, 409, corsHeaders)
  }

  // Send in the background; log delivery stats so failures are visible in logs.
  ctx.waitUntil(
    sendPushToAllSubscribers(video.title || videoId, videoId, env, db)
      .then(stats => {
        console.log(`Push notify [videoId:${videoId}] attempted=${stats.attempted} succeeded=${stats.succeeded} failed=${stats.failed} stale=${stats.stale}`)
      })
      .catch(err => {
        console.error(`Push notify error [videoId:${videoId}]:`, err)
      }),
  )

  return jsonResponse({ ok: true, push_enqueued_at: responseTimestamp }, 200, corsHeaders)
}

async function handleAdminVideoPublishSweep(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  const db = getDatabaseBinding(env)
  const nowIso = new Date().toISOString()
  const result = await db.prepare(`
    UPDATE videos
    SET publish_status = 'published',
        published_at = COALESCE(published_at, CURRENT_TIMESTAMP),
        scheduled_publish_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE publish_status != 'published'
      AND scheduled_publish_at IS NOT NULL
      AND scheduled_publish_at <= CURRENT_TIMESTAMP
  `).run()
  const publishedCount = Number(result.meta?.changes ?? result.changes ?? 0)
  return jsonResponse({
    ok: true,
    publishedCount,
    executedAt: nowIso,
  }, 200, corsHeaders)
}

async function handleVideoSwap(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const url = new URL(request.url)
  const publishedId = getAdminVideoIdFromPath(url.pathname)
  if (!publishedId) return jsonResponse({ error: 'Missing video id' }, 400, corsHeaders)

  const body = await request.json().catch(() => null)
  if (!body?.swapWithId || typeof body.swapWithId !== 'string') {
    return jsonResponse({ error: 'swapWithId (draft video id) is required' }, 400, corsHeaders)
  }
  const draftId = body.swapWithId.trim()
  if (draftId === publishedId) {
    return jsonResponse({ error: 'Cannot swap a video with itself' }, 400, corsHeaders)
  }

  const db = getDatabaseBinding(env)

  const [oldVideo, newVideo] = await Promise.all([
    db.prepare('SELECT * FROM videos WHERE id = ?').bind(publishedId).first(),
    db.prepare('SELECT * FROM videos WHERE id = ?').bind(draftId).first(),
  ])

  if (!oldVideo) return jsonResponse({ error: 'Published video not found' }, 404, corsHeaders)
  if (!newVideo) return jsonResponse({ error: 'Draft video not found' }, 404, corsHeaders)
  if (oldVideo.publish_status !== 'published') {
    return jsonResponse({ error: 'Source video must be published' }, 422, corsHeaders)
  }
  if (newVideo.publish_status !== 'draft') {
    return jsonResponse({ error: 'Target video must be a draft' }, 422, corsHeaders)
  }
  if (env.BUCKET) {
    const exists = await hasProcessedPlaybackArtifact(env.BUCKET, draftId)
    if (!exists) {
      return jsonResponse({
        error: 'Cannot swap: processed media not found in R2. Upload and process the target draft first.',
        code: 'r2_missing',
      }, 422, corsHeaders)
    }
  }

  // Cap the preview lock to the new video's actual duration (which may differ).
  const cappedPreviewDuration = newVideo.full_duration > 0
    ? Math.min(oldVideo.preview_duration ?? 0, newVideo.full_duration)
    : (oldVideo.preview_duration ?? 0)

  // Promote the draft and retire the old video atomically via D1 batch so both
  // updates succeed or both fail — no half-swapped state.
  // thumbnail_url starts as the old video's URL; upgraded below after the copy succeeds.
  const promoteStmt = db.prepare(`
    UPDATE videos SET
      title            = ?,
      description      = ?,
      thumbnail_url    = ?,
      slug             = ?,
      upload_date      = ?,
      preview_duration = ?,
      publish_status   = 'published',
      published_at     = CURRENT_TIMESTAMP,
      updated_at       = CURRENT_TIMESTAMP
    WHERE id = ? AND publish_status = 'draft'
  `).bind(
    oldVideo.title,
    oldVideo.description ?? null,
    oldVideo.thumbnail_url ?? null,
    oldVideo.slug ?? null,
    oldVideo.upload_date,
    cappedPreviewDuration,
    draftId,
  )

  const retireStmt = db.prepare(`
    UPDATE videos SET
      title          = 'OLD - ' || title,
      thumbnail_url  = NULL,
      slug           = NULL,
      publish_status = 'draft',
      published_at   = NULL,
      updated_at     = CURRENT_TIMESTAMP
    WHERE id = ? AND publish_status = 'published'
  `).bind(publishedId)

  // Retire must run first to clear the slug before the draft claims it — otherwise
  // D1 raises a UNIQUE constraint violation on the partial index on videos.slug.
  // The WHERE predicates ensure concurrent requests can't both succeed.
  const [retireResult, promoteResult] = await db.batch([retireStmt, promoteStmt])
  if ((retireResult.meta?.changes ?? 0) === 0 || (promoteResult.meta?.changes ?? 0) === 0) {
    return jsonResponse({ error: 'Swap failed: video status changed concurrently, please retry' }, 409, corsHeaders)
  }

  // If the replaced source was a livestream, mark it as replaced and keep an
  // explicit link to the promoted VOD row.
  await db.prepare(`
    UPDATE livestreams
    SET status = 'replaced_with_vod',
        recording_video_id = ?,
        ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE video_id = ?
  `).bind(draftId, publishedId).run()

  // Copy thumbnails only after the swap has committed so a failed swap never
  // overwrites the draft's existing thumbnail assets.
  if (env.BUCKET && oldVideo.thumbnail_url) {
    const thumbnailFiles = ['original.jpg', 'large.jpg', 'medium.jpg', 'small.jpg']
    const copyResults = await Promise.allSettled(thumbnailFiles.map(async (file) => {
      const srcKey = `thumbnails/${publishedId}/${file}`
      const dstKey = `thumbnails/${draftId}/${file}`
      const obj = await env.BUCKET.get(srcKey)
      if (obj) {
        await env.BUCKET.put(dstKey, obj.body, { httpMetadata: obj.httpMetadata })
        return true
      }
      return false
    }))
    const failures = copyResults.filter(r => r.status === 'rejected')
    if (failures.length) {
      console.warn(`Thumbnail copy: ${failures.length}/${thumbnailFiles.length} failed for swap ${publishedId} -> ${draftId}`)
    }
    // Upgrade the thumbnail URL on the newly promoted row only if large.jpg was
    // actually written; the initial value set in the batch was oldVideo.thumbnail_url.
    const largeCopyOk = copyResults[1]?.status === 'fulfilled' && copyResults[1].value === true
    if (env.R2_BASE_URL && largeCopyOk) {
      await db.prepare(`UPDATE videos SET thumbnail_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(`${env.R2_BASE_URL}/thumbnails/${draftId}/large.jpg`, draftId).run()
    }
  }

  // Update homepage featured slots: replace old ID with new ID so the page
  // doesn't silently show a stale/empty featured card after the swap.
  // Best-effort: the swap itself already committed — don't let this fail the response.
  try {
    await ensureAdminSettingsTable(db)
    const homepageRow = await db.prepare(
      'SELECT value FROM admin_settings WHERE key = ? LIMIT 1'
    ).bind('homepage').first()
    if (homepageRow?.value) {
      const homepage = safeJsonParse(homepageRow.value, defaultHomepageConfig())
      const before = Array.isArray(homepage.featuredVideoIds) ? homepage.featuredVideoIds : []
      const after  = before.map((id: any) => id === publishedId ? draftId : id)
      if (after.some((id: any, i: any) => id !== before[i])) {
        homepage.featuredVideoIds = after
        await db.prepare(`
          INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).bind('homepage', JSON.stringify(homepage)).run()
      }
    }
  } catch (err) {
    console.warn('Homepage featured-slot update failed after swap (non-fatal):', getErrorMessage(err))
  }

  const [published, retired] = await Promise.all([
    db.prepare('SELECT id, title, publish_status, slug, thumbnail_url FROM videos WHERE id = ?').bind(draftId).first(),
    db.prepare('SELECT id, title, publish_status, slug, thumbnail_url FROM videos WHERE id = ?').bind(publishedId).first(),
  ])

  return jsonResponse({ ok: true, published, retired }, 200, corsHeaders)
}

async function handleAdminPushTest(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const user = await requireAuth(request, env).catch(() => null)
  if (!user?.sub) return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)

  const db = getDatabaseBinding(env)
  const subscription = await db.prepare(`
    SELECT endpoint, p256dh, auth, created_at
    FROM push_subscriptions
    WHERE user_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 1
  `).bind(user.sub).first()

  if (!subscription) {
    return jsonResponse(
      { ok: false, error: 'No push subscription found for current user', code: 'missing_subscription' },
      404,
      corsHeaders,
    )
  }

  const endpointHost = safeEndpointHost(subscription.endpoint)
  const payload = {
    title: 'VMP push diagnostic',
    body: `Diagnostic ping ${new Date().toISOString()}`,
    url: `${env.FRONTEND_URL || ''}/account?push-test=1`,
  }

  try {
    const result = await sendPushNotification(subscription, payload, env)
    return jsonResponse({
      ok: true,
      endpointHost,
      subscriptionCreatedAt: subscription.created_at || null,
      delivery: {
        status: result.status,
        statusClass: result.statusClass,
      },
    }, 200, corsHeaders)
  } catch (error) {
    const code = getErrorField(error, 'code')
    const status = getErrorField(error, 'status')
    const statusClass = getErrorField(error, 'statusClass')
    const responseSnippet = getErrorField(error, 'responseSnippet')
    return jsonResponse({
      ok: false,
      endpointHost,
      subscriptionCreatedAt: subscription.created_at || null,
      error: getPublicErrorMessage('Push test failed'),
      code: typeof code === 'string' ? code : 'push_failed',
      delivery: {
        status: typeof status === 'number' ? status : null,
        statusClass: typeof statusClass === 'string' ? statusClass : null,
        responseSnippet: typeof responseSnippet === 'string' ? responseSnippet : null,
      },
    }, 502, corsHeaders)
  }
}

function safeEndpointHost(endpoint: any) {
  try {
    return new URL(endpoint).host || null
  } catch {
    return null
  }
}

// ─── Push notification helpers ────────────────────────────────────────────────

/**
 * Returns true if the hostname should be blocked as a push endpoint target.
 * Prevents SSRF by rejecting localhost, loopback, link-local, and RFC-1918 ranges.
 */
function isPrivateHost(hostname: any) {
  // Reject .local mDNS, localhost, and empty hostnames
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) return true

  // Normalise: strip IPv6 brackets, lowercase
  const h = hostname.replace(/^\[|]$/g, '').toLowerCase()

  // ── IPv4 ──────────────────────────────────────────────────────────────────
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) return isPrivateIPv4Octets(Number(ipv4[1]), Number(ipv4[2]))

  // ── IPv6 ──────────────────────────────────────────────────────────────────
  // Only apply IPv6 checks when the hostname contains ':' (IPv6 addresses always do).
  // Without this guard, domain names like `fcm.googleapis.com` (Chrome's push
  // service) would be falsely flagged as ULA fc00::/7 addresses because they
  // start with "fc".
  if (h.includes(':')) {
    if (h === '::1') return true                          // loopback
    if (h.startsWith('fe80:')) return true                // link-local fe80::/10
    if (h.startsWith('fc') || h.startsWith('fd')) return true // ULA fc00::/7
  }

  // IPv4-mapped IPv6 — ::ffff:x.x.x.x  (covers ::ffff:127.0.0.1 etc.)
  const mapped = h.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    ?? h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mapped) {
    if (mapped.length === 5) {
      // Dotted-decimal form
      return isPrivateIPv4Octets(Number(mapped[1]), Number(mapped[2]))
    }
    // Hex-word form: convert each 16-bit word to two octets
    const a = parseInt(mapped[1], 16)
    return isPrivateIPv4Octets(a >> 8, a & 0xff)
  }

  return false
}

function isPrivateIPv4Octets(a: any, b: any) {
  if (a === 10) return true                               // 10.0.0.0/8
  if (a === 127) return true                              // 127.0.0.0/8 loopback
  if (a === 172 && b >= 16 && b <= 31) return true       // 172.16.0.0/12
  if (a === 192 && b === 168) return true                 // 192.168.0.0/16
  if (a === 169 && b === 254) return true                 // 169.254.0.0/16 link-local
  if (a === 0) return true                                // 0.0.0.0/8
  return false
}

// ─── Push notification handlers ───────────────────────────────────────────────

function handleGetVapidPublicKey(request: any, env: any, corsHeaders: any) {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim()
  const privateKey = env.VAPID_PRIVATE_KEY?.trim()
  if (!publicKey || publicKey.startsWith('REPLACE_WITH_') || !privateKey) {
    return jsonResponse({ error: 'VAPID not configured' }, 503, corsHeaders)
  }
  return jsonResponse({ publicKey }, 200, corsHeaders)
}

async function handlePushSubscribe(request: any, env: any, corsHeaders: any) {
  let user
  try {
    user = await requireAuth(request, env)
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const body = await request.json().catch(() => null)
  if (
    typeof body?.endpoint !== 'string' ||
    typeof body?.keys?.p256dh !== 'string' ||
    typeof body?.keys?.auth !== 'string'
  ) {
    return jsonResponse({ error: 'Invalid push subscription object' }, 400, corsHeaders)
  }

  // Validate endpoint to prevent SSRF: must be https and not a private/local host
  let endpointUrl
  try {
    endpointUrl = new URL(body.endpoint)
  } catch {
    return jsonResponse({ error: 'Invalid push endpoint' }, 400, corsHeaders)
  }
  if (endpointUrl.protocol !== 'https:' || isPrivateHost(endpointUrl.hostname)) {
    return jsonResponse({ error: 'Invalid push endpoint' }, 400, corsHeaders)
  }

  const db = getDatabaseBinding(env)
  const id = crypto.randomUUID()
  try {
    await db.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
        p256dh = excluded.p256dh, auth = excluded.auth
    `).bind(id, user.sub, body.endpoint, body.keys.p256dh, body.keys.auth).run()
    return jsonResponse({ ok: true }, 201, corsHeaders)
  } catch (error) {
    console.error('Push subscribe error:', error)
    return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders)
  }
}

async function handlePushUnsubscribe(request: any, env: any, corsHeaders: any) {
  let user
  try {
    user = await requireAuth(request, env)
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  const body = await request.json().catch(() => null)
  if (!body?.endpoint) {
    return jsonResponse({ error: 'endpoint is required' }, 400, corsHeaders)
  }

  const db = getDatabaseBinding(env)
  try {
    await db.prepare(
      'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
    ).bind(body.endpoint, user.sub).run()
    return jsonResponse({ ok: true }, 200, corsHeaders)
  } catch (error) {
    console.error('Push unsubscribe error:', error)
    return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders)
  }
}

async function hasProcessedPlaybackArtifact(bucket: any, videoId: any) {
  const candidateKeys = [
    // Flat layout produced by the current upload script (rclone copies TMP_DIR
    // directly into videos/{id}/ with no processed/ subdirectory)
    `videos/${videoId}/master.m3u8`,
    // Processed-subdirectory layouts (video-processor pipeline output)
    `videos/${videoId}/processed/playlist.m3u8`,
    `videos/${videoId}/processed/hls/master.m3u8`,
  ]

  for (const key of candidateKeys) {
    const object = await bucket.head(key)
    if (object) return true
  }
  return false
}

// ─── Duration resolver (shared by /video-access and /videos) ───────────────────
//
// Resolves total duration by summing #EXTINF lines in the HLS media playlist.
// Follows a master playlist to its first variant if needed.
// Cached in KV to avoid repeatedly fetching/parsing manifests.

async function resolveVideoDurationSeconds(videoId: any, env: any) {
  if (!videoId) return null
  if (!env.R2_BASE_URL) return null

  const kv = env.RATE_LIMIT_KV
  const cacheKey = kv ? `duration:${videoId}` : null
  if (kv && cacheKey) {
    try {
      const cached = await kv.get(cacheKey)
      // Three states:
      // - missing key => attempt resolve
      // - sentinel "-1" => treat as unresolvable (short TTL) and return null immediately
      // - positive integer => duration seconds
      if (cached === '-1') return null
      const n = cached ? Number.parseInt(cached, 10) : NaN
      if (Number.isFinite(n) && n > 0) return n
    } catch {
      // Treat KV read failure as a cache miss - proceed with resolution
    }
  }

  const candidates = buildEntrypointCandidates(env.R2_BASE_URL, videoId)
  let lastResult = null
  for (const entrypoint of candidates) {
    const result = await resolvePlaylistDurationFromUrl(entrypoint, 0)
    lastResult = result

    if (result.kind === 'ok' && result.duration && result.duration > 0) {
      if (kv && cacheKey) {
        try {
          await kv.put(cacheKey, String(result.duration), { expirationTtl: 86400 }) // 24h
        } catch {
          // Ignore KV write failures - duration resolution still succeeded
        }
      }
      return result.duration
    }

    // If we hit a transient error, stop trying and bubble it up (don't cache)
    if (result.kind === 'transient') {
      return null
    }

    // If not_found, continue to next candidate
  }

  // All candidates returned not_found — write negative cache sentinel
  // Only write -1 for definitive not_found, not for transient errors
  if (lastResult && lastResult.kind === 'not_found') {
    if (kv && cacheKey) {
      try {
        await kv.put(cacheKey, '-1', { expirationTtl: 300 }) // 5 minutes
      } catch {
        // Ignore KV write failures - not_found result is still valid
      }
    }
  }
  return null
}

async function resolvePlaylistDurationFromUrl(url: any, depth = 0) {
  if (!url || depth > 2) return { duration: null, kind: 'not_found' }
  // Declared outside `try` so `finally` can clear the timer (try-block `let` is not in scope in `finally`).
  const timeoutMs = 5000
  let controller: any = null
  let timeoutId = null
  let signal = undefined
  try {
    // Avoid indefinite hangs on upstream fetch (network stalls, origin issues).
    // Prefer AbortSignal.timeout when available; otherwise use AbortController.
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(timeoutMs)
    } else if (typeof AbortController !== 'undefined') {
      controller = new AbortController()
      signal = controller.signal
      timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    }

    const res = await fetch(url, signal ? { signal } : undefined)

    // Distinguish between not-found (404) and transient errors
    if (!res.ok) {
      if (res.status === 404) {
        return { duration: null, kind: 'not_found' }
      }
      // Other HTTP errors (5xx, 403, etc.) are transient
      return { duration: null, kind: 'transient' }
    }

    const text = await res.text()
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

    // Media playlist: sum EXTINF segment durations
    const extInf = lines.filter(l => l.startsWith('#EXTINF:'))
    if (extInf.length) {
      const total = extInf.reduce((sum, l) => {
        const n = Number.parseFloat(l.slice('#EXTINF:'.length))
        return Number.isFinite(n) ? sum + n : sum
      }, 0)
      const rounded = Math.round(total)
      if (Number.isFinite(rounded) && rounded > 0) {
        return { duration: rounded, kind: 'ok' }
      }
      return { duration: null, kind: 'not_found' }
    }

    // Master playlist: follow first variant
    const idx = lines.findIndex(l => l.startsWith('#EXT-X-STREAM-INF'))
    if (idx >= 0 && lines[idx + 1]) {
      const variantPath = lines[idx + 1]
      if (!variantPath) return { duration: null, kind: 'not_found' }
      const nextUrl = new URL(variantPath, url).toString()
      return resolvePlaylistDurationFromUrl(nextUrl, depth + 1)
    }
  } catch (error) {
    // Network errors, timeouts, and aborts are transient
    return { duration: null, kind: 'transient' }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
  return { duration: null, kind: 'not_found' }
}

// ─── All the unchanged helper functions from the original index.js ─────────────

function getManifestType(objectPath: any, upstreamResponse: any) {
  if (objectPath.endsWith('.m3u8')) return 'hls'
  const ct = upstreamResponse.headers.get('content-type') ?? ''
  if (/application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl/i.test(ct)) return 'hls'
  return null
}

export function getVideoProxyCacheControl(objectPath: any, manifestType: any) {
  if (manifestType === 'hls') {
    // Playlists are frequently rewritten (preview boundaries, tokenized URLs), so
    // keep them short-lived while still allowing CDN edge caching.
    return 'public, max-age=60, s-maxage=60'
  }

  // HLS media segments and init files are immutable once published in VOD flows.
  if (objectPath.endsWith('.m4s') || /(^|\/)init[^/]*\.mp4$/i.test(objectPath)) {
    return 'public, max-age=31536000, immutable'
  }

  return null
}

function rewriteManifestForProxyWithPreview(manifest: any, previewUntilSeconds: any, objectPath = '', vt: string | null = null) {
  const lines = manifest.split('\n')
  const hasPreviewLimit = typeof previewUntilSeconds === 'number' && previewUntilSeconds >= 0
  const isMediaPlaylist = lines.some((l: any) => l.trim().startsWith('#EXTINF:'))
  const isMasterPlaylist = lines.some((l: any) => l.trim().startsWith('#EXT-X-STREAM-INF'))
  const previewQuery = hasPreviewLimit ? `previewUntil=${Math.floor(previewUntilSeconds)}` : null

  // Build extra query params to append to every URL: vt (required) + previewUntil (optional)
  function buildExtraQuery(includePreview: any) {
    const parts = []
    if (includePreview && previewQuery) parts.push(previewQuery)
    if (vt) parts.push(`vt=${vt}`)
    return parts.length ? parts.join('&') : null
  }

  // Base directory of the manifest in the proxy URL space, e.g. "videos/abc/".
  // Used to resolve relative paths in master playlists so that previewUntil
  // can be propagated to variant playlist requests.
  const manifestDir = objectPath.includes('/') ? objectPath.slice(0, objectPath.lastIndexOf('/') + 1) : ''

  // Resolve segment paths relative to this manifest's directory so that bare
  // filenames (e.g. "seg_1080_1.m4s", "init_1080.mp4") emitted by shaka-packager
  // are routed through the proxy with the vt token intact.
  function proxySegmentPath(path: any, query: any) {
    return rewriteSegmentPath(path, query, manifestDir)
  }

  // Helper to rewrite URLs in HLS tag attributes
  function rewriteTagAttributes(line: any, query: any) {
    // Handle #EXT-X-MAP:URI="..."
    line = line.replace(/(#EXT-X-MAP:[^"'\n]*URI=["'])([^"']+)(["'])/gi, (match: any, prefix: any, url: any, suffix: any) => {
      return prefix + proxySegmentPath(url, query) + suffix
    })
    // Handle #EXT-X-KEY:URI="..."
    line = line.replace(/(#EXT-X-KEY:[^"'\n]*URI=["'])([^"']+)(["'])/gi, (match: any, prefix: any, url: any, suffix: any) => {
      // Preserve custom-scheme URIs (skd://, data:, etc.) - only rewrite scheme-less paths
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
        return prefix + url + suffix
      }
      return prefix + proxySegmentPath(url, query) + suffix
    })
    // Handle #EXT-X-MEDIA:URI="..."
    line = line.replace(/(#EXT-X-MEDIA:[^"'\n]*URI=["'])([^"']+)(["'])/gi, (match: any, prefix: any, url: any, suffix: any) => {
      return prefix + proxySegmentPath(url, query) + suffix
    })
    // Handle #EXT-X-I-FRAME-STREAM-INF:URI="..."
    line = line.replace(/(#EXT-X-I-FRAME-STREAM-INF:[^"'\n]*URI=["'])([^"']+)(["'])/gi, (match: any, prefix: any, url: any, suffix: any) => {
      return prefix + proxySegmentPath(url, query) + suffix
    })
    return line
  }

  if (hasPreviewLimit && isMediaPlaylist) {
    let elapsed = 0, pending = null
    const out = []
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith('#')) {
        if (t.startsWith('#EXTINF:')) pending = Number.parseFloat(t.slice('#EXTINF:'.length)) || 0
        if (t !== '#EXT-X-ENDLIST') {
          // Rewrite tag attributes even in preview mode
          out.push(rewriteTagAttributes(line, buildExtraQuery(true)))
        }
        continue
      }
      if (elapsed >= previewUntilSeconds) break
      out.push(proxySegmentPath(t, buildExtraQuery(true)))
      elapsed += pending ?? 0
      pending = null
    }
    out.push('#EXT-X-ENDLIST')
    return out.join('\n')
  }
  return lines.map((line: any) => {
    const t = line.trim()
    if (!t) return line
    if (t.startsWith('#')) {
      // Rewrite URLs in HLS tag attributes
      return rewriteTagAttributes(line, buildExtraQuery(isMasterPlaylist && hasPreviewLimit))
    }
    if (isMasterPlaylist) {
      // For relative paths in master playlists we must resolve them to an
      // absolute proxy path so the previewUntil param is carried through to
      // the variant playlist request (hls.js fetches the URL verbatim).
      const isRelative = !/^https?:\/\//i.test(t) && !t.startsWith('/')
      if (isRelative && manifestDir) {
        const absolutePath = `${manifestDir}${t}`
        return rewriteSegmentPath(absolutePath, buildExtraQuery(hasPreviewLimit))
      }
    }
    return proxySegmentPath(t, buildExtraQuery(isMasterPlaylist && hasPreviewLimit))
  }).join('\n');
}

function rewriteSegmentPath(path: any, query: any, baseDir = '') {
  // Preserve custom-scheme URIs (skd://, data:, etc.) - only rewrite scheme-less paths
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) && !/^https?:\/\//i.test(path)) {
    return path
  }
  let proxied
  if (/^https?:\/\//i.test(path)) {
    const u = new URL(path)
    proxied = `/api/video-proxy${u.pathname}${u.search}`
  } else if (path.startsWith('/')) {
    proxied = `/api/video-proxy${path}`
  } else if (path.startsWith('videos/')) {
    proxied = `/api/video-proxy/${path}`
  } else if (baseDir) {
    // Bare relative filename (e.g. "seg_1080_1.m4s", "init_1080.mp4") —
    // resolve against the manifest's directory so the proxy prefix and vt
    // token are preserved for every segment/init request.
    proxied = `/api/video-proxy/${baseDir}${path}`
  } else {
    return path
  }
  return query ? (proxied.includes('?') ? `${proxied}&${query}` : `${proxied}?${query}`) : proxied
}

function normalizeVideoId(input: any) {
  const t = (input ?? '').trim()
  const m = t.match(/^videos\/([^/]+)\/processed\/playlist\.m3u8$/i)
  return m ? m[1] : t
}

function decodePathSegment(segment: any) {
  if (typeof segment !== 'string') return null
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export function getAdminVideoIdFromPath(pathname: string) {
  const pathParts = pathname.split('/').filter(Boolean)
  const videoId = decodePathSegment(pathParts[3])
  if (typeof videoId !== 'string' || videoId.length === 0) return null
  // Keep route semantics as a single path segment even after decoding.
  if (videoId.includes('/')) return null
  return videoId
}

export function getProxyVideoIdFromPath(pathname: string) {
  const pathParts = pathname.split('/').filter(Boolean)
  let videoIdSegment: string | undefined
  if (pathParts[0] === 'videos') {
    // Normalized proxy object path used by handleVideoProxy (videos/{id}/...)
    videoIdSegment = pathParts[1]
  } else if (pathParts[0] === 'api' && pathParts[1] === 'video-proxy' && pathParts[2] === 'videos') {
    // Full request pathname form (/api/video-proxy/videos/{id}/...)
    videoIdSegment = pathParts[3]
  }
  if (typeof videoIdSegment !== 'string' || videoIdSegment.length === 0) return null
  const videoId = decodePathSegment(videoIdSegment)
  if (typeof videoId !== 'string' || videoId.length === 0) return null
  // Keep route semantics as a single path segment even after decoding.
  if (videoId.includes('/') || videoId === '.' || videoId === '..') return null
  return videoId
}

// Resolve a video row by ID first, then by vanity slug.
// Returns the D1 row or null.
async function resolveVideoByIdOrSlug(db: any, idOrSlug: any) {
  const byId = await db.prepare('SELECT * FROM videos WHERE id = ?').bind(idOrSlug).first()
  if (byId) return byId
  return db.prepare('SELECT * FROM videos WHERE slug = ?').bind(idOrSlug).first()
}

// Validate a vanity slug format: lowercase alphanumeric words separated by hyphens.
function isValidSlug(slug: any) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

function sanitizeSlug(raw: any) {
  if (typeof raw !== 'string') return ''
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const HOMEPAGE_LAYOUT_VARIANTS = new Set(['three_by_one', 'side_mini'])

function normalizeHomepageLayoutVariant(raw: any) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return HOMEPAGE_LAYOUT_VARIANTS.has(value) ? value : 'three_by_one'
}

export function normalizeScheduledPublishAt(raw: any, options: { allowNull?: boolean, allowPast?: boolean } = {}) {
  const makeResult = (value: string | null, invalid: boolean, backdatesUpload = false) => ({ value, invalid, backdatesUpload })
  if (raw == null || raw === '') {
    return options.allowNull ? makeResult(null, false) : makeResult(null, true)
  }
  if (typeof raw !== 'string') return makeResult(null, true)
  const text = raw.trim()
  if (!text) return options.allowNull ? makeResult(null, false) : makeResult(null, true)

  const t = parseAdminTimestampToUtcMillis(text)
  if (!Number.isFinite(t)) return makeResult(null, true)

  const d = new Date(t)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  const value = `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`

  // Future (60s grace): normal schedule. Past: rewrite upload_date for drafts instead of auto-publishing.
  const isBackdateable = t + 60_000 <= Date.now()
  if (options.allowPast) {
    return makeResult(value, false)
  }
  if (isBackdateable) {
    return makeResult(value, false, true)
  }
  return makeResult(value, false)
}

export function normalizePublishedAt(raw: any, options: { allowNull?: boolean } = {}) {
  if (raw == null || raw === '') {
    return options.allowNull ? { value: null, invalid: false } : { value: null, invalid: true }
  }
  if (typeof raw !== 'string') return { value: null, invalid: true }
  const text = raw.trim()
  if (!text) return options.allowNull ? { value: null, invalid: false } : { value: null, invalid: true }

  const t = parseAdminTimestampToUtcMillis(text)
  if (!Number.isFinite(t)) return { value: null, invalid: true }

  const d = new Date(t)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return { value: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`, invalid: false }
}

export function parseAdminTimestampToUtcMillis(raw: string) {
  // Preferred path: ISO timestamps with explicit timezone.
  const hasTimezone = /[Zz]$|[+-]\d{2}:\d{2}$/.test(raw)
  if (hasTimezone) return Date.parse(raw)

  // Backwards-compatible path for admin payloads that may contain SQL-style
  // datetime strings from existing UI state (YYYY-MM-DD HH:MM[:SS[.sss]]).
  const sqlLike = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(raw)
  if (!sqlLike) return Number.NaN

  const [, y, m, d, hh, mm, ss = '00', sss = '0'] = sqlLike
  const millis = sss.padEnd(3, '0')
  const utcIso = `${y}-${m}-${d}T${hh}:${mm}:${ss}.${millis}Z`
  return Date.parse(utcIso)
}

async function runScheduledPublishJobs(env: any) {
  const db = getDatabaseBinding(env)
  const dueRows = await db.prepare(`
    SELECT id
    FROM videos
    WHERE publish_status = 'draft'
      AND scheduled_publish_at IS NOT NULL
      AND scheduled_publish_at <= CURRENT_TIMESTAMP
  `).all()
  const dueVideos = dueRows?.results ?? []
  if (!dueVideos.length) return 0
  const publishStmt = db.prepare(`
    UPDATE videos
    SET publish_status = 'published',
        published_at = COALESCE(published_at, CURRENT_TIMESTAMP),
        scheduled_publish_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND publish_status = 'draft'
      AND scheduled_publish_at IS NOT NULL
      AND scheduled_publish_at <= CURRENT_TIMESTAMP
  `)
  const statements = dueVideos.map((row: any) => publishStmt.bind(row.id))
  await db.batch(statements)
  return statements.length
}

async function maybeRunScheduledPublishJobsInRequest(env: any) {
  try {
    const kv = env.RATE_LIMIT_KV || env.SETTINGS_KV || null
    if (!kv) return

    try {
      const colo = typeof env.CF_COLO === 'string' ? env.CF_COLO : 'default'
      const lockKey = `scheduled-publish-sweep:${colo}`
      const lastRun = await kv.get(lockKey)
      if (lastRun) return
      await kv.put(lockKey, Date.now().toString(), { expirationTtl: 60 })
    } catch (err) {
      console.error('Scheduled publish lock KV operation failed:', err)
      return
    }

    await runScheduledPublishJobs(env)
  } catch (err) {
    console.error('In-request scheduled publish sweep failed:', err)
  }
}

function safeJsonParse(v: any, fallback: any) {
  if (!v) return fallback
  try { return JSON.parse(v) } catch { return fallback }
}

function defaultHomepageConfig() {
  return {
    ...normalizeHomepagePlacementConfig(null),
    layoutBlocks: [],
  }
}

function normalizeHomepageConfig(config: any) {
  return {
    ...normalizeHomepagePlacementConfig(config),
    layoutBlocks: Array.isArray(config?.layoutBlocks)
      ? config.layoutBlocks
        .filter((b: any) => b && typeof b === 'object')
        .map((b: any) => {
          const type = normalizeLayoutBlockType(b.type)
          const normalized: any = {
            id: typeof b.id === 'string' ? b.id : crypto.randomUUID(),
            type,
            title: typeof b.title === 'string' ? b.title : '',
            body: typeof b.body === 'string' ? b.body : '',
          }
          if (type === 'category') {
            normalized.categoryId = typeof b.categoryId === 'string' ? b.categoryId : null
          }
          if (type === 'split_horizontal' || type === 'split_vertical') {
            const children = Array.isArray(b.childBlocks) ? b.childBlocks : []
            normalized.childBlocks = children
              .filter((child: any) => child && typeof child === 'object')
              .slice(0, 2)
              .map((child: any) => ({
                type: normalizeHomepageChildBlockType(child.type),
                title: typeof child.title === 'string' ? child.title : '',
                body: typeof child.body === 'string' ? child.body : '',
                categoryId: typeof child.categoryId === 'string' ? child.categoryId : null,
              }))
          }
          return normalized
        })
      : [],
  };
}

function normalizeLayoutBlockType(type: any) {
  if (type === 'featured') return 'featured_row'
  const allowedTypes = new Set(['featured_row', 'category', 'top_video', 'split_horizontal', 'split_vertical'])
  return allowedTypes.has(type) ? type : 'top_video'
}

function normalizeHomepageChildBlockType(type: any) {
  const allowedTypes = new Set(['featured_row', 'category', 'top_video'])
  return allowedTypes.has(type) ? type : 'top_video'
}

async function canLoadEntrypoint(url: any) {
  try { return (await fetch(url, { method: 'HEAD' })).ok } catch { return false }
}

function getDatabaseBinding(env: any) {
  const db = env.DB || env.video_subscription_db
  if (!db) throw new Error('Database binding not configured')
  return db
}

function jsonResponse(data: any, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

let pillsKeySyncPromise: any = null
async function maybeSyncPillsApiKey(env: any) {
  if (!env?.PILLS_API_KEY) return
  if (!pillsKeySyncPromise) {
    pillsKeySyncPromise = ensurePillsApiKeySetting(env).catch((error) => {
      console.error('Failed to sync PILLS_API_KEY into admin_settings:', error)
    })
  }
  await pillsKeySyncPromise
}

async function sha256Hex(value: any) {
  const bytes = new TextEncoder().encode(value)
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ─── Segment duration helpers (Step 4b) ──────────────────────────────────────
//
// We cache the average HLS segment duration per videoId in KV so we can
// throttle .ts responses to roughly real-time speed.

async function getAvgSegmentDuration(videoId: any, env: any) {
  if (!env.RATE_LIMIT_KV) return null

  // Check KV cache first (1-hour TTL)
  const cached = await env.RATE_LIMIT_KV.get(`manifest:${videoId}`, 'json')
  if (cached?.avg && typeof cached.avg === 'number') return cached.avg

  // Try to fetch one of the known playlist paths from R2
  const base = env.R2_BASE_URL
  const candidates = [
    `${base}/videos/${videoId}/master.m3u8`,
    `${base}/videos/${videoId}/processed/hls/master.m3u8`,
    `${base}/videos/${videoId}/processed/playlist.m3u8`,
  ]

  let manifest = null
  for (const url of candidates) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const text = await res.text()
        // For master playlists, follow the first variant
        if (text.includes('#EXT-X-STREAM-INF')) {
          const lines    = text.split('\n')
          const varLine  = lines.find(l => !l.startsWith('#') && l.trim().endsWith('.m3u8'))
          if (varLine) {
            const trimmedLine = varLine.trim()
            const varUrl = new URL(trimmedLine, url).toString()
            const varRes = await fetch(varUrl)
            if (varRes.ok) manifest = await varRes.text()
          }
        } else {
          manifest = text
        }
        break
      }
    } catch { /* try next */ }
  }

  if (!manifest) return null

  // Parse #EXTINF durations from media playlist
  const durations = []
  for (const line of manifest.split('\n')) {
    const t = line.trim()
    if (t.startsWith('#EXTINF:')) {
      const dur = parseFloat(t.slice('#EXTINF:'.length))
      if (dur > 0) durations.push(dur)
    }
  }
  if (!durations.length) return null

  const avg = durations.reduce((a, b) => a + b, 0) / durations.length
  await env.RATE_LIMIT_KV.put(`manifest:${videoId}`, JSON.stringify({ avg }), { expirationTtl: 3600 })
  return avg
}

// ─── Segment count rate limiting (Step 4c) ────────────────────────────────────
//
// Allows up to 3× real-time segment requests per minute per user per video.
// Exceeding the threshold bans that user+video pair for 30 seconds.
//
// Uses a Durable Object to ensure atomic increment operations.

async function checkSegmentRateLimit(identifier: any, videoId: any, avgSegDur: any, env: any) {
  if (!env.RATE_LIMIT_KV) return false

  // Check active ban
  const banKey = `segban:${identifier}:${videoId}`
  const banned = await env.RATE_LIMIT_KV.get(banKey)
  if (banned) return true

  // Use Durable Object for atomic counting if available
  if (env.SEGMENT_RATE_LIMITER) {
    try {
      // Create a deterministic ID based on identifier and videoId
      const doId = env.SEGMENT_RATE_LIMITER.idFromName(`${identifier}:${videoId}`)
      const doStub = env.SEGMENT_RATE_LIMITER.get(doId)

      const response = await doStub.fetch('https://dummy-url/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, videoId, avgSegDur }),
      })

      const result = await response.json()

      if (result.exceeded) {
        await env.RATE_LIMIT_KV.put(banKey, '1', { expirationTtl: 30 })
        return true
      }

      return false
    } catch (error) {
      console.error('Durable Object rate limit error:', error)
      // Fall through to KV-based rate limiting as fallback
    }
  }

  // Fallback to non-atomic KV-based rate limiting (legacy)
  const segDur    = avgSegDur ?? 6 // default 6-second segments
  const threshold = Math.ceil(60 / segDur) * 3

  const minute   = Math.floor(Date.now() / 60000)
  const countKey = `segcount:${identifier}:${videoId}:${minute}`
  const raw      = await env.RATE_LIMIT_KV.get(countKey)
  const count    = (parseInt(raw ?? '0', 10) || 0) + 1
  await env.RATE_LIMIT_KV.put(countKey, String(count), { expirationTtl: 90 })

  if (count > threshold) {
    await env.RATE_LIMIT_KV.put(banKey, '1', { expirationTtl: 30 })
    return true
  }

  return false
}