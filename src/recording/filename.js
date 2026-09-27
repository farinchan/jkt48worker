const path = require('path');

function getDateParts(date = new Date(), timeZone = 'Asia/Jakarta') {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value])
  );

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

function generateRecordingFilenames(date = new Date(), timeZone = 'Asia/Jakarta', baseDir = './recordings') {
  const parts = getDateParts(date, timeZone);
  const baseName = `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}`;
  const filename = `${baseName}.mp4`;
  const partialFilename = `${baseName}.partial.mp4`;

  const relativeDir = path.join(parts.year, parts.month, parts.day);
  const targetDir = path.resolve(baseDir, relativeDir);

  const finalPath = path.join(targetDir, filename);
  const partialPath = path.join(targetDir, partialFilename);

  return {
    baseName,
    filename,
    partialFilename,
    targetDir,
    finalPath,
    partialPath,
    dateParts: parts
  };
}

module.exports = {
  getDateParts,
  generateRecordingFilenames
};
