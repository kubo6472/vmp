import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildEntrypointCandidates } from '../src/mediaEntrypoints.js'

describe('buildEntrypointCandidates', () => {
  it('keeps HLS-first order by default', () => {
    const base = 'https://cdn.example.com'
    const videoId = 'vid_123'
    assert.deepEqual(buildEntrypointCandidates(base, videoId), [
      'https://cdn.example.com/videos/vid_123/master.m3u8',
      'https://cdn.example.com/videos/vid_123/processed/hls/master.m3u8',
      'https://cdn.example.com/videos/vid_123/processed/playlist.m3u8',
    ])
  })

  it('adds podcast candidates first when preferPodcast is enabled', () => {
    const base = 'https://cdn.example.com'
    const videoId = 'vid_123'
    assert.deepEqual(buildEntrypointCandidates(base, videoId, { preferPodcast: true }), [
      'https://cdn.example.com/videos/vid_123/podcast.mp3',
      'https://cdn.example.com/videos/vid_123/processed/podcast.mp3',
      'https://cdn.example.com/videos/vid_123/processed/audio/podcast.mp3',
      'https://cdn.example.com/videos/vid_123/master.m3u8',
      'https://cdn.example.com/videos/vid_123/processed/hls/master.m3u8',
      'https://cdn.example.com/videos/vid_123/processed/playlist.m3u8',
    ])
  })
})
