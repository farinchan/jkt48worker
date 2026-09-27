/**
 * Master HLS Playlist Parser
 * Parses HLS master playlists into structured variant models.
 * Supports direct media playlist fallback.
 */

function parseAttributes(attrString) {
  const attrs = {};
  if (!attrString) return attrs;

  let i = 0;
  const len = attrString.length;

  while (i < len) {
    // Skip whitespace and commas
    while (i < len && (attrString[i] === ' ' || attrString[i] === '\t' || attrString[i] === ',')) {
      i++;
    }
    if (i >= len) break;

    // Read Key
    const keyStart = i;
    while (i < len && attrString[i] !== '=' && attrString[i] !== ',' && attrString[i] !== ' ') {
      i++;
    }
    const key = attrString.slice(keyStart, i).trim().toUpperCase();

    // Expect '='
    while (i < len && (attrString[i] === ' ' || attrString[i] === '\t')) {
      i++;
    }
    if (i >= len || attrString[i] !== '=') {
      attrs[key] = true;
      continue;
    }
    i++; // Skip '='

    while (i < len && (attrString[i] === ' ' || attrString[i] === '\t')) {
      i++;
    }
    if (i >= len) {
      attrs[key] = '';
      break;
    }

    // Read Value
    let val = '';
    if (attrString[i] === '"') {
      i++; // Skip opening quote
      const valStart = i;
      while (i < len && attrString[i] !== '"') {
        if (attrString[i] === '\\' && i + 1 < len) {
          i += 2; // escaped char
        } else {
          i++;
        }
      }
      val = attrString.slice(valStart, i);
      if (i < len && attrString[i] === '"') {
        i++; // Skip closing quote
      }
    } else {
      const valStart = i;
      while (i < len && attrString[i] !== ',') {
        i++;
      }
      val = attrString.slice(valStart, i).trim();
    }

    attrs[key] = val;
  }

  return attrs;
}

function parseMasterPlaylist(content, masterUrl = '') {
  if (typeof content !== 'string') {
    return { isMaster: false, isDirectMedia: false, variants: [] };
  }

  const lines = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim());

  if (lines.length === 0 || !lines[0].startsWith('#EXTM3U')) {
    return { isMaster: false, isDirectMedia: false, variants: [] };
  }

  // Check for direct media playlist (#EXTINF present without #EXT-X-STREAM-INF)
  const hasStreamInf = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'));
  const hasExtInf = lines.some((l) => l.startsWith('#EXTINF:'));

  if (!hasStreamInf && hasExtInf) {
    return {
      isMaster: false,
      isDirectMedia: true,
      uri: masterUrl,
      variants: []
    };
  }

  if (!hasStreamInf) {
    return { isMaster: false, isDirectMedia: false, variants: [] };
  }

  // Map video groups to names from #EXT-X-MEDIA:TYPE=VIDEO
  const videoMediaMap = new Map();
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      if (attrs.TYPE === 'VIDEO' && attrs['GROUP-ID']) {
        videoMediaMap.set(attrs['GROUP-ID'], attrs.NAME || attrs['GROUP-ID']);
      }
    }
  }

  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrStr = line.slice('#EXT-X-STREAM-INF:'.length);
      const attrs = parseAttributes(attrStr);

      // Find the following non-comment, non-empty URI line
      let uriLine = '';
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (!next || next.startsWith('#')) {
          continue;
        }
        uriLine = next;
        break;
      }

      if (!uriLine) continue;

      let resolvedUri = uriLine;
      if (masterUrl) {
        try {
          resolvedUri = new URL(uriLine, masterUrl).href;
        } catch {
          resolvedUri = uriLine;
        }
      }

      let width = null;
      let height = null;
      if (attrs.RESOLUTION) {
        const match = attrs.RESOLUTION.match(/^(\d+)x(\d+)$/i);
        if (match) {
          width = parseInt(match[1], 10);
          height = parseInt(match[2], 10);
        }
      }

      const bandwidth = attrs.BANDWIDTH ? parseInt(attrs.BANDWIDTH, 10) : null;
      const averageBandwidth = attrs['AVERAGE-BANDWIDTH']
        ? parseInt(attrs['AVERAGE-BANDWIDTH'], 10)
        : null;
      const frameRate = attrs['FRAME-RATE'] ? parseFloat(attrs['FRAME-RATE']) : null;
      const codecs = attrs.CODECS || null;
      const videoGroup = attrs.VIDEO || null;
      const name = videoGroup && videoMediaMap.has(videoGroup)
        ? videoMediaMap.get(videoGroup)
        : (height ? `${height}p` : null);

      variants.push({
        uri: resolvedUri,
        rawUri: uriLine,
        width,
        height,
        bandwidth,
        averageBandwidth,
        frameRate,
        codecs,
        videoGroup,
        name
      });
    }
  }

  return {
    isMaster: true,
    isDirectMedia: false,
    variants
  };
}

module.exports = {
  parseAttributes,
  parseMasterPlaylist
};
