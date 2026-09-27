const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMasterPlaylist, parseAttributes } = require('../src/stream/masterPlaylist');

test('parseAttributes handles unquoted, quoted with comma, and spacing', () => {
  const line = 'BANDWIDTH=8154731,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000';
  const attrs = parseAttributes(line);

  assert.equal(attrs.BANDWIDTH, '8154731');
  assert.equal(attrs.RESOLUTION, '1920x1080');
  assert.equal(attrs.CODECS, 'avc1.64002A,mp4a.40.2');
  assert.equal(attrs.VIDEO, 'chunked');
  assert.equal(attrs['FRAME-RATE'], '60.000');
});

test('parseMasterPlaylist parses all 5 standard variants: 1080p, 720p, 480p, 360p, 160p', () => {
  const playlist = `#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="160p30",NAME="160p",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=230000,RESOLUTION=284x160,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="160p30",FRAME-RATE=30.000
https://example.com/160p.m3u8

#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="360p30",NAME="360p",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=630000,RESOLUTION=640x360,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="360p30",FRAME-RATE=30.000
https://example.com/360p.m3u8

#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="480p30",NAME="480p",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=1427999,RESOLUTION=852x480,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="480p30",FRAME-RATE=30.000
https://example.com/480p.m3u8

#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=3422999,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000
https://example.com/720p.m3u8

#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=8154731,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000
https://example.com/1080p.m3u8
`;

  const result = parseMasterPlaylist(playlist, 'https://example.com/playback');
  assert.equal(result.isMaster, true);
  assert.equal(result.isDirectMedia, false);
  assert.equal(result.variants.length, 5);

  const resMap = Object.fromEntries(result.variants.map((v) => [`${v.width}x${v.height}`, v]));
  assert.ok(resMap['1920x1080']);
  assert.equal(resMap['1920x1080'].bandwidth, 8154731);
  assert.equal(resMap['1920x1080'].frameRate, 60.0);
  assert.equal(resMap['1920x1080'].name, '1080p60');

  assert.ok(resMap['1280x720']);
  assert.ok(resMap['852x480']);
  assert.ok(resMap['640x360']);
  assert.ok(resMap['284x160']);
});

test('parseMasterPlaylist handles relative URLs correctly', () => {
  const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720
/live/stream_720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080
relative_1080p.m3u8
`;
  const result = parseMasterPlaylist(playlist, 'https://your-worker-domain.workers.dev/playback');
  assert.equal(result.variants.length, 2);
  assert.equal(result.variants[0].uri, 'https://your-worker-domain.workers.dev/live/stream_720p.m3u8');
  assert.equal(result.variants[1].uri, 'https://your-worker-domain.workers.dev/relative_1080p.m3u8');
});

test('parseMasterPlaylist handles variant with missing RESOLUTION', () => {
  const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1500000
https://example.com/audio-only.m3u8
`;
  const result = parseMasterPlaylist(playlist);
  assert.equal(result.variants.length, 1);
  assert.equal(result.variants[0].width, null);
  assert.equal(result.variants[0].height, null);
  assert.equal(result.variants[0].bandwidth, 1500000);
});

test('parseMasterPlaylist detects direct media playlist fallback', () => {
  const directPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXTINF:6.000,
segment0.ts
#EXTINF:6.000,
segment1.ts
`;
  const result = parseMasterPlaylist(directPlaylist, 'https://example.com/direct/live.m3u8');
  assert.equal(result.isMaster, false);
  assert.equal(result.isDirectMedia, true);
  assert.equal(result.uri, 'https://example.com/direct/live.m3u8');
});

test('parseMasterPlaylist returns empty on malformed or non-M3U8 text', () => {
  const html = `<html><body>Not found</body></html>`;
  const result = parseMasterPlaylist(html);
  assert.equal(result.isMaster, false);
  assert.equal(result.isDirectMedia, false);
  assert.equal(result.variants.length, 0);
});
