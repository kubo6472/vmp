export async function onRequestGet(context) {
  const { env } = context;

  if (!env.VIDEO_BUCKET) {
    return json({ error: 'VIDEO_BUCKET binding is required' }, 500);
  }

  const result = await env.VIDEO_BUCKET.list({ prefix: 'videos/', limit: 1000 });
  const metadataObjects = result.objects.filter((object) => object.key.endsWith('/metadata.json'));

  const videos = [];
  for (const object of metadataObjects) {
    const record = await env.VIDEO_BUCKET.get(object.key);
    if (!record) continue;

    const meta = await record.json();
    videos.push({
      videoId: meta.videoId,
      status: meta.status ?? 'unknown',
      visibility: meta.visibility ?? 'private',
      updatedAt: meta.processedAt ?? object.uploaded
    });
  }

  videos.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return json({ videos });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
