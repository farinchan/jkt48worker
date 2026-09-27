const fs = require('fs');
const path = require('path');

function getDiskSpace(targetPath = process.cwd()) {
  try {
    const resolved = path.resolve(targetPath);
    // Ensure path exists for statfs
    let checkPath = resolved;
    while (!fs.existsSync(checkPath)) {
      const parent = path.dirname(checkPath);
      if (parent === checkPath) break;
      checkPath = parent;
    }

    if (typeof fs.statfsSync === 'function') {
      const stat = fs.statfsSync(checkPath);
      const freeBytes = stat.bavail * stat.bsize;
      const totalBytes = stat.blocks * stat.bsize;
      const freeGb = freeBytes / (1024 ** 3);
      const totalGb = totalBytes / (1024 ** 3);

      return {
        freeGb: parseFloat(freeGb.toFixed(2)),
        totalGb: parseFloat(totalGb.toFixed(2)),
        freeBytes,
        totalBytes
      };
    }
  } catch (err) {
    // If statfs fails on some platforms, return null with warning
    return {
      freeGb: null,
      totalGb: null,
      error: err.message
    };
  }

  return { freeGb: null, totalGb: null };
}

function checkDiskSpaceSafe(targetPath, minFreeGb = 20, logger = null) {
  const disk = getDiskSpace(targetPath);
  if (disk.freeGb !== null && disk.freeGb < minFreeGb) {
    if (logger) {
      logger.warn(
        { freeGb: disk.freeGb, minFreeGb, path: targetPath },
        'Low disk space warning: available free disk is below threshold'
      );
    }
    return { isSufficient: false, ...disk };
  }
  return { isSufficient: true, ...disk };
}

module.exports = {
  getDiskSpace,
  checkDiskSpaceSafe
};
