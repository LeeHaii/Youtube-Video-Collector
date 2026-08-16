// Tools Handler - Manages 5-Sec Downloader and CapCut Shuffle UI

console.log('🔧 Tools Handler initializing...');

// ============================================================================
// QUERY ALL DOM ELEMENTS FIRST
// ============================================================================

// 5-Sec Downloader Elements
const csvPathInput = document.getElementById('csv-path');
const outputPathInput = document.getElementById('output-path');
const clipSleepMinInput = document.getElementById('clip-sleep-min');
const clipSleepMaxInput = document.getElementById('clip-sleep-max');
const rowSleepMinInput = document.getElementById('row-sleep-min');
const rowSleepMaxInput = document.getElementById('row-sleep-max');
const downloaderLog = document.getElementById('downloader-log');
const startBtn = document.getElementById('downloader-start-btn');
const stopBtn = document.getElementById('downloader-stop-btn');

// Error Extraction Elements
const errorExtractionContainer = document.getElementById('error-extraction-buttons');
const extractRateLimitBtn = document.getElementById('extract-rate-limit-btn');
const extractAgeRestrictionBtn = document.getElementById('extract-age-restriction-btn');

// CapCut Shuffle Elements
const capcutFolderInput = document.getElementById('capcut-folder-path');
const capcutSearchInput = document.getElementById('capcut-search-input');
const capcutProjectsList = document.getElementById('capcut-projects-list');
const capcutLog = document.getElementById('capcut-log');
const capcutProcessBtn = document.getElementById('capcut-process-btn');
const capcutCacheBustCheckbox = document.getElementById('capcut-cache-bust');

console.log('✅ DOM elements queried');
console.log('   - Downloader Log:', !!downloaderLog);
console.log('   - Start Button:', !!startBtn);
console.log('   - Stop Button:', !!stopBtn);
console.log('   - CapCut Log:', !!capcutLog);
console.log('   - CapCut Process Button:', !!capcutProcessBtn);

// ============================================================================
// SETUP IPC EVENT LISTENERS (NOW THAT DOM ELEMENTS ARE READY)
// ============================================================================

console.log('📡 Setting up IPC event listeners...');

// Setup download log listener
window.electronAPI.onDownloadLog?.((message) => {
  console.log('📥 [Download Log Received]:', message);
  if (downloaderLog) {
    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ${message.trim()}\n`;
    downloaderLog.textContent += line;
    downloaderLog.scrollTop = downloaderLog.scrollHeight;
  }
});

// Setup download complete listener
window.electronAPI.onDownloadComplete?.((completion) => {
  console.log('✅ [Download Complete]:', completion);
  if (startBtn && stopBtn && downloaderLog) {
    const result = typeof completion === 'boolean' ? { success: completion } : (completion || {});
    const summary = result.summary || {};
    const timestamp = new Date().toLocaleTimeString();
    if (result.success) {
      downloaderLog.textContent += `[${timestamp}] ✅ Download completed successfully!\n`;
    } else if (result.partial) {
      downloaderLog.textContent += `[${timestamp}] ⚠️ Download completed with ${summary.failedCount ?? 'some'} failed clip(s). Use “Extract Failed Clips” to retry only those clips.\n`;
    } else if (result.canceled) {
      downloaderLog.textContent += `[${timestamp}] ⏹️ Download stopped by user.\n`;
    } else {
      const exitDetail = Number.isInteger(result.code) ? ` (exit code ${result.code})` : '';
      downloaderLog.textContent += `[${timestamp}] ❌ Downloader failed${exitDetail}.\n`;
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
    stopBtn.textContent = 'Stop';
  }
});

// Setup download error summary listener
window.electronAPI.onDownloadErrorSummary?.((summary) => {
  console.log('📊 [Download Error Summary]:', summary);
  
  if (errorExtractionContainer) {
    // Every failure category is retryable from one exported CSV.
    if (summary.failedCount > 0) {
      errorExtractionContainer.style.display = 'flex';
      
      if (extractRateLimitBtn) {
        extractRateLimitBtn.textContent = `Extract Failed Clips (${summary.failedCount})`;
        extractRateLimitBtn.style.display = 'inline-block';
      }
      
      // Show age restriction button only if there are age restriction errors
      if (extractAgeRestrictionBtn && summary.ageRestrictionCount > 0) {
        extractAgeRestrictionBtn.textContent = `Extract Age Restriction Errors (${summary.ageRestrictionCount})`;
        extractAgeRestrictionBtn.style.display = 'inline-block';
      } else if (extractAgeRestrictionBtn) {
        extractAgeRestrictionBtn.style.display = 'none';
      }
    } else {
      errorExtractionContainer.style.display = 'none';
    }
  }
});

// Setup CapCut log listener
window.electronAPI.onCapcutLog?.((message) => {
  console.log('📥 [CapCut Log Received]:', message);
  if (capcutLog) {
    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ${message.trim()}\n`;
    capcutLog.textContent += line;
    capcutLog.scrollTop = capcutLog.scrollHeight;
  }
});

