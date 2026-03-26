export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname.startsWith('/api/video-access/')) {
      return handleVideoAccess(request, env, corsHeaders);
    }

    if (url.pathname === '/api/health') {
      return jsonResponse({ status: 'healthy' }, 200, corsHeaders);
    }

    return jsonResponse({ error: 'Not Found' }, 404, corsHeaders);
  }
};

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
    const playlistUrl = await resolvePlaylistUrl({
      env,
      videoId,
      hasPremiumAccess
    });
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
