export async function onRequestGet(context) {
  const { env } = context;

  if (!env.VIDEO_BUCKET) {
    return json({ error: 'VIDEO_BUCKET binding is required' }, 500);
  }

  const result = await env.VIDEO_BUCKET.list({ prefix: 'videos/', limit: 1000 });
  const byVideoId = new Map();

  for (const object of result.objects) {
    const videoId = getVideoIdFromKey(object.key);
    if (!videoId) continue;

    const entry = byVideoId.get(videoId) ?? newVideoEntry(videoId);
    hydrateVideoEntry(entry, object);
    byVideoId.set(videoId, entry);
  }

  await hydrateMetadata(byVideoId, env);

  const videos = Array.from(byVideoId.values())
    .filter((entry) => entry.hasSource || entry.hasValidProcessedOutput)
    .map((entry) => ({
      videoId: entry.videoId,
      status: entry.hasValidProcessedOutput ? 'processed' : 'uploaded',
      visibility: entry.visibility ?? 'private',
      updatedAt: entry.updatedAt
    }));

  videos.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return json({ videos });
}

function newVideoEntry(videoId) {
  return {
    videoId,
    hasSource: false,
    hasPlaylist: false,
    hasSegments: false,
    hasValidProcessedOutput: false,
    visibility: null,
    updatedAt: null
  };
}

function hydrateVideoEntry(entry, object) {
  const sourcePrefix = `videos/${entry.videoId}/source/`;
  const playlistKey = `videos/${entry.videoId}/processed/playlist.m3u8`;
  const segmentsPrefix = `videos/${entry.videoId}/processed/segments/`;

  if (object.key.startsWith(sourcePrefix)) {
    entry.hasSource = true;
  }

  if (object.key === playlistKey && Number(object.size) > 0) {
    entry.hasPlaylist = true;
  }

  if (object.key.startsWith(segmentsPrefix) && object.key.endsWith('.ts') && Number(object.size) > 0) {
    entry.hasSegments = true;
  }

  entry.hasValidProcessedOutput = entry.hasPlaylist && entry.hasSegments;
  entry.updatedAt = maxDate(entry.updatedAt, object.uploaded);
}

function getVideoIdFromKey(key) {
  const match = key.match(/^videos\/([^/]+)\//);
  return match ? match[1] : null;
}

function maxDate(previousDate, nextDate) {
  if (!previousDate) return nextDate;
  if (!nextDate) return previousDate;
  return new Date(nextDate).getTime() > new Date(previousDate).getTime() ? nextDate : previousDate;
}

async function hydrateMetadata(byVideoId, env) {
  for (const entry of byVideoId.values()) {
    const metadataKey = `videos/${entry.videoId}/metadata.json`;
    const metadataObject = await env.VIDEO_BUCKET.get(metadataKey);
    if (!metadataObject) continue;

    const metadata = await metadataObject.json().catch(() => null);
    if (!metadata) continue;

    if (metadata.visibility === 'public' || metadata.visibility === 'unlisted' || metadata.visibility === 'private') {
      entry.visibility = metadata.visibility;
    }

    if (metadata.processedAt) {
      entry.updatedAt = maxDate(entry.updatedAt, metadata.processedAt);
    }
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
