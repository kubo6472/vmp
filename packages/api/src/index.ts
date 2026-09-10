/**
 * packages/api/src/index.js
 *
 * Main Cloudflare Worker entry point.
 * Auth routes added; CORS updated to support credentials (required for
 * the HttpOnly refresh-token cookie to be sent cross-origin).
 */

import type { DurableObjectState, ExecutionContext } from '@cloudflare/workers-types';
import * as Sentry from '@sentry/cloudflare';
import {
  canonicalWatchToken,
  compareVideosNewestFirst,
  isCmsPageIdPathSegment,
  isValidVideoSlug,
  sanitizeVideoSlug,
} from '@vmp/shared';
import type { ObjectStorageProvider } from '@vmp/storage/worker';
import {
  handleGetAccountNewsletterPreference,
  handlePutAccountNewsletterPreference,
} from './accountNewsletterPreference.js';
import {
  ensurePillsApiKeySetting,
  handleAdminAnalytics,
  handleAdminPillImageUpload,
  handleAdminPills,
  handleAdminPillsSettings,
  handleAdminUserImportCsv,
  handleAdminUsers,
  handleCategoryVideosBySlug,
  handleHomepageContent,
  handleHomepageContentPublic,
  handlePillsPublic,
  handlePillsUpdate,
  logSegmentEvent,
} from './adminExtras.js';
import { ensureAdminSettingsTable } from './adminSettingsTable.js';
import { handleAdminSystemFeatures } from './adminSystemFeatures.js';
import {
  handleGetMe,
  handleLogout,
  handleMagicPwaHandoff,
  handleNativeRedeemMagicLink,
  handleRedeemPwaHandoff,
  handleRefreshToken,
  handleRequestMagicLink,
  handleTotpConfirm,
  handleTotpDisable,
  handleTotpSetup,
  handleTotpVerify,
  handleVerifyMagicLink,
  requireAuth,
  requireRole,
  resolveAuthSubFromRequest,
} from './auth.js';
import { B2PrimaryHealthDOBase } from './b2PrimaryHealth.js';
import {
  handleAdminNewsletterCampaigns,
  handleAdminNewsletterDrafts,
  handleAdminNewsletterSchedule,
  handleAdminNewsletterSend,
  handleAdminNewsletterSettings,
  handleAdminNewsletterSync,
  handleAdminNewsletterTemplateById,
  handleAdminNewsletterTemplates,
  processNewsletterBrevoReconcileQueue,
} from './brevo.js';
import {
  handleCmsMediaBatch,
  handleCmsMediaById,
  handleCmsMediaUpload,
  handleCmsPageById,
  handleCmsPageBySlug,
  handleCmsPageCreate,
  handleCmsPagePublish,
  handleCmsPageRestoreRevision,
  handleCmsPageRevisions,
  handleCmsPagesList,
  handleCmsPageUnpublish,
} from './cmsPages.js';
import { applySessionBookmark, getDb, getReadSession } from './d1Session.js';
import { handleAdminDeploymentFeatures } from './deploymentFeaturesAdmin.js';
import {
  handleAccountInvoices,
  handleAdminEInvoiceById,
  handleAdminEInvoices,
  handleAdminEInvoicingSettings,
} from './eInvoicing.js';
import { handlePersonalFeed, handlePublicFeed } from './feed.js';
import {
  collectPlacementVideoIds,
  normalizeHomepagePlacementConfig,
  normalizePlacementVideoRows,
  placeHomepageVideos,
} from './homepagePlacement.js';
import { isPrivateHost } from './is-private-host.js';
import {
  handleAdminLegacyMigrationRelinkCandidates,
  handleAdminLegacyMigrationSendRelinkEmail,
  handleAdminLegacyMigrationStats,
  handleAdminLegacyMigrationValidateBatch,
} from './legacyMigration.js';
import {
  handleAdminLegacyPaymentSettings,
  handleLegacyCheckout,
  handleLegacyComplete,
  handleLegacyOrderStatus,
  handleLegacyWebhook,
} from './legacyPayments.js';
import { normalizeLivestreamStatus } from './livestreams.js';
import { log, runWithDatadogLogContext, setWorkerLogTracingContext } from './logger.js';
import {
  buildEntrypointCandidates,
  buildProxyPlaylistUrl,
  getVideoProxyCacheControl,
  resolveMediaEntrypointUrl,
  sortMasterPlaylistByBandwidth,
} from './mediaEntrypoints.js';
import {
  handleDevicePairingComplete,
  handleDevicePairingPoll,
  handleDevicePairingPreview,
  handleDevicePairingStart,
  handleNativePushRegister,
  handleNativePushUnregister,
} from './nativeClients.js';
import {
  getObjectStorage,
  parseHttpRangeHeader,
  storageGetResultToResponse,
} from './objectStorage.js';
import {
  handleAuthorizeDownload,
  handleDownloadAsset,
  handleListDownloads,
  handleListOfflineDevices,
  handleRegisterOfflineDevice,
  handleRenewDownloadLicenses,
  handleRevokeDownload,
  handleRevokeOfflineDevice,
} from './offlineDownloads.js';
import {
  handleAdminPaymentPlans,
  handleAdminPaymentSettings,
  handleCheckout,
  handleComgateWebhook,
  handleGetPricing,
  handleGetStripeConfig,
  handleGetSubscription,
  handleGoPayWebhook,
  handlePortal,
  handleSessionStatus,
  handleWebhook,
  runComgateRenewalJobs,
} from './payments.js';
import { handleVideoPipelineStatus } from './pipelineStatus.js';
import {
  handleAdminClearPlaybackPositions,
  handleDeletePlaybackPosition,
  handleGetPlaybackPosition,
  handleListPlaybackPositions,
  handlePutPlaybackPosition,
} from './playbackPositions.js';
import {
  enforceConcurrentPlaybackLimit,
  handleCreatePlaybackSession,
  handlePlaybackSessionHeartbeat,
  handleReleasePlaybackSession,
  PLAYBACK_SESSION_HEADER_NAME,
} from './playbackSessions.js';
import {
  capturePostHogException,
  POSTHOG_TRACING_REQUEST_HEADERS,
  posthogContextFromRequest,
  redactPathForAnalytics,
  resolvePostHogLogTracingContext,
} from './posthog.js';
import {
  handleAdminIsicCampaigns,
  handleAdminPromoCampaigns,
  handleAdminPromoCodes,
  handleIsicCampaignPublic,
  handleIsicValidate,
  handlePromoValidate,
} from './promotions.js';
import {
  createPushCampaignAndDeliveries,
  enqueueOverduePushDeliveries,
  ensurePushTierDefaultSettings,
  finalizeStalePushWatchSessions,
  handleAdminPushAnalytics,
  handlePushDeliveryQueue,
  handlePushEvents,
  isPushTierDeliveryEnabled,
  syncPushEngagementProfiles,
} from './pushEngagement.js';
import {
  handlePwaPushLoginDeliver,
  handlePwaPushLoginInit,
  handlePwaPushLoginSubscribe,
  handlePwaPushLoginVerify2fa,
} from './pwa-push-login.js';
import { checkAnonymousRateLimit } from './rateLimit.js';
import { handleVideoRecommendations } from './recommendations.js';
import {
  enqueueReplicationBatch,
  handleAdminReplicationPush,
  handleAdminReplicationSettings,
  handleReplicationQueue,
} from './replication.js';
import { isLocalVideoProxyUrl } from './requestPublicOrigin.js';
import { isAdministrativeRole } from './roles.js';
import { maybeBlockDeploymentFeatureRoute } from './routeFeatureGuard.js';
import { handleGetAccountRss, handleRotateAccountRss } from './rssAccount.js';
import {
  deliverPodcastPreviewRebuildWebhook,
  handleRssPodcastPreviewRebuildNotify,
  handleRssPodcastWebhookConfig,
} from './rssPodcastAdmin.js';
import { readRssTokenVersion } from './rssToken.js';
import { handleSiteFooterAdmin, handleSiteFooterPublic } from './siteFooter.js';
import { handleSiteSettings } from './siteSettings.js';
import { handleAdminSmokeAuth } from './smokeAuth.js';
import {
  handleAccountTransferSubscription,
  handleAdminTransferSubscription,
} from './subscriptionTransfer.js';
import {
  handleThumbnailDelete,
  handleThumbnailUpload,
  THUMBNAIL_CACHE_CONTROL,
} from './thumbnails.js';
import {
  getVideoProxyCache,
  isImmutableVideoProxyObject,
  videoProxyObjectCacheKey,
  withVideoProxyCacheHeader,
} from './videoProxyCache.js';
import { checkVideoTokenRssVersion, signVideoToken, verifyVideoToken } from './videoTokens.js';
import { sendPushNotification } from './webpush.js';

type CorsHeaders = Record<string, string>;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getPublicErrorMessage(fallback = 'Internal server error'): string {
  return fallback;
}

const MAX_MOQ_ENDPOINT_LENGTH = 2048;
const MAX_MOQ_BROADCAST_LENGTH = 128;

function validateMoqEndpoint(value: string): { ok: true } | { ok: false; error: string } {
  if (!value) return { ok: false, error: 'moqEndpoint is required' };
  if (value.length > MAX_MOQ_ENDPOINT_LENGTH) {
    return {
      ok: false,
      error: `moqEndpoint exceeds max length (${MAX_MOQ_ENDPOINT_LENGTH} chars)`,
    };
  }
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(value);
  } catch {
    return { ok: false, error: 'moqEndpoint must be a valid URL' };
  }
  if (!['https:', 'http:'].includes(parsedEndpoint.protocol)) {
    return { ok: false, error: 'moqEndpoint must use http or https scheme' };
  }
  return { ok: true };
}

function validateMoqBroadcast(value: string): { ok: true } | { ok: false; error: string } {
  if (!value) return { ok: false, error: 'moqBroadcast is required' };
  if (value.length > MAX_MOQ_BROADCAST_LENGTH) {
    return {
      ok: false,
      error: `moqBroadcast exceeds max length (${MAX_MOQ_BROADCAST_LENGTH} chars)`,
    };
  }
  if (/[\p{C}\s]/u.test(value)) {
    return { ok: false, error: 'moqBroadcast contains invalid control/whitespace characters' };
  }
  return { ok: true };
}

function deriveEffectiveLivestreamStatus(
  livestreamStatusRaw: unknown,
  videoPublishStatusRaw: unknown,
): string {
  const livestreamStatus = normalizeLivestreamStatus(livestreamStatusRaw, 'draft');
  if (livestreamStatus !== 'draft') return livestreamStatus;
  const videoPublishStatus =
    typeof videoPublishStatusRaw === 'string' ? videoPublishStatusRaw.trim().toLowerCase() : '';
  if (videoPublishStatus === 'published') return 'ready';
  if (videoPublishStatus === 'archived') return 'ended';
  return livestreamStatus;
}

function getErrorField(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as Record<string, unknown>)[key];
}

interface SegmentRateLimitBody {
  mode?: string;
  key?: string;
  limit?: number;
  identifier?: string;
  videoId?: string;
  avgSegDur?: number | null;
}

