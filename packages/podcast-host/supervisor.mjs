#!/usr/bin/env node
/**
 * VMP media host supervisor: runs video_pipeline_watch.sh, serves local dashboard + webhook API.
 *
 * Environment:
 *   VMP_WEBHOOK_SECRET     — HMAC secret (same as admin_settings); required unless VMP_REQUIRE_WEBHOOK_SECRET=0
 *   VMP_UI_HOST            — default 127.0.0.1
 *   VMP_UI_PORT            — default 8788
 *   VMP_PIPELINE_SCRIPT    — default: bin/video_pipeline_watch.sh next to this file
 *   VMP_RUN_PIPELINE       — default 1; set 0 to only run UI + preview jobs (no watchfolder)
 *   VMP_PREVIEW_CONCURRENCY — max concurrent preview encodes (default 1)
 *
 * Systemd: one unit runs this process; it spawns the bash pipeline as a child.
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = __dirname

const pipelineScript = process.env.VMP_PIPELINE_SCRIPT || path.join(pkgRoot, 'bin', 'video_pipeline_watch.sh')
const renderScript = process.env.VMP_RENDER_SCRIPT || path.join(pkgRoot, 'render_podcast_preview_mp3.sh')

const requireWebhookSecret = process.env.VMP_REQUIRE_WEBHOOK_SECRET !== '0'
const secret = process.env.VMP_WEBHOOK_SECRET?.trim()
if (requireWebhookSecret && !secret) {
  console.error('[vmp-podcast-host] Set VMP_WEBHOOK_SECRET or VMP_REQUIRE_WEBHOOK_SECRET=0')
  process.exit(1)
}

const uiHost = process.env.VMP_UI_HOST || '127.0.0.1'
const uiPort = Number.parseInt(process.env.VMP_UI_PORT || '8788', 10)
const runPipeline = process.env.VMP_RUN_PIPELINE !== '0'
const previewConcurrency = Math.max(1, Number.parseInt(process.env.VMP_PREVIEW_CONCURRENCY || '1', 10) || 1)
const MAX_BODY_SIZE = 10 * 1024 * 1024 // 10 MB

/** @type {{ id: string, type: string, videoId?: string, status: string, detail?: string, startedAt?: string, finishedAt?: string }[]} */
const jobs = []
/** @type {string[]} */
const logLines = []
const MAX_LOG = 400

function pushLog(line) {
  const ts = new Date().toISOString()
  const s = `[${ts}] ${line}`
  console.log(s)
  logLines.push(s)
  while (logLines.length > MAX_LOG) logLines.shift()
}

/** @type {{ pid: number|null, startedAt: string|null, exited: boolean, code: number|null, signal: string|null }} */
const pipelineState = {
  pid: null,
  startedAt: null,
  exited: false,
  code: null,
  signal: null,
}

let pipelineChild = null

function startPipeline() {
  if (!runPipeline) {
    pushLog('Pipeline disabled (VMP_RUN_PIPELINE=0)')
    return
  }
  if (!fs.existsSync(pipelineScript)) {
    pushLog(`ERROR: pipeline script missing: ${pipelineScript}`)
    return
  }
  pipelineChild = spawn('bash', [pipelineScript], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipelineState.pid = pipelineChild.pid ?? null
  pipelineState.startedAt = new Date().toISOString()
  pipelineState.exited = false
  pipelineState.code = null
  pipelineState.signal = null
  pushLog(`Started pipeline pid=${pipelineState.pid} (${pipelineScript})`)

  const onData = (buf, stream) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (line.trim()) pushLog(`[pipeline] ${line}`)
    }
  }
  pipelineChild.stdout?.on('data', (d) => onData(d, 'out'))
  pipelineChild.stderr?.on('data', (d) => onData(d, 'err'))
  pipelineChild.on('error', (err) => {
    pushLog(`Pipeline spawn error: ${err.message}`)
  })
  pipelineChild.on('close', (code, signal) => {
    pipelineState.exited = true
    pipelineState.code = code
    pipelineState.signal = signal ?? null
    pushLog(`Pipeline exited code=${code} signal=${signal ?? ''}`)
    pipelineChild = null
    pipelineState.pid = null
    if (runPipeline) {
      pushLog('Pipeline process exited; supervisor exiting for systemd restart')
      process.exit(1)
    }
  })
}