console.log('✅ All IPC event listeners registered');

// ============================================================================
// TAB SWITCHING
// ============================================================================
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.getAttribute('data-tab');
    switchTab(tabName);
  });
});

function switchTab(tabName) {
  // Hide all tabs
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.remove('active');
  });

  // Deactivate all buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  // Show selected tab
  document.getElementById(tabName).classList.add('active');

  // Activate selected button
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

  console.log(`📑 Switched to tab: ${tabName}`);
}

// ============================================================================
// 5-SEC DOWNLOADER TOOL
// ============================================================================

// CSV Browse Button
document.getElementById('csv-browse-btn').addEventListener('click', async () => {
  console.log('🔵 CSV Browse button clicked');
  try {
    const result = await window.electronAPI.openFileDialog({
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });
    console.log('✅ openFileDialog returned:', result);
    if (result.filePath) {
      csvPathInput.value = result.filePath;
      console.log('📝 CSV path set:', result.filePath);
      logDownloader(`✓ CSV selected: ${result.filePath}`);
    }
  } catch (err) {
    console.error('❌ openFileDialog error:', err);
    logDownloader(`❌ Error selecting file: ${err.message}`);
  }
});

// Output Folder Browse Button
document.getElementById('output-browse-btn').addEventListener('click', async () => {
  console.log('🔵 Output Folder Browse button clicked');
  try {
    const result = await window.electronAPI.openFolderDialog();
    console.log('✅ openFolderDialog returned:', result);
    if (result.folderPath) {
      outputPathInput.value = result.folderPath;
      console.log('📝 Output path set:', result.folderPath);
      logDownloader(`✓ Output folder selected: ${result.folderPath}`);
    }
  } catch (err) {
    console.error('❌ openFolderDialog error:', err);
    logDownloader(`❌ Error selecting folder: ${err.message}`);
  }
});

// Start Download
startBtn.addEventListener('click', () => {
  const csvPath = csvPathInput.value;
  const outputPath = outputPathInput.value;
  const clipSleepMin = parseFloat(clipSleepMinInput.value) || 1;
  const clipSleepMax = parseFloat(clipSleepMaxInput.value) || 2;
  const rowSleepMin = parseFloat(rowSleepMinInput.value) || 10;
  const rowSleepMax = parseFloat(rowSleepMaxInput.value) || 15;

  console.log('🔵 Start Download button clicked');
  console.log('   CSV Path:', csvPath);
  console.log('   Output Path:', outputPath);
  console.log('   Clip Sleep:', `${clipSleepMin}-${clipSleepMax}s`);
  console.log('   Row Sleep:', `${rowSleepMin}-${rowSleepMax}s`);

  if (!csvPath) {
    console.warn('❌ CSV path is empty');
    logDownloader('❌ Please select a CSV file');
    return;
  }

  if (!outputPath) {
    console.warn('❌ Output path is empty');
    logDownloader('❌ Please select an output folder');
    return;
  }

  logDownloader('🚀 Starting 5-Sec Download...');
  clearDownloaderLog();
  if (errorExtractionContainer) errorExtractionContainer.style.display = 'none';
  startBtn.disabled = true;
  stopBtn.disabled = false;
  stopBtn.textContent = 'Stop';

  // Call IPC to start download
  console.log('📤 Calling window.electronAPI.startDownload()');
  window.electronAPI.startDownload(csvPath, outputPath, clipSleepMin, clipSleepMax, rowSleepMin, rowSleepMax)
    .then((result) => {
      console.log('✅ startDownload IPC returned:', result);
      if (!result.success) {
        logDownloader(`❌ ${result.error}`);
        startBtn.disabled = false;
        stopBtn.disabled = true;
      }
    })
    .catch((err) => {
      console.error('❌ startDownload IPC error:', err);
      logDownloader(`❌ Download failed: ${err.message}`);
      startBtn.disabled = false;
      stopBtn.disabled = true;
    });
});

