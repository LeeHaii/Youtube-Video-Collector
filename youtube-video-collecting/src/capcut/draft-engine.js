const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Generate an uppercase UUID v4 matching CapCut's internal ID style.
 */
function generateCapCutId() {
  return crypto.randomUUID().toUpperCase();
}

/**
 * Formats microseconds to mm:ss format.
 */
function formatMicroseconds(microseconds) {
  const secondsTotal = Math.floor(microseconds / 1000000);
  const minutes = Math.floor(secondsTotal / 60);
  const seconds = secondsTotal % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Splits text at a space character if length exceeds maxChars.
 * 'balanced': splits closest to the string midpoint.
 * 'strict': splits at last space before maxChars limit.
 */
function processTextSpacing(text, maxChars = 35, mode = 'balanced') {
  if (!text || text.length <= maxChars) {
    return text || '';
  }

  const spaceIndices = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') spaceIndices.push(i);
  }

  if (spaceIndices.length === 0) {
    return text;
  }

  let splitIdx;
  if (mode === 'balanced') {
    const midpoint = text.length / 2;
    splitIdx = spaceIndices.reduce((closest, idx) => {
      return Math.abs(idx - midpoint) < Math.abs(closest - midpoint) ? idx : closest;
    }, spaceIndices[0]);
  } else {
    const spacesUnderLimit = spaceIndices.filter(idx => idx <= maxChars);
    splitIdx = spacesUnderLimit.length > 0 ? spacesUnderLimit[spacesUnderLimit.length - 1] : spaceIndices[0];
  }

  return text.slice(0, splitIdx) + '\n' + text.slice(splitIdx + 1);
}

/**
 * Extracts lines from text containing at least 2 keywords.
 */
function extractTextByKeywords(textInput, keywords = ['Number', ':', '번호', 'Número', 'Numéro', '番号']) {
  if (!textInput) return [];
  const lines = textInput.split(/\r?\n/);
  const extracted = [];

  for (const line of lines) {
    let keywordCount = 0;
    for (const keyword of keywords) {
      if (line.includes(keyword)) {
        keywordCount++;
      }
    }
    if (keywordCount >= 2) {
      const trimmed = line.trim();
      if (trimmed) extracted.push(trimmed);
    }
  }
  return extracted;
}

/**
 * Recursively locates all draft_content.json files in a directory hierarchy.
 */
function findDraftContentFiles(projectFolderPath) {
  const draftFiles = [];
  function scan(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile() && entry.name === 'draft_content.json') {
        draftFiles.push(fullPath);
      }
    }
  }
  scan(projectFolderPath);
  return draftFiles;
}

/**
 * Safely writes JSON content with a .bak backup and atomic temp file swap.
 */
function atomicWriteDraftFile(filePath, data) {
  const backupPath = `${filePath}.bak`;
  const tempPath = `${filePath}.${Date.now()}.tmp`;

  // Create .bak backup if the source file exists
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, backupPath);
    } catch (err) {
      // Ignore backup error but proceed
    }
  }

  const jsonString = JSON.stringify(data, null, 2);
  fs.writeFileSync(tempPath, jsonString, 'utf8');
  fs.renameSync(tempPath, filePath);
}

/**
 * Bypasses CapCut project cache by renaming the project folder and updating metadata.
 */
function bustCapCutProjectCache(projectPath, logCallback = console.log) {
  logCallback('\n🔄 CACHE-BUSTER: Renaming project folder to force CapCut cache refresh...');
  const projectDir = path.resolve(projectPath);
  const parentDir = path.dirname(projectDir);
  const currentName = path.basename(projectDir);

  let newName;
  const numMatch = currentName.match(/ - shuffled \((\d+)\)$/);
  if (numMatch) {
    const nextNum = parseInt(numMatch[1], 10) + 1;
    newName = currentName.replace(/ - shuffled \(\d+\)$/, ` - shuffled (${nextNum})`);
  } else if (currentName.includes(' - shuffled')) {
    newName = `${currentName} (1)`;
  } else {
    newName = `${currentName} - shuffled`;
  }

  const newProjectPath = path.join(parentDir, newName);

  if (fs.existsSync(newProjectPath)) {
    logCallback(`   ⚠ Target folder already exists: ${newName}. Removing old version...`);
    fs.rmSync(newProjectPath, { recursive: true, force: true });
  }

  logCallback(`   Renaming: ${currentName} → ${newName}`);
  fs.renameSync(projectDir, newProjectPath);
  logCallback('   ✓ Folder renamed successfully');

  // Update draft_meta_info.json if present
  const metaFile = path.join(newProjectPath, 'draft_meta_info.json');
  if (fs.existsSync(metaFile)) {
    try {
      logCallback(`   Updating metadata: ${path.basename(metaFile)}`);
      const metaData = JSON.parse(fs.readFileSync(metaFile, 'utf8'));

      if (metaData.draft_fold_path) {
        metaData.draft_fold_path = metaData.draft_fold_path.replace(currentName, newName);
      }
      metaData.draft_id = generateCapCutId();

      fs.writeFileSync(metaFile, JSON.stringify(metaData, null, 2), 'utf8');
      logCallback('   ✓ Metadata updated with fresh draft_id');
    } catch (e) {
      logCallback(`   ⚠ Warning: Could not update metadata at ${metaFile}: ${e.message}`);
    }
  }

  return newProjectPath;
}

