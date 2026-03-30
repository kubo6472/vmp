export async function onRequestOptions(context) {
  const corsHeaders = buildCorsHeaders(context.request);
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const corsHeaders = buildCorsHeaders(request);

  if (!env.VIDEO_BUCKET) {
    return json({ error: 'VIDEO_BUCKET binding is required' }, 500, corsHeaders);
  }

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

  return json({ videos: entries });
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
    if (object.key.endsWith('/hls/master.m3u8')) {
      entry.packaging.hasHlsMaster = true;
    }
    if (object.key.endsWith('/dash/manifest.mpd')) {
      entry.packaging.hasDashManifest = true;
    }
    if (object.key.endsWith('/playlist.m3u8')) {
      entry.packaging.hasLegacyPlaylist = true;
    }
    if (/\.m4s$|\.mp4$/i.test(object.key) && /\/processed\//.test(object.key)) {
      entry.packaging.hasVariantMedia = true;
    }
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

  entry.packaging.mode = hasModernPackaging
    ? 'modern'
    : entry.packaging.hasLegacyPlaylist
      ? 'legacy'
      : 'invalid';
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
  const hasHlsMaster = keys.has(hlsMasterKey);
  const hasDashManifest = keys.has(dashManifestKey);
  const hasLegacyPlaylist = keys.has(legacyPlaylistKey);
  const hasVariantMedia = allProcessedKeys.some((key) => variantMediaPattern.test(key));

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

function buildCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  return {
    hasHlsMaster,
    hasDashManifest,
    hasLegacyPlaylist,
    hasVariantMedia
  };
}

async function syncVideosTable(entries, env) {
  const db = getVideoDatabaseBinding(env);
  if (!db) {
    return;
  }

  for (const entry of entries) {
    const sourceName = entry.sourceKey?.split('/').pop() || entry.videoId;
    const title = sourceName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || `Uploaded video ${entry.videoId}`;
    const status = entry.needsProcessing ? 'uploaded' : 'processed';
    const now = entry.updatedAt || new Date().toISOString();

    await db.prepare(`
      INSERT INTO videos (
        id, title, description, thumbnail_url, full_duration, preview_duration, upload_date, created_at,
        source_key, visibility, status, updated_at, processed_at, managed_by_r2
      )
      VALUES (?, ?, '', NULL, 0, 0, ?, COALESCE((SELECT created_at FROM videos WHERE id = ?), ?), ?, ?, ?, ?,
        CASE WHEN ? = 'processed' THEN ? ELSE NULL END,
        1
      )
      ON CONFLICT(id) DO UPDATE SET
        title = CASE WHEN videos.managed_by_r2 = 1 OR videos.title IS NULL OR videos.title = '' THEN excluded.title ELSE videos.title END,
        source_key = excluded.source_key,
        visibility = excluded.visibility,
        status = excluded.status,
        updated_at = excluded.updated_at,
        processed_at = CASE
          WHEN excluded.status = 'processed' THEN COALESCE(videos.processed_at, excluded.processed_at)
          ELSE NULL
        END,
        managed_by_r2 = 1
    `).bind(
      entry.videoId,
      title,
      now,
      entry.videoId,
      now,
      entry.sourceKey,
      entry.visibility,
      status,
      now,
      status,
      now
    ).run();
  }

  if (!entries.length) {
    await db.prepare('DELETE FROM videos WHERE managed_by_r2 = 1').run();
    return;
  }

  const placeholders = entries.map(() => '?').join(',');
  const statement = db.prepare(`DELETE FROM videos WHERE managed_by_r2 = 1 AND id NOT IN (${placeholders})`).bind(
    ...entries.map((entry) => entry.videoId)
  );
  await statement.run();
}

function getVideoDatabaseBinding(env) {
  return env.video_subscription_db || env.VIDEO_SUBSCRIPTION_DB || env.DB || null;
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

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      ...extraHeaders
    }
  });
}
