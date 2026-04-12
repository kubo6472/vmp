const TUS_VERSION = '1.0.0';

export async function onRequest(context: any) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return tusResponse(null, 204, {}, request);
  }

  if (!env.VIDEO_BUCKET) {
    return json({ error: 'VIDEO_BUCKET binding is required' }, 500, request);
  }

  if (request.method !== 'POST') {
    return tusResponse(null, 405, { Allow: 'POST,OPTIONS' }, request);
  }

  const tusVersion = request.headers.get('Tus-Resumable');
  if (tusVersion !== TUS_VERSION) {
    return tusResponse(jsonString({ error: 'Missing or invalid Tus-Resumable header' }), 412, {}, request);
  }

  const uploadLength = Number(request.headers.get('Upload-Length'));
  if (!Number.isFinite(uploadLength) || uploadLength <= 0) {
    return tusResponse(jsonString({ error: 'Upload-Length header is required and must be > 0' }), 400, {}, request);
  }

  const metadata = parseUploadMetadata(request.headers.get('Upload-Metadata'));
  // @ts-expect-error TS(2339): Property 'filename' does not exist on type '{}'.
  const fileName = sanitizeFileName(metadata.filename || 'upload.bin');
  // @ts-expect-error TS(2339): Property 'filetype' does not exist on type '{}'.
  const contentType = (metadata.filetype || 'application/octet-stream').toLowerCase();
  if (!contentType.startsWith('video/')) {
    return tusResponse(jsonString({ error: 'Only video uploads are allowed' }), 400, {}, request);
  }

  // @ts-expect-error TS(2339): Property 'visibility' does not exist on type '{}'.
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
    Location: `/api/uploads/${videoId}`,
    'Upload-Offset': '0',
    'Upload-Length': String(uploadLength)
  }, request);
}

function parseUploadMetadata(headerValue: any) {
  if (!headerValue) return {};
  const result = {};
  const entries = headerValue.split(',');

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [rawKey, rawValue] = trimmed.split(' ');
    if (!rawKey || !rawValue) continue;

    try {
      // @ts-expect-error TS(7053): Element implicitly has an 'any' type because expre... Remove this comment to see the full error message
      result[rawKey] = atob(rawValue);
    } catch {
      continue;
    }
  }

  return result;
}

function sanitizeFileName(name: any) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function sanitizeVisibility(value: any) {
  return value === 'public' || value === 'unlisted' ? value : 'private';
}

function tusResponse(body: any, status = 200, extraHeaders = {}, request: any) {
  return withCors(new Response(body, {
    status,
    headers: {
      'Tus-Resumable': TUS_VERSION,
      ...extraHeaders
    }
  }), request);
}

function json(data: any, status = 200, request: any) {
  return withCors(new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  }), request);
}

function withCors(response: any, request: any) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get('Origin');
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Vary', 'Origin');
  } else {
    headers.set('Access-Control-Allow-Origin', '*');
  }
  headers.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Tus-Resumable, Upload-Length, Upload-Offset, Upload-Metadata');
  headers.set('Access-Control-Expose-Headers', 'Tus-Resumable, Upload-Offset, Upload-Length, Location, Upload-Complete, Upload-Result');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonString(data: any) {
  return JSON.stringify(data);
}