/**
 * Core Shuffle: Shuffles video track segments between marker pairs.
 */
function shuffleDraftSegments(projectData, logCallback = console.log) {
  const timeMarksObj = projectData.time_marks || {};
  const markItems = Array.isArray(timeMarksObj.mark_items) ? timeMarksObj.mark_items : [];

  if (markItems.length < 2) {
    throw new Error('Project must contain at least 2 markers in time_marks');
  }

  // Markers sorted descending (ms)
  const markers = markItems
    .map(m => m.time_range?.start)
    .filter(t => typeof t === 'number')
    .sort((a, b) => b - a);

  logCallback(`       Found ${markItems.length} marker items. Processing ${Math.floor(markers.length / 2)} marker pairs...`);

  const tracks = projectData.tracks || [];
  const videoTracks = tracks.filter(t => t.type === 'video' && Array.isArray(t.segments) && t.segments.length > 0);

  if (videoTracks.length === 0) {
    throw new Error('No video track with segments found');
  }

  // Select track with the most segments
  const targetTrack = videoTracks.reduce((maxTrack, t) => (t.segments.length > maxTrack.segments.length ? t : maxTrack), videoTracks[0]);
  const segments = targetTrack.segments;

  let totalShuffledPairs = 0;

  for (let pairIdx = 0; pairIdx < markers.length - 1; pairIdx += 2) {
    const markerStart = markers[pairIdx + 1]; // earlier
    const markerEnd = markers[pairIdx];       // later

    if (markerStart >= markerEnd) continue;

    const segmentsInRange = segments.filter(seg => {
      const start = seg.target_timerange?.start ?? 0;
      const duration = seg.target_timerange?.duration ?? 0;
      return start >= markerStart && (start + duration) <= markerEnd;
    });

    if (segmentsInRange.length === 0) continue;

    // Shuffle segments in range
    const shuffled = [...segmentsInRange];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Get the original indices of these segments in the track
    const segmentIndices = segmentsInRange.map(seg => segments.indexOf(seg)).sort((a, b) => a - b);

    // Place the shuffled segments back and recompute timeline start offsets
    let cursor = markerStart;
    for (let k = 0; k < segmentIndices.length; k++) {
      const targetIdx = segmentIndices[k];
      const seg = shuffled[k];
      const duration = seg.target_timerange?.duration ?? 0;
      seg.target_timerange.start = cursor;
      segments[targetIdx] = seg;
      cursor += duration;
    }
    totalShuffledPairs++;
  }

  return totalShuffledPairs;
}

/**
 * Core Effects: Adds alternating synchronized video effects based on markers.
 */