// Stop Download
stopBtn.addEventListener('click', () => {
  console.log('🔵 Stop Download button clicked');
  logDownloader('⏹️ Stop requested; waiting for the current clip to finish safely...');
  startBtn.disabled = true;
  stopBtn.disabled = true;
  stopBtn.textContent = 'Stopping...';
  window.electronAPI.stopDownload()
    .then((result) => {
      console.log('✅ stopDownload IPC returned:', result);
      if (!result.success) {
        logDownloader(`❌ ${result.error}`);
        startBtn.disabled = false;
        stopBtn.textContent = 'Stop';
      }
    })
    .catch((err) => {
      console.error('❌ stopDownload IPC error:', err);
      logDownloader(`❌ Error stopping: ${err.message}`);
      startBtn.disabled = false;
      stopBtn.textContent = 'Stop';
    });
});

// Open Output Folder
document.getElementById('open-output-btn').addEventListener('click', () => {
  const outputPath = outputPathInput.value;
  console.log('🔵 Open Output Folder button clicked:', outputPath);
  
  if (!outputPath) {
    console.warn('❌ Output path is empty');
    logDownloader('❌ Please select an output folder first');
    return;
  }

  window.electronAPI.openFolder(outputPath)
    .then((result) => {
      console.log('✅ openFolder IPC returned:', result);
    })
    .catch((err) => {
      console.error('❌ openFolder IPC error:', err);
      logDownloader(`❌ Error opening folder: ${err.message}`);
    });
});

// Extract every failed clip, regardless of root cause
extractRateLimitBtn.addEventListener('click', () => {
  console.log('🔵 Extract Failed Clips button clicked');
  logDownloader('📊 Extracting failed clips to CSV...');
  
  window.electronAPI.extractRateLimitErrors()
    .then((result) => {
      console.log('✅ extractRateLimitErrors IPC returned:', result);
      if (result.success) {
        logDownloader(`✅ Failed clips saved to: ${result.filePath}`);
      } else {
        logDownloader(`❌ Error: ${result.error}`);
      }
    })
    .catch((err) => {
      console.error('❌ extractRateLimitErrors IPC error:', err);
      logDownloader(`❌ Failed to extract errors: ${err.message}`);
    });
});

// Extract Age Restriction Errors
extractAgeRestrictionBtn.addEventListener('click', () => {
  console.log('🔵 Extract Age Restriction Errors button clicked');
  logDownloader('📊 Extracting age restriction errors to CSV...');
  
  window.electronAPI.extractAgeRestrictionErrors()
    .then((result) => {
      console.log('✅ extractAgeRestrictionErrors IPC returned:', result);
      if (result.success) {
        logDownloader(`✅ Age restriction errors saved to: ${result.filePath}`);
      } else {
        logDownloader(`❌ Error: ${result.error}`);
      }
    })
    .catch((err) => {
      console.error('❌ extractAgeRestrictionErrors IPC error:', err);
      logDownloader(`❌ Failed to extract errors: ${err.message}`);
    });
});

