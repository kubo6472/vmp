const ALLOWED_VIDEO_MIME_PREFIX = 'video/';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.VIDEO_BUCKET) {
    return json({ error: 'VIDEO_BUCKET binding is required' }, 500);
  }

  const form = await request.formData();
  const file = form.get('file');
  const visibility = sanitizeVisibility(form.get('visibility'));

  if (!file || typeof file === 'string') {
    return json({ error: 'Expected multipart form file' }, 400);
  }

  if (!file.type?.startsWith(ALLOWED_VIDEO_MIME_PREFIX)) {
    return json({ error: 'Only video file uploads are allowed' }, 400);
  }

  const videoId = crypto.randomUUID();
  const safeFileName = file.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const sourceKey = `videos/${videoId}/source/${safeFileName}`;

  await env.VIDEO_BUCKET.put(sourceKey, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: {
      status: 'uploaded',
      visibility,
      uploadedAt: new Date().toISOString()
    }
  });

  return json({
    ok: true,
    videoId,
    fileName: safeFileName,
    sourceKey,
    visibility
  });
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
