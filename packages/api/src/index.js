export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
      'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Add this new route
    if (url.pathname === '/api/videos') {
      return handleVideosList(request, env, corsHeaders);
    }

    if (url.pathname.startsWith('/api/video-access/')) {
      return handleVideoAccess(request, env, corsHeaders);
    }

    if (url.pathname.startsWith('/api/video-proxy/')) {
      return handleVideoProxy(request, env, corsHeaders);
    }

    if (url.pathname === '/api/admin/config') {
      return handleAdminConfig(request, env, corsHeaders);
    }

    if (url.pathname === '/api/admin/preview-locks') {
      return handlePreviewLocks(request, env, corsHeaders);
    }

    if (url.pathname === '/api/health') {
      return jsonResponse({ status: 'healthy' }, 200, corsHeaders);
    }

    return jsonResponse({ error: 'Not Found' }, 404, corsHeaders);
  }
};

async function handleVideosList(request, env, corsHeaders) {
  try {
    const db = getDatabaseBinding(env);
    
    const videos = await db.prepare(`
      SELECT id, title, description, thumbnail_url, full_duration, preview_duration, upload_date
      FROM videos
      ORDER BY upload_date DESC
    `).all();

    return jsonResponse({
      videos: videos.results || []
    }, 200, corsHeaders);
  } catch (error) {
    console.error('Error:', error);
    return jsonResponse({ 
      error: 'Internal server error',
      details: error.message 
    }, 500, corsHeaders);
  }
}

async function handleVideoAccess(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    
    if (pathParts.length !== 5) {
      return jsonResponse({ error: 'Invalid path format. Expected: /api/video-access/{userId}/{videoId}' }, 400, corsHeaders);
    }

    const userId = pathParts[3];
    const requestedVideoId = decodeURIComponent(pathParts[4] ?? '');
    const videoId = normalizeVideoId(requestedVideoId);

    const db = getDatabaseBinding(env);

    // Get subscription
    const subscription = await db.prepare(`
      SELECT s.*, u.email 
      FROM subscriptions s 
      JOIN users u ON u.id = s.user_id 
      WHERE s.user_id = ? AND s.status = 'active'
      ORDER BY s.created_at DESC 
      LIMIT 1
    `).bind(userId).first();

    // Get video metadata
    const video = await db.prepare(`
      SELECT * FROM videos WHERE id = ?
    `).bind(videoId).first();

    // Check premium access
    const hasPremiumAccess = subscription && 
      subscription.plan_type === 'premium' && 
      (subscription.expires_at === null || new Date(subscription.expires_at) > new Date());

    const hasVideoMetadata = Boolean(video);
    const hasAccess = hasPremiumAccess || !hasVideoMetadata;
    const resolvedPlaylistUrl = await resolvePlaylistUrl({
      env,
      videoId,
      hasPremiumAccess: true
    });
    const previewDuration = video?.preview_duration ?? video?.full_duration ?? 0;
    const playlistUrl = buildProxyPlaylistUrl(
      request,
      resolvedPlaylistUrl,
      hasPremiumAccess ? null : previewDuration
    );
    const fullDuration = video?.full_duration ?? previewDuration;

    const response = {
      userId,
      videoId,
      hasAccess,
      subscription: {
        planType: subscription ? subscription.plan_type : 'free',
        status: subscription ? subscription.status : 'none',
        expiresAt: subscription ? subscription.expires_at : null
      },
      video: {
        title: video?.title ?? `Uploaded Video ${videoId}`,
        fullDuration,
        previewDuration,
        playlistUrl
      },
      chapters: [
        {
          title: "Preview",
          startTime: 0,
          endTime: previewDuration,
          accessible: true
        },
        {
          title: "Full Content",
          startTime: previewDuration,
          endTime: fullDuration,
          accessible: hasAccess
        }
      ]
    };

    return jsonResponse(response, 200, corsHeaders);

  } catch (error) {
    console.error('Error:', error);
    return jsonResponse({ 
      error: 'Internal server error',
      details: error.message 
    }, 500, corsHeaders);
  }
}

