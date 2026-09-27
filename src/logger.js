const fs = require('fs');
const path = require('path');
const pino = require('pino');

function createLogger(config = {}) {
  const logDir = config.LOG_DIR || path.resolve(process.cwd(), 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logLevel = config.LOG_LEVEL || process.env.LOG_LEVEL || 'info';
  const logFilePath = path.join(logDir, 'app.log');
  const fileStream = fs.createWriteStream(logFilePath, { flags: 'a' });

  const streams = [{ level: logLevel, stream: fileStream }];

  if (process.env.NODE_ENV !== 'production') {
    let prettyStream;
    try {
      prettyStream = require('pino-pretty')({
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
        ignore: 'pid,hostname'
      });
    } catch {
      prettyStream = process.stdout;
    }
    streams.push({ level: logLevel, stream: prettyStream });
  } else {
    streams.push({ level: logLevel, stream: process.stdout });
  }

  return pino(
    {
      level: logLevel,
      redact: {
        paths: [
          'access_token',
          'refresh_token',
          'token',
          'client_secret',
          'clientSecret',
          'password',
          'authorization',
          'headers.authorization',
          'headers.cookie'
        ],
        censor: '[REDACTED]'
      }
    },
    pino.multistream(streams)
  );
}

const defaultLogger = createLogger();

module.exports = {
  createLogger,
  logger: defaultLogger
};
