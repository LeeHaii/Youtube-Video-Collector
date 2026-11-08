const HEADER_TO_CATEGORY = Object.freeze({
  QUALITY_UNAVAILABLE_ERRORS: 'QUALITY_UNAVAILABLE',
  VALIDATION_FAILED_ERRORS: 'VALIDATION_FAILED',
  OUTPUT_CONFLICT_ERRORS: 'OUTPUT_CONFLICT',
  FORBIDDEN_ERRORS: 'FORBIDDEN',
  RATE_LIMIT_ERRORS: 'RATE_LIMIT',
  AGE_RESTRICTION_ERRORS: 'AGE_RESTRICTION',
  AUTHENTICATION_ERRORS: 'AUTHENTICATION',
  UNAVAILABLE_ERRORS: 'UNAVAILABLE',
  FORMAT_ERRORS: 'FORMAT',
  OTHER_ERRORS: 'ERROR',
});

function createDownloadParseState() {
  return {
    clipResults: new Map(),
    protocolErrors: [],
    currentCategory: null,
    errors: [],
    summary: null,
    stdoutBuffer: '',
  };
}

function mergeDownloadError(state, category, url, timestamps) {
  let entry = state.errors.find((item) => item.category === category && item.url === url);
  if (!entry) {
    entry = { category, url, timestamps: [] };
    state.errors.push(entry);
  }

  for (const timestamp of timestamps) {
    if (Number.isFinite(timestamp) && !entry.timestamps.includes(timestamp)) {
      entry.timestamps.push(timestamp);
    }
  }
  entry.timestamps.sort((left, right) => left - right);
}

function parseDownloaderLine(state, rawLine) {
  const line = rawLine.trim();
  if (!line) return;

  const clipIndex = line.indexOf('CLIP_RESULT:');
  if (clipIndex !== -1) {
    state.currentCategory = null;
    try {
      const record = JSON.parse(line.slice(clipIndex + 'CLIP_RESULT:'.length).trim());
      if (record.schemaVersion !== 2 || typeof record.clipId !== 'string' || state.clipResults.has(record.clipId)
          || !['OK', 'CANCELED', 'QUALITY_UNAVAILABLE', 'VALIDATION_FAILED', 'OUTPUT_CONFLICT', 'FORBIDDEN', 'RATE_LIMIT', 'AGE_RESTRICTION', 'AUTHENTICATION', 'UNAVAILABLE', 'FORMAT', 'ERROR'].includes(record.status)) {
        throw new Error('Invalid or duplicate clip result');
      }
      state.clipResults.set(record.clipId, record);
      if (!['OK', 'CANCELED'].includes(record.status)) mergeDownloadError(state, record.status, record.url, [record.timestamp]);
    } catch (error) { state.protocolErrors.push(error.message); }
    return;
  }

  const errorHeader = line.match(/ERROR_SUMMARY:\s*([A-Z_]+)/);
  if (errorHeader) {
    state.currentCategory = HEADER_TO_CATEGORY[errorHeader[1]] || 'ERROR';
    return;
  }

  const summaryMarker = 'DOWNLOAD_SUMMARY:';
  const summaryIndex = line.indexOf(summaryMarker);
  if (summaryIndex !== -1) {
    state.currentCategory = null;
    try {
      if (state.summary) throw new Error('Duplicate download summary');
      state.summary = JSON.parse(line.slice(summaryIndex + summaryMarker.length).trim());
    } catch (error) {
      state.protocolErrors.push('Invalid download summary: ' + error.message);
    }
    return;
  }

  if (!state.currentCategory || !line.includes('|')) return;
  const separatorIndex = line.indexOf('|');
  const url = line.slice(0, separatorIndex).trim();
  const timestamps = line
    .slice(separatorIndex + 1)
    .split(';')
    .map(Number)
    .filter(Number.isFinite);

  if (/^https?:\/\//i.test(url) && timestamps.length > 0) {
    mergeDownloadError(state, state.currentCategory, url, timestamps);
  }
}

function consumeDownloaderStdout(state, text, flush = false) {
  state.stdoutBuffer += text;
  const lines = state.stdoutBuffer.split(/\r?\n/);
  const visible = [];
  const consume = (line) => {
    parseDownloaderLine(state, line);
    if (!/CLIP_RESULT:|DOWNLOAD_SUMMARY:|ERROR_SUMMARY:/.test(line)) visible.push(line);
  };
  const trailingLine = lines.pop() || '';
  for (const line of lines) consume(line);
  if (flush) {
    if (trailingLine) consume(trailingLine);
    state.stdoutBuffer = '';
  } else {
    state.stdoutBuffer = trailingLine;
  }
  if (state.stdoutBuffer.length > 1024 * 1024) { state.protocolErrors.push('Downloader record too large'); state.stdoutBuffer = ''; }
  return visible.length ? visible.join('\n') + '\n' : '';
}

function countErrorTimestamps(errors, category = null) {
  return errors
    .filter((entry) => !category || entry.category === category)
    .reduce((total, entry) => total + entry.timestamps.length, 0);
}

