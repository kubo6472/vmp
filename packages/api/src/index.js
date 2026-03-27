export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
      hasPremiumAccess
    });
    const playlistUrl = buildProxyPlaylistUrl(request, resolvedPlaylistUrl);
    const previewDuration = video?.preview_duration ?? video?.full_duration ?? 0;
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
    const rewrittenManifest = rewriteManifestForProxy(manifest);
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
  const lines = manifest.split('\n');

  return lines
    .map((line) => {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) {
        return line;
      }

      if (/^https?:\/\//i.test(trimmed)) {
        const sourceUrl = new URL(trimmed);
        return `/api/video-proxy${sourceUrl.pathname}${sourceUrl.search}`;
      }

      if (trimmed.startsWith('/')) {
        return `/api/video-proxy${trimmed}`;
      }

      if (/^(videos|preview|full)\//i.test(trimmed)) {
        return `/api/video-proxy/${trimmed}`;
      }

      return line;
    })
    .join('\n');
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

function buildProxyPlaylistUrl(request, playlistUrl) {
  const requestUrl = new URL(request.url);
  const upstreamUrl = new URL(playlistUrl);
  const proxyUrl = new URL(requestUrl.origin);
  proxyUrl.pathname = `/api/video-proxy${upstreamUrl.pathname}`;
  return proxyUrl.toString();
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
