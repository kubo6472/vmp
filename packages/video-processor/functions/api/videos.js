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
      packaging: entry.packaging,
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
    hasValidProcessedOutput: false,
    packaging: null,
    visibility: null,
    updatedAt: null
  };
}

function hydrateVideoEntry(entry, object) {
  const sourcePrefix = `videos/${entry.videoId}/source/`;

  if (object.key.startsWith(sourcePrefix)) {
    entry.hasSource = true;
  }
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

    const packaging = getPackagingState(metadata, entry.videoId);
    entry.packaging = packaging;
    entry.hasValidProcessedOutput = packaging.isValid;
  }
}

function getPackagingState(metadata, videoId) {
  const processedPrefix = `videos/${videoId}/processed/`;
  const hlsMasterKey = `${processedPrefix}hls/master.m3u8`;
  const dashManifestKey = `${processedPrefix}dash/manifest.mpd`;
  const legacyPlaylistKey = `${processedPrefix}playlist.m3u8`;
  const variantMediaPattern = new RegExp(`^videos/${escapeRegExp(videoId)}/processed/[^/]+/.+(?:\\.m4s|\\.mp4)$`);

  const allProcessedKeys = Array.from(collectStringValues(metadata))
    .filter((value) => value.startsWith(processedPrefix));

  const keys = new Set(allProcessedKeys);
  const hasHlsMaster = keys.has(hlsMasterKey);
  const hasDashManifest = keys.has(dashManifestKey);
  const hasLegacyPlaylist = keys.has(legacyPlaylistKey);
  const hasVariantMedia = allProcessedKeys.some((key) => variantMediaPattern.test(key));
  const hasModernPackaging = hasHlsMaster && hasVariantMedia;
  const isValid = hasModernPackaging || hasLegacyPlaylist;

  return {
    mode: hasModernPackaging ? 'modern' : hasLegacyPlaylist ? 'legacy' : 'invalid',
    isValid,
    hasHlsMaster,
    hasDashManifest,
    hasVariantMedia,
    hasLegacyPlaylist
  };
}

function* collectStringValues(value) {
  if (typeof value === 'string') {
    yield value;
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      yield* collectStringValues(item);
    }
    return;
  }

  if (value && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      yield* collectStringValues(nestedValue);
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
