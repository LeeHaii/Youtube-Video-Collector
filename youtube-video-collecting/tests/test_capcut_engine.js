const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  processTextSpacing,
  extractTextByKeywords,
  shuffleDraftSegments,
  addDraftEffects,
  addDraftTitles,
  processProjectShuffle,
  processProjectEffectAndTitle,
  findDraftContentFiles,
} = require('../src/capcut/draft-engine');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample_draft.json');

function loadFreshFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

test('processTextSpacing splits text nicely at midpoint in balanced mode', () => {
  const shortText = 'Short sentence';
  assert.equal(processTextSpacing(shortText, 35, 'balanced'), shortText);

  const longText = 'This is a significantly long subtitle text that needs splitting';
  const split = processTextSpacing(longText, 30, 'balanced');
  assert.ok(split.includes('\n'), 'Should contain a newline split');
  assert.equal(split.replace('\n', ' '), longText);
});

test('extractTextByKeywords extracts lines containing 2+ keywords', () => {
  const input = [
    'Header line ignore',
    'Number 1: Top 10 Best Moments',
    'Just some comment',
    '번호 2: Fantastic Plays',
    'Another ignored text',
  ].join('\n');

  const extracted = extractTextByKeywords(input);
  assert.equal(extracted.length, 2);
  assert.equal(extracted[0], 'Number 1: Top 10 Best Moments');
  assert.equal(extracted[1], '번호 2: Fantastic Plays');
});

test('shuffleDraftSegments preserves segment duration sum and marker bounds', () => {
  const draft = loadFreshFixture();
  const videoTrack = draft.tracks.find(t => t.type === 'video');
  const initialDurationSum = videoTrack.segments.reduce((acc, s) => acc + s.target_timerange.duration, 0);

  const pairsShuffled = shuffleDraftSegments(draft, () => {});
  assert.ok(pairsShuffled > 0, 'Should shuffle at least 1 pair');

  const afterDurationSum = videoTrack.segments.reduce((acc, s) => acc + s.target_timerange.duration, 0);
  assert.equal(afterDurationSum, initialDurationSum, 'Total duration should remain constant');
});

test('addDraftEffects creates new effect track and clones unique template materials', () => {
  const draft = loadFreshFixture();
  const initialTracksCount = draft.tracks.length;
  const initialMatCount = draft.materials.video_effects.length;

  const count = addDraftEffects(draft, { skipIntro: false }, () => {});
  assert.ok(count > 0, 'Should create new effect segments');
  assert.equal(draft.tracks.length, initialTracksCount + 1, 'Should append one new effect track');
  assert.ok(draft.materials.video_effects.length > initialMatCount, 'Should create new material IDs');

  const newTrack = draft.tracks[draft.tracks.length - 1];
  assert.equal(newTrack.type, 'effect');
  assert.equal(newTrack.segments.length, count);
});

test('addDraftTitles generates formatted text track and substitutes strings', () => {
  const draft = loadFreshFixture();
  const initialTracksCount = draft.tracks.length;
  const initialTextsCount = draft.materials.texts.length;

  const titles = [
    'Number 1: Epic Opening',
    'Number 2: Legendary Comeback',
  ];

  const count = addDraftTitles(draft, titles, { splitMode: 'balanced', logMarkersTime: false, skipIntro: false }, () => {});
  assert.equal(count, 2, 'Should add 2 title segments');
  assert.equal(draft.tracks.length, initialTracksCount + 1, 'Should append one new text track');
  assert.equal(draft.materials.texts.length, initialTextsCount + 2, 'Should create 2 new text materials');

  const newTrack = draft.tracks[draft.tracks.length - 1];
  assert.equal(newTrack.type, 'text');
  assert.equal(newTrack.segments.length, 2);

  const addedMat1 = draft.materials.texts.find(m => m.id === newTrack.segments[0].material_id);
  assert.ok(addedMat1, 'Should find newly created text material');
  assert.ok(addedMat1.content.includes('Number 1: Epic Opening'));
});

test('processProjectShuffle and processProjectEffectAndTitle end-to-end on temp project', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcut-test-project-'));
  const draftFile = path.join(tempDir, 'draft_content.json');
  fs.copyFileSync(FIXTURE_PATH, draftFile);

  const shuffleResult = processProjectShuffle(tempDir, false, () => {});
  assert.equal(shuffleResult.success, true);
  assert.equal(shuffleResult.processedCount, 1);
  assert.ok(fs.existsSync(`${draftFile}.bak`), 'Should have created .bak backup');

  const effectTitleResult = processProjectEffectAndTitle(tempDir, {
    addEffect: true,
    addTitle: true,
    titleText: 'Number 1: Play of the Game\nNumber 2: Final Victory',
    logMarkersTime: false,
    skipIntro: false,
  }, () => {});

  assert.equal(effectTitleResult.success, true);
  assert.equal(effectTitleResult.processedCount, 1);

  // Clean up
  fs.rmSync(tempDir, { recursive: true, force: true });
});
