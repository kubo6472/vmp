import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import {
  collectStartupMediaUrls,
  pickAudioPlaylistUrls,
  pickLowestBandwidthPlaylistUrl,
  prefetchHlsStartup,
} from '../utils/hlsStartupPrefetch';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
});

describe('pickLowestBandwidthPlaylistUrl', () => {
  it('selects the cheapest STREAM-INF URI', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000',
      'hi.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000',
      'lo.m3u8',
    ].join('\n');
    assert.equal(
      pickLowestBandwidthPlaylistUrl(master, 'https://api.example/videos/v/master.m3u8?vt=1'),
      'https://api.example/videos/v/lo.m3u8?vt=1',
    );
  });
});

describe('pickAudioPlaylistUrls', () => {
  it('collects EXT-X-MEDIA audio URIs', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="main",URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="a"',
      'lo.m3u8',
    ].join('\n');
    assert.deepEqual(pickAudioPlaylistUrls(master, 'https://api.example/v/master.m3u8'), [
      'https://api.example/v/audio.m3u8',
    ]);
  });
});

describe('collectStartupMediaUrls', () => {
  it('returns init plus the first N segments', () => {
    const media = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:6.0,',
      'seg1.m4s',
      '#EXTINF:6.0,',
      'seg2.m4s',
      '#EXTINF:6.0,',
      'seg3.m4s',
    ].join('\n');
    assert.deepEqual(collectStartupMediaUrls(media, 'https://api.example/v/lo.m3u8', 2), [
      'https://api.example/v/init.mp4',
      'https://api.example/v/seg1.m4s',
      'https://api.example/v/seg2.m4s',
    ]);
  });
});

describe('prefetchHlsStartup', () => {
  it('warms lowest ladder init and segments', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('master.m3u8')) {
        return new Response(
          [
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8",GROUP-ID="a"',
            '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="a"',
            'hi.m3u8',
            '#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="a"',
            'lo.m3u8',
          ].join('\n'),
          { status: 200 },
        );
      }
      if (url.includes('lo.m3u8') || url.includes('audio.m3u8')) {
        return new Response(
          ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:6.0,', 'seg1.m4s'].join('\n'),
          { status: 200 },
        );
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;

    await prefetchHlsStartup('https://api.example/v/master.m3u8?vt=tok', { segmentCount: 1 });
    assert.ok(calls.some((u) => u.includes('master.m3u8')));
    assert.ok(calls.some((u) => u.includes('lo.m3u8')));
    assert.ok(calls.some((u) => u.includes('audio.m3u8')));
    assert.ok(calls.some((u) => u.includes('/init.mp4')));
    assert.ok(calls.some((u) => u.includes('/seg1.m4s')));
    assert.ok(!calls.some((u) => u.includes('/hi.m3u8')));
  });
});
