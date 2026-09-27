const path = require('path');
const { config } = require('./config');
const { logger } = require('./logger');
const { AppDatabase } = require('./db/database');
const { StreamMonitor } = require('./stream/monitor');
const { StreamRecorder } = require('./recording/recorder');
const { GoogleDriveService } = require('./upload/googleDrive');
const { UploadWorker } = require('./upload/uploadWorker');
const { GracefulShutdownManager } = require('./system/shutdown');

async function main() {
  logger.info({ nodeEnv: config.NODE_ENV, pid: process.pid }, 'Starting JKT48 Stream Auto-Recorder');

  // 1. Initialize SQLite Database
  const dbPath = path.join(config.DATA_DIR, 'recorder.sqlite');
  const db = new AppDatabase(dbPath, logger);

  // 2. Acquire Application Single-Instance Lock (Section 43)
  const lockResult = db.acquireLock('jkt48_recorder_main', process.pid);
  if (!lockResult.acquired) {
    logger.fatal(
      {
        holderPid: lockResult.holderPid,
        acquiredAt: lockResult.acquiredAt
      },
      'Another instance of JKT48 Stream Recorder is already running. Exiting.'
    );
    process.exit(1);
  }

  // Periodic lock heartbeat
  const lockHeartbeatTimer = setInterval(() => {
    try {
      db.heartbeatLock('jkt48_recorder_main', process.pid);
    } catch {
      // ignore
    }
  }, 10000);
  lockHeartbeatTimer.unref();

  // 3. Crash Recovery (Section 35)
  const recovered = db.recoverStartupState(config.MIN_RECORDING_SIZE_BYTES);
  if (recovered.length > 0) {
    logger.info({ recoveredCount: recovered.length, recovered }, 'Crash recovery completed');
  }

  // 4. Initialize Google Drive & Upload Worker
  const driveService = new GoogleDriveService({ config, logger });
  await driveService.initialize();

  const uploadWorker = new UploadWorker({
    config,
    db,
    driveService,
    logger
  });
  uploadWorker.start();

  // 5. Initialize Stream Recorder
  const recorder = new StreamRecorder({ config, db, logger });

  // 6. Initialize Stream Monitor
  const monitor = new StreamMonitor({ config, logger });

  monitor.on('online', async (event) => {
    const { selectedVariant, variants } = event;

    if (!selectedVariant) {
      logger.warn('Stream is online but no suitable variant found');
      return;
    }

    if (recorder.isRecording()) {
      logger.debug('Stream online event received while already recording; continuing session');
      return;
    }

    if (config.DRY_RUN) {
      logger.info(
        {
          variantsCount: variants.length,
          selected: {
            resolution: `${selectedVariant.width}x${selectedVariant.height}`,
            bandwidth: selectedVariant.bandwidth,
            fps: selectedVariant.frameRate
          },
          dryRun: true
        },
        'Stream online — DRY_RUN=true, recording skipped'
      );
      return;
    }

    try {
      logger.info(
        {
          resolution: `${selectedVariant.width}x${selectedVariant.height}`,
          bandwidth: selectedVariant.bandwidth,
          fps: selectedVariant.frameRate,
          uri: selectedVariant.uri
        },
        'Starting new recording session for active stream'
      );

      const session = await recorder.startRecording(selectedVariant);

      // Await session completion in background
      session.sessionPromise
        .then((finalizeResult) => {
          if (finalizeResult && finalizeResult.success) {
            uploadWorker.triggerNow();
          }
        })
        .catch((sessionErr) => {
          logger.error({ err: sessionErr.message }, 'Recording session encountered an error');
        });
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to start recording');
    }
  });

  monitor.on('offline', () => {
    logger.info('Stream is currently offline. Monitoring continues...');
  });

  // 7. Register Graceful Shutdown Handlers
  const shutdownManager = new GracefulShutdownManager({
    config,
    db,
    monitor,
    recorder,
    uploadWorker,
    logger
  });
  shutdownManager.registerSignals();

  // 8. Start Monitoring
  monitor.start();
}

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Fatal application startup failure');
  process.exit(1);
});
