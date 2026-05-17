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
window.electronAPI.onDownloadComplete?.((success) => {
  console.log('✅ [Download Complete]:', success);
  if (startBtn && stopBtn && downloaderLog) {
    const timestamp = new Date().toLocaleTimeString();
    if (success) {
      downloaderLog.textContent += `[${timestamp}] ✅ Download completed successfully!\n`;
    } else {
      downloaderLog.textContent += `[${timestamp}] ❌ Download failed!\n`;
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

// Setup download error summary listener
window.electronAPI.onDownloadErrorSummary?.((summary) => {
  console.log('📊 [Download Error Summary]:', summary);
  
  if (errorExtractionContainer) {
    // Show error extraction buttons if there are any errors
    if (summary.rateLimitCount > 0 || summary.ageRestrictionCount > 0) {
      errorExtractionContainer.style.display = 'flex';
      
      // Update button text with error counts
      if (extractRateLimitBtn && summary.rateLimitCount > 0) {
        extractRateLimitBtn.textContent = `Extract Rate Limit Errors (${summary.rateLimitCount})`;
        extractRateLimitBtn.style.display = 'inline-block';
      }
      
      // Show age restriction button only if there are age restriction errors
      if (extractAgeRestrictionBtn && summary.ageRestrictionCount > 0) {
        extractAgeRestrictionBtn.textContent = `Extract Age Restriction Errors (${summary.ageRestrictionCount})`;
        extractAgeRestrictionBtn.style.display = 'inline-block';
      }
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
  startBtn.disabled = true;
  stopBtn.disabled = false;

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
  logDownloader('⏹️ Stopping download...');
  window.electronAPI.stopDownload()
    .then((result) => {
      console.log('✅ stopDownload IPC returned:', result);
      if (!result.success) {
        logDownloader(`❌ ${result.error}`);
      }
    })
    .catch((err) => {
      console.error('❌ stopDownload IPC error:', err);
      logDownloader(`❌ Error stopping: ${err.message}`);
    });
  startBtn.disabled = false;
  stopBtn.disabled = true;
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

// Extract Rate Limit Errors
extractRateLimitBtn.addEventListener('click', () => {
  console.log('🔵 Extract Rate Limit Errors button clicked');
  logDownloader('📊 Extracting rate limit errors to CSV...');
  
  window.electronAPI.extractRateLimitErrors()
    .then((result) => {
      console.log('✅ extractRateLimitErrors IPC returned:', result);
      if (result.success) {
        logDownloader(`✅ Rate limit errors saved to: ${result.filePath}`);
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
console.log('✅ Tools Handler fully initialized');
