const TUS_VERSION = '1.0.0'
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024

type Visibility = 'private' | 'unlisted' | 'public'

interface TusSession {
  uploadUrl: string
  videoId: string
}

interface UploadMetadata {
  filename: string
  filetype: string
  visibility: Visibility
}

interface UploadOptions {
  apiBaseUrl: string
  visibility: Visibility
  onStatus?: (message: string) => void
  onProgress?: (uploadedBytes: number, totalBytes: number) => void
  chunkSize?: number
}

interface UploadResult {
  videoId: string
  uploadUrl: string
}

const toBase64 = (value: string) => {
  if (typeof window !== 'undefined' && typeof window.btoa === 'function') return window.btoa(value)
  if (typeof Buffer !== 'undefined') return Buffer.from(value, 'utf8').toString('base64')
  return ''
}

const buildUploadMetadataHeader = (metadata: UploadMetadata) => {
  return [
    ['filename', metadata.filename],
    ['filetype', metadata.filetype || 'application/octet-stream'],
    ['visibility', metadata.visibility]
  ]
    .map(([key, value]) => `${key} ${toBase64(value)}`)
    .join(',')
}

const sanitizeApiBaseUrl = (apiBaseUrl: string) => apiBaseUrl.replace(/\/$/, '')

const getStorageKey = (file: File) => `tus-upload:${file.name}:${file.size}:${file.lastModified}`

const readStoredSession = (storageKey: string): TusSession | null => {
  if (typeof window === 'undefined') return null

  const raw = window.localStorage.getItem(storageKey)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    if (parsed.uploadUrl && parsed.videoId) return parsed
  } catch {
    // ignore malformed storage entries
  }

  return null
}

const storeSession = (storageKey: string, session: TusSession) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(storageKey, JSON.stringify(session))
}

const clearSession = (storageKey: string) => {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(storageKey)
}

const toAbsoluteUploadUrl = (apiBaseUrl: string, location: string) => {
  if (/^https?:\/\//i.test(location)) return location
  const base = sanitizeApiBaseUrl(apiBaseUrl)
  if (location.startsWith('/')) {
    const origin = (() => {
      try {
        return new URL(base).origin
      } catch {
        return base
      }
    })()
    return `${origin}${location}`
  }

  return `${base}/${location}`
}

const extractVideoId = (uploadUrl: string) => {
  const clean = uploadUrl.split('?')[0].replace(/\/$/, '')
  return clean.substring(clean.lastIndexOf('/') + 1)
}

const createSession = async (file: File, apiBaseUrl: string, visibility: Visibility): Promise<TusSession> => {
  const response = await fetch(`${sanitizeApiBaseUrl(apiBaseUrl)}/api/uploads`, {
    method: 'POST',
    headers: {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Length': String(file.size),
      'Upload-Metadata': buildUploadMetadataHeader({
        filename: file.name,
        filetype: file.type || 'application/octet-stream',
        visibility
      })
    }
  })

  if (!response.ok) {
    throw new Error(`Failed to create upload session (${response.status})`)
  }

  const location = response.headers.get('Location')
  if (!location) {
    throw new Error('Upload session created without Location header')
  }

  const uploadUrl = toAbsoluteUploadUrl(apiBaseUrl, location)
  return {
    uploadUrl,
    videoId: extractVideoId(uploadUrl)
  }
}

const readUploadOffset = async (uploadUrl: string): Promise<number | null> => {
  const response = await fetch(uploadUrl, {
    method: 'HEAD',
    headers: { 'Tus-Resumable': TUS_VERSION }
  })

  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Failed to read upload offset (${response.status})`)
  }

  const rawOffset = response.headers.get('Upload-Offset')
  const parsedOffset = Number(rawOffset)
  if (!Number.isFinite(parsedOffset) || parsedOffset < 0) {
    throw new Error('Invalid Upload-Offset header returned by server')
  }

  return parsedOffset
}

const uploadChunk = async (uploadUrl: string, offset: number, chunk: ArrayBuffer) => {
  const response = await fetch(uploadUrl, {
    method: 'PATCH',
    headers: {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Offset': String(offset),
      'Content-Type': 'application/offset+octet-stream'
    },
    body: chunk
  })

  if (response.status === 409) {
    const current = Number(response.headers.get('Upload-Offset'))
    if (Number.isFinite(current)) return { nextOffset: current, conflict: true }
    throw new Error('Upload offset conflict with invalid server offset')
  }

  if (!response.ok) {
    throw new Error(`Chunk upload failed (${response.status})`)
  }

  const nextOffset = Number(response.headers.get('Upload-Offset'))
  if (!Number.isFinite(nextOffset)) {
    throw new Error('Chunk upload response missing Upload-Offset header')
  }

  return { nextOffset, conflict: false }
}

export const useTusUpload = () => {
  const isUploading = ref(false)

  const uploadFile = async (file: File, options: UploadOptions): Promise<UploadResult> => {
    isUploading.value = true
    const apiBaseUrl = sanitizeApiBaseUrl(options.apiBaseUrl)
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
    const sessionKey = getStorageKey(file)

    try {
      options.onStatus?.('Preparing upload session...')

      let session = readStoredSession(sessionKey)
      let currentOffset: number | null = null

      if (session) {
        currentOffset = await readUploadOffset(session.uploadUrl)
        if (currentOffset === null || currentOffset > file.size) {
          clearSession(sessionKey)
          session = null
          currentOffset = null
        }
      }

      if (!session) {
        session = await createSession(file, apiBaseUrl, options.visibility)
        storeSession(sessionKey, session)
      }

      if (currentOffset === null) {
        currentOffset = await readUploadOffset(session.uploadUrl)
        if (currentOffset === null) {
          clearSession(sessionKey)
          throw new Error('Upload session is no longer available')
        }
      }

      if (currentOffset >= file.size) {
        clearSession(sessionKey)
        options.onProgress?.(file.size, file.size)
        options.onStatus?.(`Upload complete. videoId: ${session.videoId}`)
        return {
          videoId: session.videoId,
          uploadUrl: session.uploadUrl
        }
      }

      if (currentOffset > 0) {
        options.onStatus?.(`Resuming upload at ${Math.round((currentOffset / file.size) * 100)}%...`)
      }

      while (currentOffset < file.size) {
        const chunkEnd = Math.min(file.size, currentOffset + chunkSize)
        const chunk = await file.slice(currentOffset, chunkEnd).arrayBuffer()
        const { nextOffset, conflict } = await uploadChunk(session.uploadUrl, currentOffset, chunk)
        currentOffset = nextOffset

        options.onProgress?.(currentOffset, file.size)

        if (!conflict) {
          options.onStatus?.(`Uploading... ${Math.round((currentOffset / file.size) * 100)}%`)
        }
      }

      clearSession(sessionKey)
      options.onStatus?.(`Upload complete. videoId: ${session.videoId}`)

      return {
        videoId: session.videoId,
        uploadUrl: session.uploadUrl
      }
    } finally {
      isUploading.value = false
    }
  }

  return {
    isUploading: readonly(isUploading),
    uploadFile
  }
}