function buildDownloadErrorSummary(state) {
  const parsed = state.summary || {};
  const failedCount = Number.isFinite(parsed.failed)
    ? parsed.failed
    : countErrorTimestamps(state.errors);

  return {
    schemaVersion: parsed.schemaVersion ?? null,
    qualityUnavailableCount: parsed.qualityUnavailable ?? countErrorTimestamps(state.errors, 'QUALITY_UNAVAILABLE'),
    validationFailedCount: parsed.validationFailed ?? countErrorTimestamps(state.errors, 'VALIDATION_FAILED'),
    outputConflictCount: parsed.outputConflict ?? countErrorTimestamps(state.errors, 'OUTPUT_CONFLICT'),
    degradedCount: parsed.degraded ?? 0,
    protocolErrors: [...state.protocolErrors],
    total: parsed.total ?? null,
    processed: parsed.processed ?? null,
    succeeded: parsed.succeeded ?? null,
    failedCount,
    canceled: Boolean(parsed.canceled),
    forbiddenCount: parsed.forbidden ?? countErrorTimestamps(state.errors, 'FORBIDDEN'),
    rateLimitCount: parsed.rateLimited ?? countErrorTimestamps(state.errors, 'RATE_LIMIT'),
    ageRestrictionCount: parsed.ageRestricted ?? countErrorTimestamps(state.errors, 'AGE_RESTRICTION'),
    authenticationCount: parsed.authentication ?? countErrorTimestamps(state.errors, 'AUTHENTICATION'),
    unavailableCount: parsed.unavailable ?? countErrorTimestamps(state.errors, 'UNAVAILABLE'),
    formatCount: parsed.format ?? countErrorTimestamps(state.errors, 'FORMAT'),
    otherErrorCount: parsed.other ?? countErrorTimestamps(state.errors, 'ERROR'),
  };
}

function mergeErrorsForCsv(errors) {
  const byUrl = new Map();
  for (const entry of errors) {
    if (!byUrl.has(entry.url)) byUrl.set(entry.url, new Set());
    const timestamps = byUrl.get(entry.url);
    for (const timestamp of entry.timestamps) timestamps.add(timestamp);
  }
  return Array.from(byUrl, ([url, timestamps]) => ({
    url,
    timestamps: Array.from(timestamps).sort((left, right) => left - right),
  }));
}

function validateDownloadCompletion(state, code, expectedPolicy) {
  const summary = state.summary;
  if (!summary || summary.schemaVersion !== 2 || state.protocolErrors.length) return false;
  const counts = ['total', 'processed', 'succeeded', 'failed', 'notProcessed', 'degraded'];
  if (counts.some((key) => !Number.isSafeInteger(summary[key]) || summary[key] < 0)) return false;
  if (summary.processed !== summary.succeeded + summary.failed + summary.degraded
      || summary.total !== summary.processed + summary.notProcessed) return false;
  const records = [...state.clipResults.values()].filter((r) => r.status !== 'CANCELED');
  if (records.length !== summary.processed || records.filter((r) => r.status === 'OK').length !== summary.succeeded) return false;
  for (const record of records.filter((r) => r.status === 'OK')) {
    const policy = record.policy;
    const dimensions = record.outputDimensions;
    const edge = Array.isArray(dimensions) && dimensions.length === 2
      && dimensions.every((n) => Number.isSafeInteger(n) && n > 0) ? Math.min(...dimensions) : NaN;
    if (!policy || policy.policy_version !== 2 || policy.fallback_mode !== 'strict'
        || policy.dimension_basis !== 'shorter-edge' || !Number.isSafeInteger(policy.minimum_edge) || policy.minimum_edge <= 0
        || (policy.maximum_edge !== null && (!Number.isSafeInteger(policy.maximum_edge) || policy.maximum_edge < policy.minimum_edge))
        || !Number.isFinite(edge) || edge < policy.minimum_edge
        || (policy.maximum_edge !== null && edge > policy.maximum_edge)
        || !Array.isArray(record.target) || record.target.length !== 2
        || !record.target.every((n) => Number.isFinite(n) && n > 0)
        || edge < record.target[0] || !record.encoding || !Number.isFinite(record.encoding.fps)
        || record.encoding.width !== dimensions[0] || record.encoding.height !== dimensions[1]
        || record.encoding.fps + 0.1 < record.target[1] || record.state !== 'committed') return false;
    if (expectedPolicy && Object.keys(expectedPolicy).some((key) => policy[key] !== expectedPolicy[key])) return false;
  }
  return code === 0 && summary.canceled === false && summary.failed === 0 && summary.degraded === 0 && summary.notProcessed === 0;
}

function buildRetryPolicy(state, policy) {
  const targets = {};
  for (const record of state.clipResults.values()) {
    if (record.sourceKey && record.target) targets[record.sourceKey] = record.target;
  }
  return { schemaVersion: 2, policy, targets };
}

module.exports = {
  HEADER_TO_CATEGORY,
  validateDownloadCompletion,
  buildRetryPolicy,
  buildDownloadErrorSummary,
  consumeDownloaderStdout,
  createDownloadParseState,
  mergeDownloadError,
  mergeErrorsForCsv,
  parseDownloaderLine,
};
