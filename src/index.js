const path = require('path');
const { config } = require('./config');
const { logger } = require('./logger');
const { AppDatabase } = require('./db/database');
const { StreamMonitor } = require('./stream/monitor');
const { StreamRecorder } = require('./recording/recorder');
const { GoogleDriveService } = require('./upload/googleDrive');
const { YouTubeService } = require('./upload/youtube');
const { UploadWorker } = require('./upload/uploadWorker');
const { WebServer } = require('./web/server');
const { TelegramNotifier } = require('./notifier/telegram');
const { GracefulShutdownManager } = require('./system/shutdown');
const { getDiskSpace } = require('./system/diskSpace');

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

  // 4. Initialize Google Drive & YouTube Services
  const driveService = new GoogleDriveService({ config, logger });
  await driveService.initialize();

  const youtubeService = new YouTubeService({ config, logger });
  if (config.YOUTUBE_UPLOAD_ENABLED) {
    await youtubeService.initialize();
  }

  // 5. Initialize Telegram Notifier
  const telegramNotifier = new TelegramNotifier({ config, logger });
  if (telegramNotifier.isConfigured()) {
    logger.info('Telegram bot notifications enabled');
    if (recovered.length > 0) {
      await telegramNotifier.notifyCrashRecovery({
        recoveredCount: recovered.length,
        items: recovered
      });
    }
  }

  // 6. Initialize Upload Worker (coordinates Drive + YouTube uploads)
  const uploadWorker = new UploadWorker({
    config,
    db,
    driveService,
    youtubeService,
    telegramNotifier,
    logger
  });
  uploadWorker.start();

  // 7. Initialize Stream Recorder
  const recorder = new StreamRecorder({ config, db, logger });

  // 8. Initialize Stream Monitor
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

      await telegramNotifier.notifyStreamOnline({
        variant: selectedVariant,
        filename: session.filename
      });

      // Await session completion in background
      session.sessionPromise
        .then(async (finalizeResult) => {
          if (finalizeResult && finalizeResult.success) {
            const rec = finalizeResult.recording;
            await telegramNotifier.notifyRecordingFinished({
              filename: rec ? rec.filename : session.filename,
              durationSeconds: rec ? rec.duration_seconds : null,
              fileSize: rec ? rec.file_size : null,
              status: rec ? rec.status : 'PENDING_UPLOAD'
            });
            uploadWorker.triggerNow();
          } else if (finalizeResult && !finalizeResult.success) {
            await telegramNotifier.notifyRecordingFailed({
              filename: session.filename,
              reason: finalizeResult.reason,
              exitCode: finalizeResult.exitCode
            });
          }
        })
        .catch(async (sessionErr) => {
          logger.error({ err: sessionErr.message }, 'Recording session encountered an error');
          await telegramNotifier.notifyRecordingFailed({
            filename: session.filename,
            reason: sessionErr.message
          });
        });
    } catch (err) {
      if (err.message && err.message.includes('Insufficient disk space')) {
        const disk = getDiskSpace(config.RECORDINGS_DIR);
        await telegramNotifier.notifyLowDiskSpace({
          freeGb: disk.freeGb,
          minFreeGb: config.MIN_FREE_DISK_GB
        });
      } else {
        await telegramNotifier.notifyRecordingFailed({
          filename: 'session-start',
          reason: err.message
        });
      }
      logger.error({ err: err.message }, 'Failed to start recording');
    }
  });

  monitor.on('offline', () => {
    logger.info('Stream is currently offline. Monitoring continues...');
  });

  // 9. Start Web Management Server (if enabled)
  let webServer = null;
  if (config.WEB_ENABLED) {
    webServer = new WebServer({
      config,
      db,
      monitor,
      recorder,
      uploadWorker,
      telegramNotifier,
      logger
    });
    await webServer.start();
  }

  // 10. Register Graceful Shutdown Handlers
  const shutdownManager = new GracefulShutdownManager({
    config,
    db,
    monitor,
    recorder,
    uploadWorker,
    webServer,
    telegramNotifier,
    logger
  });
  shutdownManager.registerSignals();

  // 11. Start Monitoring
  monitor.start();

  // 12. Send Worker Online Notification
  const disk = getDiskSpace(config.RECORDINGS_DIR);
  await telegramNotifier.notifyWorkerStarted({
    nodeEnv: config.NODE_ENV,
    pid: process.pid,
    port: config.WEB_ENABLED ? config.WEB_PORT : null,
    driveEnabled: Boolean(config.GOOGLE_DRIVE_FOLDER_ID),
    youtubeEnabled: Boolean(config.YOUTUBE_UPLOAD_ENABLED),
    freeDiskGb: disk.freeGb,
    streamUrl: config.STREAM_URL
  });

  // 13. Optional Periodic Heartbeat
  if (config.TELEGRAM_HEARTBEAT_INTERVAL_MINUTES > 0 && telegramNotifier.isConfigured()) {
    const intervalMs = config.TELEGRAM_HEARTBEAT_INTERVAL_MINUTES * 60 * 1000;
    const heartbeatTimer = setInterval(async () => {
      try {
        const curDisk = getDiskSpace(config.RECORDINGS_DIR);
        await telegramNotifier.notifyStatusReport({
          isRecording: recorder.isRecording(),
          activeFile: recorder.currentSession ? recorder.currentSession.finalPath : null,
          queueCount: db.countPendingUploads(),
          freeDiskGb: curDisk.freeGb,
          uptimeSeconds: Math.floor(process.uptime())
        });
      } catch (hbErr) {
        logger.warn({ err: hbErr.message }, 'Failed to send periodic heartbeat to Telegram');
      }
    }, intervalMs);
    heartbeatTimer.unref();
  }
}

main().catch(async (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Fatal application startup failure');
  try {
    const emergencyNotifier = new TelegramNotifier({ config, logger });
    if (emergencyNotifier.isConfigured()) {
      await emergencyNotifier.sendMessage(
        `🚨 <b>JKT48 Worker Startup Fatal Error</b>\n\n<code>${err.message}</code>`
      );
    }
  } catch {
    // ignore
  }
  process.exit(1);
});
