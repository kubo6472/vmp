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
    const videoId = pathParts[4];

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

    if (!video) {
      return jsonResponse({ error: 'Video not found' }, 404, corsHeaders);
    }

    // Check premium access
    const hasPremiumAccess = subscription && 
      subscription.plan_type === 'premium' && 
      (subscription.expires_at === null || new Date(subscription.expires_at) > new Date());

    const response = {
      userId,
      videoId,
      hasAccess: hasPremiumAccess,
      subscription: {
        planType: subscription ? subscription.plan_type : 'free',
        status: subscription ? subscription.status : 'none',
        expiresAt: subscription ? subscription.expires_at : null
      },
      video: {
        title: video.title,
        fullDuration: video.full_duration,
        previewDuration: video.preview_duration,
        playlistUrl: hasPremiumAccess ? 
          `${env.R2_BASE_URL}/full/${videoId}/playlist.m3u8` :
          `${env.R2_BASE_URL}/preview/${videoId}/playlist.m3u8`
      },
      chapters: [
        {
          title: "Preview",
          startTime: 0,
          endTime: video.preview_duration,
          accessible: true
        },
        {
          title: "Full Content",
          startTime: video.preview_duration,
          endTime: video.full_duration,
          accessible: hasPremiumAccess
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
