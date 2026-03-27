const SEGMENT_DURATION_SECONDS = 10;
const TARGET_SEGMENT_SIZE_BYTES = 10 * 1024 * 1024;

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
  const processingMode = sanitizeProcessingMode(body.processingMode);

  if (processingMode === 'register-existing-cmaf') {
    return registerExistingCmaf({ env, videoId, visibility });
  }

  const list = await env.VIDEO_BUCKET.list({ prefix: `videos/${videoId}/source/`, limit: 1 });
  const source = list.objects[0];

  if (!source) {
    return json({ error: 'Uploaded source not found for videoId' }, 404);
  }

  if (!source.size) {
    return json({ error: 'Uploaded source file is empty' }, 400);
  }

  const sourceSize = Number(source.size);
  const segmentCount = Math.max(1, Math.ceil(sourceSize / TARGET_SEGMENT_SIZE_BYTES));
  const segmentsPrefix = `videos/${videoId}/processed/segments`;
  const playlistKey = `videos/${videoId}/processed/playlist.m3u8`;
  const metadataKey = `videos/${videoId}/metadata.json`;
  const processedAt = new Date().toISOString();

  const segmentKeys = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const start = index * TARGET_SEGMENT_SIZE_BYTES;
    const length = Math.min(TARGET_SEGMENT_SIZE_BYTES, sourceSize - start);
    const sourceChunk = await env.VIDEO_BUCKET.get(source.key, { range: { offset: start, length } });
    if (!sourceChunk) {
      return json({ error: `Unable to read source chunk ${index}` }, 500);
    }

    const segmentBytes = await sourceChunk.arrayBuffer();
    const segmentKey = `${segmentsPrefix}/segment_${String(index).padStart(4, '0')}.ts`;

    await env.VIDEO_BUCKET.put(segmentKey, segmentBytes, {
      httpMetadata: { contentType: 'video/mp2t' },
      customMetadata: {
        status: 'processed',
        visibility,
        processedAt,
        videoId,
        sourceKey: source.key,
        segmentIndex: String(index)
      }
    });

    segmentKeys.push(segmentKey);
  }

  const playlistContent = buildPlaylist(segmentKeys, SEGMENT_DURATION_SECONDS);

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
    segmentKeys,
    status: 'processed',
    visibility,
    processedAt,
    segmentDurationSeconds: SEGMENT_DURATION_SECONDS,
    note: 'Segments are generated from uploaded bytes in fixed-size chunks with .ts naming for key compatibility only. They are not guaranteed to be valid MPEG-TS. Use ffmpeg transcoding for production HLS output.'
  }, null, 2), {
    httpMetadata: { contentType: 'application/json' }
  });

  return json({
    ok: true,
    videoId,
    playlistKey,
    segmentKeys,
    metadataKey,
    processedAt,
    visibility,
    processingMode
  });
}

async function registerExistingCmaf({ env, videoId, visibility }) {
  const playlistKey = `videos/${videoId}/processed/playlist.m3u8`;
  const metadataKey = `videos/${videoId}/metadata.json`;
  const processedAt = new Date().toISOString();
  const playlist = await env.VIDEO_BUCKET.get(playlistKey);

  if (!playlist || !Number(playlist.size)) {
    return json({
      error: 'register-existing-cmaf mode requires an existing playlist.m3u8. Use legacy-process as fallback.'
    }, 409);
  }

  const segmentObjects = await env.VIDEO_BUCKET.list({ prefix: `videos/${videoId}/processed/segments/`, limit: 1000 });
  const segmentKeys = segmentObjects.objects
    .filter((object) => object.key.endsWith('.ts') && Number(object.size) > 0)
    .map((object) => object.key);

  if (!segmentKeys.length) {
    return json({
      error: 'register-existing-cmaf mode requires existing processed segments. Use legacy-process as fallback.'
    }, 409);
  }

  await env.VIDEO_BUCKET.put(metadataKey, JSON.stringify({
    videoId,
    playlistKey,
    segmentKeys,
    status: 'processed',
    visibility,
    processedAt,
    processingMode: 'register-existing-cmaf'
  }, null, 2), {
    httpMetadata: { contentType: 'application/json' }
  });

  return json({
    ok: true,
    videoId,
    playlistKey,
    segmentKeys,
    metadataKey,
    processedAt,
    visibility,
    processingMode: 'register-existing-cmaf'
  });
}

function buildPlaylist(segmentKeys, segmentDurationSeconds) {
  const header = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${segmentDurationSeconds}`,
    '#EXT-X-MEDIA-SEQUENCE:0'
  ];

  const lines = [...header];
  for (const key of segmentKeys) {
    lines.push(`#EXTINF:${segmentDurationSeconds.toFixed(1)},`);
    lines.push(key);
  }

  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

function sanitizeVisibility(value) {
  if (value === 'public' || value === 'unlisted') {
    return value;
  }
  return 'private';
}

function sanitizeProcessingMode(value) {
  if (value === 'legacy-process') return value;
  return 'register-existing-cmaf';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
