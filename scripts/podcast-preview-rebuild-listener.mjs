#!/usr/bin/env node
/**
 * Local HTTP webhook receiver for POST /api/admin/rss/podcast-preview-rebuild notifications.
 *
 * Verifies HMAC-SHA256 of the raw body (header X-VMP-Signature: sha256=<hex>).
 * Runs scripts/render_podcast_preview_mp3.sh per video (async, best-effort).
 *
 * Environment:
 *   VMP_WEBHOOK_SECRET   — same secret stored in admin_settings (required)
 *   LISTEN_HOST          — default 127.0.0.1
 *   LISTEN_PORT          — default 8788
 *   RENDER_SCRIPT        — path to render_podcast_preview_mp3.sh (default: ../scripts relative to cwd)
 *   R2_BUCKET            — passed to the shell script
 *
 * Example:
 *   VMP_WEBHOOK_SECRET='...' node scripts/podcast-preview-rebuild-listener.mjs
 *
 * Replace later with a proper service (queue, retries, metrics) without changing the Worker contract.
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const defaultScript = path.join(__dirname, 'render_podcast_preview_mp3.sh')

const secret = process.env.VMP_WEBHOOK_SECRET?.trim()
if (!secret) {
  console.error('VMP_WEBHOOK_SECRET is required')
  process.exit(1)
}

const host = process.env.LISTEN_HOST || '127.0.0.1'
const port = Number.parseInt(process.env.LISTEN_PORT || '8788', 10)
const renderScript = process.env.RENDER_SCRIPT || defaultScript

function verifySignature(rawBody, sigHeader) {
  if (!sigHeader || typeof sigHeader !== 'string') return false
  const m = sigHeader.match(/^sha256=([0-9a-f]{64})$/i)
  if (!m) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const a = Buffer.from(m[1], 'hex')
  const b = Buffer.from(expected, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function runRender(videoId, previewSeconds) {
  return new Promise((resolve) => {
    const child = spawn(
      'bash',
      [renderScript, videoId, String(previewSeconds)],
      {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let err = ''
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, code, err: err.slice(-2000) })
    })
  })
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method not allowed' }))
    return
  }

  const chunks = []
  for await (const c of req) chunks.push(c)
  const rawBody = Buffer.concat(chunks)

  const sig = req.headers['x-vmp-signature']
  if (!verifySignature(rawBody, Array.isArray(sig) ? sig[0] : sig)) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid signature' }))
    return
  }

  let payload
  try {
    payload = JSON.parse(rawBody.toString('utf8'))
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON' }))
    return
  }

  if (payload?.event !== 'podcast_preview_rebuild') {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unexpected event' }))
    return
  }

  const videos = Array.isArray(payload.videos) ? payload.videos : []
  res.writeHead(202, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, accepted: videos.length }))

  for (const v of videos) {
    const id = v?.id
    const sec = Number(v?.previewDurationSeconds)
    if (!id || !Number.isFinite(sec) || sec <= 0) continue
    const r = await runRender(id, Math.floor(sec))
    if (!r.ok) {
      console.error(`[podcast-preview] ${id} failed:`, r)
    } else {
      console.log(`[podcast-preview] ${id} ok (${sec}s)`)
    }
  }
})

server.listen(port, host, () => {
  console.log(`podcast-preview-rebuild listener on http://${host}:${port}`)
})
