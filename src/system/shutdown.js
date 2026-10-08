class GracefulShutdownManager {
  constructor({ config, db, monitor, recorder, uploadWorker, webServer, telegramNotifier, logger }) {
    this.config = config;
    this.db = db;
    this.monitor = monitor;
    this.recorder = recorder;
    this.uploadWorker = uploadWorker;
    this.webServer = webServer || null;
    this.telegramNotifier = telegramNotifier || null;
    this.logger = logger;
    this.isShuttingDown = false;
  }

  registerSignals() {
    const handleSignal = (sig) => {
      this.logger.info({ signal: sig }, 'Received shutdown signal');
      this.shutdown(sig);
    };

    process.once('SIGINT', () => handleSignal('SIGINT'));
    process.once('SIGTERM', () => handleSignal('SIGTERM'));

    // Handle unexpected exceptions
    process.on('uncaughtException', (err) => {
      this.logger.fatal({ err }, 'Uncaught exception');
      this.shutdown(`Uncaught exception: ${err.message}`, 1);
    });

    process.on('unhandledRejection', (reason) => {
      this.logger.fatal({ reason }, 'Unhandled promise rejection');
    });
  }

  async shutdown(reason = 'unknown', exitCode = 0) {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.logger.info({ reason }, 'Initiating graceful shutdown sequence');

    if (this.telegramNotifier && this.telegramNotifier.isConfigured()) {
      try {
        await this.telegramNotifier.notifyWorkerStopped({
          reason,
          uptimeSeconds: Math.floor(process.uptime())
        });
      } catch (tgErr) {
        this.logger.warn({ err: tgErr.message }, 'Failed to send worker stopped alert to Telegram');
      }
    }

    const forceTimer = setTimeout(() => {
      this.logger.error('Shutdown timed out; forcing exit');
      process.exit(1);
    }, this.config.SHUTDOWN_TIMEOUT_MS);

    try {
      // 1. Stop stream monitor so no new recordings are triggered
      if (this.monitor) {
        this.monitor.stop();
      }

      // 2. Stop active recording session if in progress
      if (this.recorder && this.recorder.isRecording()) {
        this.logger.info('Stopping active recording session');
        await this.recorder.stopRecording();
      }

      // 3. Stop upload worker and web server
      if (this.webServer) {
        await this.webServer.stop();
      }

      if (this.uploadWorker) {
        this.uploadWorker.stop();
      }

      // 4. Release lock and close DB
      if (this.db) {
        try {
          this.db.releaseLock('jkt48_recorder_main', process.pid);
        } catch {
          // ignore
        }
        this.db.close();
      }

      this.logger.info('Graceful shutdown completed successfully');
      clearTimeout(forceTimer);
      process.exit(exitCode);
    } catch (err) {
      this.logger.error({ err }, 'Error during graceful shutdown');
      clearTimeout(forceTimer);
      process.exit(1);
    }
  }
}

module.exports = {
  GracefulShutdownManager
};
