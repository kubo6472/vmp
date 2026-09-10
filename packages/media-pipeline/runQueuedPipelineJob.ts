/**
 * Encore + encore-packager queued pipeline (fast-lane vs full-ladder).
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  checkEncoreHealth,
  encoreJobUrl,
  encoreSegmentLengthSeconds,
  resolveEncoreProfileName,
  submitEncoreJob,
  waitForEncoreJob,
} from './encoreClient.js';
import { ENCORE_JOB_PRIORITY } from './encorePriorities.js';
import { detectGpuEncodeConfig } from './gpuDetect.js';
import { registerAndEnqueuePackaging, waitForPackaging } from './packagingClient.js';
import type { PackagingStage, PipelineMode, QueuedPipelineSubStage } from './pipelineMode.js';
import { objectKey, uploadFileToStorage } from './storage.js';
import { emitTtp, type TtpMilestone } from './ttpLog.js';

export type QueuedPipelineContext = {
  videoId: string;
  inputPath: string;
  pipelineMode: PipelineMode;
  tmpDir: string;
  hasAudio: boolean;
  isCancelled: () => boolean;
  emitStage: (
    stage: PackagingStage,
    subStage: QueuedPipelineSubStage,
    status: string,
    detail?: string,
  ) => void;
  notifyVideoAvailable: (
    stage: 'preview_ready' | 'fully_processed',
    renditions: string[],
  ) => Promise<void>;
};

async function run(cmd: string, args: string[], label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited ${code}`));
    });
  });
}

async function uploadLocalFile(
  localFile: string,
  relativeKey: string,
  label: string,
): Promise<void> {
  await uploadFileToStorage(localFile, relativeKey, label);
}

async function findNewestAudio(outputDir: string): Promise<string> {
  const entries = await readdir(outputDir);
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!/\.(mp3|m4a|aac)$/i.test(name)) continue;
    const full = path.join(outputDir, name);
    const info = await stat(full);
    if (!best || info.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: info.mtimeMs };
  }
  if (!best) throw new Error(`No audio output in ${outputDir}`);
  return best.path;
}

async function runEncoreAndPackage(
  ctx: QueuedPipelineContext,
  options: {
    profileBase: string;
    stage: PackagingStage;
    outputSubdir: string;
    priority?: number;
    duration?: number;
    ttpEncodeStart: TtpMilestone;
    ttpEncodeDone: TtpMilestone;
  },
): Promise<string> {
  const profile = await resolveEncoreProfileName(options.profileBase);
  const outDir = path.join(ctx.tmpDir, 'encore', options.outputSubdir);
  await mkdir(outDir, { recursive: true });
  const baseName = `vmp-${ctx.videoId}-${options.outputSubdir}`;

  await emitTtp(ctx.videoId, options.ttpEncodeStart, {
    pipelineMode: ctx.pipelineMode,
    profile,
    packagingStage: options.stage,
  });
  ctx.emitStage(options.stage, 'encode', 'active', `encore profile=${profile}`);

  const jobId = await submitEncoreJob({
    profile,
    inputPath: ctx.inputPath,
    outputFolder: outDir,
    baseName,
    externalId: ctx.videoId,
    priority: options.priority ?? 50,
    duration: options.duration,
    segmentLength: encoreSegmentLengthSeconds(),
  });
  process.stdout.write(
    `${new Date().toISOString()} 🎞️  ${ctx.videoId} encore job submitted id=${jobId} profile=${profile} stage=${options.stage}\n`,
  );

  await waitForEncoreJob(jobId, { isCancelled: ctx.isCancelled });
  await emitTtp(ctx.videoId, options.ttpEncodeDone, {
    pipelineMode: ctx.pipelineMode,
    encoreJobId: jobId,
    profile,
  });

  const url = encoreJobUrl(jobId);
  await registerAndEnqueuePackaging({
    jobId,
    encoreJobUrl: url,
    videoId: ctx.videoId,
    stage: options.stage,
    pipelineMode: ctx.pipelineMode,
  });

  ctx.emitStage(options.stage, 'package', 'active', 'packaging queued');
  const pkg = await waitForPackaging(jobId);
  if (pkg.status === 'failed') {
    throw new Error(pkg.error || `packaging failed for ${jobId}`);
  }
  return jobId;
}

async function runPodcastSidecars(ctx: QueuedPipelineContext): Promise<void> {
  if (!ctx.hasAudio) {
    await emitTtp(ctx.videoId, 'podcast_mp3_skipped', { pipelineMode: ctx.pipelineMode });
    return;
  }

  const previewSeconds = Math.max(
    1,
    Number.parseInt(process.env.PREVIEW_MP3_SECONDS || '180', 10) || 180,
  );
  const previewEnabled = process.env.PREVIEW_MP3_ENABLED !== '0';

  const podcastOut = path.join(ctx.tmpDir, 'encore', 'podcast');
  await mkdir(podcastOut, { recursive: true });
  const podcastJobId = await submitEncoreJob({
    profile: await resolveEncoreProfileName('vmp-podcast-mp3'),
    inputPath: ctx.inputPath,
    outputFolder: podcastOut,
    baseName: `vmp-${ctx.videoId}-podcast`,
    externalId: `${ctx.videoId}:podcast`,
    priority: ENCORE_JOB_PRIORITY.PODCAST,
  });
  await waitForEncoreJob(podcastJobId, { isCancelled: ctx.isCancelled });
  const podcastFile = await findNewestAudio(podcastOut);
  await uploadLocalFile(
    podcastFile,
    objectKey('videos', ctx.videoId, 'podcast.mp3'),
    'upload podcast mp3',
  );
  await emitTtp(ctx.videoId, 'podcast_mp3_done', { pipelineMode: ctx.pipelineMode });

  if (!previewEnabled) {
    await emitTtp(ctx.videoId, 'preview_mp3_skipped', { pipelineMode: ctx.pipelineMode });
    return;
  }

  const previewOut = path.join(ctx.tmpDir, 'encore', 'preview');
  await mkdir(previewOut, { recursive: true });
  const previewJobId = await submitEncoreJob({
    profile: await resolveEncoreProfileName('vmp-podcast-preview'),
    inputPath: ctx.inputPath,
    outputFolder: previewOut,
    baseName: `vmp-${ctx.videoId}-preview`,
    externalId: `${ctx.videoId}:preview`,
    priority: ENCORE_JOB_PRIORITY.PREVIEW_MP3,
    duration: previewSeconds,
  });
  await waitForEncoreJob(previewJobId, { isCancelled: ctx.isCancelled });
  const previewFile = await findNewestAudio(previewOut);
  await uploadLocalFile(
    previewFile,
    objectKey('videos', ctx.videoId, 'podcast_preview.mp3'),
    'upload preview mp3',
  );
  await emitTtp(ctx.videoId, 'preview_mp3_done', {
    pipelineMode: ctx.pipelineMode,
    previewSeconds,
  });
}

export async function runQueuedPipelineJob(ctx: QueuedPipelineContext): Promise<void> {
  await checkEncoreHealth();
  const gpu = await detectGpuEncodeConfig();
  await emitTtp(ctx.videoId, 'gpu_backend_detected', {
    pipelineMode: ctx.pipelineMode,
    gpuBackend: gpu.backend,
    profileSuffix: gpu.profileSuffix,
  });

  if (ctx.pipelineMode === 'fast_lane') {
    await runEncoreAndPackage(ctx, {
      profileBase: 'vmp-720p-audio',
      stage: 'fast_lane_preview',
      outputSubdir: 'fast-lane-720p',
      priority: ENCORE_JOB_PRIORITY.FAST_LANE_720P,
      ttpEncodeStart: 'phase1_encode_start',
      ttpEncodeDone: 'phase1_encode_done',
    });
    await emitTtp(ctx.videoId, 'phase1_upload_done', {
      pipelineMode: ctx.pipelineMode,
      via: 'encore-packager',
    });
    await ctx.notifyVideoAvailable('preview_ready', ['720p']);
    await emitTtp(ctx.videoId, 'minimal_publish_ready', {
      pipelineMode: ctx.pipelineMode,
      renditionsOnR2: ['720p'],
    });

    const podcastTask = runPodcastSidecars(ctx).catch(async (err) => {
      const detail = err instanceof Error ? err.message.slice(0, 220) : String(err).slice(0, 220);
      await emitTtp(ctx.videoId, 'podcast_mp3_failed', {
        pipelineMode: ctx.pipelineMode,
        error: detail,
      });
    });

    const ladderTask = runEncoreAndPackage(ctx, {
      profileBase: 'vmp-full-ladder',
      stage: 'full_ladder',
      outputSubdir: 'full-ladder',
      priority: ENCORE_JOB_PRIORITY.FULL_LADDER,
      ttpEncodeStart: 'phase2_encode_start',
      ttpEncodeDone: 'phase2_encode_done',
    }).then(async () => {
      await emitTtp(ctx.videoId, 'phase2_upload_done', {
        pipelineMode: ctx.pipelineMode,
        via: 'encore-packager',
      });
      await ctx.notifyVideoAvailable('fully_processed', ['1080p', '720p', '480p']);
      await emitTtp(ctx.videoId, 'full_renditions_ready', {
        pipelineMode: ctx.pipelineMode,
        renditionsOnR2: ['1080p', '720p', '480p'],
      });
    });

    await Promise.all([podcastTask, ladderTask]);
    return;
  }

  // full_ladder only — single encode + package, no preview_ready unless configured
  const podcastTask = runPodcastSidecars(ctx).catch(async (err) => {
    const detail = err instanceof Error ? err.message.slice(0, 220) : String(err).slice(0, 220);
    await emitTtp(ctx.videoId, 'podcast_mp3_failed', {
      pipelineMode: ctx.pipelineMode,
      error: detail,
    });
  });

  await runEncoreAndPackage(ctx, {
    profileBase: 'vmp-full-ladder',
    stage: 'full_ladder',
    outputSubdir: 'full-ladder',
    priority: ENCORE_JOB_PRIORITY.FULL_LADDER,
    ttpEncodeStart: 'phase2_encode_start',
    ttpEncodeDone: 'phase2_encode_done',
  });
  await emitTtp(ctx.videoId, 'phase2_upload_done', {
    pipelineMode: ctx.pipelineMode,
    via: 'encore-packager',
  });
  await ctx.notifyVideoAvailable('fully_processed', ['1080p', '720p', '480p']);
  await emitTtp(ctx.videoId, 'full_renditions_ready', {
    pipelineMode: ctx.pipelineMode,
    renditionsOnR2: ['1080p', '720p', '480p'],
  });
  await podcastTask;
}