function clientDisconnectedResponse(): Response {
  return new Response(JSON.stringify({ skipped: true, reason: 'client_disconnected' }), {
    status: 499,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isClientDisconnectError(err: unknown, request: Request): boolean {
  if (request.signal.aborted) return true;
  if (!(err instanceof TypeError)) return false;
  const message = err.message.toLowerCase();
  return message.includes('abort') || message.includes('cancel') || message.includes('disconnect');
}

// ─── Durable Object for atomic rate limiting (HLS segments + device pairing) ─
// Binding is configured in wrangler.json under durable_objects.bindings.
// Used when env.SEGMENT_RATE_LIMITER is present. Pairing sends { mode: 'pairing', key, limit }.

class SegmentRateLimiterDOBase {
  env: Record<string, unknown>;
  state: DurableObjectState;
  constructor(state: DurableObjectState, env: Record<string, unknown>) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.signal.aborted) {
      return clientDisconnectedResponse();
    }

    let body: SegmentRateLimitBody;
    try {
      body = (await request.json()) as SegmentRateLimitBody;
    } catch (err) {
      if (isClientDisconnectError(err, request)) {
        return clientDisconnectedResponse();
      }
      throw err;
    }
    if (body.mode === 'pairing') {
      const countKey =
        typeof body.key === 'string' && body.key.trim() ? body.key.trim() : 'pairing:unknown';
      const parsedLimit = Number(body.limit);
      const limit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 1;
      const existing = Number((await this.state.storage.get<number>(countKey)) ?? 0);
      if (existing >= limit) {
        return new Response(JSON.stringify({ count: existing, limit, exceeded: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const count = await this.incrementAndScheduleCleanup(countKey);
      return new Response(JSON.stringify({ count, limit, exceeded: count > limit }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const identifier = body.identifier ?? 'unknown';
    const videoId = body.videoId ?? 'unknown';
    const avgSegDur = body.avgSegDur ?? null;

    const segDur = avgSegDur ?? 6; // default 6-second segments
    const threshold = Math.ceil(60 / segDur) * 3;

    const minute = Math.floor(Date.now() / 60000);
    const countKey = `${identifier}:${videoId}:${minute}`;
    const count = await this.incrementAndScheduleCleanup(countKey);
    const exceeded = count > threshold;

    return new Response(JSON.stringify({ count, threshold, exceeded }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async incrementAndScheduleCleanup(countKey: string): Promise<number> {
    // DOs serialize requests per object — get+put is atomic here.
    let count = Number((await this.state.storage.get<number>(countKey)) ?? 0);
    count += 1;
    await this.state.storage.put(countKey, count);

    // Schedule cleanup of old keys (after 2 minutes) using alarm API.
    // Keep a set of pending keys instead of a single slot to avoid overwriting
    // when multiple requests hit before alarm() runs.
    const pending = (await this.state.storage.get<string[]>('pendingCleanupKeys')) ?? [];
    if (!pending.includes(countKey)) {
      pending.push(countKey);
      await this.state.storage.put('pendingCleanupKeys', pending);
    }
    await this.state.storage.setAlarm(Date.now() + 120000);
    return count;
  }

  async alarm(): Promise<void> {
    // Alarm handler - cleanup all pending count keys accumulated since last run.
    const countKeys = (await this.state.storage.get<string[]>('pendingCleanupKeys')) ?? [];
    if (countKeys.length) {
      await Promise.all(countKeys.map((key) => this.state.storage.delete(key)));
      await this.state.storage.delete('pendingCleanupKeys');
    }
  }
}

const SENTRY_SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'password',
  'token',
  'secret',
  'api_key',
  'apikey',
  'x-smoke-token',
]);

function parseSentryTracesSampleRate(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return 0.1;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 0.1;
  return Math.min(1, Math.max(0, parsed));
}

function parseSentryEnvBoolean(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function redactSentryRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...record };
  for (const key of Object.keys(redacted)) {
    if (SENTRY_SENSITIVE_KEYS.has(key.toLowerCase())) {
      redacted[key] = '[Redacted]';
    }
  }
  return redacted;
}

function buildSentryOptions(env: Record<string, unknown>) {
  const dsn = typeof env.SENTRY_DSN === 'string' ? env.SENTRY_DSN.trim() : '';
  if (!dsn) {
    return { enabled: false };
  }

  const enableLogs = parseSentryEnvBoolean(env.SENTRY_ENABLE_LOGS);
  const options: Record<string, unknown> = {
    dsn,
    tracesSampleRate: parseSentryTracesSampleRate(env.SENTRY_TRACES_SAMPLE_RATE),
    enableLogs,
    environment: typeof env.SENTRY_ENVIRONMENT === 'string' ? env.SENTRY_ENVIRONMENT : undefined,
  };

  if (enableLogs) {
    options.beforeSend = (event: { request?: { headers?: Record<string, string> } }) => {
      if (event.request?.headers) {
        event.request.headers = redactSentryRecord(event.request.headers) as Record<string, string>;
      }
      return event;
    };
    options.beforeSendLog = (log: { attributes?: Record<string, unknown> }) => {
      if (log.attributes) {
        log.attributes = redactSentryRecord(log.attributes);
      }
      return log;
    };
  }

  return options;
}

export const SegmentRateLimiterDO = Sentry.instrumentDurableObjectWithSentry(
  (env) => buildSentryOptions(env as Record<string, unknown>),
  // Sentry bundles its own workers-types; cast avoids duplicate-type friction in tsc.
  SegmentRateLimiterDOBase as never,
);

export const B2PrimaryHealthDO = Sentry.instrumentDurableObjectWithSentry(
  (env) => buildSentryOptions(env as Record<string, unknown>),
  B2PrimaryHealthDOBase as never,
);

function logRequest(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  extra?: Record<string, unknown>,
) {
  log({
    service: 'worker',
    event: 'request',
    level: 'info',
    http_method: method,
    http_path: path,
    http_status: status,
    duration_ms: durationMs,
    ...extra,
  });
}

const workerHandler = {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    return runWithDatadogLogContext(env, ctx, async () => {
      const url = new URL(request.url);
      const authSub = await resolveAuthSubFromRequest(request, env);
      setWorkerLogTracingContext(resolvePostHogLogTracingContext(request, authSub));
      ctx.waitUntil(maybeRunScheduledPublishJobsInRequest(env));
      await maybeSyncPillsApiKey(env);

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
      const corsHeaders = buildCorsHeaders(request, env);
      const _reqStart = Date.now();

      try {
        if (request.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: {
              ...corsHeaders,
              'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
              'Access-Control-Allow-Headers':
                'Content-Type, Authorization, Range, x-d1-bookmark, X-VMP-Device-Token, ' +
                `${PLAYBACK_SESSION_HEADER_NAME}, ` +
                POSTHOG_TRACING_REQUEST_HEADERS.join(', '),
              'Access-Control-Max-Age': '86400',
            },
          });
        }

        const featureBlock = maybeBlockDeploymentFeatureRoute(request, env, corsHeaders);
        if (featureBlock) return featureBlock;

        // ── Auth routes ───────────────────────────────────────────────────────────
        if (url.pathname === '/api/auth/magic-link' && request.method === 'POST') {
          return handleRequestMagicLink(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/verify' && request.method === 'GET') {
          return handleVerifyMagicLink(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/native/redeem' && request.method === 'POST') {
          return handleNativeRedeemMagicLink(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/magic-pwa-handoff' && request.method === 'POST') {
          return handleMagicPwaHandoff(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/redeem-pwa-handoff' && request.method === 'POST') {
          return handleRedeemPwaHandoff(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/device-pairing/start' && request.method === 'POST') {
          return handleDevicePairingStart(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/device-pairing/preview' && request.method === 'POST') {
          return handleDevicePairingPreview(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/device-pairing/complete' && request.method === 'POST') {
          return handleDevicePairingComplete(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/device-pairing/poll' && request.method === 'POST') {
          return handleDevicePairingPoll(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/pwa-push-login/init' && request.method === 'POST') {
          return handlePwaPushLoginInit(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/pwa-push-login/subscribe' && request.method === 'POST') {
          return handlePwaPushLoginSubscribe(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/pwa-push-login/deliver' && request.method === 'POST') {
          return handlePwaPushLoginDeliver(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/pwa-push-login/verify-2fa' && request.method === 'POST') {
          return handlePwaPushLoginVerify2fa(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/refresh' && request.method === 'POST') {
          return handleRefreshToken(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
          return handleLogout(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/me' && request.method === 'GET') {
          return handleGetMe(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/2fa/setup' && request.method === 'GET') {
          return handleTotpSetup(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/2fa/confirm' && request.method === 'POST') {
          return handleTotpConfirm(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/2fa/disable' && request.method === 'POST') {
          return handleTotpDisable(request, env, corsHeaders);
        }
        if (url.pathname === '/api/auth/2fa/verify' && request.method === 'POST') {
          return handleTotpVerify(request, env, corsHeaders);
        }

        // ── Existing routes ───────────────────────────────────────────────────────
        if (url.pathname === '/api/recommendations' && request.method === 'GET') {
          return handleVideoRecommendations(request, env, corsHeaders);
        }
        if (url.pathname === '/api/videos') {
          return handleVideosList(request, env, corsHeaders);
        }
        if (url.pathname.match(/^\/api\/videos\/[^/]+\/meta$/) && request.method === 'GET') {
          return handleVideoPublicMeta(request, env, corsHeaders);
        }
        if (url.pathname === '/api/homepage/placement' && request.method === 'GET') {
          return handleHomepagePlacement(request, env, corsHeaders);
        }
        if (url.pathname === '/api/feed/public') {
          return handlePublicFeed(request, env, corsHeaders);
        }
        if (url.pathname.match(/^\/api\/feed\/[^/]+\/[^/]+$/)) {
          return handlePersonalFeed(request, env, corsHeaders);
        }
        if (url.pathname.startsWith('/api/video-access/')) {
          return handleVideoAccess(request, env, corsHeaders, ctx, _reqStart);
        }
        if (url.pathname.startsWith('/api/video-proxy/')) {
          return handleVideoProxy(request, env, corsHeaders, ctx, _reqStart);
        }
        {
          const pipelineStatusMatch = url.pathname.match(
            /^\/api\/admin\/videos\/([^/]+)\/pipeline-status$/,
          );
          const pipelineVideoId = pipelineStatusMatch?.[1];
          if (pipelineVideoId && request.method === 'POST') {
            return handleVideoPipelineStatus(request, env, corsHeaders, pipelineVideoId);
          }
        }
        if (url.pathname === '/api/admin/bootstrap' && request.method === 'POST') {
          return handleBootstrap(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/config') {
          return handleAdminConfig(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/categories' &&
          ['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)
        ) {
          return handleAdminCategories(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/preview-locks') {
          return handlePreviewLocks(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/videos') {
          return handleAdminVideosList(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/videos/livestreams' && request.method === 'POST') {
          return handleAdminLivestreamCreate(request, env, corsHeaders);
        }
        if (
          url.pathname.match(/^\/api\/admin\/videos\/[^/]+\/thumbnail$/) &&
          request.method === 'POST'
        ) {
          return handleThumbnailUpload(request, env, corsHeaders);
        }
        if (
          url.pathname.match(/^\/api\/admin\/videos\/[^/]+\/thumbnail$/) &&
          request.method === 'DELETE'
        ) {
          return handleThumbnailDelete(request, env, corsHeaders);
        }
        if (
          url.pathname.match(/^\/api\/admin\/videos\/[^/]+\/livestream$/) &&
          request.method === 'PATCH'
        ) {
          return handleAdminLivestreamUpdate(request, env, corsHeaders);
        }
        if (url.pathname.startsWith('/api/admin/videos/') && request.method === 'PATCH') {
          return handleAdminVideoUpdate(request, env, ctx, corsHeaders);
        }
        if (url.pathname.match(/^\/api\/admin\/videos\/[^/]+$/) && request.method === 'DELETE') {
          return handleAdminVideoDelete(request, env, corsHeaders);
        }
        if (
          url.pathname.match(/^\/api\/admin\/videos\/[^/]+\/notify$/) &&
          request.method === 'POST'
        ) {
          return handleAdminVideoNotify(request, env, ctx, corsHeaders);
        }
        if (
          url.pathname.match(/^\/api\/admin\/videos\/[^/]+\/swap$/) &&
          request.method === 'POST'
        ) {
          return handleVideoSwap(request, env, corsHeaders);
        }
        if (
          url.pathname.match(/^\/api\/admin\/videos\/([^/]+)\/playback-positions$/) &&
          request.method === 'DELETE'
        ) {
          const adminPlaybackMatch = url.pathname.match(
            /^\/api\/admin\/videos\/([^/]+)\/playback-positions$/,
          );
          const adminPlaybackVideoId = adminPlaybackMatch?.[1];
          if (adminPlaybackVideoId) {
            return handleAdminClearPlaybackPositions(
              request,
              env,
              corsHeaders,
              adminPlaybackVideoId,
            );
          }
        }
        if (url.pathname === '/api/admin/push/test' && request.method === 'POST') {
          return handleAdminPushTest(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/newsletter/settings' &&
          (request.method === 'GET' || request.method === 'PATCH')
        ) {
          return handleAdminNewsletterSettings(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/newsletter/send' && request.method === 'POST') {
          return handleAdminNewsletterSend(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/newsletter/campaigns' && request.method === 'GET') {
          return handleAdminNewsletterCampaigns(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/payments/settings' &&
          ['GET', 'PATCH'].includes(request.method)
        ) {
          return handleAdminPaymentSettings(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/einvoicing/settings' &&
          ['GET', 'PATCH'].includes(request.method)
        ) {
          return handleAdminEInvoicingSettings(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/einvoicing/invoices' && request.method === 'GET') {
          return handleAdminEInvoices(request, env, corsHeaders);
        }
        {
          const eInvoiceById = url.pathname.match(/^\/api\/admin\/einvoicing\/invoices\/([^/]+)$/);
          if (eInvoiceById?.[1] && request.method === 'GET') {
            return handleAdminEInvoiceById(request, env, corsHeaders, eInvoiceById[1]);
          }
        }
        if (
          url.pathname === '/api/admin/promotions/campaigns' &&
          ['GET', 'POST', 'PATCH'].includes(request.method)
        ) {
          return handleAdminPromoCampaigns(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/promotions/codes' &&
          ['GET', 'POST', 'PATCH'].includes(request.method)
        ) {
          return handleAdminPromoCodes(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/isic/campaigns' &&
          ['GET', 'POST', 'PATCH'].includes(request.method)
        ) {
          return handleAdminIsicCampaigns(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/site-settings' &&
          ['GET', 'PATCH'].includes(request.method)
        ) {
          return handleSiteSettings(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/deployment-features' && request.method === 'GET') {
          return handleAdminDeploymentFeatures(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/system/features' &&
          ['GET', 'PATCH'].includes(request.method)
        ) {
          return handleAdminSystemFeatures(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/replication/push' && request.method === 'POST') {
          return handleAdminReplicationPush(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/replication' &&
          ['GET', 'PATCH'].includes(request.method)
        ) {
          return handleAdminReplicationSettings(request, env, corsHeaders);
        }
        {
          const templateById = url.pathname.match(/^\/api\/admin\/newsletter\/templates\/([^/]+)$/);
          if (templateById && (request.method === 'PATCH' || request.method === 'DELETE')) {
            return handleAdminNewsletterTemplateById(request, env, corsHeaders, templateById[1]);
          }
        }
        if (
          url.pathname === '/api/admin/newsletter/templates' &&
          (request.method === 'GET' || request.method === 'POST')
        ) {
          return handleAdminNewsletterTemplates(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/newsletter/sync' && request.method === 'POST') {
          return handleAdminNewsletterSync(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/newsletter/schedule' && request.method === 'POST') {
          return handleAdminNewsletterSchedule(request, env, corsHeaders);
        }
        {
          const draftById = url.pathname.match(/^\/api\/admin\/newsletter\/drafts\/([^/]+)$/);
          if (draftById && (request.method === 'PATCH' || request.method === 'DELETE')) {
            return handleAdminNewsletterDrafts(request, env, corsHeaders, draftById[1]);
          }
        }
        if (
          url.pathname === '/api/admin/newsletter/drafts' &&
          (request.method === 'GET' || request.method === 'POST')
        ) {
          return handleAdminNewsletterDrafts(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/payments/plans' &&
          ['GET', 'PATCH'].includes(request.method)
        ) {
          return handleAdminPaymentPlans(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/rss/podcast-rebuild-webhook' &&
          ['GET', 'PATCH'].includes(request.method)
        ) {
          return handleRssPodcastWebhookConfig(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/rss/podcast-preview-rebuild' &&
          request.method === 'POST'
        ) {
          return handleRssPodcastPreviewRebuildNotify(request, env, corsHeaders);
        }
        if (url.pathname === '/api/homepage/content' && request.method === 'GET') {
          return handleHomepageContentPublic(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/homepage/content' &&
          (request.method === 'GET' || request.method === 'PATCH')
        ) {
          return handleHomepageContent(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/users' &&
          (request.method === 'GET' || request.method === 'PATCH' || request.method === 'POST')
        ) {
          return handleAdminUsers(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/users/import-csv' && request.method === 'POST') {
          return handleAdminUserImportCsv(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/users/transfer-subscription' &&
          request.method === 'POST'
        ) {
          return handleAdminTransferSubscription(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/analytics' &&
          (request.method === 'GET' || request.method === 'PATCH')
        ) {
          return handleAdminAnalytics(request, env, corsHeaders);
        }
        if (url.pathname === '/api/site-settings' && request.method === 'GET') {
          return handleSiteSettings(request, env, corsHeaders);
        }
        if (url.pathname === '/api/site-footer' && request.method === 'GET') {
          return handleSiteFooterPublic(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/site-footer' &&
          ['GET', 'PATCH'].includes(request.method)
        ) {
          return handleSiteFooterAdmin(request, env, corsHeaders);
        }
        if (url.pathname === '/api/pages' && request.method === 'GET') {
          return handleCmsPagesList(request, env, corsHeaders);
        }
        if (url.pathname === '/api/pages' && request.method === 'POST') {
          return handleCmsPageCreate(request, env, corsHeaders);
        }
        // Page ids may be UUIDs or stable system ids (e.g. cms-page-personal-data).
        // Revision ids remain UUID-only. Slug GET uses any remaining non-id segment.
        const cmsPageRestore = url.pathname.match(
          /^\/api\/pages\/([^/]+)\/revisions\/([0-9a-f-]{36})\/restore$/,
        );
        const cmsPageRestoreId = cmsPageRestore?.[1];
        const cmsPageRestoreRevisionId = cmsPageRestore?.[2];
        if (
          cmsPageRestoreId &&
          isCmsPageIdPathSegment(cmsPageRestoreId) &&
          cmsPageRestoreRevisionId &&
          request.method === 'POST'
        ) {
          return handleCmsPageRestoreRevision(
            request,
            env,
            corsHeaders,
            cmsPageRestoreId,
            cmsPageRestoreRevisionId,
          );
        }
        const cmsPageRevisions = url.pathname.match(/^\/api\/pages\/([^/]+)\/revisions$/);
        const cmsPageRevisionsId = cmsPageRevisions?.[1];
        if (
          cmsPageRevisionsId &&
          isCmsPageIdPathSegment(cmsPageRevisionsId) &&
          request.method === 'GET'
        ) {
          return handleCmsPageRevisions(request, env, corsHeaders, cmsPageRevisionsId);
        }
        const cmsPagePublish = url.pathname.match(/^\/api\/pages\/([^/]+)\/publish$/);
        const cmsPagePublishId = cmsPagePublish?.[1];
        if (
          cmsPagePublishId &&
          isCmsPageIdPathSegment(cmsPagePublishId) &&
          request.method === 'POST'
        ) {
          return handleCmsPagePublish(request, env, corsHeaders, cmsPagePublishId);
        }
        const cmsPageUnpublish = url.pathname.match(/^\/api\/pages\/([^/]+)\/unpublish$/);
        const cmsPageUnpublishId = cmsPageUnpublish?.[1];
        if (
          cmsPageUnpublishId &&
          isCmsPageIdPathSegment(cmsPageUnpublishId) &&
          request.method === 'POST'
        ) {
          return handleCmsPageUnpublish(request, env, corsHeaders, cmsPageUnpublishId);
        }
        const cmsPageById = url.pathname.match(/^\/api\/pages\/([^/]+)$/);
        const cmsPageId = cmsPageById?.[1];
        if (
          cmsPageId &&
          isCmsPageIdPathSegment(cmsPageId) &&
          ['GET', 'PUT', 'DELETE'].includes(request.method)
        ) {
          return handleCmsPageById(request, env, corsHeaders, cmsPageId);
        }
        const cmsPageBySlug = url.pathname.match(/^\/api\/pages\/([^/]+)$/);
        const cmsPageSlug = cmsPageBySlug?.[1];
        if (cmsPageSlug && request.method === 'GET') {
          return handleCmsPageBySlug(request, env, corsHeaders, cmsPageSlug);
        }
        if (url.pathname === '/api/admin/cms/media' && request.method === 'POST') {
          return handleCmsMediaUpload(request, env, corsHeaders);
        }
        if (url.pathname === '/api/cms/media/batch' && request.method === 'GET') {
          return handleCmsMediaBatch(request, env, corsHeaders);
        }
        const cmsMediaById = url.pathname.match(/^\/api\/cms\/media\/([^/]+)$/);
        const cmsMediaId = cmsMediaById?.[1];
        if (cmsMediaId && request.method === 'GET') {
          return handleCmsMediaById(request, env, corsHeaders, cmsMediaId);
        }
        if (url.pathname === '/api/pills' && request.method === 'GET') {
          return handlePillsPublic(request, env, corsHeaders);
        }
        if (url.pathname === '/api/pills/update' && request.method === 'POST') {
          return handlePillsUpdate(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/pills' &&
          ['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)
        ) {
          return handleAdminPills(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/pills/image-upload' && request.method === 'POST') {
          return handleAdminPillImageUpload(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/pills/settings' &&
          ['GET', 'PATCH'].includes(request.method)
        ) {
          return handleAdminPillsSettings(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/smoke-auth' && request.method === 'GET') {
          return handleAdminSmokeAuth(request, env, corsHeaders);
        }
        if (url.pathname.match(/^\/api\/categories\/[^/]+\/videos$/) && request.method === 'GET') {
          return handleCategoryVideosBySlug(request, env, corsHeaders);
        }
        if (url.pathname === '/api/account/pricing' && request.method === 'GET') {
          return handleGetPricing(request, env, corsHeaders);
        }
        if (url.pathname === '/api/payments/stripe-config' && request.method === 'GET') {
          return handleGetStripeConfig(request, env, corsHeaders);
        }
        if (url.pathname === '/api/payments/checkout' && request.method === 'POST') {
          return handleCheckout(request, env, corsHeaders);
        }
        if (url.pathname === '/api/payments/session-status' && request.method === 'GET') {
          return handleSessionStatus(request, env, corsHeaders);
        }
        if (url.pathname === '/api/payments/webhook' && request.method === 'POST') {
          return handleWebhook(request, env, corsHeaders, 'stripe', ctx);
        }
        if (url.pathname === '/api/payments/webhook/stripe' && request.method === 'POST') {
          return handleWebhook(request, env, corsHeaders, 'stripe', ctx);
        }
        if (url.pathname === '/api/payments/webhook/gopay' && request.method === 'GET') {
          return handleGoPayWebhook(request, env, corsHeaders);
        }
        if (url.pathname === '/api/payments/webhook/comgate' && request.method === 'POST') {
          return handleComgateWebhook(request, env, corsHeaders);
        }
        if (url.pathname === '/api/payments/webhook/legacy' && request.method === 'POST') {
          return handleLegacyWebhook(request, env, corsHeaders, ctx);
        }
        if (url.pathname === '/api/payments/legacy/checkout' && request.method === 'POST') {
          return handleLegacyCheckout(request, env, corsHeaders);
        }
        if (url.pathname === '/api/payments/legacy/complete' && request.method === 'POST') {
          return handleLegacyComplete(request, env, corsHeaders);
        }
        if (url.pathname === '/api/payments/legacy/order-status' && request.method === 'GET') {
          return handleLegacyOrderStatus(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/payments/legacy' && request.method === 'GET') {
          return handleAdminLegacyPaymentSettings(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/legacy-migration/stats' && request.method === 'GET') {
          return handleAdminLegacyMigrationStats(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/legacy-migration/validate-batch' &&
          request.method === 'POST'
        ) {
          return handleAdminLegacyMigrationValidateBatch(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/legacy-migration/relink-candidates' &&
          request.method === 'GET'
        ) {
          return handleAdminLegacyMigrationRelinkCandidates(request, env, corsHeaders);
        }
        if (
          url.pathname === '/api/admin/legacy-migration/send-relink-email' &&
          request.method === 'POST'
        ) {
          return handleAdminLegacyMigrationSendRelinkEmail(request, env, corsHeaders);
        }
        // ── Offline downloads (M1/M2) ─────────────────────────────────────────────
        if (url.pathname === '/api/offline/devices/register' && request.method === 'POST') {
          return handleRegisterOfflineDevice(request, env, corsHeaders);
        }
        if (url.pathname === '/api/offline/devices' && request.method === 'GET') {
          return handleListOfflineDevices(request, env, corsHeaders);
        }
        {
          const offlineDeviceMatch = url.pathname.match(/^\/api\/offline\/devices\/([^/]+)$/);
          const offlineDeviceId = offlineDeviceMatch?.[1];
          if (offlineDeviceId && request.method === 'DELETE') {
            return handleRevokeOfflineDevice(request, env, corsHeaders, offlineDeviceId);
          }
        }
        if (url.pathname === '/api/downloads/licenses/renew' && request.method === 'POST') {
          return handleRenewDownloadLicenses(request, env, corsHeaders);
        }
        if (url.pathname === '/api/downloads' && request.method === 'GET') {
          return handleListDownloads(request, env, corsHeaders);
        }
        {
          const downloadAssetMatch = url.pathname.match(
            /^\/api\/downloads\/([^/]+)\/assets\/(.+)$/,
          );
          const downloadVideoId = downloadAssetMatch?.[1];
          const downloadAssetPath = downloadAssetMatch?.[2];
          if (downloadVideoId && downloadAssetPath && request.method === 'GET') {
            let decodedAssetPath: string;
            try {
              decodedAssetPath = decodeURIComponent(downloadAssetPath);
            } catch {
              return jsonResponse({ error: 'Invalid asset path encoding' }, 400, corsHeaders);
            }
            return handleDownloadAsset(
              request,
              env,
              corsHeaders,
              downloadVideoId,
              decodedAssetPath,
            );
          }
        }
        {
          const downloadAuthorizeMatch = url.pathname.match(
            /^\/api\/downloads\/([^/]+)\/authorize$/,
          );
          const authorizeVideoId = downloadAuthorizeMatch?.[1];
          if (authorizeVideoId && request.method === 'POST') {
            return handleAuthorizeDownload(request, env, corsHeaders, authorizeVideoId);
          }
        }
        {
          const downloadRevokeMatch = url.pathname.match(/^\/api\/downloads\/([^/]+)$/);
          const revokeVideoId = downloadRevokeMatch?.[1];
          if (revokeVideoId && request.method === 'DELETE') {
            return handleRevokeDownload(request, env, corsHeaders, revokeVideoId);
          }
        }

        if (url.pathname === '/api/account/subscription' && request.method === 'GET') {
          return handleGetSubscription(request, env, corsHeaders);
        }
        if (url.pathname === '/api/account/promotions/validate' && request.method === 'POST') {
          return handlePromoValidate(request, env, corsHeaders);
        }
        if (url.pathname === '/api/account/isic/validate' && request.method === 'POST') {
          return handleIsicValidate(request, env, corsHeaders);
        }
        if (url.pathname === '/api/account/isic/campaigns' && request.method === 'GET') {
          return handleIsicCampaignPublic(request, env, corsHeaders);
        }
        if (url.pathname === '/api/account/rss' && request.method === 'GET') {
          return handleGetAccountRss(request, env, corsHeaders);
        }
        if (url.pathname === '/api/account/newsletter-preference' && request.method === 'GET') {
          return handleGetAccountNewsletterPreference(request, env, corsHeaders);
        }
        if (url.pathname === '/api/account/newsletter-preference' && request.method === 'PUT') {
          return handlePutAccountNewsletterPreference(request, env, corsHeaders);
        }
        if (url.pathname === '/api/account/rss/rotate' && request.method === 'POST') {
          return handleRotateAccountRss(request, env, corsHeaders);
        }
        if (url.pathname === '/api/account/playback-positions' && request.method === 'GET') {
          return handleListPlaybackPositions(request, env, corsHeaders);
        }
        {
          const playbackPositionMatch = url.pathname.match(
            /^\/api\/account\/playback-positions\/([^/]+)$/,
          );
          const playbackVideoId = playbackPositionMatch?.[1];
          if (playbackVideoId && request.method === 'GET') {
            return handleGetPlaybackPosition(request, env, corsHeaders, playbackVideoId);
          }
          if (playbackVideoId && request.method === 'PUT') {
            return handlePutPlaybackPosition(request, env, corsHeaders, playbackVideoId);
          }
          if (playbackVideoId && request.method === 'DELETE') {
            return handleDeletePlaybackPosition(request, env, corsHeaders, playbackVideoId);
          }
        }
        if (url.pathname === '/api/account/playback-sessions' && request.method === 'POST') {
          return handleCreatePlaybackSession(request, env, corsHeaders, ctx);
        }
        {
          const playbackSessionMatch = url.pathname.match(
            /^\/api\/account\/playback-sessions\/([^/]+)$/,
          );
          const sessionId = playbackSessionMatch?.[1];
          if (sessionId && request.method === 'PUT') {
            return handlePlaybackSessionHeartbeat(request, env, corsHeaders, sessionId);
          }
          if (sessionId && request.method === 'DELETE') {
            return handleReleasePlaybackSession(request, env, corsHeaders, sessionId);
          }
        }
        if (url.pathname === '/api/account/invoices' && request.method === 'GET') {
          return handleAccountInvoices(request, env, corsHeaders);
        }
        if (url.pathname === '/api/account/transfer-subscription' && request.method === 'POST') {
          return handleAccountTransferSubscription(request, env, corsHeaders);
        }
        if (url.pathname === '/api/payments/portal' && request.method === 'POST') {
          return handlePortal(request, env, corsHeaders);
        }
        // ── Push notification routes ──────────────────────────────────────────────
        if (url.pathname === '/api/push/vapid-public-key' && request.method === 'GET') {
          return handleGetVapidPublicKey(request, env, corsHeaders);
        }
        if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
          return handlePushSubscribe(request, env, corsHeaders);
        }
        if (url.pathname === '/api/push/device' && request.method === 'POST') {
          return handleNativePushRegister(request, env, corsHeaders);
        }
        if (url.pathname === '/api/push/device' && request.method === 'DELETE') {
          return handleNativePushUnregister(request, env, corsHeaders);
        }
        if (url.pathname === '/api/push/events' && request.method === 'POST') {
          return handlePushEvents(request, env, corsHeaders);
        }
        if (url.pathname === '/api/admin/push-analytics' && request.method === 'GET') {
          return handleAdminPushAnalytics(request, env, corsHeaders);
        }
        if (url.pathname === '/api/push/subscribe' && request.method === 'DELETE') {
          return handlePushUnsubscribe(request, env, corsHeaders);
        }
        if (url.pathname === '/api/health') {
          return jsonResponse({ status: 'healthy' }, 200, corsHeaders);
        }

        log({
          service: 'worker',
          event: 'route_not_found',
          http_method: request.method,
          http_path: url.pathname,
          http_status: 404,
        });
        return jsonResponse({ error: 'Not Found' }, 404, corsHeaders);
      } catch (err) {
        if (!request.signal.aborted) {
          capturePostHogException(env, err, {
            request,
            ctx,
            properties: {
              handler: 'fetch',
              http_method: request.method,
              http_path: redactPathForAnalytics(url.pathname),
            },
          });
        }
        return jsonResponse(
          {
            error: getPublicErrorMessage('Internal server error'),
            code: 'internal_error',
          },
          500,
          corsHeaders,
        );
      }
    });
  },

  async scheduled(event: any, env: any, ctx: ExecutionContext) {
    return runWithDatadogLogContext(env, ctx, async () => {
      const cron = String(event?.cron ?? '*/5 * * * *');
      const runReplication = cron === '*/15 * * * *';

      if (!runReplication) {
        try {
          await runComgateRenewalJobs(env);
        } catch (err) {
          console.error('Comgate renewal sweep failed:', err);
        }
        try {
          await runScheduledPublishJobs(env);
          await syncScheduledPublishHint(env);
        } catch (err) {
          console.error('Scheduled publish sweep failed:', err);
        }
        try {
          await ensurePushTierDefaultSettings(env);
          await enqueueOverduePushDeliveries(env);
          await syncPushEngagementProfiles(env);
          await finalizeStalePushWatchSessions(env);
        } catch (err) {
          console.error('Push engagement sweep failed:', err);
        }
        try {
          await processNewsletterBrevoReconcileQueue(env);
        } catch (err) {
          console.error('Newsletter Brevo reconcile sweep failed:', err);
        }
      }

      if (runReplication) {
        try {
          await enqueueReplicationBatch(env);
        } catch (err) {
          console.error('Replication enqueue sweep failed:', err);
        }
      }
    });
  },

  async queue(batch: any, env: any, ctx: ExecutionContext) {
    return runWithDatadogLogContext(env, ctx, async () => {
      const queueName = String(batch?.queue ?? '');
      if (queueName.includes('push-delivery')) {
        await handlePushDeliveryQueue(batch, env);
        return;
      }
      await handleReplicationQueue(batch, env);
    });
  },
};

export default Sentry.withSentry(
  (env) => buildSentryOptions(env as Record<string, unknown>),
  workerHandler as never,
);

// ─── CORS helpers ─────────────────────────────────────────────────────────────

function buildCorsHeaders(request: any, env: any) {
  const requestOrigin = request.headers.get('Origin') || '';
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);

  if (allowedOrigins.includes(requestOrigin)) {
    // Credentialed CORS — required for the cookie to be sent/received
    return {
      'Access-Control-Allow-Origin': requestOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Expose-Headers':
        'Accept-Ranges, Content-Length, Content-Range, Content-Type, x-d1-bookmark',
      Vary: 'Origin',
    };
  }

  // Public CORS — no credentials, matches any origin (e.g. curl, public consumers)
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers':
      'Accept-Ranges, Content-Length, Content-Range, Content-Type, x-d1-bookmark',
  };
}

function parseAllowedOrigins(envValue: any) {
  if (!envValue) return [];
  return envValue
    .split(',')
    .map((o: any) => o.trim())
    .filter(Boolean);
}

/** Collapse LEFT JOIN duplicate rows (multi-category) and order like homepage placement. */
function dedupeVideoListRows(rows: any[]) {
  return normalizePlacementVideoRows(rows).sort((a, b) => compareVideosNewestFirst(a, b));
}

// ─── Existing handler implementations (unchanged) ─────────────────────────────

async function handleHomepagePlacement(request: any, env: any, corsHeaders: any) {
  if (request.method !== 'GET')
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  try {
    const db = getDatabaseBinding(env);
    await ensureAdminSettingsTable(db);
    const [videoRows, catRows, homepageRow] = await Promise.all([
      db
        .prepare(`
        SELECT v.id, v.published_at, v.upload_date, vca.category_id
        FROM videos v
        LEFT JOIN video_category_assignments vca ON vca.video_id = v.id
        WHERE v.publish_status = 'published'
          AND (v.scheduled_publish_at IS NULL OR datetime(v.scheduled_publish_at) <= CURRENT_TIMESTAMP)
      `)
        .all(),
      db
        .prepare(`
        SELECT id, slug, name, sort_order, direction, homepage_layout_variant
        FROM video_categories
      `)
        .all(),
      db.prepare('SELECT value FROM admin_settings WHERE key = ? LIMIT 1').bind('homepage').first(),
    ]);
    const homepageRaw = safeJsonParse(homepageRow?.value, defaultHomepageConfig());
    const homepage = normalizeHomepagePlacementConfig(homepageRaw);
    const layoutBlocks = Array.isArray(homepageRaw?.layoutBlocks) ? homepageRaw.layoutBlocks : [];
    const normalizedVideos = normalizePlacementVideoRows(videoRows.results || []);
    const placement = placeHomepageVideos({
      videos: normalizedVideos,
      categories: catRows.results || [],
      homepage,
      layoutBlocks,
    });
    const videoIds = new Set(collectPlacementVideoIds(placement));
    const newestPublished = [...normalizedVideos].sort(compareVideosNewestFirst)[0];
    if (newestPublished?.id) videoIds.add(newestPublished.id);

    let placementVideos: any[] = [];
    if (videoIds.size) {
      const PLACEMENT_VIDEO_ID_CHUNK_SIZE = 90;
      const idList = [...videoIds];
      const slimSql = `
        SELECT v.id, v.title, v.description, v.thumbnail_url, v.full_duration, v.preview_duration,
               v.upload_date, v.publish_status, v.slug, v.published_at,
               vc.id AS category_id, vc.name AS category_name, vc.slug AS category_slug
        FROM videos v
        LEFT JOIN video_category_assignments vca ON vca.video_id = v.id
        LEFT JOIN video_categories vc ON vc.id = vca.category_id
        WHERE v.id IN (
      `;
      const mergedRows: any[] = [];
      for (let i = 0; i < idList.length; i += PLACEMENT_VIDEO_ID_CHUNK_SIZE) {
        const chunk = idList.slice(i, i + PLACEMENT_VIDEO_ID_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        const slimRows = await db
          .prepare(`${slimSql}${placeholders})`)
          .bind(...chunk)
          .all();
        mergedRows.push(...(slimRows.results || []));
      }
      placementVideos = dedupeVideoListRows(mergedRows);
    }

    return jsonResponse({ ...placement, videos: placementVideos }, 200, corsHeaders);
  } catch (error) {
    console.error('handleHomepagePlacement:', error);
    return jsonResponse(
      { error: getPublicErrorMessage('Internal server error') },
      500,
      corsHeaders,
    );
  }
}

async function handleVideosList(request: any, env: any, corsHeaders: any) {
  try {
    const { session } = getReadSession(env, request);

    // Editors and above see all statuses; everyone else only sees published videos.
    let isEditor = false;
    try {
      await requireRole(request, env, 'editor', 'admin', 'super_admin');
      isEditor = true;
    } catch {
      isEditor = false;
    }

    const query = isEditor
      ? `SELECT v.id, v.title, v.description, v.thumbnail_url, v.full_duration, v.preview_duration, v.upload_date, v.publish_status, v.slug,
                v.published_at, v.scheduled_publish_at, v.notified_at,
                vc.id AS category_id,
                vc.name AS category_name,
                vc.slug AS category_slug,
                ls.provider AS livestream_provider,
                ls.status AS livestream_status,
                ls.recording_video_id AS livestream_recording_video_id
         FROM videos v
         LEFT JOIN video_category_assignments vca ON vca.video_id = v.id
         LEFT JOIN video_categories vc ON vc.id = vca.category_id
         LEFT JOIN livestreams ls ON ls.video_id = v.id
         ORDER BY CASE WHEN v.published_at IS NOT NULL AND trim(v.published_at) != '' THEN v.published_at ELSE v.upload_date END DESC,
                  v.id DESC`
      : `SELECT v.id, v.title, v.description, v.thumbnail_url, v.full_duration, v.preview_duration, v.upload_date, v.publish_status, v.slug,
                v.published_at, v.scheduled_publish_at, v.notified_at,
                vc.id AS category_id,
                vc.name AS category_name,
                vc.slug AS category_slug,
                ls.provider AS livestream_provider,
                ls.status AS livestream_status,
                ls.recording_video_id AS livestream_recording_video_id
         FROM videos v
         LEFT JOIN video_category_assignments vca ON vca.video_id = v.id
         LEFT JOIN video_categories vc ON vc.id = vca.category_id
         LEFT JOIN livestreams ls ON ls.video_id = v.id
         WHERE v.publish_status = 'published'
           AND (v.scheduled_publish_at IS NULL OR datetime(v.scheduled_publish_at) <= CURRENT_TIMESTAMP)
         ORDER BY CASE WHEN v.published_at IS NOT NULL AND trim(v.published_at) != '' THEN v.published_at ELSE v.upload_date END DESC,
                  v.id DESC`;

    const videos = await session.prepare(query).all();

    // Best-effort duration hydration for legacy rows where full_duration=0.
    // Cached in KV so this stays cheap for repeated list loads.
    const results = dedupeVideoListRows(videos.results || []);
    if (env.R2_BASE_URL) {
      await Promise.all(
        results.map(async (v: any) => {
          if (!v || typeof v.id !== 'string') return;
          if (typeof v.full_duration === 'number' && v.full_duration > 0) return;
          const resolved = await resolveVideoDurationSeconds(v.id, env);
          if (resolved && resolved > 0) v.full_duration = resolved;
        }),
      );
    }

    const response = jsonResponse({ videos: results }, 200, corsHeaders);
    applySessionBookmark(response.headers, session);
    return response;
  } catch (error) {
    console.error('Error:', error);
    return jsonResponse(
      { error: getPublicErrorMessage('Internal server error') },
      500,
      corsHeaders,
    );
  }
}

/** Public metadata for Open Graph / social previews (no auth, no rate limit). */
async function handleVideoPublicMeta(request: any, env: any, corsHeaders: any) {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  try {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const rawIdOrSlug = pathParts.length === 4 ? decodeURIComponent(pathParts[2] ?? '') : '';
    const idOrSlug = normalizeVideoId(rawIdOrSlug);
    if (!idOrSlug) {
      return jsonResponse({ error: 'Invalid video id' }, 400, corsHeaders);
    }

    const db = getDatabaseBinding(env);
    const video = await resolveVideoByIdOrSlug(db, idOrSlug);
    if (!video || video.publish_status !== 'published') {
      return jsonResponse({ error: 'Video not found' }, 404, corsHeaders);
    }

    if (video.scheduled_publish_at) {
      const scheduledAt = parseAdminTimestampToUtcMillis(String(video.scheduled_publish_at));
      if (Number.isFinite(scheduledAt) && scheduledAt > Date.now()) {
        return jsonResponse({ error: 'Video not found' }, 404, corsHeaders);
      }
    }

    return jsonResponse(
      {
        id: video.id,
        slug: video.slug ?? null,
        title: video.title ?? '',
        description: video.description ?? '',
        thumbnail_url: video.thumbnail_url ?? null,
        canonicalWatchPath: `/watch/${encodeURIComponent(canonicalWatchToken({ id: video.id, slug: video.slug ?? null }))}`,
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    console.error('handleVideoPublicMeta:', error);
    return jsonResponse(
      { error: getPublicErrorMessage('Internal server error') },
      500,
      corsHeaders,
    );
  }
}

async function handleVideoAccess(
  request: any,
  env: any,
  corsHeaders: any,
  ctx?: ExecutionContext,
  reqStart = Date.now(),
) {
  try {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);

    // Supports both:
    //   /api/video-access/{videoId}                 (preferred; user from JWT)
    //   /api/video-access/{userId}/{videoId}        (legacy fallback)
    let legacyUserId = null;
    let requestedVideoId = null;

    if (pathParts.length === 3) {
      requestedVideoId = decodeURIComponent(pathParts[2] ?? '');
    } else if (pathParts.length === 4) {
      // DEPRECATED: Legacy callers still send /api/video-access/{userId}/{videoId}.
      // Keep this temporarily for backward compatibility while clients migrate
      // to /api/video-access/{videoId} with Authorization header when available.
      legacyUserId = pathParts[2];
      requestedVideoId = decodeURIComponent(pathParts[3] ?? '');
      // Log deprecation warning without raw user identifiers to comply with privacy/retention policies
      // Suppress warning for 'anonymous' userId to avoid log spam from admin UI
      if (legacyUserId !== 'anonymous') {
        console.warn(
          'DEPRECATED_API_CALL /api/video-access/{userId}/{videoId} - Legacy path format still in use',
        );
      }
    } else {
      return jsonResponse(
        { error: 'Invalid path format. Expected: /api/video-access/{videoId}' },
        400,
        corsHeaders,
      );
    }

    const videoId = normalizeVideoId(requestedVideoId);

    let authUser = null;
    let userId = legacyUserId;

    // Legacy non-anonymous callers must now authenticate.
    if (legacyUserId && legacyUserId !== 'anonymous') {
      try {
        authUser = await requireAuth(request, env);
      } catch {
        return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
      }
      userId = authUser?.sub;
    } else {
      try {
        authUser = await requireAuth(request, env);
      } catch {
        authUser = null;
      }
      if (authUser?.sub) userId = authUser.sub;
    }

    // ── Anonymous rate limiting ────────────────────────────────────────────────
    // Only applied when there is no authenticated user (anonymous viewer).
    // Logged-in users — even on the free plan — are never rate-limited here.
    const isAnonymous = !authUser && (!userId || userId === 'anonymous');
    if (isAnonymous) {
      const rateLimitResult = await checkAnonymousRateLimit(request, env, ctx);
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
          },
        );
      }
    }
    const db = getDatabaseBinding(env);

    const subscription = userId
      ? await db
          .prepare(`
          SELECT * FROM subscriptions
          WHERE user_id = ? AND status IN ('active', 'trialing')
            AND (current_period_end IS NULL OR datetime(current_period_end) > CURRENT_TIMESTAMP)
          ORDER BY created_at DESC
          LIMIT 1
        `)
          .bind(userId)
          .first()
      : null;

    // Resolve by ID first, then by vanity slug so /watch/<slug> works transparently.
    const video = await resolveVideoByIdOrSlug(db, videoId);
    const hasElevatedRole = isAdministrativeRole(authUser?.role);

    if (!video && !hasElevatedRole) {
      return jsonResponse({ error: 'Video not found', code: 'video_not_found' }, 404, corsHeaders);
    }

    // Use the canonical database ID for all downstream operations (R2 paths, token signing).
    const resolvedVideoId = video?.id ?? videoId;
    const livestream = video
      ? await db
          .prepare(`
          SELECT video_id, provider, stream_id, stream_key, ingest_url, playback_url, status, moq_endpoint, moq_broadcast, recording_video_id, started_at, ended_at
          FROM livestreams
          WHERE video_id = ?
          LIMIT 1
        `)
          .bind(resolvedVideoId)
          .first()
      : null;

    // Reject unpublished videos for non-staff so drafts/archived videos can't
    // receive signed playlist tokens via a slug or ID they happen to know.
    if (video && video.publish_status !== 'published' && !hasElevatedRole) {
      return jsonResponse({ error: 'Video not found' }, 404, corsHeaders);
    }

    // Any active monthly/yearly/club subscription grants full access
    const hasPremiumSubscription = Boolean(subscription);
    const hasPremiumAccess = hasElevatedRole || hasPremiumSubscription;

    // Cap simultaneous streams per subscriber (club entitlements #649). Staff
    // bypass; free/anonymous get preview only and are unaffected.
    if (hasPremiumSubscription && !hasElevatedRole && userId) {
      const limitResponse = await enforceConcurrentPlaybackLimit(request, env, ctx, {
        userId,
        planType: subscription?.plan_type,
        videoId: resolvedVideoId,
        corsHeaders,
      });
      if (limitResponse) return limitResponse;
    }

    const hasVideoMetadata = Boolean(video);
    const hasAccess = hasPremiumAccess || !hasVideoMetadata;
    const previewDuration = video?.preview_duration ?? video?.full_duration ?? 0;
    const isLivestream = Boolean(livestream);
    const livestreamStatus = deriveEffectiveLivestreamStatus(
      livestream?.status,
      video?.publish_status,
    );
    const hasLivestreamMoqEndpoint =
      typeof livestream?.moq_endpoint === 'string' && livestream.moq_endpoint.trim().length > 0;
    const livestreamMoqEndpoint = hasLivestreamMoqEndpoint ? livestream.moq_endpoint.trim() : null;
    const hasLivestreamMoqBroadcast =
      typeof livestream?.moq_broadcast === 'string' && livestream.moq_broadcast.trim().length > 0;
    const livestreamMoqBroadcast = hasLivestreamMoqBroadcast
      ? livestream.moq_broadcast.trim()
      : null;
    const livestreamRecordingId =
      typeof livestream?.recording_video_id === 'string' &&
      livestream.recording_video_id.trim().length > 0
        ? livestream.recording_video_id.trim()
        : null;

    const shouldPreferVodRecording =
      Boolean(livestreamRecordingId) &&
      ['ended', 'vod_attached', 'replaced_with_vod'].includes(livestreamStatus);
    const playbackVideoId =
      shouldPreferVodRecording && livestreamRecordingId ? livestreamRecordingId : resolvedVideoId;

    const bunnyPlaybackRow = (await db
      .prepare(`
      SELECT bunny_playback_url
      FROM media_convert_jobs
      WHERE video_id = ?
        AND provider = 'bunnystream'
        AND status = 'completed'
        AND bunny_playback_url IS NOT NULL
        AND TRIM(bunny_playback_url) != ''
      ORDER BY completed_at DESC, created_at DESC
      LIMIT 1
    `)
      .bind(playbackVideoId)
      .first()) as { bunny_playback_url?: string } | null;
    const bunnyPlaybackUrl =
      typeof bunnyPlaybackRow?.bunny_playback_url === 'string'
        ? bunnyPlaybackRow.bunny_playback_url.trim()
        : null;

    const resolvedEntrypointUrl = await resolveMediaEntrypointUrl({
      env,
      videoId: playbackVideoId,
      bunnyPlaybackUrl: hasPremiumAccess ? bunnyPlaybackUrl : null,
    });

    const isBunnyCdnPlayback = Boolean(
      hasPremiumAccess && bunnyPlaybackUrl && resolvedEntrypointUrl === bunnyPlaybackUrl,
    );
    const basePlaylistUrl = isBunnyCdnPlayback
      ? resolvedEntrypointUrl
      : buildProxyPlaylistUrl(
          request,
          resolvedEntrypointUrl,
          hasPremiumAccess ? null : previewDuration,
          env,
        );
    // Unify duration logic with the frontend: if D1 has 0/unknown duration,
    // attempt to resolve from the HLS playlist stored in R2.
    let fullDuration = video?.full_duration ?? previewDuration;
    // Avoid racing the video-processor duration sync while a video is still in the
    // "uploaded" (not yet processed) state.
    const isProcessingInFlight = Boolean(video && video.status && video.status !== 'processed');
    if ((!fullDuration || fullDuration === 0) && env.R2_BASE_URL && !isProcessingInFlight) {
      const resolved = await resolveVideoDurationSeconds(resolvedVideoId, env);
      if (resolved && resolved > 0) {
        fullDuration = resolved;
        // Best-effort: backfill D1 so list endpoints and cards stop showing "--".
        if (video && (video.full_duration == null || video.full_duration === 0)) {
          try {
            await db
              .prepare(
                `UPDATE videos
               SET full_duration = ?,
                   preview_duration = CASE
                     WHEN preview_duration IS NULL THEN 0
                     WHEN preview_duration <= 0 THEN preview_duration
                     ELSE MIN(preview_duration, ?)
                   END,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status = 'processed'`,
              )
              .bind(fullDuration, fullDuration, resolvedVideoId)
              .run();
          } catch (e) {
            console.warn(`Duration backfill failed for ${resolvedVideoId}:`, getErrorMessage(e));
          }
        }
      }
    }

    // Sign the playlist URL with a short-lived video token so the proxy can
    // authenticate every subsequent manifest and segment request.
    const effectiveUserId = authUser?.sub ?? userId ?? 'anonymous';
    let playlistUrl: string | null = basePlaylistUrl ?? null;
    if (
      isLivestream &&
      !shouldPreferVodRecording &&
      livestreamMoqEndpoint &&
      livestreamMoqBroadcast
    ) {
      // Active MoQ livestreams play in the frontend runtime, not via stored VOD media.
      playlistUrl = null;
    }
    if (env.JWT_SECRET && playlistUrl) {
      const shouldSignProxyUrl = isLocalVideoProxyUrl(request, playlistUrl, env);
      if (shouldSignProxyUrl) {
        const vt = await signVideoToken(
          effectiveUserId,
          playbackVideoId,
          env.JWT_SECRET,
          hasPremiumAccess ? null : previewDuration,
        );
        playlistUrl = playlistUrl.includes('?')
          ? `${playlistUrl}&vt=${vt}`
          : `${playlistUrl}?vt=${vt}`;
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
        description: video?.description ?? '',
        fullDuration,
        previewDuration,
        playlistUrl,
        isLivestream,
        livestreamStatus,
        livestreamProvider: livestream?.provider ?? null,
        livestreamMoqEndpoint,
        livestreamMoqBroadcast,
        livestreamRecordingVideoId: livestreamRecordingId,
        livestreamUnavailableReason: (() => {
          if (!isLivestream || playlistUrl) return null;
          if (!(livestreamMoqEndpoint && livestreamMoqBroadcast)) {
            return 'Live stream is not configured. Add MoQ endpoint + broadcast, or attach a recorded VOD.';
          }
          return null;
        })(),
      },
      chapters: [
        { title: 'Preview', startTime: 0, endTime: previewDuration, accessible: true },
        {
          title: 'Full Content',
          startTime: previewDuration,
          endTime: fullDuration,
          accessible: hasAccess,
        },
      ],
    };
    logRequest(request.method, url.pathname, 200, Date.now() - reqStart, {
      video_id: resolvedVideoId,
      has_access: response.hasAccess,
      is_preview: !hasPremiumAccess,
      subscription_status: subscription?.status ?? 'none',
    });
    return jsonResponse(response, 200, corsHeaders);
  } catch (error) {
    console.error('Error:', error);
    return jsonResponse(
      { error: getPublicErrorMessage('Internal server error') },
      500,
      corsHeaders,
    );
  }
}

async function handleVideoProxy(
  request: any,
  env: any,
  corsHeaders: any,
  ctx: any,
  reqStart = Date.now(),
) {
  const requestUrl = new URL(request.url);
  const proxyPrefix = '/api/video-proxy/';
  const objectPath = requestUrl.pathname.slice(proxyPrefix.length);
  const previewUntil = Number.parseFloat(requestUrl.searchParams.get('previewUntil') ?? '');
  const previewUntilSeconds =
    Number.isFinite(previewUntil) && previewUntil >= 0 ? previewUntil : null;
  if (!objectPath) return jsonResponse({ error: 'Missing proxied object path' }, 400, corsHeaders);

  // This platform is HLS-only. Explicitly reject DASH manifest requests (.mpd)
  // so they fail clearly rather than passing through the proxy unprocessed
  // (where preview limits would not be enforced).
  if (objectPath.endsWith('.mpd')) {
    return jsonResponse({ error: 'DASH streaming is not supported. Use HLS.' }, 410, corsHeaders);
  }

  // Normalize the path to resolve any dot-segments, leading slashes, etc.
  // This prevents rewritten URLs from rewriteSegmentPath() that produce root-relative
  // or dot-containing paths from bypassing the subtree check.
  let normalizedPath;
  try {
    // Use WHATWG URL to normalize the path (resolves dots and removes leading slash)
    const tempUrl = new URL(objectPath, 'http://dummy');
    normalizedPath = tempUrl.pathname.replace(/^\/+/, ''); // strip leading slashes
  } catch {
    return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders);
  }

  // Enforce that the normalized path is within the videos/ subtree
  if (!normalizedPath.startsWith('videos/')) {
    return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders);
  }

  // Reject dot-segment traversal in the normalized path
  // Decoding catches percent-encoded forms like %2e%2e
  const pathSegments = normalizedPath.split('/');
  for (const seg of pathSegments) {
    let decoded;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders);
    }
    if (decoded === '.' || decoded === '..') {
      return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders);
    }
  }

  // ── Step 4a: Validate the signed video token ──────────────────────────────
  // Every proxy request must carry a valid short-lived HMAC token issued by
  // handleVideoAccess.  This prevents direct enumeration / bulk downloading of
  // R2 segment URLs without going through the access-control layer.
  const jwtSecret = typeof env.JWT_SECRET === 'string' ? env.JWT_SECRET.trim() : '';
  if (!jwtSecret) {
    return jsonResponse(
      { error: 'Video playback is not configured', code: 'video_auth_not_configured' },
      503,
      corsHeaders,
    );
  }

  const vtParam = requestUrl.searchParams.get('vt');
  if (!vtParam) {
    return jsonResponse(
      { error: 'Missing video token', code: 'video_token_missing' },
      403,
      corsHeaders,
    );
  }

  let tokenClaims = null;
  try {
    tokenClaims = await verifyVideoToken(vtParam, jwtSecret);
  } catch {
    return jsonResponse(
      { error: 'Invalid or expired video token', code: 'video_token_invalid' },
      403,
      corsHeaders,
    );
  }

  // Extract and decode videoId from path (videos/{id}/...). URL paths preserve
  // percent-encoding (e.g. spaces as %20), while signed tokens use decoded IDs.
  const proxyVideoId = getProxyVideoIdFromPath(normalizedPath);
  if (!proxyVideoId) {
    return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders);
  }

  // Verify token claims match the requested video
  if (tokenClaims && tokenClaims.videoId !== proxyVideoId) {
    return new Response(JSON.stringify({ error: 'Video token does not match requested video' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // RSS-issued tokens carry rss_token_version; reject stale or legacy unbound tokens.
  if (tokenClaims && tokenClaims.userId !== 'anonymous') {
    const versionLookup = await readRssTokenVersion(getDb(env), tokenClaims.userId);
    const versionCheck = checkVideoTokenRssVersion(tokenClaims, versionLookup);
    if (versionCheck === 'unavailable') {
      return jsonResponse(
        { error: 'Video playback temporarily unavailable', code: 'video_auth_unavailable' },
        503,
        corsHeaders,
      );
    }
    if (versionCheck === 'forbidden') {
      return jsonResponse(
        { error: 'Invalid or expired video token', code: 'video_token_invalid' },
        403,
        corsHeaders,
      );
    }
  }

  // Enforce previewUntil from token claims
  let effectivePreviewUntil = previewUntilSeconds;
  if (tokenClaims && tokenClaims.previewUntil !== null && tokenClaims.previewUntil !== undefined) {
    // Token has a preview limit - enforce it
    effectivePreviewUntil = tokenClaims.previewUntil;
  } else if (
    tokenClaims &&
    (tokenClaims.previewUntil === null || tokenClaims.previewUntil === undefined)
  ) {
    // Token grants full access (no preview limit)
    effectivePreviewUntil = null;
  }

  const vtForRewrite = requestUrl.searchParams.get('vt') ?? null;
  const isManifest = objectPath.endsWith('.m3u8');
  const rangeHeader = request.headers.get('Range');
  const byteRange = isManifest ? undefined : parseHttpRangeHeader(rangeHeader);

  const isSegment = objectPath.endsWith('.m4s');
  let segmentDurationForAnalytics = null;

  // ── Step 4c: Segment count rate limiting ─────────────────────────────────
  if (isSegment && env.RATE_LIMIT_KV) {
    let authUser = null;
    try {
      authUser = await requireAuth(request, env);
    } catch {
      /* anonymous */
    }
    const identifier = authUser?.sub ?? request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const avgDur = await getAvgSegmentDuration(proxyVideoId, env);
    segmentDurationForAnalytics = avgDur;
    const limited = await checkSegmentRateLimit(identifier, proxyVideoId, avgDur, env);
    if (limited) {
      return new Response(JSON.stringify({ error: 'Too many segment requests. Slow down.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '30', ...corsHeaders },
      });
    }
  }

  const storage = getObjectStorage(env);
  let upstreamResponse: Response | undefined;
  let proxyCacheStatus: 'HIT' | 'MISS' | 'BYPASS' = 'BYPASS';
  const canUseObjectCache =
    !isManifest && !byteRange && isImmutableVideoProxyObject(normalizedPath);
  const objectCache = canUseObjectCache ? getVideoProxyCache() : null;
  const objectCacheKey = canUseObjectCache ? videoProxyObjectCacheKey(normalizedPath) : null;

  if (objectCache && objectCacheKey) {
    const cached = await objectCache.match(objectCacheKey);
    if (cached) {
      upstreamResponse = cached;
      proxyCacheStatus = 'HIT';
    }
  }

  if (proxyCacheStatus !== 'HIT') {
    if (storage) {
      try {
        const storageObject = await storage.getObject(
          normalizedPath,
          byteRange ? { range: byteRange } : undefined,
        );
        if (!storageObject) {
          return jsonResponse(
            { error: 'Video media is not available', code: 'media_not_available' },
            404,
            corsHeaders,
          );
        }
        upstreamResponse = storageGetResultToResponse(storageObject);
      } catch (err) {
        console.error('[video-proxy] storage getObject failed:', err);
        return jsonResponse(
          { error: 'Video is temporarily unavailable', code: 'storage_unavailable' },
          502,
          corsHeaders,
        );
      }
    } else if (env.R2_BASE_URL) {
      const upstreamUrl = new URL(`${env.R2_BASE_URL}/${objectPath}`);
      const upstreamHeaders = new Headers();
      if (rangeHeader && !isManifest) upstreamHeaders.set('Range', rangeHeader);
      upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers: upstreamHeaders,
      });
    } else {
      return jsonResponse({ error: 'Object storage not configured' }, 503, corsHeaders);
    }
    if (objectCache && objectCacheKey && upstreamResponse.ok) {
      proxyCacheStatus = 'MISS';
    }
  }

  if (!upstreamResponse) {
    return jsonResponse({ error: 'Object storage not configured' }, 503, corsHeaders);
  }

  if (isSegment) {
    const referer = request.headers.get('referer') || '';
    let sourceHost = null;
    try {
      sourceHost = referer ? new URL(referer).host : null;
    } catch {}
    // Segment filenames are usually ordinal indexes (e.g. segment-42.m4s), not
    // wall-clock playback seconds, unless a specific packager naming scheme is used.
    const segmentMatch = normalizedPath.match(/(\d+)(?:\.\w+)?$/);
    const segmentIndex = segmentMatch ? Number(segmentMatch[1]) : null;
    const rawIp = request.headers.get('CF-Connecting-IP');
    const ipHash = rawIp ? await sha256Hex(rawIp) : null;
    const countryCode = request.headers.get('CF-IPCountry');
    ctx?.waitUntil?.(
      logSegmentEvent(env, {
        videoId: proxyVideoId,
        userId: tokenClaims?.userId || null,
        requestPath: normalizedPath,
        eventType: 'segment',
        segmentIndex,
        segmentDurationSeconds: segmentDurationForAnalytics,
        referer,
        sourceHost,
        ipHash,
        countryCode,
      }),
    );
  }

  const manifestType = getManifestType(objectPath, upstreamResponse);
  if (manifestType === 'hls') {
    const manifest = await upstreamResponse.text();
    let rewrittenManifest = rewriteManifestForProxyWithPreview(
      manifest,
      effectivePreviewUntil,
      objectPath,
      vtForRewrite,
    );
    if (rewrittenManifest.includes('#EXT-X-STREAM-INF')) {
      rewrittenManifest = sortMasterPlaylistByBandwidth(rewrittenManifest);
    }
    const headers = new Headers(upstreamResponse.headers);
    headers.set('Content-Type', 'application/vnd.apple.mpegurl');
    const cacheControl = getVideoProxyCacheControl(objectPath, manifestType);
    if (cacheControl) headers.set('Cache-Control', cacheControl);
    headers.delete('Content-Length');
    headers.delete('Content-Range');
    headers.delete('Accept-Ranges');
    for (const [k, v] of Object.entries(corsHeaders as CorsHeaders)) headers.set(k, v);
    logRequest(request.method, requestUrl.pathname, 200, Date.now() - reqStart, {
      video_id: proxyVideoId,
      manifest_type: manifestType ?? 'segment',
      preview_enforced: effectivePreviewUntil !== null,
    });
    return new Response(rewrittenManifest, { status: 200, headers });
  }
  const headers = withVideoProxyCacheHeader(
    new Headers(upstreamResponse.headers),
    proxyCacheStatus,
  );
  const cacheControl = getVideoProxyCacheControl(objectPath, manifestType);
  if (cacheControl) headers.set('Cache-Control', cacheControl);
  for (const [k, v] of Object.entries(corsHeaders as CorsHeaders)) headers.set(k, v);
  if (isSegment) {
    log({
      service: 'video_proxy',
      event: 'segment_served',
      video_id: proxyVideoId,
      duration_ms: Date.now() - reqStart,
      cache: proxyCacheStatus,
    });
  }
  logRequest(request.method, requestUrl.pathname, upstreamResponse.status, Date.now() - reqStart, {
    video_id: proxyVideoId,
    manifest_type: manifestType ?? 'segment',
    preview_enforced: effectivePreviewUntil !== null,
    cache: proxyCacheStatus,
  });
  const mediaResponse = new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers,
  });
  if (
    objectCache &&
    objectCacheKey &&
    proxyCacheStatus === 'MISS' &&
    mediaResponse.ok &&
    !byteRange
  ) {
    const cacheHeaders = new Headers(headers);
    // Store without per-request CORS / debug headers so HIT responses can re-apply them.
    cacheHeaders.delete('Access-Control-Allow-Origin');
    cacheHeaders.delete('Access-Control-Expose-Headers');
    cacheHeaders.delete('X-VMP-Cache');
    ctx?.waitUntil?.(
      objectCache.put(
        objectCacheKey,
        new Response(mediaResponse.clone().body, {
          status: mediaResponse.status,
          headers: cacheHeaders,
        }),
      ),
    );
  }
  return mediaResponse;
}

async function handleBootstrap(request: any, env: any, corsHeaders: any) {
  const body = await request.json().catch(() => null);
  if (!body?.email || typeof body.email !== 'string') {
    return jsonResponse({ error: 'email is required' }, 400, corsHeaders);
  }
  const email = body.email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: 'Invalid email format' }, 400, corsHeaders);
  }

  const db = getDatabaseBinding(env);

  // Guard: only allow bootstrap when no super_admin exists
  const existingAdmin = await db
    .prepare("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1")
    .first();
  if (existingAdmin) {
    return jsonResponse(
      { error: 'Bootstrap already completed — a super_admin already exists.' },
      409,
      corsHeaders,
    );
  }

  // Upsert: promote existing user or create new one
  const existingUser = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existingUser) {
    await db
      .prepare("UPDATE users SET role = 'super_admin' WHERE id = ?")
      .bind(existingUser.id)
      .run();
  } else {
    await db
      .prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'super_admin')")
      .bind(crypto.randomUUID(), email)
      .run();
  }

  return jsonResponse(
    {
      ok: true,
      message: `${email} is now super_admin. Sign in via magic link to access admin features.`,
    },
    200,
    corsHeaders,
  );
}

async function handleAdminConfig(request: any, env: any, corsHeaders: any) {
  const db = getDatabaseBinding(env);
  await ensureAdminSettingsTable(db);

  if (request.method === 'GET') {
    const row = await db
      .prepare('SELECT value FROM admin_settings WHERE key = ? LIMIT 1')
      .bind('homepage')
      .first();
    const value = normalizeHomepageConfig(safeJsonParse(row?.value, defaultHomepageConfig()));
    return jsonResponse({ config: value }, 200, corsHeaders);
  }

  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin');
  } catch (error) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  if (request.method !== 'POST')
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  const body = await request.json().catch(() => null);
  if (!body?.config || typeof body.config !== 'object')
    return jsonResponse({ error: 'config object is required' }, 400, corsHeaders);
  const normalized = normalizeHomepageConfig(body.config);
  await db
    .prepare(
      `INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    )
    .bind('homepage', JSON.stringify(normalized))
    .run();
  return jsonResponse({ ok: true, config: normalized }, 200, corsHeaders);
}

async function handlePreviewLocks(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin');
  } catch (error) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  if (request.method !== 'POST')
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.locks))
    return jsonResponse({ error: 'locks array is required' }, 400, corsHeaders);
  const db = getDatabaseBinding(env);
  const updatedVideoIds: string[] = [];
  for (const lockEntry of body.locks) {
    if (!lockEntry || typeof lockEntry.videoId !== 'string') continue;
    const lockSeconds = Number.parseInt(lockEntry.previewDuration, 10);
    if (!Number.isFinite(lockSeconds) || lockSeconds < 0) continue;
    // When full_duration = 0 (unprocessed draft), MIN would clamp preview to 0.
    // Treat 0 as "unknown duration" and store the requested value as-is.
    await db
      .prepare(`
      UPDATE videos
      SET preview_duration = CASE WHEN full_duration = 0 THEN ? ELSE MIN(full_duration, ?) END
      WHERE id = ?
    `)
      .bind(lockSeconds, lockSeconds, lockEntry.videoId)
      .run();
    updatedVideoIds.push(lockEntry.videoId);
  }

  let podcastPreviewNotify = null;
  if (updatedVideoIds.length) {
    const uniqueIds = [...new Set(updatedVideoIds)];
    const placeholders = uniqueIds.map(() => '?').join(',');
    const rows = await db
      .prepare(`
      SELECT id, preview_duration, full_duration, updated_at
      FROM videos
      WHERE id IN (${placeholders})
    `)
      .bind(...uniqueIds)
      .all();
    podcastPreviewNotify = await deliverPodcastPreviewRebuildWebhook(env, rows?.results ?? []);
  }

  return jsonResponse({ ok: true, podcastPreviewNotify }, 200, corsHeaders);
}

async function handleAdminCategories(request: any, env: any, corsHeaders: any) {
  try {
    const method = request.method;
    const db = getDatabaseBinding(env);

    if (method === 'GET') {
      try {
        await requireRole(request, env, 'editor', 'admin', 'super_admin');
      } catch {
        return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
      }
      const rows = await db
        .prepare(`
        SELECT vc.id, vc.slug, vc.name, vc.sort_order, vc.direction, vc.homepage_layout_variant,
               vc.recommendation_recency_bias, vc.recommendation_low_views_boost, vc.recommendation_category_lock,
               COUNT(vca.video_id) AS video_count
        FROM video_categories vc
        LEFT JOIN video_category_assignments vca ON vca.category_id = vc.id
        GROUP BY vc.id
        ORDER BY vc.sort_order ASC, vc.name ASC
      `)
        .all();
      return jsonResponse({ categories: rows?.results ?? [] }, 200, corsHeaders);
    }

    try {
      await requireRole(request, env, 'admin', 'super_admin');
    } catch {
      return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return jsonResponse({ error: 'Request body is required' }, 400, corsHeaders);
    }

    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const slug = typeof body.slug === 'string' ? sanitizeVideoSlug(body.slug) : '';
      const sortOrder = Number.isInteger(body.sortOrder) ? body.sortOrder : 0;
      const direction = body.direction === 'asc' ? 'asc' : 'desc';
      const homepageLayoutVariant = normalizeHomepageLayoutVariant(body.homepageLayoutVariant);
      if (!name) return jsonResponse({ error: 'name is required' }, 400, corsHeaders);
      if (!isValidVideoSlug(slug))
        return jsonResponse(
          { error: 'slug must be lowercase alphanumeric words separated by hyphens' },
          400,
          corsHeaders,
        );
      try {
        await db
          .prepare(`
          INSERT INTO video_categories (id, slug, name, sort_order, direction, homepage_layout_variant)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
          .bind(crypto.randomUUID(), slug, name, sortOrder, direction, homepageLayoutVariant)
          .run();
        return jsonResponse({ ok: true }, 201, corsHeaders);
      } catch (err) {
        if (getErrorMessage(err).includes('UNIQUE')) {
          return jsonResponse({ error: 'Category slug already exists' }, 409, corsHeaders);
        }
        throw err;
      }
    }

    if (method === 'PATCH') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) return jsonResponse({ error: 'id is required' }, 400, corsHeaders);
      const updates = [];
      const values = [];
      if (typeof body.name === 'string') {
        const name = body.name.trim();
        if (!name) return jsonResponse({ error: 'name must not be empty' }, 400, corsHeaders);
        updates.push('name = ?');
        values.push(name);
      }
      if (typeof body.slug === 'string') {
        const slug = sanitizeVideoSlug(body.slug);
        if (!isValidVideoSlug(slug))
          return jsonResponse(
            { error: 'slug must be lowercase alphanumeric words separated by hyphens' },
            400,
            corsHeaders,
          );
        updates.push('slug = ?');
        values.push(slug);
      }
      if (Object.hasOwn(body, 'sortOrder')) {
        if (!Number.isInteger(body.sortOrder))
          return jsonResponse({ error: 'sortOrder must be an integer' }, 400, corsHeaders);
        updates.push('sort_order = ?');
        values.push(body.sortOrder);
      }
      if (Object.hasOwn(body, 'direction')) {
        if (!['asc', 'desc'].includes(body.direction))
          return jsonResponse({ error: 'direction must be asc or desc' }, 400, corsHeaders);
        updates.push('direction = ?');
        values.push(body.direction);
      }
      if (Object.hasOwn(body, 'homepageLayoutVariant')) {
        updates.push('homepage_layout_variant = ?');
        values.push(normalizeHomepageLayoutVariant(body.homepageLayoutVariant));
      }
      if (Object.hasOwn(body, 'recommendationRecencyBias')) {
        const value = Number(body.recommendationRecencyBias);
        if (!Number.isFinite(value) || value < 0)
          return jsonResponse(
            { error: 'recommendationRecencyBias must be a non-negative number' },
            400,
            corsHeaders,
          );
        updates.push('recommendation_recency_bias = ?');
        values.push(value);
      }
      if (Object.hasOwn(body, 'recommendationLowViewsBoost')) {
        const value = Number(body.recommendationLowViewsBoost);
        if (!Number.isFinite(value) || value < 0)
          return jsonResponse(
            { error: 'recommendationLowViewsBoost must be a non-negative number' },
            400,
            corsHeaders,
          );
        updates.push('recommendation_low_views_boost = ?');
        values.push(value);
      }
      if (Object.hasOwn(body, 'recommendationCategoryLock')) {
        if (typeof body.recommendationCategoryLock !== 'boolean') {
          return jsonResponse(
            { error: 'recommendationCategoryLock must be a boolean' },
            400,
            corsHeaders,
          );
        }
        updates.push('recommendation_category_lock = ?');
        values.push(body.recommendationCategoryLock ? 1 : 0);
      }
      if (!updates.length)
        return jsonResponse({ error: 'No category fields to update' }, 400, corsHeaders);
      values.push(id);
      try {
        const result = await db
          .prepare(`UPDATE video_categories SET ${updates.join(', ')} WHERE id = ?`)
          .bind(...values)
          .run();
        const changes = result.meta?.changes ?? result.changes ?? 0;
        if (!changes) {
          const existing = await db
            .prepare('SELECT id FROM video_categories WHERE id = ?')
            .bind(id)
            .first();
          if (!existing) return jsonResponse({ error: 'Category not found' }, 404, corsHeaders);
          return jsonResponse({ ok: true, updated: false }, 200, corsHeaders);
        }
        return jsonResponse({ ok: true }, 200, corsHeaders);
      } catch (err) {
        if (getErrorMessage(err).includes('UNIQUE')) {
          return jsonResponse({ error: 'Category slug already exists' }, 409, corsHeaders);
        }
        throw err;
      }
    }

    if (method === 'DELETE') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const reassignToCategoryId =
        typeof body.reassignToCategoryId === 'string' && body.reassignToCategoryId.trim()
          ? body.reassignToCategoryId.trim()
          : null;
      if (!id) return jsonResponse({ error: 'id is required' }, 400, corsHeaders);

      const category = await db
        .prepare('SELECT id FROM video_categories WHERE id = ?')
        .bind(id)
        .first();
      if (!category) return jsonResponse({ error: 'Category not found' }, 404, corsHeaders);

      if (reassignToCategoryId) {
        if (reassignToCategoryId === id)
          return jsonResponse(
            { error: 'reassignToCategoryId must be different from deleted category' },
            400,
            corsHeaders,
          );
        const reassignCategory = await db
          .prepare('SELECT id FROM video_categories WHERE id = ?')
          .bind(reassignToCategoryId)
          .first();
        if (!reassignCategory)
          return jsonResponse({ error: 'Reassignment category not found' }, 404, corsHeaders);
        const reassignStmt = db
          .prepare(`
          UPDATE video_category_assignments
          SET category_id = ?
          WHERE category_id = ?
        `)
          .bind(reassignToCategoryId, id);
        const deleteStmt = db.prepare('DELETE FROM video_categories WHERE id = ?').bind(id);
        const [, deleteResult] = await db.batch([reassignStmt, deleteStmt]);
        const deleteChanges = deleteResult.meta?.changes ?? deleteResult.changes ?? 0;
        if (!deleteChanges) return jsonResponse({ error: 'Category not found' }, 404, corsHeaders);
        return jsonResponse({ ok: true }, 200, corsHeaders);
      }

      const deleteResult = await db
        .prepare(`
        DELETE FROM video_categories
        WHERE id = ?
          AND NOT EXISTS (
            SELECT 1 FROM video_category_assignments WHERE category_id = ?
          )
      `)
        .bind(id, id)
        .run();
      const changes = deleteResult.meta?.changes ?? deleteResult.changes ?? 0;
      if (!changes) {
        return jsonResponse(
          { error: 'Category has assigned videos. Reassign them before deletion.' },
          409,
          corsHeaders,
        );
      }
      return jsonResponse({ ok: true }, 200, corsHeaders);
    }

    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  } catch (err) {
    const codeField = getErrorField(err, 'code');
    console.error('handleVideoCategories error:', err);
    return jsonResponse(
      {
        error: getPublicErrorMessage('Internal Server Error'),
        code: typeof codeField === 'string' ? codeField : 'internal_error',
      },
      500,
      corsHeaders,
    );
  }
}

async function handleAdminVideosList(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin');
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }
  if (request.method !== 'GET')
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  const db = getDatabaseBinding(env);
  try {
    // ── 1. Auto-register any R2 uploads that have no D1 row ──────────────────
    const storage = getObjectStorage(env);
    if (storage?.listObjectsPage) {
      const listed = await storage.listObjectsPage({ prefix: 'videos/', delimiter: '/' });
      const r2VideoIds = (listed.prefixes ?? [])
        .map((prefix: string) => {
          // prefix looks like "videos/abc123/" — extract the folder name
          const parts = prefix.replace(/\/$/, '').split('/');
          return parts[parts.length - 1];
        })
        .filter(Boolean);

      for (const r2Id of r2VideoIds) {
        // Register every R2 video folder as a draft regardless of whether
        // processed artifacts exist yet — source-only and mid-processing
        // videos should still appear in the admin list.
        await db
          .prepare(`
          INSERT OR IGNORE INTO videos (id, title, publish_status, upload_date, full_duration, preview_duration)
          VALUES (?, 'Untitled upload', 'draft', CURRENT_TIMESTAMP, 0, 0)
        `)
          .bind(r2Id)
          .run();
      }
    }

    // ── 2. Fetch all videos from D1 ──────────────────────────────────────────
    const videos = await db
      .prepare(`
      SELECT v.id, v.title, v.description, v.thumbnail_url, v.full_duration, v.preview_duration,
             v.upload_date, v.status, v.publish_status, v.published_at, v.updated_at, v.slug, v.legacy_slug,
             v.scheduled_publish_at, v.notified_at,
             vca.category_id, COALESCE(vvc.view_count, 0) AS total_views,
             ls.provider AS livestream_provider,
             ls.status AS livestream_status,
             ls.moq_endpoint AS livestream_moq_endpoint,
             ls.moq_broadcast AS livestream_moq_broadcast,
             ls.recording_video_id AS livestream_recording_video_id
      FROM videos v
      LEFT JOIN video_category_assignments vca ON vca.video_id = v.id
      LEFT JOIN video_view_counts vvc ON vvc.video_id = v.id
      LEFT JOIN livestreams ls ON ls.video_id = v.id
      ORDER BY v.upload_date DESC
    `)
      .all();

    // ── 3. Annotate each row with r2_exists ──────────────────────────────────
    const annotated = await Promise.all(
      (videos.results || []).map(async (video: any) => {
        let r2Exists = null;
        if (video?.livestream_provider) {
          r2Exists = true;
        } else if (getObjectStorage(env)) {
          r2Exists = await hasProcessedPlaybackArtifact(getObjectStorage(env)!, video.id);
        }
        const effectiveLivestreamStatus = video?.livestream_provider
          ? deriveEffectiveLivestreamStatus(video.livestream_status, video.publish_status)
          : (video?.livestream_status ?? null);
        return {
          ...video,
          livestream_status: effectiveLivestreamStatus,
          r2_exists: r2Exists,
        };
      }),
    );

    // Best-effort duration hydration for legacy rows where full_duration=0.
    if (env.R2_BASE_URL) {
      const durationById = new Map<string, number>();
      const uniqueIds = [
        ...new Set(
          annotated
            .filter(
              (video: any) =>
                video &&
                typeof video.id === 'string' &&
                !(typeof video.full_duration === 'number' && video.full_duration > 0),
            )
            .map((video: any) => video.id),
        ),
      ];
      await Promise.all(
        uniqueIds.map(async (id) => {
          const resolved = await resolveVideoDurationSeconds(id, env);
          if (resolved && resolved > 0) durationById.set(id, resolved);
        }),
      );
      for (const video of annotated) {
        if (!video || typeof video.id !== 'string') continue;
        const resolved = durationById.get(video.id);
        if (resolved) video.full_duration = resolved;
      }
    }

    return jsonResponse({ videos: annotated }, 200, corsHeaders);
  } catch (error) {
    console.error('Error:', error);
    return jsonResponse(
      { error: getPublicErrorMessage('Internal server error') },
      500,
      corsHeaders,
    );
  }
}

async function handleAdminLivestreamCreate(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin');
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object')
    return jsonResponse({ error: 'Request body is required' }, 400, corsHeaders);

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return jsonResponse({ error: 'title is required' }, 400, corsHeaders);

  const description = typeof body.description === 'string' ? body.description.trim() : null;
  const rawSlug = typeof body.slug === 'string' ? body.slug.trim() : '';
  let slug: string | null = null;
  if (rawSlug) {
    const sanitizedSlug = sanitizeVideoSlug(rawSlug);
    if (!sanitizedSlug || !isValidVideoSlug(sanitizedSlug)) {
      return jsonResponse(
        { error: 'slug must be lowercase alphanumeric words separated by hyphens' },
        400,
        corsHeaders,
      );
    }
    slug = sanitizedSlug;
  }

  const publishStatus = typeof body.publishStatus === 'string' ? body.publishStatus : 'draft';
  if (!['draft', 'published', 'archived'].includes(publishStatus)) {
    return jsonResponse(
      { error: 'publishStatus must be one of: draft, published, archived' },
      400,
      corsHeaders,
    );
  }

  const provider = 'moq';
  const livestreamStatus = normalizeLivestreamStatus(body.status, 'draft');
  const moqEndpoint =
    typeof body.moqEndpoint === 'string' && body.moqEndpoint.trim() ? body.moqEndpoint.trim() : '';
  const moqBroadcast =
    typeof body.moqBroadcast === 'string' && body.moqBroadcast.trim()
      ? body.moqBroadcast.trim()
      : '';
  const endpointValidation = validateMoqEndpoint(moqEndpoint);
  if (!endpointValidation.ok)
    return jsonResponse({ error: endpointValidation.error }, 400, corsHeaders);
  const broadcastValidation = validateMoqBroadcast(moqBroadcast);
  if (!broadcastValidation.ok)
    return jsonResponse({ error: broadcastValidation.error }, 400, corsHeaders);

  const categoryId =
    typeof body.categoryId === 'string' && body.categoryId.trim() ? body.categoryId.trim() : null;
  const db = getDatabaseBinding(env);
  if (categoryId) {
    const category = await db
      .prepare(`SELECT id FROM video_categories WHERE id = ?`)
      .bind(categoryId)
      .first();
    if (!category) {
      return jsonResponse(
        { error: 'Category not found', code: 'category_not_found' },
        404,
        corsHeaders,
      );
    }
  }

  const videoId = crypto.randomUUID();

  // Validate slug/legacy_slug uniqueness before creating the video
  const collisionError = await validateRouteTokenUniqueness(db, videoId, slug, null, corsHeaders);
  if (collisionError) return collisionError;
  const publishedAt = publishStatus === 'published' ? new Date().toISOString() : null;

  await db
    .prepare(`
    INSERT INTO videos (
      id, title, description, full_duration, preview_duration, status, publish_status, published_at, slug, upload_date, updated_at
    )
    VALUES (?, ?, ?, 0, 0, 'processed', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `)
    .bind(videoId, title, description, publishStatus, publishedAt, slug)
    .run();

  await db
    .prepare(`
    INSERT INTO livestreams (
      video_id, provider, stream_id, stream_key, ingest_url, playback_url, status, moq_endpoint, moq_broadcast, started_at, ended_at, updated_at
    )
    VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, CURRENT_TIMESTAMP)
  `)
    .bind(videoId, provider, livestreamStatus, moqEndpoint, moqBroadcast)
    .run();

  if (categoryId) {
    await db
      .prepare(`
      INSERT INTO video_category_assignments (video_id, category_id, assigned_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(video_id) DO UPDATE SET category_id = excluded.category_id, assigned_at = CURRENT_TIMESTAMP
    `)
      .bind(videoId, categoryId)
      .run();
  }

  const livestreamVideo = await getAdminVideoById(db, videoId);
  return jsonResponse(
    {
      ok: true,
      video: livestreamVideo,
      provisioning: { ok: true, skipped: true, mode: 'manual_moq' },
    },
    201,
    corsHeaders,
  );
}

async function getAdminVideoById(db: any, videoId: string) {
  return db
    .prepare(`
    SELECT v.id, v.title, v.description, v.thumbnail_url, v.full_duration, v.preview_duration,
           v.upload_date, v.status, v.publish_status, v.published_at, v.updated_at, v.slug, v.legacy_slug, vca.category_id,
           ls.provider AS livestream_provider,
           ls.status AS livestream_status,
           ls.moq_endpoint AS livestream_moq_endpoint,
           ls.moq_broadcast AS livestream_moq_broadcast,
           ls.recording_video_id AS livestream_recording_video_id
    FROM videos v
    LEFT JOIN video_category_assignments vca ON vca.video_id = v.id
    LEFT JOIN livestreams ls ON ls.video_id = v.id
    WHERE v.id = ?
    LIMIT 1
  `)
    .bind(videoId)
    .first();
}

async function handleAdminLivestreamUpdate(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin');
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  const url = new URL(request.url);
  const videoId = getAdminVideoIdFromPath(url.pathname);
  if (!videoId) return jsonResponse({ error: 'Missing videoId' }, 400, corsHeaders);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object')
    return jsonResponse({ error: 'Request body is required' }, 400, corsHeaders);

  const updates = [];
  const values = [];
  if (Object.hasOwn(body, 'moqEndpoint')) {
    const moqEndpoint =
      typeof body.moqEndpoint === 'string' && body.moqEndpoint.trim()
        ? body.moqEndpoint.trim()
        : null;
    if (moqEndpoint !== null) {
      const endpointValidation = validateMoqEndpoint(moqEndpoint);
      if (!endpointValidation.ok)
        return jsonResponse({ error: endpointValidation.error }, 400, corsHeaders);
    }
    updates.push('moq_endpoint = ?');
    values.push(moqEndpoint);
  }
  if (Object.hasOwn(body, 'moqBroadcast')) {
    const moqBroadcast =
      typeof body.moqBroadcast === 'string' && body.moqBroadcast.trim()
        ? body.moqBroadcast.trim()
        : null;
    if (moqBroadcast !== null) {
      const broadcastValidation = validateMoqBroadcast(moqBroadcast);
      if (!broadcastValidation.ok)
        return jsonResponse({ error: broadcastValidation.error }, 400, corsHeaders);
    }
    updates.push('moq_broadcast = ?');
    values.push(moqBroadcast);
  }
  if (Object.hasOwn(body, 'status')) {
    updates.push('status = ?');
    values.push(normalizeLivestreamStatus(body.status, 'draft'));
  }
  if (Object.hasOwn(body, 'recordingVideoId')) {
    const recordingVideoId =
      typeof body.recordingVideoId === 'string' && body.recordingVideoId.trim()
        ? body.recordingVideoId.trim()
        : null;
    if (recordingVideoId) {
      const db = getDatabaseBinding(env);
      const recordingVideo = await db
        .prepare('SELECT id FROM videos WHERE id = ?')
        .bind(recordingVideoId)
        .first();
      if (!recordingVideo) {
        return jsonResponse(
          { error: 'recordingVideoId must reference an existing video' },
          400,
          corsHeaders,
        );
      }
    }
    updates.push('recording_video_id = ?');
    values.push(recordingVideoId);
  }

  if (!updates.length)
    return jsonResponse({ error: 'No livestream fields to update' }, 400, corsHeaders);

  const db = getDatabaseBinding(env);
  values.push(videoId);
  const result = await db
    .prepare(`
    UPDATE livestreams
    SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
    WHERE video_id = ?
  `)
    .bind(...values)
    .run();

  const changes = result.meta?.changes ?? result.changes ?? 0;
  if (!changes) return jsonResponse({ error: 'Livestream not found' }, 404, corsHeaders);

  const livestreamVideo = await getAdminVideoById(db, videoId);

  return jsonResponse({ ok: true, video: livestreamVideo }, 200, corsHeaders);
}

async function handleAdminVideoUpdate(request: any, env: any, ctx: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin');
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  const url = new URL(request.url);
  const videoId = getAdminVideoIdFromPath(url.pathname);
  if (!videoId) return jsonResponse({ error: 'Missing videoId' }, 400, corsHeaders);

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Request body is required' }, 400, corsHeaders);

  const allowedStatuses = ['draft', 'published', 'archived'];
  const hasStatus = Object.hasOwn(body, 'status');
  const hasTitle = Object.hasOwn(body, 'title');
  const hasSlug = Object.hasOwn(body, 'slug');
  const hasCategoryId = Object.hasOwn(body, 'categoryId');
  const hasDescription = Object.hasOwn(body, 'description');
  const hasScheduledPublishAt = Object.hasOwn(body, 'scheduledPublishAt');
  const hasPublishedAt = Object.hasOwn(body, 'publishedAt');
  const hasUploadDate = Object.hasOwn(body, 'uploadDate');
  const hasLegacySlug = Object.hasOwn(body, 'legacySlug');

  if (
    !hasStatus &&
    !hasTitle &&
    !hasSlug &&
    !hasCategoryId &&
    !hasDescription &&
    !hasScheduledPublishAt &&
    !hasPublishedAt &&
    !hasUploadDate &&
    !hasLegacySlug
  ) {
    return jsonResponse(
      {
        error:
          'At least one of status, title, slug, legacySlug, description, categoryId, scheduledPublishAt, publishedAt, or uploadDate must be provided',
      },
      400,
      corsHeaders,
    );
  }
  if (hasTitle && (typeof body.title !== 'string' || body.title.trim().length === 0)) {
    return jsonResponse({ error: 'title must not be empty' }, 400, corsHeaders);
  }
  if (hasStatus && !allowedStatuses.includes(body.status)) {
    return jsonResponse(
      { error: 'status must be one of: draft, published, archived' },
      400,
      corsHeaders,
    );
  }
  const normalizedSlug =
    hasSlug && body.slug !== null
      ? typeof body.slug === 'string'
        ? sanitizeVideoSlug(body.slug)
        : null
      : null;
  if (hasSlug && body.slug !== null && !normalizedSlug) {
    return jsonResponse(
      {
        error:
          'slug must be lowercase alphanumeric words separated by hyphens (e.g. my-video-title), or null to clear it',
      },
      400,
      corsHeaders,
    );
  }
  if (normalizedSlug && !isValidVideoSlug(normalizedSlug)) {
    return jsonResponse(
      {
        error:
          'slug must be lowercase alphanumeric words separated by hyphens (e.g. my-video-title), or null to clear it',
      },
      400,
      corsHeaders,
    );
  }
  const normalizedLegacySlug =
    hasLegacySlug && body.legacySlug !== null
      ? typeof body.legacySlug === 'string'
        ? sanitizeVideoSlug(body.legacySlug)
        : null
      : null;
  if (hasLegacySlug && body.legacySlug !== null && !normalizedLegacySlug) {
    return jsonResponse(
      {
        error:
          'legacySlug must be lowercase alphanumeric words separated by hyphens (e.g. old-video-title), or null to clear it',
      },
      400,
      corsHeaders,
    );
  }
  if (normalizedLegacySlug && !isValidVideoSlug(normalizedLegacySlug)) {
    return jsonResponse(
      {
        error:
          'legacySlug must be lowercase alphanumeric words separated by hyphens (e.g. old-video-title), or null to clear it',
      },
      400,
      corsHeaders,
    );
  }
  const scheduledPublishAt = normalizeScheduledPublishAt(body.scheduledPublishAt, {
    allowNull: true,
  });
  if (hasScheduledPublishAt && scheduledPublishAt.invalid) {
    return jsonResponse(
      { error: 'scheduledPublishAt must be a valid ISO timestamp, or null to clear schedule' },
      400,
      corsHeaders,
    );
  }
  const uploadDateNorm = normalizePublishedAt(body.uploadDate, { allowNull: false });
  if (hasUploadDate && uploadDateNorm.invalid) {
    return jsonResponse(
      { error: 'uploadDate must be a valid ISO timestamp and may not be null' },
      400,
      corsHeaders,
    );
  }
  const publishedAt = normalizePublishedAt(body.publishedAt, { allowNull: true });
  if (hasPublishedAt && publishedAt.invalid) {
    return jsonResponse(
      { error: 'publishedAt must be a valid ISO timestamp, or null to clear it' },
      400,
      corsHeaders,
    );
  }
  if (
    hasScheduledPublishAt &&
    body.scheduledPublishAt !== null &&
    hasStatus &&
    body.status === 'published'
  ) {
    return jsonResponse(
      {
        error:
          'Conflicting payload: scheduledPublishAt cannot be provided when status is published',
        code: 'invalid_payload',
      },
      400,
      corsHeaders,
    );
  }
  if (
    hasScheduledPublishAt &&
    body.scheduledPublishAt !== null &&
    hasPublishedAt &&
    body.publishedAt !== null
  ) {
    return jsonResponse(
      {
        error: 'Conflicting payload: scheduledPublishAt cannot be combined with publishedAt',
        code: 'invalid_payload',
      },
      400,
      corsHeaders,
    );
  }
  if (hasScheduledPublishAt && scheduledPublishAt.backdatesUpload && hasUploadDate) {
    return jsonResponse(
      {
        error:
          'Conflicting payload: backdating scheduledPublishAt cannot be combined with uploadDate',
        code: 'invalid_payload',
      },
      400,
      corsHeaders,
    );
  }

  const db = getDatabaseBinding(env);
  const videoExists = await db
    .prepare('SELECT publish_status FROM videos WHERE id = ?')
    .bind(videoId)
    .first();
  if (!videoExists) return jsonResponse({ error: 'Video not found' }, 404, corsHeaders);
  if (hasPublishedAt && body.publishedAt !== null) {
    const nextPublished = hasStatus
      ? body.status === 'published'
      : videoExists.publish_status === 'published';
    if (!nextPublished) {
      return jsonResponse(
        { error: 'publishedAt can only be set for published videos' },
        400,
        corsHeaders,
      );
    }
  }
  const livestreamRow = await db
    .prepare('SELECT video_id FROM livestreams WHERE video_id = ? LIMIT 1')
    .bind(videoId)
    .first();
  const isLivestreamVideo = Boolean(livestreamRow);

  // Guard: refuse to publish if the processed playlist is missing from R2.
  // Livestream videos are allowed to publish without an uploaded VOD.
  const storage = getObjectStorage(env);
  if (hasStatus && body.status === 'published' && storage && !isLivestreamVideo) {
    const exists = await hasProcessedPlaybackArtifact(storage, videoId);
    if (!exists) {
      return jsonResponse(
        {
          error:
            'Cannot publish: processed media not found in R2. Upload and process the video first.',
          code: 'r2_missing',
        },
        422,
        corsHeaders,
      );
    }
  }
  let validatedCategoryId = null;
  if (hasCategoryId) {
    if (body.categoryId === null) {
      validatedCategoryId = null;
    } else if (typeof body.categoryId === 'string' && body.categoryId.trim()) {
      validatedCategoryId = body.categoryId.trim();
      const category = await db
        .prepare(`SELECT id FROM video_categories WHERE id = ?`)
        .bind(validatedCategoryId)
        .first();
      if (!category) {
        return jsonResponse(
          { error: 'Category not found', code: 'category_not_found' },
          404,
          corsHeaders,
        );
      }
    } else {
      return jsonResponse({ error: 'categoryId must be a string or null' }, 400, corsHeaders);
    }
  }

  // When the vanity slug changes, preserve the previous slug as legacy_slug so
  // old /watch/ and /videos/ links keep working without manual admin setup.
  let autoLegacySlug: string | null = null;
  if (!hasLegacySlug && hasSlug && body.slug !== null && normalizedSlug) {
    const currentRouteRow = (await db
      .prepare('SELECT slug, legacy_slug FROM videos WHERE id = ?')
      .bind(videoId)
      .first()) as {
      slug?: string | null;
      legacy_slug?: string | null;
    } | null;
    const previousSlug =
      typeof currentRouteRow?.slug === 'string' ? currentRouteRow.slug.trim() : '';
    const existingLegacy =
      typeof currentRouteRow?.legacy_slug === 'string' ? currentRouteRow.legacy_slug.trim() : '';
    if (previousSlug && previousSlug !== normalizedSlug && !existingLegacy) {
      autoLegacySlug = previousSlug;
    }
  }
  const willUpdateLegacySlug = hasLegacySlug || autoLegacySlug !== null;
  const legacySlugToWrite = hasLegacySlug ? normalizedLegacySlug : autoLegacySlug;

  // Guard: reject a slug that equals another video's id — resolveVideoByIdOrSlug
  // resolves by id before slug, so the slug would become permanently shadowed.
  // Also ensure slug/legacy_slug don't collide with existing videos.
  const collisionError = await validateRouteTokenUniqueness(
    db,
    videoId,
    hasSlug ? normalizedSlug : null,
    willUpdateLegacySlug ? legacySlugToWrite : null,
    corsHeaders,
  );
  if (collisionError) return collisionError;

  try {
    // When both title and slug are supplied, write them atomically so a slug
    // constraint violation cannot leave the title committed but the slug not.
    if (hasTitle || hasSlug || willUpdateLegacySlug) {
      try {
        if (hasTitle && hasSlug && willUpdateLegacySlug) {
          await db
            .prepare(
              `UPDATE videos SET title = ?, slug = ?, legacy_slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            )
            .bind(body.title.trim(), normalizedSlug ?? null, legacySlugToWrite ?? null, videoId)
            .run();
        } else if (hasTitle && hasSlug) {
          await db
            .prepare(
              `UPDATE videos SET title = ?, slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            )
            .bind(body.title.trim(), normalizedSlug ?? null, videoId)
            .run();
        } else if (hasTitle && willUpdateLegacySlug) {
          await db
            .prepare(
              `UPDATE videos SET title = ?, legacy_slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            )
            .bind(body.title.trim(), legacySlugToWrite ?? null, videoId)
            .run();
        } else if (hasSlug && willUpdateLegacySlug) {
          await db
            .prepare(
              `UPDATE videos SET slug = ?, legacy_slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            )
            .bind(normalizedSlug ?? null, legacySlugToWrite ?? null, videoId)
            .run();
        } else if (hasTitle) {
          await db
            .prepare(`UPDATE videos SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .bind(body.title.trim(), videoId)
            .run();
        } else if (willUpdateLegacySlug && !hasSlug) {
          await db
            .prepare(
              `UPDATE videos SET legacy_slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            )
            .bind(legacySlugToWrite ?? null, videoId)
            .run();
        } else {
          await db
            .prepare(`UPDATE videos SET slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .bind(normalizedSlug ?? null, videoId)
            .run();
        }
      } catch (err) {
        if (getErrorMessage(err).includes('UNIQUE')) {
          return jsonResponse(
            { error: 'Slug or legacy slug already in use by another video' },
            409,
            corsHeaders,
          );
        }
        throw err;
      }
    }

    if (hasDescription) {
      const desc = typeof body.description === 'string' ? body.description.trim() : '';
      await db
        .prepare(`UPDATE videos SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(desc, videoId)
        .run();
    }

    if (hasCategoryId) {
      if (validatedCategoryId === null) {
        await db
          .prepare(`DELETE FROM video_category_assignments WHERE video_id = ?`)
          .bind(videoId)
          .run();
      } else {
        await db
          .prepare(`
          INSERT INTO video_category_assignments (video_id, category_id, assigned_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(video_id) DO UPDATE SET category_id = excluded.category_id, assigned_at = CURRENT_TIMESTAMP
        `)
          .bind(videoId, validatedCategoryId)
          .run();
      }
    }
    if (hasScheduledPublishAt) {
      if (scheduledPublishAt.value) {
        const expectedPublishStatus = videoExists.publish_status;
        const staleStatusPayload = {
          error:
            'Cannot backdate scheduledPublishAt for a published video. Use uploadDate instead.',
          code: 'invalid_payload',
        };
        const concurrentChangePayload = {
          error: 'Video state changed concurrently, please retry',
          code: 'conflict',
        };
        if (scheduledPublishAt.backdatesUpload) {
          if (expectedPublishStatus === 'published') {
            return jsonResponse(staleStatusPayload, 409, corsHeaders);
          }
        }
        const setClause = scheduledPublishAt.backdatesUpload
          ? 'upload_date = ?, scheduled_publish_at = NULL'
          : 'scheduled_publish_at = ?';
        const result = await db
          .prepare(`
          UPDATE videos
          SET ${setClause},
              publish_status = CASE WHEN publish_status = 'archived' THEN 'archived' ELSE 'draft' END,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND publish_status = ?
        `)
          .bind(scheduledPublishAt.value, videoId, expectedPublishStatus)
          .run();
        const changes = result.meta?.changes ?? result.changes ?? 0;
        if (changes === 0) {
          return jsonResponse(concurrentChangePayload, 409, corsHeaders);
        }
      } else {
        await db
          .prepare(`
          UPDATE videos
          SET scheduled_publish_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
          .bind(videoId)
          .run();
      }
    }
    if (hasUploadDate && uploadDateNorm?.value) {
      await db
        .prepare(`
        UPDATE videos
        SET upload_date = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
        .bind(uploadDateNorm.value, videoId)
        .run();
    }
    if (hasPublishedAt) {
      await db
        .prepare(`
        UPDATE videos
        SET published_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
        .bind(publishedAt.value, videoId)
        .run();
    }

    let transitionedToPublished = false;
    if (hasStatus) {
      if (body.status === 'published') {
        // Atomic transition: the WHERE clause ensures we only update (and fire push)
        // when the row was NOT already published, eliminating the TOCTOU race.
        const result = await db
          .prepare(`
          UPDATE videos
          SET publish_status = 'published',
              published_at = COALESCE(published_at, CURRENT_TIMESTAMP),
              scheduled_publish_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND publish_status != 'published'
        `)
          .bind(videoId)
          .run();
        transitionedToPublished = (result.meta?.changes ?? result.changes ?? 0) > 0;
        // If the row was already published, still run a no-op update to get consistent
        // state for the SELECT below — this is a read guard, not a second write
      } else {
        await db
          .prepare(`
          UPDATE videos
          SET publish_status = ?,
              scheduled_publish_at = CASE WHEN ? = 'published' THEN NULL ELSE scheduled_publish_at END,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
          .bind(body.status, body.status, videoId)
          .run();
      }
    }

    const video = await db
      .prepare(`
      SELECT v.id, v.title, v.description, v.status, v.publish_status, v.published_at, v.scheduled_publish_at, v.notified_at, v.updated_at, v.slug, v.legacy_slug, v.upload_date, vca.category_id,
             ls.provider AS livestream_provider,
             ls.status AS livestream_status,
             ls.moq_endpoint AS livestream_moq_endpoint,
             ls.moq_broadcast AS livestream_moq_broadcast,
             ls.recording_video_id AS livestream_recording_video_id
      FROM videos v
      LEFT JOIN video_category_assignments vca ON vca.video_id = v.id
      LEFT JOIN livestreams ls ON ls.video_id = v.id
      WHERE v.id = ?
    `)
      .bind(videoId)
      .first();
    if (!video) return jsonResponse({ error: 'Video not found' }, 404, corsHeaders);
    if (video.livestream_provider) {
      video.livestream_status = deriveEffectiveLivestreamStatus(
        video.livestream_status,
        video.publish_status,
      );
    }

    // Automatic notifications on publish are intentionally disabled.
    void transitionedToPublished;

    try {
      await syncScheduledPublishHint(env);
    } catch (err) {
      console.warn(
        'Scheduled publish hint sync failed after admin update (non-fatal):',
        getErrorMessage(err),
      );
    }

    return jsonResponse({ ok: true, video }, 200, corsHeaders);
  } catch (error) {
    console.error('Error:', error);
    return jsonResponse(
      { error: getPublicErrorMessage('Internal server error') },
      500,
      corsHeaders,
    );
  }
}

async function handleAdminVideoDelete(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin');
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  const url = new URL(request.url);
  const videoId = getAdminVideoIdFromPath(url.pathname);
  if (!videoId) return jsonResponse({ error: 'Missing videoId' }, 400, corsHeaders);

  try {
    const db = getDatabaseBinding(env);
    // Guard: ensure admin_settings exists on fresh/migration-lagged deployments
    // before the homepage cleanup query below tries to read from it.
    await ensureAdminSettingsTable(db);

    const video = await db.prepare(`SELECT id FROM videos WHERE id = ?`).bind(videoId).first();
    if (!video) return jsonResponse({ error: 'Video not found' }, 404, corsHeaders);
    // Delete all R2 objects under videos/{videoId}/ (paginated)
    let deletedR2Objects = 0;
    const storage = getObjectStorage(env);
    if (storage?.listObjectsPage) {
      let cursor: string | undefined;
      do {
        const listed = await storage.listObjectsPage({
          prefix: `videos/${videoId}/`,
          ...(cursor ? { cursor } : {}),
        });
        const keys = listed.objects.map((obj) => obj.key);
        if (keys.length > 0) {
          if (storage.deleteObjects) {
            await storage.deleteObjects(keys);
          } else {
            for (const key of keys) await storage.deleteObject(key);
          }
          deletedR2Objects += keys.length;
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }

    // Evict the deleted ID from the persisted homepage featured-slots config so
    // a subsequent page load doesn't rehydrate a stale or empty featured card.
    const homepageRow = await db
      .prepare('SELECT value FROM admin_settings WHERE key = ? LIMIT 1')
      .bind('homepage')
      .first();
    if (homepageRow?.value) {
      const homepage = safeJsonParse(homepageRow.value, defaultHomepageConfig());
      const before = Array.isArray(homepage.featuredVideoIds) ? homepage.featuredVideoIds : [];
      const after = before.filter((id: any) => id !== videoId);
      if (after.length !== before.length) {
        homepage.featuredVideoIds = after;
        await db
          .prepare(`
          INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `)
          .bind('homepage', JSON.stringify(homepage))
          .run();
      }
    }

    // Delete the D1 row
    await db.prepare(`DELETE FROM videos WHERE id = ?`).bind(videoId).run();

    try {
      await syncScheduledPublishHint(env);
    } catch (err) {
      console.warn(
        'Scheduled publish hint sync failed after delete (non-fatal):',
        getErrorMessage(err),
      );
    }

    return jsonResponse({ ok: true, deletedR2Objects }, 200, corsHeaders);
  } catch (error) {
    console.error(`handleAdminVideoDelete [videoId:${videoId}]:`, error);
    return jsonResponse(
      { error: getPublicErrorMessage('Internal server error') },
      500,
      corsHeaders,
    );
  }
}

async function handleAdminVideoNotify(request: any, env: any, ctx: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin');
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  const url = new URL(request.url);
  const videoId = getAdminVideoIdFromPath(url.pathname);
  if (!videoId) return jsonResponse({ error: 'Missing videoId' }, 400, corsHeaders);

  const db = getDatabaseBinding(env);
  const video = await db
    .prepare(`SELECT id, title, publish_status FROM videos WHERE id = ?`)
    .bind(videoId)
    .first();

  if (!video) return jsonResponse({ error: 'Video not found' }, 404, corsHeaders);
  if (video.publish_status !== 'published') {
    return jsonResponse(
      { error: 'Only published videos can trigger notifications' },
      422,
      corsHeaders,
    );
  }

  // KV-based cooldown: prevent accidental spam from double-clicks or repeated sends.
  // TTL matches the cooldown window so the key auto-expires.
  const NOTIFY_COOLDOWN_SECONDS = 300; // 5 minutes
  if (env.RATE_LIMIT_KV) {
    const cooldownKey = `notify:video:${videoId}`;
    const lastSent = await env.RATE_LIMIT_KV.get(cooldownKey);
    if (lastSent) {
      const secondsAgo = Math.floor((Date.now() - Number(lastSent)) / 1000);
      const retryAfter = NOTIFY_COOLDOWN_SECONDS - secondsAgo;
      return jsonResponse(
        {
          error: 'Notification cooldown active — wait 5 minutes between sends.',
          code: 'cooldown',
          retryAfter,
        },
        429,
        corsHeaders,
      );
    }
    await env.RATE_LIMIT_KV.put(cooldownKey, String(Date.now()), {
      expirationTtl: NOTIFY_COOLDOWN_SECONDS,
    });
  }

  const authUser = await requireAuth(request, env).catch(() => null);
  const tiered = await isPushTierDeliveryEnabled(env);

  const responseTimestamp = new Date().toISOString();
  const notifiedResult = await db
    .prepare(`
    UPDATE videos
    SET notified_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND notified_at IS NULL
  `)
    .bind(responseTimestamp, videoId)
    .run();
  const notifiedChanges = Number(notifiedResult.meta?.changes ?? notifiedResult.changes ?? 0);
  if (!notifiedChanges) {
    return jsonResponse(
      { error: 'Video already notified', code: 'already_notified' },
      409,
      corsHeaders,
    );
  }

  let campaignResult;
  try {
    campaignResult = await createPushCampaignAndDeliveries({
      env,
      db,
      videoId,
      videoTitle: video.title || videoId,
      createdByUserId: authUser?.sub ?? null,
      tiered,
    });
    console.log(
      `Push notify [videoId:${videoId}] campaign=${campaignResult.campaignId} mode=${campaignResult.mode} scheduled=${campaignResult.scheduled} skipped=${campaignResult.skipped}`,
    );
  } catch (err) {
    console.error(`Push notify error [videoId:${videoId}]:`, err);
    return jsonResponse({ error: 'Failed to queue push campaign' }, 500, corsHeaders);
  }

  return jsonResponse(
    {
      ok: true,
      push_enqueued_at: responseTimestamp,
      tiered,
      campaignId: campaignResult.campaignId,
      scheduled: campaignResult.scheduled,
      skipped: campaignResult.skipped,
      tiers: campaignResult.tiers,
    },
    200,
    corsHeaders,
  );
}

async function handleVideoSwap(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin');
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  const url = new URL(request.url);
  const publishedId = getAdminVideoIdFromPath(url.pathname);
  if (!publishedId) return jsonResponse({ error: 'Missing video id' }, 400, corsHeaders);

  const body = await request.json().catch(() => null);
  if (!body?.swapWithId || typeof body.swapWithId !== 'string') {
    return jsonResponse({ error: 'swapWithId (draft video id) is required' }, 400, corsHeaders);
  }
  const draftId = body.swapWithId.trim();
  if (draftId === publishedId) {
    return jsonResponse({ error: 'Cannot swap a video with itself' }, 400, corsHeaders);
  }

  const db = getDatabaseBinding(env);

  const [oldVideo, newVideo] = await Promise.all([
    db.prepare('SELECT * FROM videos WHERE id = ?').bind(publishedId).first(),
    db.prepare('SELECT * FROM videos WHERE id = ?').bind(draftId).first(),
  ]);

  if (!oldVideo) return jsonResponse({ error: 'Published video not found' }, 404, corsHeaders);
  if (!newVideo) return jsonResponse({ error: 'Draft video not found' }, 404, corsHeaders);
  if (oldVideo.publish_status !== 'published') {
    return jsonResponse({ error: 'Source video must be published' }, 422, corsHeaders);
  }
  if (newVideo.publish_status !== 'draft') {
    return jsonResponse({ error: 'Target video must be a draft' }, 422, corsHeaders);
  }
  const swapStorage = getObjectStorage(env);
  if (swapStorage) {
    const exists = await hasProcessedPlaybackArtifact(swapStorage, draftId);
    if (!exists) {
      return jsonResponse(
        {
          error:
            'Cannot swap: processed media not found in R2. Upload and process the target draft first.',
          code: 'r2_missing',
        },
        422,
        corsHeaders,
      );
    }
  }

  // Cap the preview lock to the new video's actual duration (which may differ).
  const cappedPreviewDuration =
    newVideo.full_duration > 0
      ? Math.min(oldVideo.preview_duration ?? 0, newVideo.full_duration)
      : (oldVideo.preview_duration ?? 0);
  const preservedWatchPathToken =
    typeof oldVideo.slug === 'string' && oldVideo.slug.trim() ? oldVideo.slug.trim() : publishedId;

  // Promote the draft and retire the old video atomically via D1 batch so both
  // updates succeed or both fail — no half-swapped state.
  // thumbnail_url starts as the old video's URL; upgraded below after the copy succeeds.
  const promoteStmt = db
    .prepare(`
    UPDATE videos SET
      title            = ?,
      description      = ?,
      thumbnail_url    = ?,
      slug             = ?,
      legacy_slug      = ?,
      upload_date      = ?,
      preview_duration = ?,
      publish_status   = 'published',
      published_at     = CURRENT_TIMESTAMP,
      updated_at       = CURRENT_TIMESTAMP
    WHERE id = ? AND publish_status = 'draft'
  `)
    .bind(
      oldVideo.title,
      oldVideo.description ?? null,
      oldVideo.thumbnail_url ?? null,
      preservedWatchPathToken,
      oldVideo.legacy_slug ?? null,
      oldVideo.upload_date,
      cappedPreviewDuration,
      draftId,
    );

  const retireStmt = db
    .prepare(`
    UPDATE videos SET
      title          = 'OLD - ' || title,
      thumbnail_url  = NULL,
      slug           = NULL,
      legacy_slug    = NULL,
      publish_status = 'draft',
      published_at   = NULL,
      updated_at     = CURRENT_TIMESTAMP
    WHERE id = ? AND publish_status = 'published'
  `)
    .bind(publishedId);

  // Retire must run first to clear the slug before the draft claims it — otherwise
  // D1 raises a UNIQUE constraint violation on the partial index on videos.slug.
  // The WHERE predicates ensure concurrent requests can't both succeed.
  const [retireResult, promoteResult] = await db.batch([retireStmt, promoteStmt]);
  if ((retireResult.meta?.changes ?? 0) === 0 || (promoteResult.meta?.changes ?? 0) === 0) {
    return jsonResponse(
      { error: 'Swap failed: video status changed concurrently, please retry' },
      409,
      corsHeaders,
    );
  }

  // If the replaced source was a livestream, mark it as replaced and keep an
  // explicit link to the promoted VOD row.
  await db
    .prepare(`
    UPDATE livestreams
    SET status = 'replaced_with_vod',
        recording_video_id = ?,
        ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE video_id = ?
  `)
    .bind(draftId, publishedId)
    .run();

  // Copy thumbnails only after the swap has committed so a failed swap never
  // overwrites the draft's existing thumbnail assets.
  if (swapStorage && oldVideo.thumbnail_url) {
    const thumbnailFiles = ['original.jpg', 'large.jpg', 'medium.jpg', 'small.jpg'];
    const copyResults = await Promise.allSettled(
      thumbnailFiles.map(async (file) => {
        const srcKey = `thumbnails/${publishedId}/${file}`;
        const dstKey = `thumbnails/${draftId}/${file}`;
        const obj = await swapStorage.getObject(srcKey);
        if (obj) {
          await swapStorage.putObject(dstKey, obj.body, {
            ...(obj.contentType ? { contentType: obj.contentType } : {}),
          });
          return true;
        }
        return false;
      }),
    );
    const failures = copyResults.filter((r) => r.status === 'rejected');
    if (failures.length) {
      console.warn(
        `Thumbnail copy: ${failures.length}/${thumbnailFiles.length} failed for swap ${publishedId} -> ${draftId}`,
      );
    }
    // Upgrade the thumbnail URL on the newly promoted row only if large.jpg was
    // actually written; the initial value set in the batch was oldVideo.thumbnail_url.
    const largeCopyOk = copyResults[1]?.status === 'fulfilled' && copyResults[1].value === true;
    if (env.R2_BASE_URL && largeCopyOk) {
      await db
        .prepare(`UPDATE videos SET thumbnail_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(`${env.R2_BASE_URL}/thumbnails/${draftId}/large.jpg`, draftId)
        .run();
    }
  }

  // Update homepage featured slots: replace old ID with new ID so the page
  // doesn't silently show a stale/empty featured card after the swap.
  // Best-effort: the swap itself already committed — don't let this fail the response.
  try {
    await ensureAdminSettingsTable(db);
    const homepageRow = await db
      .prepare('SELECT value FROM admin_settings WHERE key = ? LIMIT 1')
      .bind('homepage')
      .first();
    if (homepageRow?.value) {
      const homepage = safeJsonParse(homepageRow.value, defaultHomepageConfig());
      const before = Array.isArray(homepage.featuredVideoIds) ? homepage.featuredVideoIds : [];
      const after = before.map((id: any) => (id === publishedId ? draftId : id));
      if (after.some((id: any, i: any) => id !== before[i])) {
        homepage.featuredVideoIds = after;
        await db
          .prepare(`
          INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `)
          .bind('homepage', JSON.stringify(homepage))
          .run();
      }
    }
  } catch (err) {
    console.warn(
      'Homepage featured-slot update failed after swap (non-fatal):',
      getErrorMessage(err),
    );
  }

  const [published, retired] = await Promise.all([
    db
      .prepare('SELECT id, title, publish_status, slug, thumbnail_url FROM videos WHERE id = ?')
      .bind(draftId)
      .first(),
    db
      .prepare('SELECT id, title, publish_status, slug, thumbnail_url FROM videos WHERE id = ?')
      .bind(publishedId)
      .first(),
  ]);

  try {
    await syncScheduledPublishHint(env);
  } catch (err) {
    console.warn(
      'Scheduled publish hint sync failed after swap (non-fatal):',
      getErrorMessage(err),
    );
  }

  return jsonResponse({ ok: true, published, retired }, 200, corsHeaders);
}

async function handleAdminPushTest(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin');
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  const user = await requireAuth(request, env).catch(() => null);
  if (!user?.sub) return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);

  const db = getDatabaseBinding(env);
  const subscription = await db
    .prepare(`
    SELECT endpoint, p256dh, auth, created_at
    FROM push_subscriptions
    WHERE user_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 1
  `)
    .bind(user.sub)
    .first();

  if (!subscription) {
    return jsonResponse(
      {
        ok: false,
        error: 'No push subscription found for current user',
        code: 'missing_subscription',
      },
      404,
      corsHeaders,
    );
  }

  const endpointHost = safeEndpointHost(subscription.endpoint);
  const payload = {
    title: 'VMP push diagnostic',
    body: `Diagnostic ping ${new Date().toISOString()}`,
    url: `${env.FRONTEND_URL || ''}/account?push-test=1`,
  };

  try {
    const result = await sendPushNotification(subscription, payload, env);
    return jsonResponse(
      {
        ok: true,
        endpointHost,
        subscriptionCreatedAt: subscription.created_at || null,
        delivery: {
          status: result.status,
          statusClass: result.statusClass,
        },
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    const code = getErrorField(error, 'code');
    const status = getErrorField(error, 'status');
    const statusClass = getErrorField(error, 'statusClass');
    const responseSnippet = getErrorField(error, 'responseSnippet');
    return jsonResponse(
      {
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
      },
      502,
      corsHeaders,
    );
  }
}

function safeEndpointHost(endpoint: any) {
  try {
    return new URL(endpoint).host || null;
  } catch {
    return null;
  }
}

// ─── Push notification helpers ────────────────────────────────────────────────

// ─── Push notification handlers ───────────────────────────────────────────────

function handleGetVapidPublicKey(request: any, env: any, corsHeaders: any) {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || publicKey.startsWith('REPLACE_WITH_') || !privateKey) {
    return jsonResponse({ error: 'VAPID not configured' }, 503, corsHeaders);
  }
  return jsonResponse({ publicKey }, 200, corsHeaders);
}

async function handlePushSubscribe(request: any, env: any, corsHeaders: any) {
  let user;
  try {
    user = await requireAuth(request, env);
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  const body = await request.json().catch(() => null);
  if (
    typeof body?.endpoint !== 'string' ||
    typeof body?.keys?.p256dh !== 'string' ||
    typeof body?.keys?.auth !== 'string'
  ) {
    return jsonResponse({ error: 'Invalid push subscription object' }, 400, corsHeaders);
  }

  // Validate endpoint to prevent SSRF: must be https and not a private/local host
  let endpointUrl;
  try {
    endpointUrl = new URL(body.endpoint);
  } catch {
    return jsonResponse({ error: 'Invalid push endpoint' }, 400, corsHeaders);
  }
  if (endpointUrl.protocol !== 'https:' || isPrivateHost(endpointUrl.hostname)) {
    return jsonResponse({ error: 'Invalid push endpoint' }, 400, corsHeaders);
  }

  const db = getDatabaseBinding(env);
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
        p256dh = excluded.p256dh, auth = excluded.auth
    `)
      .bind(id, user.sub, body.endpoint, body.keys.p256dh, body.keys.auth)
      .run();
    return jsonResponse({ ok: true }, 201, corsHeaders);
  } catch (error) {
    console.error('Push subscribe error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders);
  }
}

async function handlePushUnsubscribe(request: any, env: any, corsHeaders: any) {
  let user;
  try {
    user = await requireAuth(request, env);
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  const body = await request.json().catch(() => null);
  if (!body?.endpoint) {
    return jsonResponse({ error: 'endpoint is required' }, 400, corsHeaders);
  }

  const db = getDatabaseBinding(env);
  try {
    await db
      .prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
      .bind(body.endpoint, user.sub)
      .run();
    return jsonResponse({ ok: true }, 200, corsHeaders);
  } catch (error) {
    console.error('Push unsubscribe error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders);
  }
}

async function hasProcessedPlaybackArtifact(storage: ObjectStorageProvider, videoId: any) {
  const candidateKeys = [
    // Flat layout produced by the current upload script (rclone copies TMP_DIR
    // directly into videos/{id}/ with no processed/ subdirectory)
    `videos/${videoId}/master.m3u8`,
    // Processed-subdirectory layouts (video-processor pipeline output)
    `videos/${videoId}/processed/playlist.m3u8`,
    `videos/${videoId}/processed/hls/master.m3u8`,
  ];

  for (const key of candidateKeys) {
    const object = await storage.headObject(key);
    if (object) return true;
  }
  return false;
}

// ─── Duration resolver (shared by /video-access and /videos) ───────────────────
//
// Resolves total duration by summing #EXTINF lines in the HLS media playlist.
// Follows a master playlist to its first variant if needed.
// Cached in KV to avoid repeatedly fetching/parsing manifests.

async function resolveVideoDurationSeconds(videoId: any, env: any) {
  if (!videoId) return null;
  if (!env.R2_BASE_URL) return null;

  const kv = env.RATE_LIMIT_KV;
  const cacheKey = kv ? `duration:${videoId}` : null;
  if (kv && cacheKey) {
    try {
      const cached = await kv.get(cacheKey);
      // Three states:
      // - missing key => attempt resolve
      // - sentinel "-1" => treat as unresolvable (short TTL) and return null immediately
      // - positive integer => duration seconds
      if (cached === '-1') return null;
      const n = cached ? Number.parseInt(cached, 10) : NaN;
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      // Treat KV read failure as a cache miss - proceed with resolution
    }
  }

  const candidates = buildEntrypointCandidates(env.R2_BASE_URL, videoId);
  let lastResult = null;
  for (const entrypoint of candidates) {
    const result = await resolvePlaylistDurationFromUrl(entrypoint, 0);
    lastResult = result;

    if (result.kind === 'ok' && result.duration && result.duration > 0) {
      if (kv && cacheKey) {
        try {
          await kv.put(cacheKey, String(result.duration), { expirationTtl: 86400 }); // 24h
        } catch {
          // Ignore KV write failures - duration resolution still succeeded
        }
      }
      return result.duration;
    }

    // If we hit a transient error, stop trying and bubble it up (don't cache)
    if (result.kind === 'transient') {
      return null;
    }

    // If not_found, continue to next candidate
  }

  // All candidates returned not_found — write negative cache sentinel
  // Only write -1 for definitive not_found, not for transient errors
  if (lastResult && lastResult.kind === 'not_found') {
    if (kv && cacheKey) {
      try {
        await kv.put(cacheKey, '-1', { expirationTtl: 300 }); // 5 minutes
      } catch {
        // Ignore KV write failures - not_found result is still valid
      }
    }
  }
  return null;
}

async function resolvePlaylistDurationFromUrl(url: any, depth = 0) {
  if (!url || depth > 2) return { duration: null, kind: 'not_found' };
  // Declared outside `try` so `finally` can clear the timer (try-block `let` is not in scope in `finally`).
  const timeoutMs = 5000;
  let controller: any = null;
  let timeoutId = null;
  let signal;
  try {
    // Avoid indefinite hangs on upstream fetch (network stalls, origin issues).
    // Prefer AbortSignal.timeout when available; otherwise use AbortController.
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(timeoutMs);
    } else if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      signal = controller.signal;
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    const res = await fetch(url, signal ? { signal } : undefined);

    // Distinguish between not-found (404) and transient errors
    if (!res.ok) {
      if (res.status === 404) {
        return { duration: null, kind: 'not_found' };
      }
      // Other HTTP errors (5xx, 403, etc.) are transient
      return { duration: null, kind: 'transient' };
    }

    const text = await res.text();
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    // Media playlist: sum EXTINF segment durations
    const extInf = lines.filter((l) => l.startsWith('#EXTINF:'));
    if (extInf.length) {
      const total = extInf.reduce((sum, l) => {
        const n = Number.parseFloat(l.slice('#EXTINF:'.length));
        return Number.isFinite(n) ? sum + n : sum;
      }, 0);
      const rounded = Math.round(total);
      if (Number.isFinite(rounded) && rounded > 0) {
        return { duration: rounded, kind: 'ok' };
      }
      return { duration: null, kind: 'not_found' };
    }

    // Master playlist: follow first variant
    const idx = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
    if (idx >= 0 && lines[idx + 1]) {
      const variantPath = lines[idx + 1];
      if (!variantPath) return { duration: null, kind: 'not_found' };
      const nextUrl = new URL(variantPath, url).toString();
      return resolvePlaylistDurationFromUrl(nextUrl, depth + 1);
    }
  } catch (error) {
    // Network errors, timeouts, and aborts are transient
    return { duration: null, kind: 'transient' };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  return { duration: null, kind: 'not_found' };
}

// ─── All the unchanged helper functions from the original index.js ─────────────

function getManifestType(objectPath: any, upstreamResponse: any) {
  if (objectPath.endsWith('.m3u8')) return 'hls';
  const ct = upstreamResponse.headers.get('content-type') ?? '';
  if (/application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl/i.test(ct)) return 'hls';
  return null;
}

export {
  getVideoProxyCacheControl,
  sortMasterPlaylistByBandwidth,
} from './mediaEntrypoints.js';
export {
  isImmutableVideoProxyObject,
  videoProxyObjectCacheKey,
} from './videoProxyCache.js';

export function rewriteManifestForProxyWithPreview(
  manifest: any,
  previewUntilSeconds: any,
  objectPath = '',
  vt: string | null = null,
) {
  const lines = manifest.split('\n');
  const hasPreviewLimit = typeof previewUntilSeconds === 'number' && previewUntilSeconds >= 0;
  const isMediaPlaylist = lines.some((l: any) => l.trim().startsWith('#EXTINF:'));
  const isMasterPlaylist = lines.some((l: any) => l.trim().startsWith('#EXT-X-STREAM-INF'));
  const previewQuery = hasPreviewLimit ? `previewUntil=${Math.floor(previewUntilSeconds)}` : null;

  // Build extra query params to append to every URL: vt (required) + previewUntil (optional)
  function buildExtraQuery(includePreview: any) {
    const parts = [];
    if (includePreview && previewQuery) parts.push(previewQuery);
    if (vt) parts.push(`vt=${vt}`);
    return parts.length ? parts.join('&') : null;
  }

  // Base directory of the manifest in the proxy URL space, e.g. "videos/abc/".
  // Used to resolve relative paths in master playlists so that previewUntil
  // can be propagated to variant playlist requests.
  const manifestDir = objectPath.includes('/')
    ? objectPath.slice(0, objectPath.lastIndexOf('/') + 1)
    : '';

  // Resolve segment paths relative to this manifest's directory so that bare
  // filenames (e.g. "seg_1080_1.m4s", "init_1080.mp4") emitted by shaka-packager
  // are routed through the proxy with the vt token intact.
  function proxySegmentPath(path: any, query: any) {
    return rewriteSegmentPath(path, query, manifestDir);
  }

  // Rewrite URI= in HLS tags regardless of attribute order (quoted GROUP-ID/CODECS may precede URI).
  function rewriteTagUriAttribute(line: string, tagName: string, query: string | null) {
    const prefix = `#${tagName}:`;
    if (!line.trimStart().startsWith(prefix)) return line;
    return line.replace(/\bURI=(?:"([^"]*)"|([^",\s]+))/i, (full, quoted, unquoted) => {
      const url = (quoted ?? unquoted ?? '').trim();
      if (!url) return full;
      // Preserve custom-scheme URIs (skd://, data:, etc.) - only rewrite scheme-less paths
      if (
        tagName === 'EXT-X-KEY' &&
        /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) &&
        !/^https?:\/\//i.test(url)
      ) {
        return full;
      }
      const rewritten = proxySegmentPath(url, query);
      return quoted !== undefined ? `URI="${rewritten}"` : `URI=${rewritten}`;
    });
  }

  function rewriteTagAttributes(line: any, query: any) {
    for (const tag of ['EXT-X-MAP', 'EXT-X-KEY', 'EXT-X-MEDIA', 'EXT-X-I-FRAME-STREAM-INF']) {
      line = rewriteTagUriAttribute(line, tag, query);
    }
    return line;
  }

  if (hasPreviewLimit && isMediaPlaylist) {
    let elapsed = 0,
      pending = null;
    const out = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) {
        if (t.startsWith('#EXTINF:')) pending = Number.parseFloat(t.slice('#EXTINF:'.length)) || 0;
        if (t !== '#EXT-X-ENDLIST') {
          // Rewrite tag attributes even in preview mode
          out.push(rewriteTagAttributes(line, buildExtraQuery(true)));
        }
        continue;
      }
      if (elapsed >= previewUntilSeconds) break;
      out.push(proxySegmentPath(t, buildExtraQuery(true)));
      elapsed += pending ?? 0;
      pending = null;
    }
    out.push('#EXT-X-ENDLIST');
    return out.join('\n');
  }
  return lines
    .map((line: any) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        // Rewrite URLs in HLS tag attributes
        return rewriteTagAttributes(line, buildExtraQuery(isMasterPlaylist && hasPreviewLimit));
      }
      if (isMasterPlaylist) {
        // For relative paths in master playlists we must resolve them to an
        // absolute proxy path so the previewUntil param is carried through to
        // the variant playlist request (hls.js fetches the URL verbatim).
        const isRelative = !/^https?:\/\//i.test(t) && !t.startsWith('/');
        if (isRelative && manifestDir) {
          const absolutePath = `${manifestDir}${t}`;
          return rewriteSegmentPath(absolutePath, buildExtraQuery(hasPreviewLimit));
        }
      }
      return proxySegmentPath(t, buildExtraQuery(isMasterPlaylist && hasPreviewLimit));
    })
    .join('\n');
}

function rewriteSegmentPath(path: any, query: any, baseDir = '') {
  // Preserve custom-scheme URIs (skd://, data:, etc.) - only rewrite scheme-less paths
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) && !/^https?:\/\//i.test(path)) {
    return path;
  }
  let proxied;
  if (/^https?:\/\//i.test(path)) {
    const u = new URL(path);
    proxied = `/api/video-proxy${u.pathname}${u.search}`;
  } else if (path.startsWith('/')) {
    proxied = `/api/video-proxy${path}`;
  } else if (path.startsWith('videos/')) {
    proxied = `/api/video-proxy/${path}`;
  } else if (baseDir) {
    // Bare relative filename (e.g. "seg_1080_1.m4s", "init_1080.mp4") —
    // resolve against the manifest's directory so the proxy prefix and vt
    // token are preserved for every segment/init request.
    proxied = `/api/video-proxy/${baseDir}${path}`;
  } else {
    return path;
  }
  return query ? (proxied.includes('?') ? `${proxied}&${query}` : `${proxied}?${query}`) : proxied;
}

function normalizeVideoId(input: any) {
  const t = (input ?? '').trim();
  const m = t.match(/^videos\/([^/]+)\/processed\/playlist\.m3u8$/i);
  return m ? m[1] : t;
}

function decodePathSegment(segment: any) {
  if (typeof segment !== 'string') return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function getAdminVideoIdFromPath(pathname: string) {
  const pathParts = pathname.split('/').filter(Boolean);
  const videoId = decodePathSegment(pathParts[3]);
  if (typeof videoId !== 'string' || videoId.length === 0) return null;
  // Keep route semantics as a single path segment even after decoding.
  if (videoId.includes('/')) return null;
  return videoId;
}

export function getProxyVideoIdFromPath(pathname: string) {
  const pathParts = pathname.split('/').filter(Boolean);
  let videoIdSegment: string | undefined;
  if (pathParts[0] === 'videos') {
    // Normalized proxy object path used by handleVideoProxy (videos/{id}/...)
    videoIdSegment = pathParts[1];
  } else if (
    pathParts[0] === 'api' &&
    pathParts[1] === 'video-proxy' &&
    pathParts[2] === 'videos'
  ) {
    // Full request pathname form (/api/video-proxy/videos/{id}/...)
    videoIdSegment = pathParts[3];
  }
  if (typeof videoIdSegment !== 'string' || videoIdSegment.length === 0) return null;
  const videoId = decodePathSegment(videoIdSegment);
  if (typeof videoId !== 'string' || videoId.length === 0) return null;
  // Keep route semantics as a single path segment even after decoding.
  if (videoId.includes('/') || videoId === '.' || videoId === '..') return null;
  return videoId;
}

// Resolve a video row by ID first, then by vanity slug.
// Returns the D1 row or null.
async function resolveVideoByIdOrSlug(db: any, idOrSlug: any) {
  const byId = await db.prepare('SELECT * FROM videos WHERE id = ?').bind(idOrSlug).first();
  if (byId) return byId;
  const bySlug = await db.prepare('SELECT * FROM videos WHERE slug = ?').bind(idOrSlug).first();
  if (bySlug) return bySlug;
  return db.prepare('SELECT * FROM videos WHERE legacy_slug = ?').bind(idOrSlug).first();
}

/**
 * Validates that slug and legacy_slug tokens do not collide with existing videos.
 * Checks:
 * 1. Slug doesn't equal another video's ID
 * 2. Slug isn't already used as another video's slug or legacy_slug
 * 3. Legacy slug doesn't equal another video's ID
 * 4. Legacy slug isn't already used as another video's slug or legacy_slug
 *
 * @param db - Database binding
 * @param videoId - ID of the video being created/updated (used to exclude self from collision checks)
 * @param normalizedSlug - The normalized slug value (or null)
 * @param normalizedLegacySlug - The normalized legacy_slug value (or null)
 * @param corsHeaders - CORS headers for the response
 * @returns Response object if there's a collision, null if validation passes
 */
async function validateRouteTokenUniqueness(
  db: any,
  videoId: string,
  normalizedSlug: string | null,
  normalizedLegacySlug: string | null,
  corsHeaders: any,
): Promise<any | null> {
  // Check slug collisions
  if (normalizedSlug) {
    const idCollision = await db
      .prepare('SELECT 1 FROM videos WHERE id = ? AND id != ? LIMIT 1')
      .bind(normalizedSlug, videoId)
      .first();
    if (idCollision) {
      return jsonResponse({ error: 'Slug conflicts with an existing video ID' }, 409, corsHeaders);
    }
    const slugCollision = await db
      .prepare('SELECT 1 FROM videos WHERE id != ? AND (slug = ? OR legacy_slug = ?) LIMIT 1')
      .bind(videoId, normalizedSlug, normalizedSlug)
      .first();
    if (slugCollision) {
      return jsonResponse(
        { error: 'Slug already in use by another video (slug or legacy redirect)' },
        409,
        corsHeaders,
      );
    }
  }

  // Check legacy_slug collisions
  if (normalizedLegacySlug) {
    const idCollision = await db
      .prepare('SELECT 1 FROM videos WHERE id = ? AND id != ? LIMIT 1')
      .bind(normalizedLegacySlug, videoId)
      .first();
    if (idCollision) {
      return jsonResponse(
        { error: 'Legacy slug conflicts with an existing video ID' },
        409,
        corsHeaders,
      );
    }
    const legacyCollision = await db
      .prepare('SELECT 1 FROM videos WHERE id != ? AND (slug = ? OR legacy_slug = ?) LIMIT 1')
      .bind(videoId, normalizedLegacySlug, normalizedLegacySlug)
      .first();
    if (legacyCollision) {
      return jsonResponse(
        { error: 'Legacy slug already in use by another video (slug or legacy redirect)' },
        409,
        corsHeaders,
      );
    }
  }

  return null;
}

const HOMEPAGE_LAYOUT_VARIANTS = new Set(['three_by_one', 'side_mini']);

function normalizeHomepageLayoutVariant(raw: any) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return HOMEPAGE_LAYOUT_VARIANTS.has(value) ? value : 'three_by_one';
}

export function normalizeScheduledPublishAt(
  raw: any,
  options: { allowNull?: boolean; allowPast?: boolean } = {},
) {
  const makeResult = (value: string | null, invalid: boolean, backdatesUpload = false) => ({
    value,
    invalid,
    backdatesUpload,
  });
  if (raw == null || raw === '') {
    return options.allowNull ? makeResult(null, false) : makeResult(null, true);
  }
  if (typeof raw !== 'string') return makeResult(null, true);
  const text = raw.trim();
  if (!text) return options.allowNull ? makeResult(null, false) : makeResult(null, true);

  const t = parseAdminTimestampToUtcMillis(text);
  if (!Number.isFinite(t)) return makeResult(null, true);

  const d = new Date(t);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const value = `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;

  // Future (60s grace): normal schedule. Past: rewrite upload_date for drafts instead of auto-publishing.
  const isBackdateable = t + 60_000 <= Date.now();
  if (options.allowPast) {
    return makeResult(value, false);
  }
  if (isBackdateable) {
    return makeResult(value, false, true);
  }
  return makeResult(value, false);
}

export function normalizePublishedAt(raw: any, options: { allowNull?: boolean } = {}) {
  if (raw == null || raw === '') {
    return options.allowNull ? { value: null, invalid: false } : { value: null, invalid: true };
  }
  if (typeof raw !== 'string') return { value: null, invalid: true };
  const text = raw.trim();
  if (!text)
    return options.allowNull ? { value: null, invalid: false } : { value: null, invalid: true };

  const t = parseAdminTimestampToUtcMillis(text);
  if (!Number.isFinite(t)) return { value: null, invalid: true };

  const d = new Date(t);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return { value: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`, invalid: false };
}

export function parseAdminTimestampToUtcMillis(raw: string) {
  // Preferred path: ISO timestamps with explicit timezone.
  const hasTimezone = /[Zz]$|[+-]\d{2}:\d{2}$/.test(raw);
  if (hasTimezone) return Date.parse(raw);

  // Backwards-compatible path for admin payloads that may contain SQL-style
  // datetime strings from existing UI state (YYYY-MM-DD HH:MM[:SS[.sss]]).
  const sqlLike = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
    raw,
  );
  if (!sqlLike) return Number.NaN;

  const [, y, m, d, hh, mm, ss = '00', sss = '0'] = sqlLike;
  const millis = sss.padEnd(3, '0');
  const utcIso = `${y}-${m}-${d}T${hh}:${mm}:${ss}.${millis}Z`;
  return Date.parse(utcIso);
}

async function runScheduledPublishJobs(env: any) {
  const db = getDatabaseBinding(env);
  const dueRows = await db
    .prepare(`
    SELECT id
    FROM videos
    WHERE publish_status = 'draft'
      AND scheduled_publish_at IS NOT NULL
      AND scheduled_publish_at <= CURRENT_TIMESTAMP
  `)
    .all();
  const dueVideos = dueRows?.results ?? [];
  if (!dueVideos.length) return 0;
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
  `);
  const statements = dueVideos.map((row: any) => publishStmt.bind(row.id));
  await db.batch(statements);
  return statements.length;
}

async function getNextScheduledPublishAtUtcMillis(env: any): Promise<number | null> {
  const db = getDatabaseBinding(env);
  const row = await db
    .prepare(`
    SELECT scheduled_publish_at
    FROM videos
    WHERE publish_status = 'draft'
      AND scheduled_publish_at IS NOT NULL
    ORDER BY scheduled_publish_at ASC
    LIMIT 1
  `)
    .first();
  if (!row?.scheduled_publish_at || typeof row.scheduled_publish_at !== 'string') {
    return null;
  }
  const nextRun = parseAdminTimestampToUtcMillis(row.scheduled_publish_at);
  return Number.isFinite(nextRun) ? nextRun : null;
}

function clampSeconds(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

async function syncScheduledPublishHint(env: any) {
  const kv = env.RATE_LIMIT_KV || env.SETTINGS_KV || null;
  if (!kv) return;

  const hintKey = 'scheduled-publish-next:default';
  const nextRunAt = await getNextScheduledPublishAtUtcMillis(env);
  if (!nextRunAt) {
    await kv.delete(hintKey);
    return;
  }

  const now = Date.now();
  const secondsUntilDue = Math.max(0, Math.ceil((nextRunAt - now) / 1000));
  const ttl = clampSeconds(secondsUntilDue + 3600, 3600, 86400);
  await kv.put(hintKey, String(nextRunAt), { expirationTtl: ttl });
}

async function maybeRunScheduledPublishJobsInRequest(env: any) {
  try {
    const kv = env.RATE_LIMIT_KV || env.SETTINGS_KV || null;
    if (!kv) return;

    try {
      const colo = typeof env.CF_COLO === 'string' ? env.CF_COLO : 'default';
      const lockKey = `scheduled-publish-sweep:${colo}`;
      const lastRun = await kv.get(lockKey);
      if (lastRun) return;

      const now = Date.now();
      const hintKey = 'scheduled-publish-next:default';
      let hintRaw = await kv.get(hintKey);
      if (!hintRaw) {
        // Backfill hint in case older schedules were created before hinting was introduced.
        await syncScheduledPublishHint(env);
        hintRaw = await kv.get(hintKey);
        if (!hintRaw) {
          // No scheduled drafts exist: avoid frequent writes in request path.
          await kv.put(lockKey, String(now), { expirationTtl: 3600 });
          return;
        }
      }

      const nextRunAt = Number.parseInt(hintRaw, 10);
      if (!Number.isFinite(nextRunAt) || nextRunAt <= 0) {
        await kv.delete(hintKey);
        await kv.put(lockKey, String(now), { expirationTtl: 600 });
        return;
      }

      if (nextRunAt > now) {
        // Back off until the next draft is due.
        const secondsUntilDue = Math.ceil((nextRunAt - now) / 1000);
        const ttl = clampSeconds(secondsUntilDue, 60, 3600);
        await kv.put(lockKey, String(now), { expirationTtl: ttl });
        return;
      }

      await kv.put(lockKey, String(now), { expirationTtl: 60 });
    } catch (err) {
      console.error('Scheduled publish lock KV operation failed:', err);
      return;
    }

    await runScheduledPublishJobs(env);
    await syncScheduledPublishHint(env);
  } catch (err) {
    console.error('In-request scheduled publish sweep failed:', err);
  }
}

function safeJsonParse(v: any, fallback: any) {
  if (!v) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function defaultHomepageConfig() {
  return {
    ...normalizeHomepagePlacementConfig(null),
    layoutBlocks: [],
  };
}

function normalizeHomepageConfig(config: any) {
  return {
    ...normalizeHomepagePlacementConfig(config),
    layoutBlocks: Array.isArray(config?.layoutBlocks)
      ? config.layoutBlocks
          .filter((b: any) => b && typeof b === 'object')
          .map((b: any) => {
            const type = normalizeLayoutBlockType(b.type);
            const normalized: any = {
              id: typeof b.id === 'string' ? b.id : crypto.randomUUID(),
              type,
              title: typeof b.title === 'string' ? b.title : '',
              body: typeof b.body === 'string' ? b.body : '',
            };
            if (type === 'category') {
              normalized.categoryId = typeof b.categoryId === 'string' ? b.categoryId : null;
            }
            if (type === 'split_horizontal' || type === 'split_vertical') {
              const children = Array.isArray(b.childBlocks) ? b.childBlocks : [];
              normalized.childBlocks = children
                .filter((child: any) => child && typeof child === 'object')
                .slice(0, 2)
                .map((child: any) => ({
                  type: normalizeHomepageChildBlockType(child.type),
                  title: typeof child.title === 'string' ? child.title : '',
                  body: typeof child.body === 'string' ? child.body : '',
                  categoryId: typeof child.categoryId === 'string' ? child.categoryId : null,
                }));
            }
            return normalized;
          })
      : [],
  };
}

function normalizeLayoutBlockType(type: any) {
  if (type === 'featured') return 'featured_row';
  const allowedTypes = new Set([
    'featured_row',
    'category',
    'top_video',
    'split_horizontal',
    'split_vertical',
  ]);
  return allowedTypes.has(type) ? type : 'top_video';
}

function normalizeHomepageChildBlockType(type: any) {
  const allowedTypes = new Set(['featured_row', 'category', 'top_video']);
  return allowedTypes.has(type) ? type : 'top_video';
}

function getDatabaseBinding(env: any) {
  const db = env.DB || env.video_subscription_db;
  if (!db) throw new Error('Database binding not configured');
  return db;
}

function jsonResponse(data: any, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

let pillsKeySyncPromise: any = null;
async function maybeSyncPillsApiKey(env: any) {
  if (!env?.PILLS_API_KEY) return;
  if (!pillsKeySyncPromise) {
    pillsKeySyncPromise = ensurePillsApiKeySetting(env).catch((error) => {
      console.error('Failed to sync PILLS_API_KEY into admin_settings:', error);
    });
  }
  await pillsKeySyncPromise;
}

async function sha256Hex(value: any) {
  const bytes = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── Segment duration helpers (Step 4b) ──────────────────────────────────────
//
// We cache the average HLS segment duration per videoId in KV so we can
// throttle .ts responses to roughly real-time speed.

async function getAvgSegmentDuration(videoId: any, env: any) {
  if (!env.RATE_LIMIT_KV) return null;

  // Check KV cache first (1-hour TTL)
  const cached = await env.RATE_LIMIT_KV.get(`manifest:${videoId}`, 'json');
  if (cached?.avg && typeof cached.avg === 'number') return cached.avg;

  // Try to fetch one of the known playlist paths from R2
  const base = env.R2_BASE_URL;
  const candidates = [
    `${base}/videos/${videoId}/master.m3u8`,
    `${base}/videos/${videoId}/processed/hls/master.m3u8`,
    `${base}/videos/${videoId}/processed/playlist.m3u8`,
  ];

  let manifest = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const text = await res.text();
        // For master playlists, follow the first variant
        if (text.includes('#EXT-X-STREAM-INF')) {
          const lines = text.split('\n');
          const varLine = lines.find((l) => !l.startsWith('#') && l.trim().endsWith('.m3u8'));
          if (varLine) {
            const trimmedLine = varLine.trim();
            const varUrl = new URL(trimmedLine, url).toString();
            const varRes = await fetch(varUrl);
            if (varRes.ok) manifest = await varRes.text();
          }
        } else {
          manifest = text;
        }
        break;
      }
    } catch {
      /* try next */
    }
  }

  if (!manifest) return null;

  // Parse #EXTINF durations from media playlist
  const durations = [];
  for (const line of manifest.split('\n')) {
    const t = line.trim();
    if (t.startsWith('#EXTINF:')) {
      const dur = parseFloat(t.slice('#EXTINF:'.length));
      if (dur > 0) durations.push(dur);
    }
  }
  if (!durations.length) return null;

  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  await env.RATE_LIMIT_KV.put(`manifest:${videoId}`, JSON.stringify({ avg }), {
    expirationTtl: 3600,
  });
  return avg;
}

// ─── Segment count rate limiting (Step 4c) ────────────────────────────────────
//
// Allows up to 3× real-time segment requests per minute per user per video.
// Exceeding the threshold bans that user+video pair for 60 seconds (KV minimum TTL).
//
// Uses a Durable Object to ensure atomic increment operations.

async function checkSegmentRateLimit(identifier: any, videoId: any, avgSegDur: any, env: any) {
  if (!env.RATE_LIMIT_KV) return false;

  // Check active ban
  const banKey = `segban:${identifier}:${videoId}`;
  const banned = await env.RATE_LIMIT_KV.get(banKey);
  if (banned) return true;

  // Use Durable Object for atomic counting if available
  if (env.SEGMENT_RATE_LIMITER) {
    try {
      // Create a deterministic ID based on identifier and videoId
      const doId = env.SEGMENT_RATE_LIMITER.idFromName(`${identifier}:${videoId}`);
      const doStub = env.SEGMENT_RATE_LIMITER.get(doId);

      const response = await doStub.fetch('https://dummy-url/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, videoId, avgSegDur }),
      });

      const result = await response.json();

      if (result.exceeded) {
        await env.RATE_LIMIT_KV.put(banKey, '1', { expirationTtl: 60 });
        return true;
      }

      return false;
    } catch (error) {
      console.error('Durable Object rate limit error:', error);
      // Fall through to KV-based rate limiting as fallback
    }
  }

  // Fallback to non-atomic KV-based rate limiting (legacy)
  const segDur = avgSegDur ?? 6; // default 6-second segments
  const threshold = Math.ceil(60 / segDur) * 3;

  const minute = Math.floor(Date.now() / 60000);
  const countKey = `segcount:${identifier}:${videoId}:${minute}`;
  const raw = await env.RATE_LIMIT_KV.get(countKey);
  const count = (parseInt(raw ?? '0', 10) || 0) + 1;
  await env.RATE_LIMIT_KV.put(countKey, String(count), { expirationTtl: 90 });

  if (count > threshold) {
    await env.RATE_LIMIT_KV.put(banKey, '1', { expirationTtl: 60 });
    return true;
  }

  return false;
}