function logDownloader(message) {
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${message}\n`;
  console.log(`📝 [Downloader Log]: ${message}`);
  downloaderLog.textContent += line;
  downloaderLog.scrollTop = downloaderLog.scrollHeight;
}

function clearDownloaderLog() {
  console.log('🗑️  Clearing downloader log');
  downloaderLog.textContent = '';
}

// Facebook link
document.getElementById('fb-link-downloader').addEventListener('click', (e) => {
  e.preventDefault();
  console.log('🔗 Opening Facebook link');
  window.electronAPI.openUrl('https://www.facebook.com/rhymx2k3/');
});

// ============================================================================
// CAPCUT SHUFFLE TOOL
// ============================================================================

let allCapcutProjects = {}; // {folderName: folderPath}
let selectedProjects = {}; // {folderName: true/false}

// Browse CapCut Folder
document.getElementById('capcut-browse-btn').addEventListener('click', async () => {
  console.log('🔵 CapCut Browse button clicked');
  try {
    const result = await window.electronAPI.openFolderDialog();
    console.log('✅ openFolderDialog returned:', result);
    if (result.folderPath) {
      capcutFolderInput.value = result.folderPath;
      console.log('📝 CapCut path set:', result.folderPath);
      logCapcut(`✓ CapCut folder selected: ${result.folderPath}`);
      await loadCapcutProjects(result.folderPath);
    }
  } catch (err) {
    console.error('❌ openFolderDialog error:', err);
    logCapcut(`❌ Error selecting folder: ${err.message}`);
  }
});

// Refresh Projects
document.getElementById('capcut-refresh-btn').addEventListener('click', () => {
  const folderPath = capcutFolderInput.value;
  console.log('🔵 Refresh Projects button clicked:', folderPath);
  
  if (!folderPath) {
    console.warn('❌ Folder path is empty');
    logCapcut('❌ Please select a CapCut folder first');
    return;
  }
  logCapcut('🔄 Refreshing projects...');
  loadCapcutProjects(folderPath);
});

// Load CapCut Projects
async function loadCapcutProjects(folderPath) {
  try {
    console.log('📤 Calling window.electronAPI.scanCapcutProjects()');
    logCapcut('🔍 Scanning for CapCut projects...');
    const result = await window.electronAPI.scanCapcutProjects(folderPath);
    console.log('✅ scanCapcutProjects IPC returned:', result);

    if (result.projects && result.projects.length > 0) {
      console.log(`📊 Found ${result.projects.length} project(s)`);
      allCapcutProjects = {};
      result.projects.forEach(project => {
        allCapcutProjects[project.name] = project.path;
      });
      logCapcut(`✓ Found ${result.projects.length} project(s)`);
      renderCapcutProjects();
    } else {
      console.warn('⚠️ No projects found');
      logCapcut('⚠️ No CapCut projects found in this folder');
      capcutProjectsList.innerHTML = '';
    }
  } catch (err) {
    console.error('❌ scanCapcutProjects error:', err);
    logCapcut(`❌ Error scanning projects: ${err.message}`);
  }
}

// Render Projects List
function renderCapcutProjects(filter = '') {
  capcutProjectsList.innerHTML = '';
  const filterLower = filter.toLowerCase();

  for (const [projectName, projectPath] of Object.entries(allCapcutProjects)) {
    if (!filterLower || projectName.toLowerCase().includes(filterLower)) {
      const projectDiv = document.createElement('div');
      projectDiv.className = 'project-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `project-${projectName}`;
      checkbox.checked = selectedProjects[projectName] || false;
      checkbox.addEventListener('change', () => {
        selectedProjects[projectName] = checkbox.checked;
      });

      const label = document.createElement('label');
      label.htmlFor = `project-${projectName}`;
      label.textContent = projectName;

      projectDiv.appendChild(checkbox);
      projectDiv.appendChild(label);
      capcutProjectsList.appendChild(projectDiv);
    }
  }
}

// Search Filter
capcutSearchInput.addEventListener('input', (e) => {
  const filterText = e.target.value;
  console.log('🔍 Search filter changed:', filterText);
  renderCapcutProjects(filterText);
});

// Process Projects
capcutProcessBtn.addEventListener('click', async () => {
  const selectedNames = Object.keys(selectedProjects).filter(name => selectedProjects[name]);

  console.log('🔵 Process Projects button clicked');
  console.log('   Selected projects:', selectedNames);

  if (selectedNames.length === 0) {
    console.warn('❌ No projects selected');
    logCapcut('❌ Please select at least one project');
    return;
  }

  logCapcut(`🚀 Processing ${selectedNames.length} project(s)...`);
  capcutProcessBtn.disabled = true;

  const cacheBust = capcutCacheBustCheckbox.checked;
  const projectPaths = selectedNames.map(name => allCapcutProjects[name]);

  console.log('📤 Calling window.electronAPI.processCapcutProjects()');
  console.log('   Cache bust:', cacheBust);
  console.log('   Project paths:', projectPaths);

  try {
    const result = await window.electronAPI.processCapcutProjects(projectPaths, cacheBust);
    console.log('✅ processCapcutProjects IPC returned:', result);

    if (result.success) {
      logCapcut(`✅ Successfully processed ${result.processedCount} project(s)`);
      if (result.failed && result.failed.length > 0) {
        logCapcut('⚠️ Failed projects:');
        result.failed.forEach(f => logCapcut(`  - ${f}`));
      }
    } else {
      console.error('❌ Processing failed:', result.error);
      logCapcut(`❌ Error: ${result.error}`);
    }
  } catch (err) {
    console.error('❌ processCapcutProjects IPC error:', err);
    logCapcut(`❌ Processing failed: ${err.message}`);
  }

  capcutProcessBtn.disabled = false;
  
  // Clear all selections after processing
  selectedProjects = {};
  renderCapcutProjects(capcutSearchInput.value);
});

function logCapcut(message) {
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${message}\n`;
  console.log(`📝 [CapCut Log]: ${message}`);
  capcutLog.textContent += line;
  capcutLog.scrollTop = capcutLog.scrollHeight;
}

