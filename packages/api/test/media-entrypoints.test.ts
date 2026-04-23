import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildEntrypointCandidates } from '../src/mediaEntrypoints.js'
import { getVideoProxyCacheControl } from '../src/mediaEntrypoints.js'

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

  it('prefers preview MP3 then HLS when rssPreview is enabled', () => {
    const base = 'https://cdn.example.com'
    const videoId = 'vid_123'
    assert.deepEqual(buildEntrypointCandidates(base, videoId, { preferPodcast: true, rssPreview: true }), [
      'https://cdn.example.com/videos/vid_123/podcast_preview.mp3',
      'https://cdn.example.com/videos/vid_123/processed/podcast_preview.mp3',
      'https://cdn.example.com/videos/vid_123/master.m3u8',
      'https://cdn.example.com/videos/vid_123/processed/hls/master.m3u8',
      'https://cdn.example.com/videos/vid_123/processed/playlist.m3u8',
    ])
  })
})

describe('getVideoProxyCacheControl', () => {
  it('returns short-lived cache for HLS playlists', () => {
    assert.equal(
      getVideoProxyCacheControl('videos/vid_123/master.m3u8', 'hls'),
      'public, max-age=60, s-maxage=60',
    )
  })

  it('returns immutable cache for CMAF segments', () => {
    assert.equal(
      getVideoProxyCacheControl('videos/vid_123/seg_1080_1.m4s', null),
      'public, max-age=31536000, immutable',
    )
  })

  it('returns immutable cache for CMAF init segments', () => {
    assert.equal(
      getVideoProxyCacheControl('videos/vid_123/init_1080.mp4', null),
      'public, max-age=31536000, immutable',
    )
  })

  it('returns null for non-HLS assets', () => {
    assert.equal(
      getVideoProxyCacheControl('videos/vid_123/poster.jpg', null),
      null,
    )
  })
})
