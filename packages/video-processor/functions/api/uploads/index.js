const TUS_VERSION = '1.0.0';

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.VIDEO_BUCKET) {
    return json({ error: 'VIDEO_BUCKET binding is required' }, 500);
  }

  if (request.method === 'OPTIONS') {
    return tusResponse(null, 204);
  }

  if (request.method !== 'POST') {
    return tusResponse(null, 405, { 'Allow': 'POST,OPTIONS' });
  }

  const tusVersion = request.headers.get('Tus-Resumable');
  if (tusVersion !== TUS_VERSION) {
    return tusResponse(jsonString({ error: 'Missing or invalid Tus-Resumable header' }), 412);
  }

  const uploadLength = Number(request.headers.get('Upload-Length'));
  if (!Number.isFinite(uploadLength) || uploadLength <= 0) {
    return tusResponse(jsonString({ error: 'Upload-Length header is required and must be > 0' }), 400);
  }

  const metadata = parseUploadMetadata(request.headers.get('Upload-Metadata'));
  const fileName = sanitizeFileName(metadata.filename || 'upload.bin');
  const contentType = (metadata.filetype || 'application/octet-stream').toLowerCase();
  if (!contentType.startsWith('video/')) {
    return tusResponse(jsonString({ error: 'Only video uploads are allowed' }), 400);
  }

  const visibility = sanitizeVisibility(metadata.visibility);
  const videoId = crypto.randomUUID();
  const sourceKey = `videos/${videoId}/source/${fileName}`;
  const sessionKey = `videos/${videoId}/upload-session.json`;

  const multipartUpload = await env.VIDEO_BUCKET.createMultipartUpload(sourceKey, {
    httpMetadata: { contentType },
    customMetadata: {
      status: 'uploading',
      visibility,
      uploadedAt: new Date().toISOString()
    }
  });

  const session = {
    videoId,
    sourceKey,
    uploadId: multipartUpload.uploadId,
    uploadLength,
    offset: 0,
    partNumber: 1,
    parts: [],
    visibility,
    fileName,
    contentType,
    createdAt: new Date().toISOString()
  };

  await env.VIDEO_BUCKET.put(sessionKey, JSON.stringify(session), {
    httpMetadata: { contentType: 'application/json' }
  });

  return tusResponse(null, 201, {
    'Location': `/api/uploads/${videoId}`,
    'Upload-Offset': '0',
    'Upload-Length': String(uploadLength)
  });
}

function parseUploadMetadata(headerValue) {
  if (!headerValue) return {};
  const result = {};
  const entries = headerValue.split(',');

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [rawKey, rawValue] = trimmed.split(' ');
    if (!rawKey || !rawValue) continue;

    try {
      result[rawKey] = atob(rawValue);
    } catch {
      continue;
    }
  }

  return result;
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function sanitizeVisibility(value) {
  if (value === 'public' || value === 'unlisted') {
    return value;
  }
  return 'private';
}

function tusResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      'Tus-Resumable': TUS_VERSION,
      ...extraHeaders
    }
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function jsonString(data) {
  return JSON.stringify(data);
}
