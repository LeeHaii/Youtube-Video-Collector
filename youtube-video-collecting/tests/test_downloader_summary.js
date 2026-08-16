const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDownloadErrorSummary,
  consumeDownloaderStdout,
  createDownloadParseState,
  mergeErrorsForCsv,
} = require('../src/downloader-summary');

test('parses structured errors when process output arrives in arbitrary chunks', () => {
  const state = createDownloadParseState();
  const output = [
    '📊 ERROR_SUMMARY: FORBIDDEN_ERRORS\n',
    '  https://www.youtube.com/watch?v=one|5;10\n',
    '📊 ERROR_SUMMARY: RATE_LIMIT_ERRORS\n',
    '  https://www.youtube.com/watch?v=two|15\n',
    '📊 DOWNLOAD_SUMMARY: {"total":4,"processed":4,"succeeded":1,"failed":3,"canceled":false,"forbidden":2,"rateLimited":1,"ageRestricted":0,"authentication":0,"unavailable":0,"format":0,"other":0}',
  ].join('');

  for (const chunk of [output.slice(0, 13), output.slice(13, 79), output.slice(79, 167), output.slice(167)]) {
    consumeDownloaderStdout(state, chunk);
  }
  consumeDownloaderStdout(state, '', true);

  assert.deepEqual(state.errors, [
    { category: 'FORBIDDEN', url: 'https://www.youtube.com/watch?v=one', timestamps: [5, 10] },
    { category: 'RATE_LIMIT', url: 'https://www.youtube.com/watch?v=two', timestamps: [15] },
  ]);
  assert.deepEqual(buildDownloadErrorSummary(state), {
    total: 4,
    processed: 4,
    succeeded: 1,
    failedCount: 3,
    canceled: false,
    forbiddenCount: 2,
    rateLimitCount: 1,
    ageRestrictionCount: 0,
    authenticationCount: 0,
    unavailableCount: 0,
    formatCount: 0,
    otherErrorCount: 0,
  });
});

test('merges timestamps for the same URL across categories when exporting retry CSV', () => {
  const merged = mergeErrorsForCsv([
    { category: 'FORBIDDEN', url: 'https://example.test/video', timestamps: [10, 20] },
    { category: 'FORMAT', url: 'https://example.test/video', timestamps: [20, 30] },
  ]);

  assert.deepEqual(merged, [
    { url: 'https://example.test/video', timestamps: [10, 20, 30] },
  ]);
});