function addDraftEffects(projectData, options = {}, logCallback = console.log) {
  const { skipIntro = false } = options;
  const timeMarksObj = projectData.time_marks || {};
  const markItems = Array.isArray(timeMarksObj.mark_items) ? [...timeMarksObj.mark_items] : [];

  markItems.sort((a, b) => (a.time_range?.start || 0) - (b.time_range?.start || 0));

  if (markItems.length < 3) {
    logCallback('    -> Skipped (Not enough markers to form alternating pairs)');
    return 0;
  }

  const tracks = projectData.tracks || [];
  const effectTracks = tracks.filter(t => t.type === 'effect' && Array.isArray(t.segments));

  if (effectTracks.length === 0) {
    logCallback('    -> Skipped (No effect tracks found in draft)');
    return 0;
  }

  // Find effect track with the most unique materials
  let targetTrack = null;
  let maxUnique = -1;
  let uniqueSegments = [];

  for (const track of effectTracks) {
    const seenMaterials = new Set();
    const trackUniqueSegs = [];
    for (const seg of track.segments || []) {
      const matId = seg.material_id;
      if (matId && !seenMaterials.has(matId)) {
        seenMaterials.add(matId);
        trackUniqueSegs.push(seg);
      }
    }
    if (seenMaterials.size > maxUnique) {
      maxUnique = seenMaterials.size;
      targetTrack = track;
      uniqueSegments = trackUniqueSegs;
    }
  }

  if (!targetTrack || uniqueSegments.length === 0) {
    logCallback('    -> Skipped (Could not isolate unique template effects)');
    return 0;
  }

  // Clone track
  const newTrack = JSON.parse(JSON.stringify(targetTrack));
  newTrack.id = generateCapCutId();
  newTrack.segments = [];

  const startIdx = skipIntro ? 0 : 1;
  const pairIndices = [];
  for (let i = startIdx; i < markItems.length - 1; i += 2) {
    pairIndices.push([i, i + 1]);
  }

  if (pairIndices.length === 0) {
    logCallback('    -> Skipped (Not enough marker pairs)');
    return 0;
  }

  if (!projectData.materials) projectData.materials = {};
  if (!Array.isArray(projectData.materials.video_effects)) projectData.materials.video_effects = [];

  let segmentsCreated = 0;

  for (let i = 0; i < pairIndices.length; i++) {
    const [idxStart, idxEnd] = pairIndices[i];
    const mStart = markItems[idxStart].time_range.start;
    const mEnd = markItems[idxEnd].time_range.start;

    const pairDuration = mEnd - mStart;
    const effectDuration = Math.floor(pairDuration / 3);
    const effectStart = mStart + effectDuration;

    const templateSeg = uniqueSegments[i % uniqueSegments.length];
    const newSeg = JSON.parse(JSON.stringify(templateSeg));
    newSeg.id = generateCapCutId();
    newSeg.target_timerange = {
      start: effectStart,
      duration: effectDuration,
    };

    const origMatId = templateSeg.material_id;
    const origMat = projectData.materials.video_effects.find(m => m.id === origMatId);

    if (origMat) {
      const newMat = JSON.parse(JSON.stringify(origMat));
      const newMatId = generateCapCutId();
      newMat.id = newMatId;
      newSeg.material_id = newMatId;
      projectData.materials.video_effects.push(newMat);
    }

    newTrack.segments.push(newSeg);
    segmentsCreated++;
  }

  projectData.tracks.push(newTrack);
  return segmentsCreated;
}

/**
 * Core Titles: Adds stylized text subtitles across marker intervals.
 */
function addDraftTitles(projectData, texts = [], options = {}, logCallback = console.log) {
  const { splitMode = 'balanced', logMarkersTime = true, skipIntro = false } = options;
  const timeMarksObj = projectData.time_marks || {};
  const markItems = Array.isArray(timeMarksObj.mark_items) ? [...timeMarksObj.mark_items] : [];

  markItems.sort((a, b) => (a.time_range?.start || 0) - (b.time_range?.start || 0));

  if (logMarkersTime) {
    logCallback(`  -> Timeline Log: Found ${markItems.length} total markers`);
    for (let i = 0; i < markItems.length; i += 2) {
      const t = markItems[i].time_range?.start || 0;
      const title = markItems[i].title || `Marker ${i}`;
      logCallback(`     Index ${i} | ${title} starts at ${formatMicroseconds(t)}`);
    }
  }

  const tracks = projectData.tracks || [];
  const templateTrack = tracks.find(t => t.type === 'text' && Array.isArray(t.segments) && t.segments.length === 1);

  if (!templateTrack) {
    logCallback('  -> Skip: No valid text track with exactly 1 segment found to use as template.');
    return 0;
  }

  const templateSegment = templateTrack.segments[0];
  const materials = projectData.materials || {};
  const textsMaterials = Array.isArray(materials.texts) ? materials.texts : [];
  const origMaterial = textsMaterials.find(m => m.id === templateSegment.material_id);

  if (!origMaterial) {
    logCallback('  -> Skip: Root text style material missing.');
    return 0;
  }

  const newTrack = JSON.parse(JSON.stringify(templateTrack));
  newTrack.id = generateCapCutId();
  newTrack.segments = [];

  const offset = skipIntro ? 1 : 0;
  const maxPairs = Math.floor((markItems.length - offset) / 2);
  let segmentsCreated = 0;

  const count = Math.min(texts.length, maxPairs);

  for (let i = 0; i < count; i++) {
    const startIdx = i * 2 + offset;
    const endIdx = startIdx + 1;

    if (endIdx >= markItems.length) break;

    const start = markItems[startIdx].time_range.start;
    const end = markItems[endIdx].time_range.start;

    const newSeg = JSON.parse(JSON.stringify(templateSegment));
    newSeg.id = generateCapCutId();
    newSeg.target_timerange = {
      start: start,
      duration: end - start,
    };

    const newMat = JSON.parse(JSON.stringify(origMaterial));
    const newMatId = generateCapCutId();
    newMat.id = newMatId;

    const processedText = processTextSpacing(texts[i], 35, splitMode);
    try {
      const contentJson = JSON.parse(newMat.content);
      contentJson.text = processedText;
      newMat.content = JSON.stringify(contentJson);
    } catch (e) {
      newMat.content = JSON.stringify({ text: processedText });
    }

    newSeg.material_id = newMatId;
    projectData.materials.texts.push(newMat);
    newTrack.segments.push(newSeg);
    segmentsCreated++;
  }

  projectData.tracks.push(newTrack);
  return segmentsCreated;
}

