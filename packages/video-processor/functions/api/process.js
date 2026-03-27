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
  const validateDash = Boolean(body.validateDash);

  const hlsMasterKey = `videos/${videoId}/processed/hls/master.m3u8`;
  const dashManifestKey = `videos/${videoId}/processed/dash/manifest.mpd`;
  const metadataKey = `videos/${videoId}/metadata.json`;
  const processedAt = new Date().toISOString();

  const existingMetadataObject = await env.VIDEO_BUCKET.get(metadataKey);
  const existingMetadata = existingMetadataObject
    ? await existingMetadataObject.json().catch(() => null)
    : null;
  const durationSeconds = toNumberOrNull(existingMetadata?.durationSeconds);

  const hlsMaster = await env.VIDEO_BUCKET.get(hlsMasterKey);
  if (!hlsMaster) {
    return json({ error: `Missing required HLS master playlist at ${hlsMasterKey}` }, 404);
  }

  const hlsMasterContent = await hlsMaster.text();
  const { variants, audioGroups } = parseHlsMasterPlaylist(hlsMasterContent);

  const dashManifest = await env.VIDEO_BUCKET.get(dashManifestKey);
  if (validateDash && !dashManifest) {
    return json({ error: `DASH validation requested but manifest not found at ${dashManifestKey}` }, 404);
  }

  const resolvedDashManifestKey = dashManifest ? dashManifestKey : null;

  const metadata = {
    videoId,
    packaging: 'cmaf',
    hlsMasterKey,
    dashManifestKey: resolvedDashManifestKey,
    variants,
    processedAt,
    visibility,
    status: 'processed'
  };

  if (durationSeconds !== null) {
    metadata.durationSeconds = durationSeconds;
  }

  if (audioGroups.length > 0) {
    metadata.audioGroups = audioGroups;
  }

  await env.VIDEO_BUCKET.put(metadataKey, JSON.stringify(metadata, null, 2), {
    httpMetadata: { contentType: 'application/json' }
  });

  const durationSync = await syncVideoDurationToDb({
    db: getVideoDatabaseBinding(env),
    videoId,
    durationSeconds
  });

  return json({
    ok: true,
    videoId,
    packaging: metadata.packaging,
    hlsMasterKey,
    dashManifestKey: resolvedDashManifestKey,
    variants,
    audioGroups: audioGroups.length > 0 ? audioGroups : undefined,
    metadataKey,
    processedAt,
    visibility,
    status: metadata.status,
    durationSeconds,
    durationSync
  });
}

async function syncVideoDurationToDb({ db, videoId, durationSeconds }) {
  if (!db) {
    return { updated: false, reason: 'missing-d1-binding' };
  }

  if (durationSeconds === null) {
    return { updated: false, reason: 'missing-duration-seconds' };
  }

  const normalizedDuration = Math.round(durationSeconds);
  const result = await db
    .prepare('UPDATE videos SET full_duration = ? WHERE id = ?')
    .bind(normalizedDuration, videoId)
    .run();

  return {
    updated: Number(result.meta?.changes || 0) > 0,
    changes: Number(result.meta?.changes || 0),
    durationSeconds: normalizedDuration
  };
}

function parseHlsMasterPlaylist(content) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const variants = [];
  const audioGroups = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attributes = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length));
      if (attributes.TYPE === 'AUDIO') {
        audioGroups.push({
          type: attributes.TYPE,
          groupId: attributes['GROUP-ID'] ?? null,
          name: attributes.NAME ?? null,
          language: attributes.LANGUAGE ?? null,
          default: attributes.DEFAULT === 'YES',
          autoselect: attributes.AUTOSELECT === 'YES',
          channels: attributes.CHANNELS ?? null,
          uri: attributes.URI ?? null
        });
      }
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attributes = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
      const nextLine = lines[i + 1];
      const uri = nextLine && !nextLine.startsWith('#') ? nextLine : null;

      variants.push({
        uri,
        bandwidth: toNumberOrNull(attributes.BANDWIDTH),
        averageBandwidth: toNumberOrNull(attributes['AVERAGE-BANDWIDTH']),
        codecs: attributes.CODECS ?? null,
        resolution: attributes.RESOLUTION ?? null,
        frameRate: toNumberOrNull(attributes['FRAME-RATE']),
        audioGroupId: attributes.AUDIO ?? null,
        subtitlesGroupId: attributes.SUBTITLES ?? null,
        closedCaptions: attributes['CLOSED-CAPTIONS'] ?? null
      });
    }
  }

  return { variants, audioGroups };
}

function parseAttributeList(rawAttributes) {
  const attributes = {};
  const regex = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/g;

  for (const match of rawAttributes.matchAll(regex)) {
    const key = match[1];
    const value = match[2];
    attributes[key] = stripQuotes(value);
  }

  return attributes;
}

function stripQuotes(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : null;
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

function getVideoDatabaseBinding(env) {
  return env.video_subscription_db || env.VIDEO_SUBSCRIPTION_DB || env.DB || null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