// Facebook link
document.getElementById('fb-link-capcut').addEventListener('click', (e) => {
  e.preventDefault();
  console.log('🔗 Opening Facebook link');
  window.electronAPI.openUrl('https://www.facebook.com/rhymx2k3/');
});

document.getElementById('fb-link-render').addEventListener('click', (e) => {
  e.preventDefault();
  console.log('🔗 Opening Facebook link');
  window.electronAPI.openUrl('https://www.facebook.com/rhymx2k3/');
});

document.getElementById('fb-link-trimmer').addEventListener('click', (e) => {
  e.preventDefault();
  console.log('🔗 Opening Facebook link');
  window.electronAPI.openUrl('https://www.facebook.com/rhymx2k3/');
});

// ============================================================================
// AUTO ADD EFFECT & TITLE TOOL
// ============================================================================

let allEffectTitleProjects = {}; // {folderName: folderPath}
let selectedEffectTitleProjects = {}; // {folderName: true/false}

// DOM Elements for Effect & Title Tab
const effectTitleFolderInput = document.getElementById('effect-title-folder-path');
const effectTitleSearchInput = document.getElementById('effect-title-search-input');
const effectTitleProjectsList = document.getElementById('effect-title-projects-list');
const effectTitleLog = document.getElementById('effect-title-log');
const effectTitleProcessBtn = document.getElementById('effect-title-process-btn');
const effectTitleAddEffectCheckbox = document.getElementById('effect-title-add-effect');
const effectTitleAddTitleCheckbox = document.getElementById('effect-title-add-title');
const effectTitleTextSection = document.getElementById('effect-title-text-section');
const effectTitleExtractedSection = document.getElementById('effect-title-extracted-section');
const effectTitleTextInput = document.getElementById('effect-title-text-input');
const effectTitleExtractedOutput = document.getElementById('effect-title-extracted-output');

// Browse Effect & Title Folder
document.getElementById('effect-title-browse-btn').addEventListener('click', async () => {
  console.log('🔵 Effect & Title Browse button clicked');
  try {
    const result = await window.electronAPI.openFolderDialog();
    console.log('✅ openFolderDialog returned:', result);
    if (result.folderPath) {
      effectTitleFolderInput.value = result.folderPath;
      console.log('📝 Effect & Title path set:', result.folderPath);
      logEffectTitle(`✓ CapCut folder selected: ${result.folderPath}`);
      await loadEffectTitleProjects(result.folderPath);
    }
  } catch (err) {
    console.error('❌ openFolderDialog error:', err);
    logEffectTitle(`❌ Error selecting folder: ${err.message}`);
  }
});