let previewRunning = 0
const previewQueue = []
/** @type {Set<import('node:child_process').ChildProcess>} */
const previewChildren = new Set()

function enqueuePreview(videoId, previewSeconds, source = 'webhook') {
  const id = crypto.randomUUID()
  jobs.unshift({
    id,
    type: 'preview_mp3',
    videoId,
    status: 'queued',
    detail: `${previewSeconds}s`,
    source,
    startedAt: undefined,
    finishedAt: undefined,
  })
  trimJobs()
  previewQueue.push({ id, videoId, previewSeconds })
  drainPreviewQueue()
  return id
}

function trimJobs() {
  while (jobs.length > 200) jobs.pop()
}

function drainPreviewQueue() {
  while (previewRunning < previewConcurrency && previewQueue.length) {
    const task = previewQueue.shift()
    if (!task) break
    previewRunning++
    const row = jobs.find((j) => j.id === task.id)
    if (row) {
      row.status = 'running'
      row.startedAt = new Date().toISOString()
    }
    const child = spawn('bash', [renderScript, task.videoId, String(task.previewSeconds)], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    previewChildren.add(child)
    let err = ''
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('close', (code) => {
      previewChildren.delete(child)
      previewRunning--
      const r = jobs.find((j) => j.id === task.id)
      if (r) {
        r.status = code === 0 ? 'done' : 'failed'
        r.finishedAt = new Date().toISOString()
        if (code !== 0) r.detail = `${task.previewSeconds}s — ${err.slice(-400) || `exit ${code}`}`
      }
      pushLog(
        code === 0
          ? `Preview MP3 ok: ${task.videoId} (${task.previewSeconds}s)`
          : `Preview MP3 FAILED: ${task.videoId} (${task.previewSeconds}s) ${err.slice(-200)}`,
      )
      drainPreviewQueue()
    })
    child.on('error', () => {
      previewChildren.delete(child)
    })
  }
}

function verifySignature(rawBody, sigHeader, ts) {
  if (!secret) return false
  if (!sigHeader || typeof sigHeader !== 'string') return false
  if (!ts || typeof ts !== 'string') return false
  const m = sigHeader.match(/^sha256=([0-9a-f]{64})$/i)
  if (!m) return false
  const signedPayload = `${ts}.${rawBody}`
  const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex')
  const a = Buffer.from(m[1], 'hex')
  const b = Buffer.from(expected, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj, null, 2))
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>VMP media host</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1.5rem; background: #0f172a; color: #e2e8f0; }
    h1 { font-size: 1.25rem; }
    section { margin: 1rem 0; padding: 1rem; background: #1e293b; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #334155; }
    .ok { color: #4ade80; }
    .fail { color: #f87171; }
    .run { color: #fbbf24; }
    pre { white-space: pre-wrap; word-break: break-word; font-size: 0.75rem; max-height: 16rem; overflow: auto; background: #0f172a; padding: 0.75rem; border-radius: 6px; }
    code { font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>VMP media host</h1>
  <p>Local observability for <code>video_pipeline_watch</code> and preview MP3 jobs. Refreshes every 3s.</p>
  <section>
    <h2>Pipeline</h2>
    <div id="pipeline">Loading…</div>
  </section>
  <section>
    <h2>Jobs (preview MP3)</h2>
    <div id="jobs">Loading…</div>
  </section>
  <section>
    <h2>Recent log</h2>
    <pre id="log">Loading…</pre>
  </section>
  <script>
    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }
    async function tick() {
      try {
        const r = await fetch('/api/status')
        const d = await r.json()
        const p = d.pipeline || {}
        document.getElementById('pipeline').innerHTML =
          '<p><strong>Script:</strong> ' + escapeHtml(p.script || '') + '</p>' +
          '<p><strong>PID:</strong> ' + escapeHtml(p.pid ?? '—') +
          ' · <strong>Started:</strong> ' + escapeHtml(p.startedAt || '—') + '</p>' +
          '<p><strong>Status:</strong> ' +
          (p.exited ? ('exited code ' + escapeHtml(p.code) + (p.signal ? ' signal ' + escapeHtml(p.signal) : '')) : 'running') +
          '</p>'
        const rows = (d.jobs || []).map(j =>
          '<tr><td>' + escapeHtml(j.status || '') + '</td><td>' + escapeHtml(j.type || '') + '</td><td>' + escapeHtml(j.videoId || '') + '</td><td>' + escapeHtml(j.detail || '') + '</td><td>' + escapeHtml(j.source || '') + '</td></tr>'
        ).join('')
        document.getElementById('jobs').innerHTML = '<table><thead><tr><th>Status</th><th>Type</th><th>Video</th><th>Detail</th><th>Source</th></tr></thead><tbody>' + rows + '</tbody></table>'
        document.getElementById('log').textContent = (d.logLines || []).join('\\n')
      } catch (e) {
        document.getElementById('pipeline').textContent = 'Error: ' + e
      }
    }
    tick()
    setInterval(tick, 3000)
  </script>
</body>
</html>`
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${uiHost}:${uiPort}`)

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(dashboardHtml())
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    json(res, {
      pipeline: {
        script: pipelineScript,
        runPipeline,
        pid: pipelineState.pid,
        startedAt: pipelineState.startedAt,
        exited: pipelineState.exited,
        code: pipelineState.code,
        signal: pipelineState.signal,
      },
      previewQueueLength: previewQueue.length,
      previewRunning,
      jobs,
      logLines,
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/podcast-preview-rebuild') {
    const chunks = []
    let byteCount = 0
    for await (const c of req) {
      byteCount += c.length
      if (byteCount > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Request body too large' }))
        req.destroy()
        return
      }
      chunks.push(c)
    }
    const rawBody = Buffer.concat(chunks)

    if (secret) {
      // Validate timestamp freshness
      const tsHeader = req.headers['x-vmp-timestamp']
      const ts = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader
      if (!ts) {
        json(res, { error: 'Invalid or stale timestamp' }, 401)
        return
      }
      const tsNum = Number(ts)
      if (!Number.isFinite(tsNum) || tsNum <= 0) {
        json(res, { error: 'Invalid or stale timestamp' }, 401)
        return
      }
      const nowSec = Math.floor(Date.now() / 1000)
      const skewWindow = 5 * 60 // 5 minutes in seconds
      if (Math.abs(nowSec - tsNum) > skewWindow) {
        json(res, { error: 'Invalid or stale timestamp' }, 401)
        return
      }

      // Verify signature
      const sig = req.headers['x-vmp-signature']
      if (!verifySignature(rawBody, Array.isArray(sig) ? sig[0] : sig, ts)) {
        json(res, { error: 'Invalid signature' }, 401)
        return
      }
    }

    let payload
    try {
      payload = JSON.parse(rawBody.toString('utf8'))
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return
    }

    if (payload?.event !== 'podcast_preview_rebuild') {
      json(res, { error: 'Unexpected event' }, 400)
      return
    }

    const videos = Array.isArray(payload.videos) ? payload.videos : []
    const accepted = []
    for (const v of videos) {
      const id = v?.id
      const sec = Number(v?.previewDurationSeconds)
      if (!id || !Number.isFinite(sec) || sec <= 0) continue
      // Reject path-like IDs to prevent directory traversal
      if (typeof id !== 'string' || id.includes('/') || id.includes('\\') || id.includes('..')) {
        pushLog(`Rejected invalid video ID: ${id}`)
        continue
      }
      // Stricter validation: allow only alphanumerics, dash, dot, underscore
      if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
        pushLog(`Rejected invalid video ID: ${id}`)
        continue
      }
      accepted.push({ jobId: enqueuePreview(id, Math.floor(sec), 'webhook'), videoId: id, previewSeconds: Math.floor(sec) })
    }

    json(res, { ok: true, accepted: accepted.length, jobs: accepted }, 202)
    return
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, { ok: true })
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

server.listen(uiPort, uiHost, () => {
  pushLog(`Dashboard http://${uiHost}:${uiPort}/  (webhook POST /api/podcast-preview-rebuild)`)
  startPipeline()
})

process.on('SIGTERM', async () => {
  pushLog('SIGTERM — stopping')
  if (pipelineChild && !pipelineState.exited) {
    try {
      pipelineChild.kill('SIGTERM')
    } catch {}
  }
  for (const child of previewChildren) {
    try {
      child.kill('SIGTERM')
    } catch {}
  }
  // Give children a moment to exit gracefully
  await new Promise((resolve) => setTimeout(resolve, 1000))
  for (const child of previewChildren) {
    try {
      child.kill('SIGKILL')
    } catch {}
  }
  server.close(() => process.exit(0))
})