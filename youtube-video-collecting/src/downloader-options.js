const RESOLUTIONS = Object.freeze(['auto', '360', '480', '720', '1080', '1440', '2160']);
const MINIMUM_QUALITIES = Object.freeze(['144', '240', '360', '480', '720', '1080', '1440', '2160']);
const PROTOCOL_VERSION = 2;

function validateDownloadResolution(resolution = '1080') {
  if (!RESOLUTIONS.includes(resolution)) throw new Error('Invalid resolution. Choose Best available, 360p, 480p, 720p, 1080p, 1440p, or 2160p.');
  return resolution;
}

function validateDownloadPolicy(resolution = '1080', minimum = undefined, replaceExisting = false) {
  const maximum = validateDownloadResolution(resolution);
  const derived = String(Math.min(1080, maximum === 'auto' ? 1080 : Number(maximum)));
  const min = minimum === undefined ? derived : String(minimum);
  if (!MINIMUM_QUALITIES.includes(min)) throw new Error('Invalid minimum quality.');
  if (maximum !== 'auto' && Number(min) > Number(maximum)) throw new Error('Minimum quality cannot exceed maximum quality.');
  if (typeof replaceExisting !== 'boolean') throw new Error('Invalid replace-existing setting.');
  return Object.freeze({ minimum_edge: Number(min), maximum_edge: maximum === 'auto' ? null : Number(maximum),
    policy_version: PROTOCOL_VERSION, dimension_basis: 'shorter-edge', fallback_mode: 'strict' });
}

function buildDownloadArguments(csvPath, outputPath, clipSleepMin, clipSleepMax, rowSleepMin, rowSleepMax, stopFlagPath, resolution = '1080', minimum, replaceExisting = false) {
  const policy = validateDownloadPolicy(resolution, minimum, replaceExisting);
  return [csvPath, outputPath, clipSleepMin, clipSleepMax, rowSleepMin, rowSleepMax, stopFlagPath,
    '--max-quality', policy.maximum_edge ?? 'auto', '--min-quality', policy.minimum_edge,
    '--quality-mode', 'strict', ...(replaceExisting ? ['--replace-existing'] : [])].map(String);
}

module.exports = { RESOLUTIONS, MINIMUM_QUALITIES, PROTOCOL_VERSION, validateDownloadResolution, validateDownloadPolicy, buildDownloadArguments };
