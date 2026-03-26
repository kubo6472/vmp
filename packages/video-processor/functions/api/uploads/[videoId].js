const TUS_VERSION = '1.0.0';

export async function onRequest(context) {
  const { request, env, params } = context;

  if (!env.VIDEO_BUCKET) {
    return json({ error: 'VIDEO_BUCKET binding is required' }, 500);
  }

  const videoId = params.videoId;
  if (!videoId) {
    return tusResponse(null, 400);
  }

  const sessionKey = `videos/${videoId}/upload-session.json`;

  if (request.method === 'OPTIONS') {
    return tusResponse(null, 204);
  }

  if (request.method === 'HEAD') {
    const session = await readSession(env, sessionKey);
    if (!session) return tusResponse(null, 404);

    return tusResponse(null, 200, {
      'Upload-Offset': String(session.offset),
      'Upload-Length': String(session.uploadLength)
    });
  }

  if (request.method === 'PATCH') {
    if (request.headers.get('Tus-Resumable') !== TUS_VERSION) {
      return tusResponse(null, 412);
    }

    const session = await readSession(env, sessionKey);
    if (!session) return tusResponse(null, 404);

    const requestedOffset = Number(request.headers.get('Upload-Offset'));
    if (!Number.isFinite(requestedOffset) || requestedOffset !== session.offset) {
      return tusResponse(null, 409, {
        'Upload-Offset': String(session.offset)
      });
    }

    const chunk = await request.arrayBuffer();
    if (!chunk.byteLength) {
      return tusResponse(null, 400);
    }

    if (session.offset + chunk.byteLength > session.uploadLength) {
      return tusResponse(null, 413);
    }

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
      await multipart.complete(session.parts.map(({ partNumber, etag }) => ({ partNumber, etag })));

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
      });
    }

    await env.VIDEO_BUCKET.put(sessionKey, JSON.stringify(session), {
      httpMetadata: { contentType: 'application/json' }
    });

    return tusResponse(null, 204, {
      'Upload-Offset': String(session.offset)
    });
  }

  return tusResponse(null, 405, { 'Allow': 'HEAD,PATCH,OPTIONS' });
}

async function readSession(env, key) {
  const obj = await env.VIDEO_BUCKET.get(key);
  if (!obj) return null;
  return obj.json();
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