async function handleVideoProxy(request, env, corsHeaders) {
  const requestUrl = new URL(request.url);
  const proxyPrefix = '/api/video-proxy/';
  const objectPath = requestUrl.pathname.slice(proxyPrefix.length);
  const previewUntil = Number.parseFloat(requestUrl.searchParams.get('previewUntil') ?? '');
  const previewUntilSeconds = Number.isFinite(previewUntil) && previewUntil > 0 ? previewUntil : null;

  if (!objectPath) {
    return jsonResponse({ error: 'Missing proxied object path' }, 400, corsHeaders);
  }

  const allowedPrefix = ['videos/', 'preview/', 'full/'];
  if (!allowedPrefix.some((prefix) => objectPath.startsWith(prefix))) {
    return jsonResponse({ error: 'Unsupported proxied path' }, 400, corsHeaders);
  }

  const upstreamUrl = new URL(`${env.R2_BASE_URL}/${objectPath}`);
  const upstreamHeaders = new Headers();
  const rangeHeader = request.headers.get('Range');

  if (rangeHeader) {
    upstreamHeaders.set('Range', rangeHeader);
  }

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: upstreamHeaders
  });

  if (shouldRewriteManifest(objectPath, upstreamResponse)) {
    const manifest = await upstreamResponse.text();
    const rewrittenManifest = rewriteManifestForProxyWithPreview(manifest, previewUntilSeconds);
    const headers = new Headers(upstreamResponse.headers);

    headers.set('Content-Type', 'application/vnd.apple.mpegurl');
    headers.delete('Content-Length');

    for (const [key, value] of Object.entries(corsHeaders)) {
      headers.set(key, value);
    }

    return new Response(rewrittenManifest, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers
    });
  }

  const headers = new Headers(upstreamResponse.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers
  });
}

function shouldRewriteManifest(objectPath, upstreamResponse) {
  if (objectPath.endsWith('.m3u8')) {
    return true;
  }

  const contentType = upstreamResponse.headers.get('content-type') ?? '';
  return /application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl/i.test(contentType);
}

function rewriteManifestForProxy(manifest) {
  return rewriteManifestForProxyWithPreview(manifest, null);
}

function rewriteManifestForProxyWithPreview(manifest, previewUntilSeconds) {
  const lines = manifest.split('\n');
  const hasPreviewLimit = typeof previewUntilSeconds === 'number' && previewUntilSeconds > 0;
  const isMediaPlaylist = lines.some((line) => line.trim().startsWith('#EXTINF:'));
  const isMasterPlaylist = lines.some((line) => line.trim().startsWith('#EXT-X-STREAM-INF'));
  const previewQuery = hasPreviewLimit ? `previewUntil=${Math.floor(previewUntilSeconds)}` : null;

  if (hasPreviewLimit && isMediaPlaylist) {
    let elapsedSeconds = 0;
    let pendingExtInf = null;
    const limitedLines = [];

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) {
        if (trimmed.startsWith('#EXTINF:')) {
          const duration = Number.parseFloat(trimmed.slice('#EXTINF:'.length));
          pendingExtInf = Number.isFinite(duration) ? duration : 0;
        }
        if (trimmed !== '#EXT-X-ENDLIST') {
          limitedLines.push(line);
        }
        continue;
      }

      const segmentDuration = pendingExtInf ?? 0;
      const nextElapsed = elapsedSeconds + segmentDuration;

      if (elapsedSeconds >= previewUntilSeconds) {
        break;
      }

      limitedLines.push(rewriteSegmentPath(trimmed, previewQuery));
      elapsedSeconds = nextElapsed;
      pendingExtInf = null;
    }

    limitedLines.push('#EXT-X-ENDLIST');
    return limitedLines.join('\n');
  }

  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;

      if (isMasterPlaylist && hasPreviewLimit) {
        return rewriteSegmentPath(trimmed, previewQuery);
      }

      return rewriteSegmentPath(trimmed, null);
    })
    .join('\n');
}

function rewriteSegmentPath(trimmedPath, appendedQuery) {
  if (/^https?:\/\//i.test(trimmedPath)) {
    const sourceUrl = new URL(trimmedPath);
    const proxyPath = `/api/video-proxy${sourceUrl.pathname}${sourceUrl.search}`;
    return appendQuery(proxyPath, appendedQuery);
  }

  if (trimmedPath.startsWith('/')) {
    return appendQuery(`/api/video-proxy${trimmedPath}`, appendedQuery);
  }

  if (/^(videos|preview|full)\//i.test(trimmedPath)) {
    return appendQuery(`/api/video-proxy/${trimmedPath}`, appendedQuery);
  }

  return trimmedPath;
}

