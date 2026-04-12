const TUS_VERSION = '1.0.0';

export async function onRequest(context: any) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') {
    return tusResponse(null, 204, {}, request);
  }

  if (!env.VIDEO_BUCKET) {
    return json({ error: 'VIDEO_BUCKET binding is required' }, 500, request);
  }

  const videoId = params.videoId;
  if (!videoId) {
    return tusResponse(null, 400, {}, request);
  }

  const sessionKey = `videos/${videoId}/upload-session.json`;

  if (request.method === 'HEAD') {
    const session = await readSession(env, sessionKey);
    if (!session) return tusResponse(null, 404, {}, request);

    return tusResponse(null, 200, {
      'Upload-Offset': String(session.offset),
      'Upload-Length': String(session.uploadLength)
    }, request);
  }

  if (request.method === 'PATCH') {
    if (request.headers.get('Tus-Resumable') !== TUS_VERSION) {
      return tusResponse(null, 412, {}, request);
    }

    const session = await readSession(env, sessionKey);
    if (!session) return tusResponse(null, 404, {}, request);

    const requestedOffset = Number(request.headers.get('Upload-Offset'));
    if (!Number.isFinite(requestedOffset) || requestedOffset !== session.offset) {
      return tusResponse(null, 409, { 'Upload-Offset': String(session.offset) }, request);
    }

    const chunk = await request.arrayBuffer();
    if (!chunk.byteLength) return tusResponse(null, 400, {}, request);
    if (session.offset + chunk.byteLength > session.uploadLength) return tusResponse(null, 413, {}, request);

    const multipart = env.VIDEO_BUCKET.resumeMultipartUpload(session.sourceKey, session.uploadId);
    const uploadedPart = await multipart.uploadPart(session.partNumber, chunk);

    session.parts.push({
      partNumber: session.partNumber,
      etag: uploadedPart.etag,
      size: chunk.byteLength
    });

    session.partNumber += 1;
    session.offset += chunk.byteLength;

    if (session.offset === session.uploadLength) {
      await multipart.complete(session.parts.map(({
        partNumber,
        etag
      }: any) => ({ partNumber, etag })));
      await env.VIDEO_BUCKET.delete(sessionKey);

      return tusResponse(null, 204, {
        'Upload-Offset': String(session.offset),
        'Upload-Complete': '?1',
        'Upload-Result': JSON.stringify({
          ok: true,
          videoId,
          fileName: session.fileName,
          sourceKey: session.sourceKey,
          visibility: session.visibility
        })
      }, request);
    }

    await env.VIDEO_BUCKET.put(sessionKey, JSON.stringify(session), {
      httpMetadata: { contentType: 'application/json' }
    });

    return tusResponse(null, 204, { 'Upload-Offset': String(session.offset) }, request);
  }

  return tusResponse(null, 405, { Allow: 'HEAD,PATCH,OPTIONS' }, request);
}

async function readSession(env: any, key: any) {
  const obj = await env.VIDEO_BUCKET.get(key);
  if (!obj) return null;
  return obj.json();
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
  headers.set('Access-Control-Allow-Methods', 'HEAD,PATCH,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Tus-Resumable, Upload-Length, Upload-Offset, Upload-Metadata');
  headers.set('Access-Control-Expose-Headers', 'Tus-Resumable, Upload-Offset, Upload-Length, Upload-Complete, Upload-Result');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
