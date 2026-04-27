#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

function env(name, fallback = '') {
  const value = process.env[name]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function parseArgs() {
  const [, , rawVideoId, rawSeconds] = process.argv
  if (!rawVideoId) throw new Error('Usage: node render_podcast_preview_mp3.mjs <video_id> <preview_seconds>')
  if (!/^[a-zA-Z0-9._-]+$/.test(rawVideoId)) throw new Error('video_id contains invalid characters')
  const seconds = Number.parseInt(String(rawSeconds ?? ''), 10)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('preview_seconds must be a positive integer')
  return { videoId: rawVideoId, previewSeconds: Math.floor(seconds) }
}

function buildR2Root() {
  const rcloneRemote = env('RCLONE_REMOTE')
  const bucketName = env('R2_BUCKET_NAME')
  const bucket = env('R2_BUCKET', 'vmp-videos')
  if (rcloneRemote) return bucketName ? `${rcloneRemote}:${bucketName}` : `${rcloneRemote}:`
  return bucket.includes(':') ? bucket : `${bucket}:`
}

function r2Path(root, relativePath) {
  return `${root.replace(/\/+$/, '')}/${String(relativePath).replace(/^\/+/, '')}`
}

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    activeChild = child
    let stderr = ''
    child.stdout.on('data', (chunk) => process.stdout.write(chunk))
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (activeChild === child) activeChild = null
      if (code === 0) return resolve(undefined)
      reject(new Error(`${label} failed with exit ${code}: ${stderr.slice(-400)}`))
    })
  })
}

async function copyFirstAvailableSource(root, videoId, localIn) {
  const candidates = [
    r2Path(root, `videos/${videoId}/podcast.mp3`),
    r2Path(root, `videos/${videoId}/processed/audio/podcast.mp3`),
    r2Path(root, `videos/${videoId}/processed/podcast.mp3`),
  ]
  let lastErr = null
  for (const remote of candidates) {
    try {
      await run('rclone', ['copyto', remote, localIn], `rclone copyto (${remote})`)
      return remote
    } catch (err) {
      lastErr = err
      // Try next candidate
    }
  }
  const detail = lastErr instanceof Error ? ` Last error: ${lastErr.message}` : ''
  throw new Error(`Could not locate source podcast MP3 in R2 for video ${videoId}.${detail}`)
}

async function main() {
  const { videoId, previewSeconds } = parseArgs()
  const mp3Bitrate = env('MP3_BITRATE', '128k')
  const root = buildR2Root()

  const tempDir = await mkdtemp(path.join(tmpdir(), `vmp_podcast_preview_${videoId}_`))
  const localIn = path.join(tempDir, 'podcast.mp3')
  const localOut = path.join(tempDir, 'podcast_preview.mp3')
  let cleaning = false
  const cleanupTempDir = async () => {
    if (cleaning) return
    cleaning = true
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
  const onSigterm = () => {
    if (activeChild) {
      try { activeChild.kill('SIGTERM') } catch {}
      setTimeout(() => {
        if (activeChild) {
          try { activeChild.kill('SIGKILL') } catch {}
        }
      }, 1500)
    }
    void cleanupTempDir().finally(() => process.exit(143))
  }
  process.on('SIGTERM', onSigterm)

  try {
    const sourceUsed = await copyFirstAvailableSource(root, videoId, localIn)
    console.log(`[preview] source=${sourceUsed}`)

    await run(
      'ffmpeg',
      ['-hide_banner', '-y', '-i', localIn, '-t', String(previewSeconds), '-vn', '-c:a', 'libmp3lame', '-b:a', mp3Bitrate, '-f', 'mp3', localOut],
      'ffmpeg preview render',
    )

    await run('rclone', ['copyto', localOut, r2Path(root, `videos/${videoId}/podcast_preview.mp3`)], 'rclone preview upload')
    console.log(`[preview] done video=${videoId} seconds=${previewSeconds}`)
  } finally {
    process.off('SIGTERM', onSigterm)
    await cleanupTempDir()
  }
}

main().catch((err) => {
  console.error(`[preview] failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