// Refresh Effect & Title Projects
document.getElementById('effect-title-refresh-btn').addEventListener('click', () => {
  const folderPath = effectTitleFolderInput.value;
  console.log('🔵 Refresh Projects button clicked:', folderPath);
  
  if (!folderPath) {
    console.warn('❌ Folder path is empty');
    logEffectTitle('❌ Please select a CapCut folder first');
    return;
  }
  logEffectTitle('🔄 Refreshing projects...');
  loadEffectTitleProjects(folderPath);
});

// Load Effect & Title Projects
async function loadEffectTitleProjects(folderPath) {
  try {
    console.log('📤 Calling window.electronAPI.scanCapcutProjects()');
    logEffectTitle('🔍 Scanning for CapCut projects...');
    const result = await window.electronAPI.scanCapcutProjects(folderPath);
    console.log('✅ scanCapcutProjects IPC returned:', result);

    if (result.projects && result.projects.length > 0) {
      console.log(`📊 Found ${result.projects.length} project(s)`);
      allEffectTitleProjects = {};
      result.projects.forEach(project => {
        allEffectTitleProjects[project.name] = project.path;
      });
      logEffectTitle(`✓ Found ${result.projects.length} project(s)`);
      renderEffectTitleProjects();
    } else {
      console.warn('⚠️ No projects found');
      logEffectTitle('⚠️ No CapCut projects found in this folder');
      effectTitleProjectsList.innerHTML = '';
    }
  } catch (err) {
    console.error('❌ scanCapcutProjects error:', err);
    logEffectTitle(`❌ Error scanning projects: ${err.message}`);
  }
}

// Render Effect & Title Projects List
function renderEffectTitleProjects(filter = '') {
  effectTitleProjectsList.innerHTML = '';
  const filterLower = filter.toLowerCase();

  for (const [projectName, projectPath] of Object.entries(allEffectTitleProjects)) {
    if (!filterLower || projectName.toLowerCase().includes(filterLower)) {
      const projectDiv = document.createElement('div');
      projectDiv.className = 'project-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `effect-title-project-${projectName}`;
      checkbox.checked = selectedEffectTitleProjects[projectName] || false;
      checkbox.addEventListener('change', () => {
        selectedEffectTitleProjects[projectName] = checkbox.checked;
      });

      const label = document.createElement('label');
      label.htmlFor = `effect-title-project-${projectName}`;
      label.textContent = projectName;

      projectDiv.appendChild(checkbox);
      projectDiv.appendChild(label);
      effectTitleProjectsList.appendChild(projectDiv);
    }
  }
}

// Effect & Title Search Filter
effectTitleSearchInput.addEventListener('input', (e) => {
  const filterText = e.target.value;
  console.log('🔍 Search filter changed:', filterText);
  renderEffectTitleProjects(filterText);
});

// Toggle Auto Add Title Checkbox
effectTitleAddTitleCheckbox.addEventListener('change', () => {
  console.log('🔲 Auto Add Title checkbox changed:', effectTitleAddTitleCheckbox.checked);
  if (effectTitleAddTitleCheckbox.checked) {
    effectTitleTextSection.style.display = 'block';
    effectTitleExtractedSection.style.display = 'block';
  } else {
    effectTitleTextSection.style.display = 'none';
    effectTitleExtractedSection.style.display = 'none';
    effectTitleTextInput.value = '';
    effectTitleExtractedOutput.textContent = '';
  }
});

// Extract Text from Input
effectTitleTextInput.addEventListener('input', () => {
  const inputText = effectTitleTextInput.value;
  console.log('📝 Text input changed, extracting...');
  
  if (!inputText.trim()) {
    effectTitleExtractedOutput.textContent = '';
    return;
  }

  // Extract lines containing at least 2 keywords: "Number" and ":"
  const keywords = [
    'Number',
    ':',
    '번호',
    'Número',
    'Numéro',
    '番号',];
  const lines = inputText.split('\n');
  const extractedLines = [];

  for (const line of lines) {
    let keywordCount = 0;
    for (const keyword of keywords) {
      if (line.includes(keyword)) {
        keywordCount++;
      }
    }
    if (keywordCount >= 2) {
      const trimmedLine = line.trim();
      if (trimmedLine) {
        extractedLines.push(trimmedLine);
      }
    }
  }

  // Display extracted lines
  if (extractedLines.length > 0) {
    effectTitleExtractedOutput.textContent = extractedLines.join('\n');
    console.log(`✅ Extracted ${extractedLines.length} line(s)`);
  } else {
    effectTitleExtractedOutput.textContent = '(No lines match the criteria)';
  }
});

