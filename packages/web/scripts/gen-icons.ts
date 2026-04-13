/**
 * gen-icons.ts
 * Generates PWA icons (play-button triangle on dark background) as PNG files.
 * Pure Node.js — no external dependencies required.
 * Usage: tsx scripts/gen-icons.ts   (from packages/web/)
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '../public/icons')

mkdirSync(OUT_DIR, { recursive: true })

// ── PNG encoder ──────────────────────────────────────────────────────────────

function crc32(buf: Uint8Array) {
  const table = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })()
  let c = 0xffffffff
  for (const byte of buf) {
    const idx = (c ^ byte) & 0xff
    c = table[idx]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer) {
  const typeBytes = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length)
  const crcInput = Buffer.concat([typeBytes, data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(crcInput))
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf])
}

function encodePNG(pixels: Buffer, width: number, height: number) {
  // pixels: Uint8Array of length width*height*3 (RGB rows, top→bottom)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8   // bit depth
  ihdrData[9] = 2   // colour type: RGB
  ihdrData[10] = 0  // compression
  ihdrData[11] = 0  // filter
  ihdrData[12] = 0  // interlace

  // Build filtered scanlines (filter byte 0 = None per row)
  const scanlines = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    scanlines[y * (1 + width * 3)] = 0  // filter type None
    pixels.copy(scanlines, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3)
  }

  const idatData = deflateSync(scanlines, { level: 6 })

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdrData),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── Drawing helpers ──────────────────────────────────────────────────────────

function makeCanvas(size: number) {
  // RGB pixel buffer, all zeros
  return Buffer.alloc(size * size * 3)
}

function setPixel(buf: Buffer, size: number, x: number, y: number, r: number, g: number, b: number) {
  if (x < 0 || x >= size || y < 0 || y >= size) return
  const i = (y * size + x) * 3
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b
}

function fillRect(buf: Buffer, size: number, x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number) {
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      setPixel(buf, size, x, y, r, g, b)
}

// Anti-aliased circle fill
function fillCircle(buf: Buffer, size: number, cx: number, cy: number, radius: number, r: number, g: number, b: number, bgR: number, bgG: number, bgB: number) {
  for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius + 1); y++) {
    for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x++) {
      const dx = x - cx, dy = y - cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < radius - 0.5) {
        setPixel(buf, size, x, y, r, g, b)
      } else if (dist < radius + 0.5) {
        const t = radius + 0.5 - dist  // 0..1 coverage
        setPixel(buf, size, x, y,
          Math.round(bgR * (1 - t) + r * t),
          Math.round(bgG * (1 - t) + g * t),
          Math.round(bgB * (1 - t) + b * t),
        )
      }
    }
  }
}

// Anti-aliased filled triangle (right-pointing play symbol)
// p0=top-left, p1=bottom-left, p2=right
function fillTriangle(buf: Buffer, size: number, p0: [number, number], p1: [number, number], p2: [number, number], r: number, g: number, b: number) {
  const minX = Math.floor(Math.min(p0[0], p1[0], p2[0])) - 1
  const maxX = Math.ceil(Math.max(p0[0], p1[0], p2[0])) + 1
  const minY = Math.floor(Math.min(p0[1], p1[1], p2[1])) - 1
  const maxY = Math.ceil(Math.max(p0[1], p1[1], p2[1])) + 1

  function edgeFn(ax: number, ay: number, bx: number, by: number, px: number, py: number) {
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax)
  }

  // Super-sample 4×4 for anti-aliasing
  const N = 4
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      let coverage = 0
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const spx = px + (sx + 0.5) / N
          const spy = py + (sy + 0.5) / N
          const e0 = edgeFn(p0[0], p0[1], p1[0], p1[1], spx, spy)
          const e1 = edgeFn(p1[0], p1[1], p2[0], p2[1], spx, spy)
          const e2 = edgeFn(p2[0], p2[1], p0[0], p0[1], spx, spy)
          // p0→p1→p2 is clockwise in screen-space (y-down), so interior = all ≤ 0
          if (e0 <= 0 && e1 <= 0 && e2 <= 0) coverage++
        }
      }
      if (coverage === 0) continue
      const t = coverage / (N * N)
      if (px < 0 || px >= size || py < 0 || py >= size) continue
      const i = (py * size + px) * 3
      const br = buf[i] ?? 0
      const bg = buf[i + 1] ?? 0
      const bb = buf[i + 2] ?? 0
      buf[i] = Math.round(br * (1 - t) + r * t)
      buf[i + 1] = Math.round(bg * (1 - t) + g * t)
      buf[i + 2] = Math.round(bb * (1 - t) + b * t)
    }
  }
}

// ── Icon renderer ────────────────────────────────────────────────────────────

/**
 * Draws the VMP play-button icon.
 */
function drawIcon(size: number, safePad = 0) {
  const buf = makeCanvas(size)

  // Background: #0f172a (slate-950)
  const [bgR, bgG, bgB] = [15, 23, 42]
  fillRect(buf, size, 0, 0, size, size, bgR, bgG, bgB)

  const inner = size * (1 - 2 * safePad)  // drawable region
  const ox = size * safePad               // origin x
  const oy = size * safePad               // origin y
  const cx = ox + inner / 2
  const cy = oy + inner / 2

  // Blue circle: #3b82f6
  const circleR = inner * 0.42
  fillCircle(buf, size, cx, cy, circleR, 59, 130, 246, bgR, bgG, bgB)

  // White play triangle, centred inside the circle
  const th = inner * 0.28
  const tw = inner * 0.30
  const nudge = inner * 0.02
  const tlx = cx - tw * 0.38 + nudge
  const trx = cx + tw * 0.62 + nudge
  const tmy = cy
  const p0: [number, number] = [tlx, cy - th]
  const p1: [number, number] = [tlx, cy + th]
  const p2: [number, number] = [trx, tmy]

  fillTriangle(buf, size, p0, p1, p2, 255, 255, 255)

  return buf
}

// ── Write files ──────────────────────────────────────────────────────────────

const variants = [
  { name: 'pwa-192.png', size: 192, safePad: 0 },
  { name: 'pwa-512.png', size: 512, safePad: 0 },
  { name: 'pwa-512-maskable.png', size: 512, safePad: 0.10 },
]

for (const { name, size, safePad } of variants) {
  const pixels = drawIcon(size, safePad)
  const png = encodePNG(pixels, size, size)
  const outPath = join(OUT_DIR, name)
  writeFileSync(outPath, png)
  console.log(`Written ${outPath} (${png.length} bytes)`)
}