/**
 * High-level runner: Process Shuffling on a project folder.
 */
function processProjectShuffle(projectPath, forceCacheBust = true, logCallback = console.log) {
  let targetPath = projectPath;
  if (forceCacheBust) {
    targetPath = bustCapCutProjectCache(projectPath, logCallback);
  }

  const draftFiles = findDraftContentFiles(targetPath);
  if (draftFiles.length === 0) {
    throw new Error(`No draft_content.json files found in ${targetPath}`);
  }

  logCallback(`\n🔄 Found ${draftFiles.length} draft file(s). Shuffling segments...`);
  let processedCount = 0;

  for (const draftPath of draftFiles) {
    logCallback(`\n   Processing: ${path.basename(draftPath)}`);
    const projectData = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
    const pairsShuffled = shuffleDraftSegments(projectData, logCallback);
    atomicWriteDraftFile(draftPath, projectData);
    logCallback(`   ✓ Successfully shuffled ${pairsShuffled} marker pair(s) and saved.`);
    processedCount++;
  }

  return { success: true, processedCount, targetPath };
}

/**
 * High-level runner: Process Effects & Titles on a project folder.
 */
function processProjectEffectAndTitle(projectPath, options = {}, logCallback = console.log) {
  const { addEffect = false, addTitle = false, titleText = '', logMarkersTime = true, skipIntro = false } = options;
  const draftFiles = findDraftContentFiles(projectPath);

  if (draftFiles.length === 0) {
    throw new Error(`No draft_content.json files found inside: ${projectPath}`);
  }

  let extractedTexts = [];
  if (addTitle && titleText && titleText.trim()) {
    extractedTexts = extractTextByKeywords(titleText);
    if (extractedTexts.length === 0) {
      throw new Error('No lines matching criteria (must contain keyword like Number and :) were found.');
    }
  }

  logCallback(`\n🎨 Processing ${draftFiles.length} draft file(s) for Effect & Title...`);
  logCallback(`   Add Effect: ${addEffect}, Add Title: ${addTitle}, Skip Intro: ${skipIntro}`);

  let processedCount = 0;

  for (const draftPath of draftFiles) {
    logCallback(`\n[${processedCount + 1}/${draftFiles.length}] Modifying: ${draftPath}`);
    const projectData = JSON.parse(fs.readFileSync(draftPath, 'utf8'));

    if (addEffect) {
      logCallback('  ✨ Applying auto add effect...');
      const effectsCount = addDraftEffects(projectData, { skipIntro }, logCallback);
      logCallback(`  ✓ Added effect track with ${effectsCount} segments`);
    }

    if ((addTitle && extractedTexts.length > 0) || logMarkersTime) {
      logCallback(`  📝 Applying auto add title (${extractedTexts.length} text lines)...`);
      const titlesCount = addDraftTitles(projectData, extractedTexts, { splitMode: 'balanced', logMarkersTime, skipIntro }, logCallback);
      logCallback(`  ✓ Added title track with ${titlesCount} segments`);
    }

    atomicWriteDraftFile(draftPath, projectData);
    logCallback(`  -> Success: Saved updates back to ${path.basename(draftPath)}`);
    processedCount++;
  }

  return { success: true, processedCount };
}

module.exports = {
  generateCapCutId,
  formatMicroseconds,
  processTextSpacing,
  extractTextByKeywords,
  findDraftContentFiles,
  atomicWriteDraftFile,
  bustCapCutProjectCache,
  shuffleDraftSegments,
  addDraftEffects,
  addDraftTitles,
  processProjectShuffle,
  processProjectEffectAndTitle,
};
