const HEADER_TO_CATEGORY = Object.freeze({
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
      state.summary = JSON.parse(line.slice(summaryIndex + summaryMarker.length).trim());
    } catch (error) {
      console.warn('Could not parse downloader summary:', error.message);
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
  const trailingLine = lines.pop() || '';
  for (const line of lines) parseDownloaderLine(state, line);
  if (flush) {
    if (trailingLine) parseDownloaderLine(state, trailingLine);
    state.stdoutBuffer = '';
  } else {
    state.stdoutBuffer = trailingLine;
  }
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

module.exports = {
  HEADER_TO_CATEGORY,
  buildDownloadErrorSummary,
  consumeDownloaderStdout,
  createDownloadParseState,
  mergeDownloadError,
  mergeErrorsForCsv,
  parseDownloaderLine,
};
