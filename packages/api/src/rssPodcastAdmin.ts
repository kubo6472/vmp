/**
 * Admin-only webhook to notify a host-side script when preview podcast assets may need re-encoding
 * (e.g. after preview_duration changes). The Worker cannot run ffmpeg; the receiver runs on the media host.
 */

import { requireRole } from './auth.js'
import { ensureAdminSettingsTable } from './adminSettingsTable.js'
import { getSetting, setSettings } from './settingsStore.js'

function getDb(env: any) {
  const db = env.DB || env.video_subscription_db
  if (!db) throw new Error('D1 binding not found')
  return db
}

function jsonResponse(data: any, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('')
}

async function listPublishedVideosForRebuild(db: any) {
  try {
    const q = await db.prepare(`
      SELECT id, preview_duration, full_duration, updated_at
      FROM videos
      WHERE publish_status = 'published'
      ORDER BY datetime(published_at) DESC, datetime(upload_date) DESC
    `).all()
    return q.results || []
  } catch {
    const q = await db.prepare(`
      SELECT id, preview_duration, full_duration, updated_at
      FROM videos
      WHERE visibility = 'public'
      ORDER BY datetime(published_at) DESC, datetime(upload_date) DESC
    `).all()
    return q.results || []
  }
}

export async function handleRssPodcastWebhookConfig(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  try {
    const db = getDb(env)
    await ensureAdminSettingsTable(db)

    if (request.method === 'GET') {
      const [url, secretSet] = await Promise.all([
        getSetting(env, 'podcast_rebuild_webhook_url', { defaultValue: null }),
        getSetting(env, 'podcast_rebuild_webhook_secret_set', { defaultValue: null }),
      ])
      return jsonResponse({
        webhookUrl: typeof url === 'string' ? url : (url ?? ''),
        secretConfigured: secretSet === '1' || secretSet === 1,
      }, 200, corsHeaders)
    }

    if (request.method !== 'PATCH') {
      return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
    }

    const body = await request.json().catch(() => null)
    const rawUrl = typeof body?.webhookUrl === 'string' ? body.webhookUrl.trim() : ''
    const secretRaw = typeof body?.webhookSecret === 'string' ? body.webhookSecret : null

    let webhookUrl: string | null = rawUrl || null
    if (webhookUrl) {
      try {
        const u = new URL(webhookUrl)
        if (u.protocol !== 'https:' && u.protocol !== 'http:') {
          return jsonResponse({ error: 'webhookUrl must be http(s)' }, 400, corsHeaders)
        }
      } catch {
        return jsonResponse({ error: 'Invalid webhookUrl' }, 400, corsHeaders)
      }
    }

    const rows: [string, string][] = [['podcast_rebuild_webhook_url', webhookUrl ?? '']]
    if (secretRaw != null) {
      const trimmed = secretRaw.trim()
      if (trimmed.length === 0) {
        rows.push(['podcast_rebuild_webhook_secret', ''])
        rows.push(['podcast_rebuild_webhook_secret_set', '0'])
      } else if (trimmed.length < 16) {
        return jsonResponse({ error: 'webhookSecret must be at least 16 characters when set' }, 400, corsHeaders)
      } else {
        rows.push(['podcast_rebuild_webhook_secret', trimmed])
        rows.push(['podcast_rebuild_webhook_secret_set', '1'])
      }
    }

    await setSettings(env, rows)

    const configured = (await getSetting(env, 'podcast_rebuild_webhook_secret_set', { defaultValue: null })) === '1'
    return jsonResponse({
      ok: true,
      webhookUrl: webhookUrl ?? '',
      secretConfigured: configured,
    }, 200, corsHeaders)
  } catch (e) {
    console.error('handleRssPodcastWebhookConfig:', e)
    return jsonResponse({ error: 'Internal server error', code: 'internal_error' }, 500, corsHeaders)
  }
}

export async function handleRssPodcastPreviewRebuildNotify(request: any, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'admin', 'super_admin')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders)
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders)
  }

  try {
    const db = getDb(env)
    await ensureAdminSettingsTable(db)

    const webhookUrl = (await getSetting(env, 'podcast_rebuild_webhook_url', { defaultValue: '' }))?.trim()
    if (!webhookUrl) {
      return jsonResponse({ error: 'Podcast rebuild webhook URL is not configured', code: 'webhook_not_configured' }, 400, corsHeaders)
    }

    const secret = (await getSetting(env, 'podcast_rebuild_webhook_secret', { defaultValue: '' }))?.trim()
    if (!secret) {
      return jsonResponse({ error: 'Podcast rebuild webhook secret is not configured', code: 'secret_not_configured' }, 400, corsHeaders)
    }

    const body = await request.json().catch(() => ({}))
    const filterIds = Array.isArray(body?.videoIds)
      ? body.videoIds.filter((x: unknown) => typeof x === 'string' && x.trim()).map((x: string) => x.trim())
      : null

    let videos = await listPublishedVideosForRebuild(db)
    if (filterIds && filterIds.length) {
      const set = new Set(filterIds)
      videos = videos.filter((v: { id?: string }) => v?.id && set.has(v.id))
    }

    const payload = {
      event: 'podcast_preview_rebuild',
      sentAt: new Date().toISOString(),
      videos: videos.map((v: any) => ({
        id: v.id,
        previewDurationSeconds: Number(v.preview_duration) || 0,
        fullDurationSeconds: Number(v.full_duration) || 0,
        updatedAt: v.updated_at ?? null,
      })),
    }

    const rawBody = JSON.stringify(payload)
    const signature = await hmacSha256Hex(secret, rawBody)
    const ts = String(Math.floor(Date.now() / 1000))

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VMP-Signature': `sha256=${signature}`,
        'X-VMP-Timestamp': ts,
      },
      body: rawBody,
    })

    const text = await res.text().catch(() => '')
    if (!res.ok) {
      return jsonResponse({
        error: 'Webhook request failed',
        code: 'webhook_failed',
        status: res.status,
        detail: text.slice(0, 500),
      }, 502, corsHeaders)
    }

    return jsonResponse({ ok: true, delivered: true, videoCount: payload.videos.length }, 200, corsHeaders)
  } catch (e) {
    console.error('handleRssPodcastPreviewRebuildNotify:', e)
    return jsonResponse({ error: 'Internal server error', code: 'internal_error' }, 500, corsHeaders)
  }
}
