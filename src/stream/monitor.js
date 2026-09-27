const EventEmitter = require('events');
const { parseMasterPlaylist } = require('./masterPlaylist');
const { selectHighestVariant } = require('./variantSelector');

class StreamMonitor extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger;
    this.timer = null;
    this.isPolling = false;
    this.consecutiveFailures = 0;
    this.lastState = 'OFFLINE';
    this.lastSelectedVariant = null;
  }

  start() {
    if (this.timer) return;
    this.logger.info(
      { url: this.config.STREAM_URL, intervalMs: this.config.POLL_INTERVAL_MS },
      'Stream monitor started'
    );
    this.pollOnce();
    this.timer = setInterval(() => this.pollOnce(), this.config.POLL_INTERVAL_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('Stream monitor stopped');
  }

  async checkStream() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(this.config.STREAM_URL, {
        signal: controller.signal,
        headers: {
          'User-Agent': this.config.HTTP_USER_AGENT,
          Accept: '*/*'
        }
      });

      if (!response.ok) {
        return {
          isOnline: false,
          reason: `HTTP ${response.status} ${response.statusText}`,
          statusCode: response.status
        };
      }

      const text = await response.text();
      const parsed = parseMasterPlaylist(text, response.url || this.config.STREAM_URL);

      if (parsed.isMaster && parsed.variants.length > 0) {
        const selected = selectHighestVariant(parsed.variants);
        return {
          isOnline: true,
          isMaster: true,
          variants: parsed.variants,
          selectedVariant: selected,
          rawPlaylist: text
        };
      }

      if (parsed.isDirectMedia) {
        return {
          isOnline: true,
          isDirectMedia: true,
          selectedVariant: {
            uri: parsed.uri,
            width: null,
            height: null,
            bandwidth: null,
            frameRate: null,
            name: 'direct-media'
          },
          variants: [],
          rawPlaylist: text
        };
      }

      return {
        isOnline: false,
        reason: 'Response is not a valid HLS master or media playlist'
      };
    } catch (err) {
      const isAbort = err.name === 'AbortError';
      const msg = isAbort ? `Request timed out after ${this.config.REQUEST_TIMEOUT_MS}ms` : err.message;
      return {
        isOnline: false,
        reason: msg
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async pollOnce() {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const result = await this.checkStream();

      if (result.isOnline) {
        this.consecutiveFailures = 0;
        this.lastSelectedVariant = result.selectedVariant;

        if (this.lastState !== 'ONLINE') {
          this.logger.info(
            {
              variantsCount: result.variants.length,
              selected: result.selectedVariant
                ? {
                    resolution:
                      result.selectedVariant.width && result.selectedVariant.height
                        ? `${result.selectedVariant.width}x${result.selectedVariant.height}`
                        : 'unknown',
                    bandwidth: result.selectedVariant.bandwidth,
                    fps: result.selectedVariant.frameRate,
                    uri: result.selectedVariant.uri
                  }
                : null
            },
            'Stream online'
          );
          this.lastState = 'ONLINE';
          this.emit('online', result);
        } else {
          // Still online
          this.emit('heartbeat', result);
        }
      } else {
        this.consecutiveFailures++;
        if (this.lastState !== 'OFFLINE') {
          this.logger.info({ reason: result.reason }, 'Stream offline');
          this.lastState = 'OFFLINE';
          this.lastSelectedVariant = null;
          this.emit('offline', result);
        } else {
          this.logger.debug({ reason: result.reason }, 'Stream check: offline');
        }
      }
    } catch (err) {
      this.logger.error({ err: err.message }, 'Unexpected error during stream polling');
    } finally {
      this.isPolling = false;
    }
  }
}

module.exports = {
  StreamMonitor
};
