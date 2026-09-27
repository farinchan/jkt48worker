const { spawn } = require('child_process');
const fs = require('fs');

/**
 * Probes a media file using ffprobe.
 */
function probeMedia(filePath, ffprobePath = 'ffprobe') {
  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'error',
      '-show_entries',
      'format=duration,size,bit_rate:stream=codec_name,width,height,r_frame_rate',
      '-of',
      'json',
      filePath
    ];

    const child = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`FFprobe spawn error: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`FFprobe failed (code ${code}): ${stderr.trim()}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        const format = parsed.format || {};
        const videoStream = (parsed.streams || []).find((s) => s.width && s.height) || {};
        const audioStream = (parsed.streams || []).find((s) => s.codec_name && !s.width) || {};

        let frameRate = null;
        if (videoStream.r_frame_rate) {
          const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
          if (den) frameRate = parseFloat((num / den).toFixed(2));
        }

        resolve({
          duration: format.duration ? parseFloat(format.duration) : null,
          size: format.size ? parseInt(format.size, 10) : null,
          bitRate: format.bit_rate ? parseInt(format.bit_rate, 10) : null,
          width: videoStream.width || null,
          height: videoStream.height || null,
          frameRate,
          videoCodec: videoStream.codec_name || null,
          audioCodec: audioStream.codec_name || null
        });
      } catch (e) {
        reject(new Error(`Failed to parse FFprobe JSON: ${e.message}`));
      }
    });
  });
}

/**
 * Spawns an FFmpeg recording process with reconnect and custom HLS options.
 */
function startFfmpegRecording({
  ffmpegPath = 'ffmpeg',
  streamUrl,
  outputPath,
  durationLimitSeconds = null,
  logger = null
}) {
  const args = [
    '-y',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '5',
    '-allowed_extensions',
    'ALL',
    '-allowed_segment_extensions',
    'ALL',
    '-extension_picky',
    '0',
    '-f',
    'hls',
    '-i',
    streamUrl
  ];

  if (durationLimitSeconds) {
    args.push('-t', durationLimitSeconds.toString());
  }

  args.push('-c', 'copy', outputPath);

  if (logger) {
    logger.info({ ffmpegPath, outputPath, streamUrl }, 'Spawning FFmpeg recorder');
  }

  const child = spawn(ffmpegPath, args, {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stderrBuffer = '';
  child.stderr.on('data', (chunk) => {
    const str = chunk.toString();
    stderrBuffer += str;
    if (stderrBuffer.length > 20000) {
      stderrBuffer = stderrBuffer.slice(-20000);
    }
  });

  return {
    child,
    getStderr: () => stderrBuffer,
    stopGracefully: (timeoutMs = 10000) => {
      return new Promise((resolve) => {
        let timer = null;

        const onExit = (code) => {
          if (timer) clearTimeout(timer);
          resolve(code);
        };

        child.once('close', onExit);

        // Try writing 'q' to stdin for FFmpeg clean shutdown
        try {
          if (child.stdin && child.stdin.writable) {
            child.stdin.write('q\n');
          }
        } catch {
          // Ignore
        }

        timer = setTimeout(() => {
          try {
            child.kill('SIGINT');
          } catch {
            // Ignore
          }
          timer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // Ignore
            }
          }, 3000);
        }, timeoutMs);
      });
    }
  };
}

module.exports = {
  probeMedia,
  startFfmpegRecording
};
