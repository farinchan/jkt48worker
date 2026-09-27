const { config } = require('../config');
const { parseMasterPlaylist } = require('../stream/masterPlaylist');
const { selectHighestVariant } = require('../stream/variantSelector');

async function testStream() {
  console.log(`Checking stream endpoint: ${config.STREAM_URL}`);
  console.log('--------------------------------------------------');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(config.STREAM_URL, {
      signal: controller.signal,
      headers: {
        'User-Agent': config.HTTP_USER_AGENT,
        Accept: '*/*'
      }
    });

    clearTimeout(timer);

    console.log(`HTTP Status: ${res.status} ${res.statusText}`);
    console.log(`Content-Type: ${res.headers.get('content-type')}`);

    if (!res.ok) {
      console.log('Stream reachable: NO');
      console.log(`Reason: HTTP status ${res.status}`);
      process.exit(1);
    }

    const text = await res.text();
    const parsed = parseMasterPlaylist(text, res.url || config.STREAM_URL);

    console.log(`Stream reachable: YES`);
    console.log(`Master playlist: ${parsed.isMaster ? 'YES' : 'NO'}`);
    console.log(`Direct media playlist: ${parsed.isDirectMedia ? 'YES' : 'NO'}`);

    if (parsed.isMaster) {
      console.log(`Variants: ${parsed.variants.length}\n`);
      console.log('Available variants:');
      for (const v of parsed.variants) {
        const resStr = v.width && v.height ? `${v.width}x${v.height}` : 'unknown resolution';
        const bwStr = v.bandwidth ? `${v.bandwidth} bps` : '';
        const fpsStr = v.frameRate ? `${v.frameRate}fps` : '';
        console.log(`- ${resStr} ${bwStr} ${fpsStr} [name: ${v.name || 'none'}]`);
      }

      const selected = selectHighestVariant(parsed.variants);
      console.log('\nSelected:');
      if (selected) {
        const selRes = selected.width && selected.height ? `${selected.width}x${selected.height}` : 'unknown';
        console.log(`${selRes} (${selected.bandwidth} bps, ${selected.frameRate}fps)`);
        console.log(`URI: ${selected.uri}`);
      } else {
        console.log('None');
      }
    } else if (parsed.isDirectMedia) {
      console.log('\nDirect media playlist detected.');
      console.log(`URI: ${parsed.uri}`);
    } else {
      console.log('\nEndpoint returned content, but no valid HLS playlist was found.');
      console.log('First 200 characters of response:');
      console.log(text.slice(0, 200));
    }
  } catch (err) {
    clearTimeout(timer);
    console.error('Stream reachable: NO');
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

testStream();
