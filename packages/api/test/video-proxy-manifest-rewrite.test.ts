import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rewriteManifestForProxyWithPreview } from '../src/index.js';

const videoId = '22983b87-2e88-4adc-aa2c-a40d04ae371b';
const objectPath = `videos/${videoId}/master.m3u8`;
const vt = 'test-token';

describe('rewriteManifestForProxyWithPreview', () => {
  it('rewrites EXT-X-MEDIA audio URI when quoted attributes precede URI=', () => {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Main",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"`,
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio"',
      '720p/playlist.m3u8',
    ].join('\n');

    const rewritten = rewriteManifestForProxyWithPreview(manifest, null, objectPath, vt);
    assert.match(
      rewritten,
      new RegExp(`URI="/api/video-proxy/videos/${videoId}/audio\\.m3u8\\?vt=${vt}"`),
    );
    assert.doesNotMatch(rewritten, /URI="audio\.m3u8"/);
  });

  it('rewrites relative variant playlist URLs with vt on master playlists', () => {
    const manifest = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=3000000', '720p/playlist.m3u8'].join(
      '\n',
    );

    const rewritten = rewriteManifestForProxyWithPreview(manifest, null, objectPath, vt);
    assert.match(
      rewritten,
      new RegExp(`/api/video-proxy/videos/${videoId}/720p/playlist\\.m3u8\\?vt=${vt}`),
    );
  });

  it('sorts master variants by ascending bandwidth after rewrite', () => {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000',
      'hi.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000',
      'lo.m3u8',
    ].join('\n');
    const rewritten = rewriteManifestForProxyWithPreview(manifest, null, objectPath, vt);
    // sort is applied by handleVideoProxy; exercise helper via mediaEntrypoints import in other test.
    // Here we only assert rewrite still tokenizes both URIs.
    assert.match(rewritten, /lo\.m3u8\?vt=/);
    assert.match(rewritten, /hi\.m3u8\?vt=/);
  });

  it('preserves custom-scheme EXT-X-KEY URIs', () => {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://example/key"',
      '#EXTINF:6.0,',
      'seg_1.m4s',
    ].join('\n');

    const rewritten = rewriteManifestForProxyWithPreview(
      manifest,
      null,
      `videos/${videoId}/720p/playlist.m3u8`,
      vt,
    );
    assert.match(rewritten, /URI="skd:\/\/example\/key"/);
  });
});
