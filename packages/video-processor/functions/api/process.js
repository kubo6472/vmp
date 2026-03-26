export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.VIDEO_BUCKET) {
    return json({ error: 'VIDEO_BUCKET binding is required' }, 500);
  }

  const body = await request.json().catch(() => null);
  if (!body?.videoId) {
    return json({ error: 'videoId is required' }, 400);
  }

  const videoId = body.videoId;
  const visibility = sanitizeVisibility(body.visibility);

  const list = await env.VIDEO_BUCKET.list({ prefix: `videos/${videoId}/source/`, limit: 1 });
  const source = list.objects[0];

  if (!source) {
    return json({ error: 'Uploaded source not found for videoId' }, 404);
  }

  const processedAt = new Date().toISOString();
  const playlistKey = `videos/${videoId}/processed/playlist.m3u8`;
  const metadataKey = `videos/${videoId}/metadata.json`;

  const playlistContent = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:10.0,',
    source.key,
    '#EXT-X-ENDLIST'
  ].join('\n');

  await env.VIDEO_BUCKET.put(playlistKey, playlistContent, {
    httpMetadata: { contentType: 'application/vnd.apple.mpegurl' },
    customMetadata: {
      status: 'processed',
      visibility,
      processedAt
    }
  });

  await env.VIDEO_BUCKET.put(metadataKey, JSON.stringify({
    videoId,
    sourceKey: source.key,
    playlistKey,
    status: 'processed',
    visibility,
    processedAt,
    note: 'This is a lightweight processing placeholder. Replace with real transcoding pipeline as needed.'
  }, null, 2), {
    httpMetadata: { contentType: 'application/json' }
  });

  return json({ ok: true, videoId, playlistKey, metadataKey, processedAt, visibility });
}

function sanitizeVisibility(value) {
  if (value === 'public' || value === 'unlisted') {
    return value;
  }
  return 'private';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
