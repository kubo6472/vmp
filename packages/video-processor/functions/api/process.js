export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return withCors(new Response(null, { status: 204 }), request);
  }

  if (request.method !== 'POST') {
    return withCors(json({ error: 'Method not allowed' }, 405), request);
  }

  if (!env.VIDEO_BUCKET) {
    return withCors(json({ error: 'VIDEO_BUCKET binding is required' }, 500), request);
  }

  try {
    const body = await request.json().catch(() => null);
    if (!body?.videoId) {
      return withCors(json({ error: 'videoId is required' }, 400), request);
    }

    const videoId = body.videoId;
    const visibility = sanitizeVisibility(body.visibility);
    const validateDash = Boolean(body.validateDash);

    const metadataKey = `videos/${videoId}/metadata.json`;
    const processedAt = new Date().toISOString();

    const existingMetadataObject = await env.VIDEO_BUCKET.get(metadataKey);
    const existingMetadata = existingMetadataObject
      ? await existingMetadataObject.json().catch(() => null)
      : null;
    let durationSeconds = toNumberOrNull(existingMetadata?.durationSeconds);

    // Try flat layout (shell-script output) first, then the processed/hls/ path
    const hlsMasterCandidates = [
      `videos/${videoId}/master.m3u8`,
      `videos/${videoId}/processed/hls/master.m3u8`,
    ];
    let hlsMasterKey = null;
    let hlsMaster = null;
    for (const candidate of hlsMasterCandidates) {
      const obj = await env.VIDEO_BUCKET.get(candidate);
      if (obj) { hlsMasterKey = candidate; hlsMaster = obj; break; }
    }
    if (!hlsMaster) {
      return withCors(json({ error: `Missing required HLS master playlist. Tried: ${hlsMasterCandidates.join(', ')}` }, 404), request);
    }

    const hlsMasterContent = await hlsMaster.text();
    const { variants, audioGroups } = parseHlsMasterPlaylist(hlsMasterContent);

    // Derive duration by summing #EXTINF from the first variant media playlist
    // when metadata.json has no durationSeconds (e.g. shell-script uploads)
    if (durationSeconds === null && variants.length > 0) {
      const firstUri = variants[0].uri;
      if (firstUri) {
        const masterDir = hlsMasterKey.slice(0, hlsMasterKey.lastIndexOf('/') + 1);
        const variantKey = firstUri.startsWith('videos/') ? firstUri : `${masterDir}${firstUri}`;
        const variantObj = await env.VIDEO_BUCKET.get(variantKey);
        if (variantObj) {
          const text = await variantObj.text();
          const total = text.split('\n')
            .filter(l => l.trim().startsWith('#EXTINF:'))
            .reduce((s, l) => {
              const n = Number.parseFloat(l.trim().slice('#EXTINF:'.length));
              return Number.isFinite(n) ? s + n : s;
            }, 0);
          if (total > 0) durationSeconds = total;
        }
      }
    }

    // Try flat layout for DASH manifest, then processed/dash/
    const dashManifestCandidates = [
      `videos/${videoId}/manifest.mpd`,
      `videos/${videoId}/processed/dash/manifest.mpd`,
    ];
    let dashManifestKey = null;
    for (const c of dashManifestCandidates) {
      const obj = await env.VIDEO_BUCKET.get(c);
      if (obj) { dashManifestKey = c; break; }
    }
    const dashManifest = dashManifestKey ? true : null;
    if (validateDash && !dashManifest) {
      return withCors(json({ error: `DASH validation requested but manifest not found. Tried: ${dashManifestCandidates.join(', ')}` }, 404), request);
    }

    const resolvedDashManifestKey = dashManifestKey ?? null;

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

    if (durationSeconds !== null) metadata.durationSeconds = durationSeconds;
    if (audioGroups.length > 0) metadata.audioGroups = audioGroups;

    await env.VIDEO_BUCKET.put(metadataKey, JSON.stringify(metadata, null, 2), {
      httpMetadata: { contentType: 'application/json' }
    });

    const durationSync = await syncVideoDurationToDb({ db: getVideoDatabaseBinding(env), videoId, durationSeconds });

    return withCors(json({
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
    }), request);
  } catch (error) {
    console.error('Failed to process video metadata registration', error);
    return withCors(json({ error: 'Failed to process video', details: String(error?.message || error) }, 500), request);
  }
}

async function syncVideoDurationToDb({ db, videoId, durationSeconds }) {
  if (!db) return { updated: false, reason: 'missing-d1-binding' };
  if (durationSeconds === null) return { updated: false, reason: 'missing-duration-seconds' };

  const normalizedDuration = Math.round(durationSeconds);
  const result = await db.prepare('UPDATE videos SET full_duration = ? WHERE id = ?').bind(normalizedDuration, videoId).run();

  return {
    updated: Number(result.meta?.changes || 0) > 0,
    changes: Number(result.meta?.changes || 0),
    durationSeconds: normalizedDuration
  };
}

function parseHlsMasterPlaylist(content) {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
  for (const match of rawAttributes.matchAll(regex)) attributes[match[1]] = stripQuotes(match[2]);
  return attributes;
}

function stripQuotes(value) {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function sanitizeVisibility(value) {
  return value === 'public' || value === 'unlisted' ? value : 'private';
}

function getVideoDatabaseBinding(env) {
  return env.video_subscription_db || env.VIDEO_SUBSCRIPTION_DB || env.DB || null;
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get('Origin');
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Vary', 'Origin');
  } else {
    headers.set('Access-Control-Allow-Origin', '*');
  }
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