function appendQuery(path, queryString) {
  if (!queryString) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${queryString}`;
}

function normalizeVideoId(input) {
  const trimmed = (input ?? '').trim();

  const pathMatch = trimmed.match(/^videos\/([^/]+)\/processed\/playlist\.m3u8$/i);
  if (pathMatch) {
    return pathMatch[1];
  }

  return trimmed;
}

async function resolvePlaylistUrl({ env, videoId, hasPremiumAccess }) {
  const base = env.R2_BASE_URL;
  const candidates = hasPremiumAccess
    ? [
        `${base}/full/${videoId}/playlist.m3u8`,
        `${base}/videos/${videoId}/processed/playlist.m3u8`,
      ]
    : [
        `${base}/preview/${videoId}/playlist.m3u8`,
        `${base}/videos/${videoId}/processed/playlist.m3u8`,
      ];

  for (const candidate of candidates) {
    if (await canLoadPlaylist(candidate)) {
      return candidate;
    }
  }

  return `${base}/videos/${videoId}/processed/playlist.m3u8`;
}

function buildProxyPlaylistUrl(request, playlistUrl, previewUntilSeconds = null) {
  const requestUrl = new URL(request.url);
  const upstreamUrl = new URL(playlistUrl);
  const proxyUrl = new URL(requestUrl.origin);
  proxyUrl.pathname = `/api/video-proxy${upstreamUrl.pathname}`;
  if (previewUntilSeconds && previewUntilSeconds > 0) {
    proxyUrl.searchParams.set('previewUntil', String(Math.floor(previewUntilSeconds)));
  }
  return proxyUrl.toString();
}

async function handleAdminConfig(request, env, corsHeaders) {
  const db = getDatabaseBinding(env);
  await ensureAdminSettingsTable(db);

  if (request.method === 'GET') {
    const row = await db.prepare(`SELECT value FROM admin_settings WHERE key = ? LIMIT 1`).bind('homepage').first();
    const value = safeJsonParse(row?.value, defaultHomepageConfig());
    return jsonResponse({ config: value }, 200, corsHeaders);
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  const body = await request.json().catch(() => null);
  if (!body?.config || typeof body.config !== 'object') {
    return jsonResponse({ error: 'config object is required' }, 400, corsHeaders);
  }

  const normalized = normalizeHomepageConfig(body.config);
  await db.prepare(`
    INSERT INTO admin_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).bind('homepage', JSON.stringify(normalized)).run();

  return jsonResponse({ ok: true, config: normalized }, 200, corsHeaders);
}

async function handlePreviewLocks(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.locks)) {
    return jsonResponse({ error: 'locks array is required' }, 400, corsHeaders);
  }

  const db = getDatabaseBinding(env);

  for (const lockEntry of body.locks) {
    if (!lockEntry || typeof lockEntry.videoId !== 'string') continue;
    const lockSeconds = Number.parseInt(lockEntry.previewDuration, 10);
    if (!Number.isFinite(lockSeconds) || lockSeconds < 0) continue;

    await db.prepare(`
      UPDATE videos
      SET preview_duration = MIN(full_duration, ?)
      WHERE id = ?
    `).bind(lockSeconds, lockEntry.videoId).run();
  }

  return jsonResponse({ ok: true }, 200, corsHeaders);
}

async function ensureAdminSettingsTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function defaultHomepageConfig() {
  return {
    featuredVideoIds: [],
    layoutBlocks: []
  };
}

function normalizeHomepageConfig(config) {
  const featuredVideoIds = Array.isArray(config.featuredVideoIds)
    ? config.featuredVideoIds
        .filter((videoId) => typeof videoId === 'string')
        .slice(0, 4)
    : [];

  const layoutBlocks = Array.isArray(config.layoutBlocks)
    ? config.layoutBlocks
        .filter((block) => block && typeof block === 'object')
        .map((block) => ({
          id: typeof block.id === 'string' ? block.id : crypto.randomUUID(),
          type: typeof block.type === 'string' ? block.type : 'hero',
          title: typeof block.title === 'string' ? block.title : '',
          body: typeof block.body === 'string' ? block.body : ''
        }))
    : [];

  return { featuredVideoIds, layoutBlocks };
}

async function canLoadPlaylist(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch (_) {
    return false;
  }
}

function getDatabaseBinding(env) {
  const db = env.DB || env.video_subscription_db;

  if (!db) {
    throw new Error('Database binding is not configured. Expected env.DB or env.video_subscription_db');
  }

  return db;
}

function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}
