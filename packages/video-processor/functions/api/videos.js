export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return withCors(new Response(null, { status: 204 }), request);
  }

  if (request.method !== 'GET') {
    return withCors(json({ error: 'Method not allowed' }, 405), request);
  }

  if (!env.VIDEO_BUCKET) {
    return withCors(json({ error: 'VIDEO_BUCKET binding is required' }, 500), request);
  }

  try {
    const objects = await listAllVideoObjects(env.VIDEO_BUCKET);
    const byVideoId = new Map();

    for (const object of objects) {
      const videoId = getVideoIdFromKey(object.key);
      if (!videoId) continue;

      const entry = byVideoId.get(videoId) ?? newVideoEntry(videoId);
      hydrateVideoEntry(entry, object);
      byVideoId.set(videoId, entry);
    }

    await hydrateMetadata(byVideoId, env);

    const entries = Array.from(byVideoId.values())
      .filter((entry) => entry.hasSource || entry.hasAnyProcessedArtifact)
      .map((entry) => {
        const hasPlaylist = entry.packaging.hasHlsMaster || entry.packaging.hasLegacyPlaylist;
        const needsProcessing = entry.hasSource && !hasPlaylist;
        return {
          videoId: entry.videoId,
          status: hasPlaylist ? 'processed' : 'uploaded',
          needsProcessing,
          packaging: entry.packaging,
          visibility: entry.visibility ?? 'private',
          sourceKey: entry.sourceKey,
          updatedAt: entry.updatedAt
        };
      });

    await syncVideosTable(entries, env);

    entries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    return withCors(json({ videos: entries }), request);
  } catch (error) {
    console.error('Failed to build admin videos inventory', error);
    return withCors(json({ error: 'Failed to load videos', details: String(error?.message || error) }, 500), request);
  }
}

