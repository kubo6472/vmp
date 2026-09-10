/**
 * Thin client for SVT Encore (https://svt.github.io/encore/).
 * Submits transcoding jobs and waits for completion; maps outputs to VMP filenames.
 */

import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { ENCORE_JOB_PRIORITY } from './encorePriorities.js';
import { detectGpuEncodeConfig, resolveEncoreProfileBase } from './gpuDetect.js';

/** Optional parallel segment encode (seconds). Requires Encore shared-work-dir. */
export function encoreSegmentLengthSeconds(): number | undefined {
  const raw = (process.env.ENCORE_SEGMENT_LENGTH_SECONDS || '').trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export type EncoreJobStatus =
  | 'NEW'
  | 'QUEUED'
  | 'IN_PROGRESS'
  | 'SUCCESSFUL'
  | 'FAILED'
  | 'CANCELLED';

type EncoreJob = {
  id?: string;
  status?: EncoreJobStatus;
  progress?: number;
  message?: string;
  externalId?: string;
};

const ENCORE_BASE_URL = (process.env.ENCORE_BASE_URL || 'http://127.0.0.1:8080')
  .trim()
  .replace(/\/+$/, '');
const ENCORE_USER = (process.env.ENCORE_USER || '').trim();
const ENCORE_PASSWORD = (process.env.ENCORE_PASSWORD || '').trim();
const ENCORE_POLL_MS = Math.max(
  500,
  Number.parseInt(process.env.ENCORE_POLL_MS || '2000', 10) || 2000,
);
const ENCORE_JOB_TIMEOUT_MS = Math.max(
  60_000,
  Number.parseInt(process.env.ENCORE_JOB_TIMEOUT_MS || '7200000', 10) || 7_200_000,
);
const MEDIA_HOST_ROOT = (process.env.MEDIA_HOST_ROOT || '/mnt').replace(/\/$/, '');
const ENCORE_MEDIA_ROOT = (process.env.ENCORE_MEDIA_ROOT || MEDIA_HOST_ROOT).replace(/\/$/, '');

function encoreAuthHeader(): string | undefined {
  if (!ENCORE_USER) return undefined;
  const token = Buffer.from(`${ENCORE_USER}:${ENCORE_PASSWORD}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

function encoreHeaders(contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers['Content-Type'] = contentType;
  const auth = encoreAuthHeader();
  if (auth) headers.Authorization = auth;
  return headers;
}

/** Map a host filesystem path to the URI Encore workers can read (shared volume). */
export function toEncoreUri(hostPath: string): string {
  const resolved = path.resolve(hostPath);
  if (MEDIA_HOST_ROOT !== ENCORE_MEDIA_ROOT && resolved.startsWith(`${MEDIA_HOST_ROOT}/`)) {
    return `${ENCORE_MEDIA_ROOT}${resolved.slice(MEDIA_HOST_ROOT.length)}`;
  }
  return resolved;
}

async function encoreFetch(
  urlPath: string,
  init: RequestInit = {},
  timeoutMs?: number,
): Promise<Response> {
  const headers = { ...encoreHeaders(), ...(init.headers as Record<string, string> | undefined) };
  const controller = new AbortController();
  const timeout = timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${ENCORE_BASE_URL}${urlPath}`, {
      ...init,
      headers,
      signal: init.signal ?? controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkEncoreHealth(): Promise<void> {
  const res = await encoreFetch('/actuator/health', { method: 'GET' });
  if (!res.ok) {
    throw new Error(`Encore health check failed: HTTP ${res.status}`);
  }
}

export async function submitEncoreJob(options: {
  profile: string;
  inputPath: string;
  outputFolder: string;
  baseName: string;
  externalId: string;
  priority?: number;
  duration?: number;
  seekTo?: number;
  /** Seconds per segment for parallel encode across workers (needs shared-work-dir). */
  segmentLength?: number;
}): Promise<string> {
  const body: Record<string, unknown> = {
    profile: options.profile,
    outputFolder: toEncoreUri(options.outputFolder),
    baseName: options.baseName,
    externalId: options.externalId,
    priority: options.priority ?? 50,
    inputs: [
      {
        type: 'AudioVideo',
        uri: toEncoreUri(options.inputPath),
      },
    ],
  };
  if (options.duration != null) body.duration = options.duration;
  if (options.seekTo != null) body.seekTo = options.seekTo;
  if (options.segmentLength != null && options.segmentLength > 0) {
    body.segmentLength = options.segmentLength;
  }

  const res = await encoreFetch('/encoreJobs', {
    method: 'POST',
    headers: encoreHeaders('application/json'),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Encore job submit failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  const job = (await res.json()) as EncoreJob;
  const id = String(job.id ?? '').trim();
  if (!id) throw new Error('Encore job response missing id');
  return id;
}

export async function getEncoreJob(jobId: string): Promise<EncoreJob> {
  const res = await encoreFetch(
    `/encoreJobs/${encodeURIComponent(jobId)}`,
    { method: 'GET' },
    15_000,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Encore job fetch failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return (await res.json()) as EncoreJob;
}

export async function waitForEncoreJob(
  jobId: string,
  options: {
    onProgress?: (progress: number, status: EncoreJobStatus) => void;
    isCancelled?: () => boolean;
  } = {},
): Promise<EncoreJob> {
  const started = Date.now();
  while (Date.now() - started <= ENCORE_JOB_TIMEOUT_MS) {
    if (options.isCancelled?.()) {
      throw new Error(`Encore job ${jobId} cancelled`);
    }
    const job = await getEncoreJob(jobId);
    const status = (job.status ?? 'QUEUED') as EncoreJobStatus;
    options.onProgress?.(job.progress ?? 0, status);
    if (status === 'SUCCESSFUL') return job;
    if (status === 'FAILED' || status === 'CANCELLED') {
      throw new Error(`Encore job ${jobId} ${status}: ${job.message ?? 'unknown error'}`);
    }
    await new Promise((r) => setTimeout(r, ENCORE_POLL_MS));
  }
  throw new Error(`Encore job ${jobId} timed out after ${ENCORE_JOB_TIMEOUT_MS}ms`);
}

/** Pick the newest video file Encore wrote in outputFolder and rename to targetFileName. */
export async function adoptEncoreOutput(
  outputFolder: string,
  targetFileName: string,
): Promise<string> {
  const entries = await readdir(outputFolder);
  const videoExts = new Set(['.mp4', '.mkv', '.mov', '.m4v']);
  let best: { name: string; mtimeMs: number } | null = null;

  for (const name of entries) {
    const ext = path.extname(name).toLowerCase();
    if (!videoExts.has(ext)) continue;
    if (name === targetFileName) {
      return path.join(outputFolder, name);
    }
    const full = path.join(outputFolder, name);
    const info = await stat(full);
    if (!best || info.mtimeMs > best.mtimeMs) {
      best = { name, mtimeMs: info.mtimeMs };
    }
  }

  if (!best) {
    throw new Error(`No Encore video output found in ${outputFolder}`);
  }

  const src = path.join(outputFolder, best.name);
  const dest = path.join(outputFolder, targetFileName);
  if (src !== dest) {
    await rename(src, dest);
  }
  return dest;
}

export function encoreJobUrl(jobId: string): string {
  return `${ENCORE_BASE_URL}/encoreJobs/${encodeURIComponent(jobId)}`;
}

const PROFILE_GPU_VARIANTS: Record<string, string[]> = {
  'vmp-720p-audio': ['vmp-720p-audio-gpu-nvenc', 'vmp-720p-audio-gpu-vaapi', 'vmp-720p-audio'],
  'vmp-1080p': ['vmp-1080p'],
  'vmp-480p': ['vmp-480p'],
  'vmp-full-ladder': ['vmp-full-ladder-gpu-nvenc', 'vmp-full-ladder-gpu-vaapi', 'vmp-full-ladder'],
  'vmp-podcast-mp3': ['vmp-podcast-mp3'],
  'vmp-podcast-preview': ['vmp-podcast-preview'],
};

/** Pick best registered Encore profile for this host (GPU when available). */
export async function resolveEncoreProfileName(profileBase: string): Promise<string> {
  const gpu = await detectGpuEncodeConfig();
  const variants = PROFILE_GPU_VARIANTS[profileBase];
  if (!variants) {
    return resolveEncoreProfileBase(profileBase, gpu.profileSuffix);
  }
  if (gpu.backend === 'nvenc') {
    const nvenc = variants.find((c) => c.includes('nvenc'));
    if (nvenc) return nvenc;
  }
  if (gpu.backend === 'vaapi') {
    const vaapi = variants.find((c) => c.includes('vaapi'));
    if (vaapi) return vaapi;
  }
  return variants[variants.length - 1];
}

export const ENCORE_PROFILES = {
  '720p': 'vmp-720p-audio',
  '1080p': 'vmp-1080p',
  '480p': 'vmp-480p',
} as const;

export type EncoreRenditionKey = keyof typeof ENCORE_PROFILES;

export async function transcodeRenditionWithEncore(options: {
  videoId: string;
  inputPath: string;
  outputDir: string;
  rendition: EncoreRenditionKey;
  targetFileName: string;
  onProgress?: (progress: number) => void;
  isCancelled?: () => boolean;
}): Promise<string> {
  const profile = await resolveEncoreProfileName(ENCORE_PROFILES[options.rendition]);
  const baseName = `vmp-${options.videoId}-${options.rendition}`;
  const attemptId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const encoreOutDir = path.join(options.outputDir, 'encore', options.rendition, attemptId);
  await mkdir(encoreOutDir, { recursive: true });

  const jobId = await submitEncoreJob({
    profile,
    inputPath: options.inputPath,
    outputFolder: encoreOutDir,
    baseName,
    externalId: `${options.videoId}:${options.rendition}`,
    priority:
      options.rendition === '720p'
        ? ENCORE_JOB_PRIORITY.RENDITION_720P
        : ENCORE_JOB_PRIORITY.RENDITION_OTHER,
    segmentLength: encoreSegmentLengthSeconds(),
  });

  await waitForEncoreJob(jobId, {
    onProgress: (progress) => options.onProgress?.(progress),
    isCancelled: options.isCancelled,
  });

  return adoptEncoreOutput(encoreOutDir, options.targetFileName);
}
