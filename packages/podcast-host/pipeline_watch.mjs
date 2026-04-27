#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readdir, rm, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const INBOX_DIR = (process.env.INBOX_DIR || '/mnt/videos/inbox').trim()
const TMP_DIR_BASE = (process.env.TMP_DIR_BASE || '/mnt/tmp/video_pipeline').trim()
const VAAPI_DEVICE = (process.env.VAAPI_DEVICE || '/dev/dri/renderD128').trim()
const MAX_JOBS = Math.max(1, Number.parseInt(process.env.MAX_JOBS || '2', 10) || 2)
const MP3_BITRATE = (process.env.MP3_BITRATE || '128k').trim()
const PREVIEW_MP3_ENABLED = process.env.PREVIEW_MP3_ENABLED !== '0'
const PREVIEW_MP3_SECONDS = Math.max(1, Number.parseInt(process.env.PREVIEW_MP3_SECONDS || '180', 10) || 180)
const PREVIEW_MP3_LOCK_SECONDS = Math.max(0, Number.parseInt(process.env.PREVIEW_MP3_LOCK_SECONDS || '60', 10) || 60)
const VIDEO_ID_SANITIZE_MODE = (process.env.VIDEO_ID_SANITIZE_MODE || 'slug-hash').trim()
const WAIT_STABLE_TIMEOUT_MS = Math.max(1_000, Number.parseInt(process.env.WAIT_STABLE_TIMEOUT_MS || '120000', 10) || 120000)
const WAIT_STABLE_POLL_MS = Math.max(250, Number.parseInt(process.env.WAIT_STABLE_POLL_MS || '2000', 10) || 2000)
const WAIT_STABLE_IDLE_POLLS = Math.max(1, Number.parseInt(process.env.WAIT_STABLE_IDLE_POLLS || '1', 10) || 1)