// Process Effect & Title Projects
effectTitleProcessBtn.addEventListener('click', async () => {
  const selectedNames = Object.keys(selectedEffectTitleProjects).filter(name => selectedEffectTitleProjects[name]);

  console.log('🔵 Process Effect & Title Projects button clicked');
  console.log('   Selected projects:', selectedNames);
  console.log('   Add Effect:', effectTitleAddEffectCheckbox.checked);
  console.log('   Add Title:', effectTitleAddTitleCheckbox.checked);
  console.log('   Log Markers Time:', document.getElementById('effect-title-log-markers-time').checked);
  
  // Safe null-check for skip intro checkbox
  const skipIntroCheckbox = document.getElementById('effect-title-skip-intro');
  console.log('   Skip Intro Checkbox Element:', skipIntroCheckbox);
  console.log('   Skip Intro Checkbox Checked:', skipIntroCheckbox?.checked);

  if (selectedNames.length === 0) {
    console.warn('❌ No projects selected');
    logEffectTitle('❌ Please select at least one project');
    return;
  }

  if (effectTitleAddTitleCheckbox.checked && !effectTitleTextInput.value.trim()) {
    console.warn('❌ Title text is empty');
    logEffectTitle('❌ Please enter text for Auto Add Title');
    return;
  }

  logEffectTitle(`🚀 Processing ${selectedNames.length} project(s)...`);
  effectTitleProcessBtn.disabled = true;

  const projectPaths = selectedNames.map(name => allEffectTitleProjects[name]);
  const addEffect = effectTitleAddEffectCheckbox.checked;
  const addTitle = effectTitleAddTitleCheckbox.checked;
  const logMarkersTime = document.getElementById('effect-title-log-markers-time').checked;
  const skipIntro = skipIntroCheckbox?.checked || false;
  const titleText = addTitle ? effectTitleTextInput.value : '';

  console.log('📤 Calling window.electronAPI.processEffectTitle()');
  console.log('   Add Effect:', addEffect);
  console.log('   Add Title:', addTitle);
  console.log('   Log Markers Time:', logMarkersTime);
  console.log('   Skip Intro (final value):', skipIntro);
  console.log('   Project paths:', projectPaths);
  
  logEffectTitle(`📝 Skip Intro enabled: ${skipIntro}`);

  try {
    const result = await window.electronAPI.processEffectTitle(projectPaths, addEffect, addTitle, titleText, logMarkersTime, skipIntro);
    console.log('✅ processEffectTitle IPC returned:', result);

    if (result.success) {
      logEffectTitle(`✅ Successfully processed ${result.processedCount} project(s)`);
      if (result.failed && result.failed.length > 0) {
        logEffectTitle('⚠️ Failed projects:');
        result.failed.forEach(f => logEffectTitle(`  - ${f}`));
      }
    } else {
      console.error('❌ Processing failed:', result.error);
      logEffectTitle(`❌ Error: ${result.error}`);
    }
  } catch (err) {
    console.error('❌ processEffectTitle IPC error:', err);
    logEffectTitle(`❌ Processing failed: ${err.message}`);
  }

  effectTitleProcessBtn.disabled = false;
  
  // Clear all selections after processing
  selectedEffectTitleProjects = {};
  renderEffectTitleProjects(effectTitleSearchInput.value);
});

function logEffectTitle(message) {
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${message}\n`;
  console.log(`📝 [Effect & Title Log]: ${message}`);
  effectTitleLog.textContent += line;
  effectTitleLog.scrollTop = effectTitleLog.scrollHeight;
}

// Facebook link
document.getElementById('fb-link-effect-title').addEventListener('click', (e) => {
  e.preventDefault();
  console.log('🔗 Opening Facebook link');
  window.electronAPI.openUrl('https://www.facebook.com/rhymx2k3/');
});

console.log('✅ Tools Handler fully initialized');
