export interface User {
  id: string
  email: string
  createdAt: string
}

export interface Subscription {
  id: number
  userId: string
  planType: 'free' | 'premium'
  status: 'active' | 'cancelled' | 'expired'
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

export interface Video {
  id: string
  title: string
  fullDuration: number
  previewDuration: number
  createdAt: string
}

export interface Chapter {
  title: string
  startTime: number
  endTime: number
  accessible: boolean
}

export interface VideoAccessResponse {
  userId: string
  videoId: string
  hasAccess: boolean
  subscription: {
    planType: string
    status: string
    expiresAt: string | null
  }
  video: {
    title: string
    fullDuration: number
    previewDuration: number
    playlistUrl: string
  }
  chapters: Chapter[]
}