function log(msg) {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`)
}

function emitPipelineEvent(videoId, stage, status, detail = '') {
  process.stdout.write(`VMP_PIPELINE_EVENT\t${videoId}\t${stage}\t${status}\t${detail}\n`)
}

function run(command, args, label, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => { stderr += d.toString() })
    }
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr })
      reject(new Error(`${label} failed exit=${code}${capture ? ` stderr=${stderr.slice(-400)}` : ''}`))
    })
  })
}

function r2Root() {
  const rcloneRemote = (process.env.RCLONE_REMOTE || '').trim()
  const bucketName = (process.env.R2_BUCKET_NAME || '').trim()
  const bucket = (process.env.R2_BUCKET || 'vmp-videos').trim()
  if (rcloneRemote) return bucketName ? `${rcloneRemote}:${bucketName}` : `${rcloneRemote}:`
  return bucket.includes(':') ? bucket : `${bucket}:`
}

function r2Path(relativePath) {
  return `${r2Root().replace(/\/+$/, '')}/${String(relativePath).replace(/^\/+/, '')}`
}

function hash8(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function sanitizeVideoId(stem) {
  if (VIDEO_ID_SANITIZE_MODE === 'none') return stem
  if (VIDEO_ID_SANITIZE_MODE === 'base64url') return Buffer.from(stem).toString('base64url') || 'dmlkZW8'
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '').replace(/-{2,}/g, '-') || 'video'
  if (VIDEO_ID_SANITIZE_MODE === 'slug') return slug
  if (/^[a-z0-9-]+$/.test(stem)) return stem
  return `${slug}-${hash8(stem)}`
}

async function waitStableSize(filePath) {
  let prev = -1
  let idlePolls = 0
  const startedAt = Date.now()
  while (Date.now() - startedAt <= WAIT_STABLE_TIMEOUT_MS) {
    const s = (await stat(filePath)).size
    if (s === prev) {
      idlePolls += 1
      if (idlePolls >= WAIT_STABLE_IDLE_POLLS) return
    } else {
      idlePolls = 0
    }
    prev = s
    await new Promise((r) => setTimeout(r, WAIT_STABLE_POLL_MS))
  }
  throw new Error(`wait_stable_timeout after ${WAIT_STABLE_TIMEOUT_MS}ms`)
}

async function detectHasAudio(filePath) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath], 'ffprobe audio', { capture: true })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function processVideo(videoId, inputPath, source = 'watchfolder') {
  const tmpDir = path.join(TMP_DIR_BASE, videoId)
  const doneFlag = path.join(tmpDir, '.done')
  const lockFile = path.join(tmpDir, '.lock')
  await mkdir(tmpDir, { recursive: true })
  if (existsSync(doneFlag)) {
    emitPipelineEvent(videoId, 'done', 'success', 'already_done')
    return
  }
  if (existsSync(lockFile)) {
    emitPipelineEvent(videoId, 'deduped', 'active', 'already_processing')
    return
  }
  await writeFile(lockFile, String(process.pid))
  emitPipelineEvent(videoId, 'detected', 'active', `source=${source}`)
  try {
    emitPipelineEvent(videoId, 'wait_upload_complete', 'active', 'waiting_for_file_stability')
    await waitStableSize(inputPath)
    emitPipelineEvent(videoId, 'wait_upload_complete', 'active', 'stable')

    emitPipelineEvent(videoId, 'probe', 'active', 'probing_streams')
    const hasAudio = await detectHasAudio(inputPath)

    const renditions = [
      { out: '1080p.mp4', w: '1920', h: '1080', br: '5M', max: '5M', buf: '10M', abr: '128k' },
      { out: '720p.mp4', w: '1280', h: '720', br: '3M', max: '3M', buf: '6M', abr: '128k' },
      { out: '480p.mp4', w: '854', h: '480', br: '1500k', max: '1500k', buf: '3000k', abr: '96k' },
    ]
    for (let i = 0; i < renditions.length; i += 1) {
      const r = renditions[i]
      emitPipelineEvent(videoId, 'encode', 'active', `${i + 1}/3 ${r.out}`)
      const outPath = path.join(tmpDir, `${r.out}.tmp.${process.pid}`)
      await run('ffmpeg', [
        '-hide_banner', '-y',
        '-init_hw_device', `vaapi=vaapi0:${VAAPI_DEVICE}`,
        '-i', inputPath, '-r', '30',
        '-vf', `format=nv12,hwupload,scale_vaapi=w=${r.w}:h=${r.h}:force_original_aspect_ratio=decrease`,
        '-map', '0:v:0', '-map', '0:a?', '-c:v', 'h264_vaapi', '-g', '180', '-keyint_min', '180', '-sc_threshold', '0',
        '-b:v', r.br, '-maxrate', r.max, '-bufsize', r.buf, '-c:a', 'aac', '-b:a', r.abr, '-f', 'mp4',
        outPath,
      ], `encode ${r.out}`)
      await rename(outPath, path.join(tmpDir, r.out))
    }
    emitPipelineEvent(videoId, 'encode', 'active', 'done')

    if (hasAudio) {
      emitPipelineEvent(videoId, 'podcast_mp3', 'active', 'start')
      const mp3Tmp = path.join(tmpDir, `podcast.mp3.tmp.${process.pid}`)
      await run('ffmpeg', ['-hide_banner', '-y', '-i', inputPath, '-vn', '-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', MP3_BITRATE, '-f', 'mp3', mp3Tmp], 'encode podcast mp3')
      await rename(mp3Tmp, path.join(tmpDir, 'podcast.mp3'))
      emitPipelineEvent(videoId, 'podcast_mp3', 'active', 'done')
    } else {
      emitPipelineEvent(videoId, 'podcast_mp3', 'active', 'skipped_no_audio')
    }

    emitPipelineEvent(videoId, 'package_hls', 'active', 'start')
    const shakaArgs = [
      `input=${path.join(tmpDir, '1080p.mp4')},stream=video,init_segment=${path.join(tmpDir, 'init_1080.mp4')},segment_template=${path.join(tmpDir, 'seg_1080_$Number$.m4s')}`,
      `input=${path.join(tmpDir, '720p.mp4')},stream=video,init_segment=${path.join(tmpDir, 'init_720.mp4')},segment_template=${path.join(tmpDir, 'seg_720_$Number$.m4s')}`,
      `input=${path.join(tmpDir, '480p.mp4')},stream=video,init_segment=${path.join(tmpDir, 'init_480.mp4')},segment_template=${path.join(tmpDir, 'seg_480_$Number$.m4s')}`,
    ]
    if (hasAudio) {
      shakaArgs.push(`input=${path.join(tmpDir, '1080p.mp4')},stream=audio,init_segment=${path.join(tmpDir, 'init_audio.mp4')},segment_template=${path.join(tmpDir, 'seg_audio_$Number$.m4s')}`)
    }
    shakaArgs.push('--segment_duration', '6', '--fragment_duration', '6', '--generate_static_live_mpd', '--mpd_output', path.join(tmpDir, 'manifest.mpd'), '--hls_master_playlist_output', path.join(tmpDir, 'master.m3u8'))
    await run('shaka-packager', shakaArgs, 'shaka-packager')
    emitPipelineEvent(videoId, 'package_hls', 'active', 'done')

    emitPipelineEvent(videoId, 'upload_assets', 'active', 'start')
    await run('rclone', ['copy', tmpDir, r2Path(`videos/${videoId}`), '--exclude', '1080p.mp4', '--exclude', '720p.mp4', '--exclude', '480p.mp4', '--ignore-existing', '--transfers', '8', '--checkers', '16'], 'rclone upload assets')
    emitPipelineEvent(videoId, 'upload_assets', 'active', 'verified')

    if (PREVIEW_MP3_ENABLED && hasAudio && existsSync(path.join(tmpDir, 'podcast.mp3'))) {
      if (PREVIEW_MP3_LOCK_SECONDS > 0) {
        emitPipelineEvent(videoId, 'preview_wait', 'active', `${PREVIEW_MP3_LOCK_SECONDS}s`)
        await new Promise((r) => setTimeout(r, PREVIEW_MP3_LOCK_SECONDS * 1000))
      }
      emitPipelineEvent(videoId, 'preview_render', 'active', `${PREVIEW_MP3_SECONDS}s`)
      const prevTmp = path.join(tmpDir, `podcast_preview.mp3.tmp.${process.pid}`)
      await run('ffmpeg', ['-hide_banner', '-y', '-i', path.join(tmpDir, 'podcast.mp3'), '-t', String(PREVIEW_MP3_SECONDS), '-vn', '-c:a', 'libmp3lame', '-b:a', MP3_BITRATE, '-f', 'mp3', prevTmp], 'encode preview mp3')
      await rename(prevTmp, path.join(tmpDir, 'podcast_preview.mp3'))
      emitPipelineEvent(videoId, 'preview_upload', 'active', 'start')
      await run('rclone', ['copyto', path.join(tmpDir, 'podcast_preview.mp3'), r2Path(`videos/${videoId}/podcast_preview.mp3`)], 'upload preview mp3')
      emitPipelineEvent(videoId, 'preview_upload', 'active', 'done')
    } else {
      emitPipelineEvent(videoId, 'preview_render', 'active', 'skipped')
    }

    emitPipelineEvent(videoId, 'cleanup', 'active', 'start')
    await writeFile(doneFlag, 'done')
    await rm(inputPath, { force: true })
    await rm(tmpDir, { recursive: true, force: true })
    emitPipelineEvent(videoId, 'done', 'success', 'watchfolder_and_tmp_cleared')
  } catch (err) {
    emitPipelineEvent(videoId, 'failed', 'failed', err instanceof Error ? err.message.slice(0, 220) : String(err).slice(0, 220))
    log(`❌ ${videoId} failed: ${err instanceof Error ? err.message : String(err)}`)
    await rm(lockFile, { force: true })
    throw err
  }
}

const queue = []
let running = 0
let shuttingDown = false

function enqueue(videoId, inputPath, source) {
  queue.push({ videoId, inputPath, source })
  drain()
}

async function resolveSanitizedTargetPath(stem, ext, oldPath, source) {
  const baseId = sanitizeVideoId(stem)
  if (baseId === stem) {
    return { safeId: baseId, targetPath: oldPath, renamed: false }
  }
  const dir = path.dirname(oldPath)
  let attempt = 0
  while (attempt < 1000) {
    const suffix = attempt === 0 ? '' : `-${attempt}`
    const candidateId = `${baseId}${suffix}`
    const candidateFile = `${candidateId}.${ext}`
    const candidatePath = path.join(dir, candidateFile)
    if (!existsSync(candidatePath)) {
      await rename(oldPath, candidatePath)
      if (attempt > 0) {
        log(`⚠️ Filename collision in ${source}: '${oldPath}' -> '${candidatePath}' (base '${baseId}' already existed)`)
      }
      return { safeId: candidateId, targetPath: candidatePath, renamed: true }
    }
    attempt += 1
  }
  throw new Error(`unable to resolve sanitized filename collision for ${oldPath}`)
}

function drain() {
  while (!shuttingDown && running < MAX_JOBS && queue.length > 0) {
    const job = queue.shift()
    if (!job) break
    running += 1
    processVideo(job.videoId, job.inputPath, job.source)
      .catch(() => {})
      .finally(() => {
        running -= 1
        drain()
      })
  }
}

async function startupScan() {
  await mkdir(INBOX_DIR, { recursive: true })
  await mkdir(TMP_DIR_BASE, { recursive: true })
  const entries = await readdir(INBOX_DIR)
  for (const file of entries) {
    if (!/\.(mp4|mkv|mov)$/i.test(file)) continue
    const stem = file.replace(/\.[^.]+$/, '')
    const oldPath = path.join(INBOX_DIR, file)
    const ext = file.split('.').pop() || 'mp4'
    const { safeId, targetPath, renamed } = await resolveSanitizedTargetPath(stem, ext, oldPath, 'startup_scan')
    if (renamed) {
      log(`🧼 Sanitized VIDEO_ID startup_scan: '${stem}' -> '${safeId}'`)
    }
    enqueue(safeId, targetPath, 'startup_scan')
  }
}

function startWatcher() {
  const child = spawn('inotifywait', ['-m', '-e', 'close_write', '--format', '%f', INBOX_DIR], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] })
  let stdoutBuffer = ''
  const processLines = async (lines) => {
    for (const file of lines) {
      if (!/\.(mp4|mkv|mov)$/i.test(file)) continue
      const stem = file.replace(/\.[^.]+$/, '')
      const oldPath = path.join(INBOX_DIR, file)
      const ext = file.split('.').pop() || 'mp4'
      const { safeId, targetPath, renamed } = await resolveSanitizedTargetPath(stem, ext, oldPath, 'watchfolder')
      if (renamed) {
        log(`🧼 Sanitized VIDEO_ID watchfolder: '${stem}' -> '${safeId}'`)
      }
      enqueue(safeId, targetPath, 'watchfolder')
    }
  }
  child.stdout.on('data', async (chunk) => {
    stdoutBuffer += chunk.toString()
    const parts = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = parts.pop() ?? ''
    const lines = parts.filter(Boolean)
    await processLines(lines)
  })
  child.on('close', (code) => {
    if (stdoutBuffer.trim()) {
      const trailing = stdoutBuffer.trim()
      stdoutBuffer = ''
      processLines([trailing]).catch((err) => {
        log(`watcher trailing line processing failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
    if (!shuttingDown) {
      log(`inotifywait exited unexpectedly with code=${code ?? 'null'}`)
      process.exit(1)
    }
  })
  return child
}

async function main() {
  if (!existsSync(VAAPI_DEVICE)) {
    throw new Error(`VAAPI device not found: ${VAAPI_DEVICE}`)
  }
  log(`☁️  Using R2 root: ${r2Root()}`)
  log('🔍 Resuming existing jobs...')
  await startupScan()
  log('🎬 Watching for new uploads...')
  const watcher = startWatcher()

  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    watcher.kill('SIGTERM')
    log('Shutting down pipeline watcher')
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
