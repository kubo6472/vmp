import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildEntrypointCandidates,
  getVideoProxyCacheControl,
  sortMasterPlaylistByBandwidth,
} from '../src/mediaEntrypoints.js';
import { isImmutableVideoProxyObject, videoProxyObjectCacheKey } from '../src/videoProxyCache.js';

describe('buildEntrypointCandidates', () => {
  it('keeps HLS-first order by default', () => {
    const base = 'https://cdn.example.com';
    const videoId = 'vid_123';
    assert.deepEqual(buildEntrypointCandidates(base, videoId), [
      'https://cdn.example.com/videos/vid_123/master.m3u8',
      'https://cdn.example.com/videos/vid_123/processed/hls/master.m3u8',
      'https://cdn.example.com/videos/vid_123/processed/playlist.m3u8',
    ]);
  });

  it('adds podcast candidates first when preferPodcast is enabled', () => {
    const base = 'https://cdn.example.com';
    const videoId = 'vid_123';
    assert.deepEqual(buildEntrypointCandidates(base, videoId, { preferPodcast: true }), [
      'https://cdn.example.com/videos/vid_123/podcast.mp3',
      'https://cdn.example.com/videos/vid_123/processed/podcast.mp3',
      'https://cdn.example.com/videos/vid_123/processed/audio/podcast.mp3',
      'https://cdn.example.com/videos/vid_123/master.m3u8',
      'https://cdn.example.com/videos/vid_123/processed/hls/master.m3u8',
      'https://cdn.example.com/videos/vid_123/processed/playlist.m3u8',
    ]);
  });

  it('prefers preview MP3 then HLS when rssPreview is enabled', () => {
    const base = 'https://cdn.example.com';
    const videoId = 'vid_123';
    assert.deepEqual(
      buildEntrypointCandidates(base, videoId, { preferPodcast: true, rssPreview: true }),
      [
        'https://cdn.example.com/videos/vid_123/podcast_preview.mp3',
        'https://cdn.example.com/videos/vid_123/processed/podcast_preview.mp3',
        'https://cdn.example.com/videos/vid_123/master.m3u8',
        'https://cdn.example.com/videos/vid_123/processed/hls/master.m3u8',
        'https://cdn.example.com/videos/vid_123/processed/playlist.m3u8',
      ],
    );
  });
});

describe('getVideoProxyCacheControl', () => {
  it('returns short-lived cache for HLS playlists', () => {
    assert.equal(
      getVideoProxyCacheControl('videos/vid_123/master.m3u8', 'hls'),
      'public, max-age=60, s-maxage=60',
    );
  });

  it('returns immutable cache for CMAF segments', () => {
    assert.equal(
      getVideoProxyCacheControl('videos/vid_123/seg_1080_1.m4s', null),
      'public, max-age=31536000, immutable',
    );
  });

  it('returns immutable cache for CMAF init segments', () => {
    assert.equal(
      getVideoProxyCacheControl('videos/vid_123/init_1080.mp4', null),
      'public, max-age=31536000, immutable',
    );
  });

  it('returns null for non-HLS assets', () => {
    assert.equal(getVideoProxyCacheControl('videos/vid_123/poster.jpg', null), null);
  });
});

describe('sortMasterPlaylistByBandwidth', () => {
  it('orders STREAM-INF pairs ascending by BANDWIDTH', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8",GROUP-ID="a"',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="a"',
      'stream_hi.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,AUDIO="a"',
      'stream_lo.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="a"',
      'stream_mid.m3u8',
    ].join('\n');

    const sorted = sortMasterPlaylistByBandwidth(input);
    const lines = sorted.split('\n');
    assert.equal(lines[0], '#EXTM3U');
    assert.match(lines[1]!, /EXT-X-MEDIA/);
    assert.match(lines[2]!, /BANDWIDTH=800000/);
    assert.equal(lines[3], 'stream_lo.m3u8');
    assert.match(lines[4]!, /BANDWIDTH=2000000/);
    assert.equal(lines[5], 'stream_mid.m3u8');
    assert.match(lines[6]!, /BANDWIDTH=5000000/);
    assert.equal(lines[7], 'stream_hi.m3u8');
  });
});

describe('videoProxyCache keys', () => {
  it('treats m4s and init as immutable', () => {
    assert.equal(isImmutableVideoProxyObject('videos/x/seg_1.m4s'), true);
    assert.equal(isImmutableVideoProxyObject('videos/x/init_audio.mp4'), true);
    assert.equal(isImmutableVideoProxyObject('videos/x/master.m3u8'), false);
  });

  it('builds path-only cache keys without query strings', () => {
    const key = videoProxyObjectCacheKey('videos/abc/seg_1.m4s');
    assert.equal(new URL(key.url).pathname, '/videos/abc/seg_1.m4s');
    assert.equal(new URL(key.url).search, '');
  });
});
