import type { D1Database, ExecutionContext, R2Bucket } from '@cloudflare/workers-types'

export interface WorkerEnv {
  VIDEO_BUCKET?: R2Bucket
  DB?: D1Database
  video_subscription_db?: D1Database
  VIDEO_SUBSCRIPTION_DB?: D1Database
  ALLOWED_ORIGINS?: string
  VIDEO_PROCESSOR_API_TOKEN?: string
  PROCESSOR_API_TOKEN?: string
  ADMIN_API_TOKEN?: string
}

export interface RequestContext<TEnv extends WorkerEnv = WorkerEnv> {
  request: Request
  env: TEnv
  params?: Record<string, string>
  waitUntil?: ExecutionContext['waitUntil']
}
