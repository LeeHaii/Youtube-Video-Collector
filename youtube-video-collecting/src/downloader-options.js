const RESOLUTIONS = Object.freeze(['auto', '360', '480', '720', '1080', '1440', '2160']);

function validateDownloadResolution(resolution = 'auto') {
  if (!RESOLUTIONS.includes(resolution)) {
    throw new Error('Invalid resolution. Choose Auto, 360p, 480p, 720p, 1080p, 1440p, or 2160p (4K).');
  }
  return resolution;
}

function buildDownloadArguments(csvPath, outputPath, clipSleepMin, clipSleepMax, rowSleepMin, rowSleepMax, stopFlagPath, resolution = 'auto') {
  const selectedResolution = validateDownloadResolution(resolution);
  return [
    csvPath, outputPath, clipSleepMin, clipSleepMax, rowSleepMin, rowSleepMax, stopFlagPath,
    '--resolution', selectedResolution,
  ].map(String);
}

module.exports = { RESOLUTIONS, validateDownloadResolution, buildDownloadArguments };