async function listAllVideoObjects(bucket) {
  const objects = [];
  let cursor = undefined;

  do {
    const result = await bucket.list({ prefix: 'videos/', limit: 1000, cursor });
    objects.push(...result.objects);
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  return objects;
}

function newVideoEntry(videoId) {
  return {
    videoId,
    hasSource: false,
    hasAnyProcessedArtifact: false,
    sourceKey: null,
    visibility: null,
    updatedAt: null,
    packaging: {
      mode: 'invalid',
      isValid: false,
      hasHlsMaster: false,
      hasDashManifest: false,
      hasLegacyPlaylist: false,
      hasVariantMedia: false
    }
  };
}

function hydrateVideoEntry(entry, object) {
  const sourcePrefix = `videos/${entry.videoId}/source/`;
  const processedPrefix = `videos/${entry.videoId}/processed/`;

  if (object.key.startsWith(sourcePrefix)) {
    entry.hasSource = true;
    if (!entry.sourceKey || object.key < entry.sourceKey) {
      entry.sourceKey = object.key;
    }
  }

  if (object.key.startsWith(processedPrefix)) {
    entry.hasAnyProcessedArtifact = true;
    if (object.key.endsWith('/hls/master.m3u8')) entry.packaging.hasHlsMaster = true;
    if (object.key.endsWith('/dash/manifest.mpd')) entry.packaging.hasDashManifest = true;
    if (object.key.endsWith('/playlist.m3u8')) entry.packaging.hasLegacyPlaylist = true;
    if (/\.m4s$|\.mp4$/i.test(object.key) && /\/processed\//.test(object.key)) entry.packaging.hasVariantMedia = true;
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
    if (!metadataObject) {
      finalizePackaging(entry);
      continue;
    }

    const metadata = await metadataObject.json().catch(() => null);
    if (!metadata) {
      finalizePackaging(entry);
      continue;
    }

    if (metadata.visibility === 'public' || metadata.visibility === 'unlisted' || metadata.visibility === 'private') {
      entry.visibility = metadata.visibility;
    }

    if (metadata.processedAt) {
      entry.updatedAt = maxDate(entry.updatedAt, metadata.processedAt);
    }

    const metadataPackaging = getPackagingStateFromMetadata(metadata, entry.videoId);
    entry.packaging.hasHlsMaster ||= metadataPackaging.hasHlsMaster;
    entry.packaging.hasDashManifest ||= metadataPackaging.hasDashManifest;
    entry.packaging.hasLegacyPlaylist ||= metadataPackaging.hasLegacyPlaylist;
    entry.packaging.hasVariantMedia ||= metadataPackaging.hasVariantMedia;

    finalizePackaging(entry);
  }
}

function finalizePackaging(entry) {
  const hasModernPackaging = entry.packaging.hasHlsMaster && entry.packaging.hasVariantMedia;
  const isValid = hasModernPackaging || entry.packaging.hasLegacyPlaylist;
  entry.packaging.mode = hasModernPackaging ? 'modern' : entry.packaging.hasLegacyPlaylist ? 'legacy' : 'invalid';
  entry.packaging.isValid = isValid;
}

function getPackagingStateFromMetadata(metadata, videoId) {
  const processedPrefix = `videos/${videoId}/processed/`;
  const hlsMasterKey = `${processedPrefix}hls/master.m3u8`;
  const dashManifestKey = `${processedPrefix}dash/manifest.mpd`;
  const legacyPlaylistKey = `${processedPrefix}playlist.m3u8`;
  const variantMediaPattern = new RegExp(`^videos/${escapeRegExp(videoId)}/processed/[^/]+/.+(?:\\.m4s|\\.mp4)$`);

  const allProcessedKeys = Array.from(collectStringValues(metadata)).filter((value) => value.startsWith(processedPrefix));

  const keys = new Set(allProcessedKeys);
  return {
    hasHlsMaster: keys.has(hlsMasterKey),
    hasDashManifest: keys.has(dashManifestKey),
    hasLegacyPlaylist: keys.has(legacyPlaylistKey),
    hasVariantMedia: allProcessedKeys.some((key) => variantMediaPattern.test(key))
  };
}

async function syncVideosTable(entries, env) {
  const db = getVideoDatabaseBinding(env);
  if (!db) return;

  try {
    const columnSet = await getVideosTableColumnSet(db);
    if (!columnSet.size) return;

    for (const entry of entries) {
      await upsertVideoRow(db, entry, columnSet);
    }

    if (columnSet.has('managed_by_r2')) {
      if (!entries.length) {
        await db.prepare('DELETE FROM videos WHERE managed_by_r2 = 1').run();
      } else {
        const placeholders = entries.map(() => '?').join(',');
        await db.prepare(`DELETE FROM videos WHERE managed_by_r2 = 1 AND id NOT IN (${placeholders})`)
          .bind(...entries.map((entry) => entry.videoId))
          .run();
      }
    }
  } catch (error) {
    console.error('Video D1 sync skipped due to error', error);
  }
}

async function getVideosTableColumnSet(db) {
  const result = await db.prepare('PRAGMA table_info(videos)').all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  return new Set(rows.map((row) => row?.name).filter(Boolean));
}

async function upsertVideoRow(db, entry, columnSet) {
  const sourceName = entry.sourceKey?.split('/').pop() || entry.videoId;
  const inferredTitle = sourceName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || `Uploaded video ${entry.videoId}`;
  const status = entry.needsProcessing ? 'uploaded' : 'processed';
  const now = entry.updatedAt || new Date().toISOString();

  const insertColumns = ['id', 'title', 'description', 'thumbnail_url', 'full_duration', 'preview_duration', 'upload_date', 'created_at'];
  const insertValues = ['?', '?', "''", 'NULL', '0', '0', '?', "COALESCE((SELECT created_at FROM videos WHERE id = ?), ?)"];
  const bindValues = [entry.videoId, inferredTitle, now, entry.videoId, now];

  if (columnSet.has('source_key')) {
    insertColumns.push('source_key');
    insertValues.push('?');
    bindValues.push(entry.sourceKey);
  }
  if (columnSet.has('visibility')) {
    insertColumns.push('visibility');
    insertValues.push('?');
    bindValues.push(entry.visibility);
  }
  if (columnSet.has('status')) {
    insertColumns.push('status');
    insertValues.push('?');
    bindValues.push(status);
  }
  if (columnSet.has('updated_at')) {
    insertColumns.push('updated_at');
    insertValues.push('?');
    bindValues.push(now);
  }
  if (columnSet.has('processed_at')) {
    insertColumns.push('processed_at');
    insertValues.push(status === 'processed' ? '?' : 'NULL');
    if (status === 'processed') bindValues.push(now);
  }
  if (columnSet.has('managed_by_r2')) {
    insertColumns.push('managed_by_r2');
    insertValues.push('1');
  }

  const updates = [
    "title = CASE WHEN videos.title IS NULL OR videos.title = '' THEN excluded.title ELSE videos.title END",
    'upload_date = excluded.upload_date'
  ];

  if (columnSet.has('source_key')) updates.push('source_key = excluded.source_key');
  if (columnSet.has('visibility')) updates.push('visibility = excluded.visibility');
  if (columnSet.has('status')) updates.push('status = excluded.status');
  if (columnSet.has('updated_at')) updates.push('updated_at = excluded.updated_at');
  if (columnSet.has('processed_at')) {
    updates.push("processed_at = CASE WHEN excluded.status = 'processed' THEN COALESCE(videos.processed_at, excluded.processed_at) ELSE NULL END");
  }
  if (columnSet.has('managed_by_r2')) updates.push('managed_by_r2 = 1');

  const sql = `
    INSERT INTO videos (${insertColumns.join(', ')})
    VALUES (${insertValues.join(', ')})
    ON CONFLICT(id) DO UPDATE SET ${updates.join(',\n      ')}
  `;

  await db.prepare(sql).bind(...bindValues).run();
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

  headers.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Tus-Resumable, Upload-Length, Upload-Offset, Upload-Metadata');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
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
