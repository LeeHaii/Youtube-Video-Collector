// Renderer process - Main UI controller

console.log('📹 Renderer process starting...');

let markers = [];
let currentRow = [];
let rows = [];
let currentUrl = '';
let lastMarkerTime = -1; // Prevent duplicate markers

// DOM Elements
const youtubeWebview = document.querySelector('#youtube-webview');
const currentUrlInput = document.querySelector('#current-url');
const markersList = document.querySelector('#markers-list');
const takeUrlBtn = document.querySelector('#take-url-btn');
const nextRowBtn = document.querySelector('#next-row-btn');
const exportBtn = document.querySelector('#export-btn');
const undoBtn = document.querySelector('#undo-btn');
const clearRowBtn = document.querySelector('#clear-row-btn');
const currentRowDisplay = document.querySelector('#current-row-display');
const currentRowTimestampCount = document.querySelector('#current-row-timestamp-count');
const rowCountSpan = document.querySelector('#row-count');
const markerCountSpan = document.querySelector('#marker-count');
const rowsGrid = document.querySelector('#rows-grid tbody');

console.log('✅ DOM elements loaded');

// Event Listeners
takeUrlBtn.addEventListener('click', takeUrlAndMarkers);
nextRowBtn.addEventListener('click', nextRow);
exportBtn.addEventListener('click', exportCSV);
undoBtn.addEventListener('click', undoMarker);
clearRowBtn.addEventListener('click', clearCurrentRow);

console.log('✅ Button listeners attached');

// Global keyboard listener for marker detection
let isYoutubeActive = false;

youtubeWebview.addEventListener('focus', () => {
  console.log('🎯 WebView focused');
  isYoutubeActive = true;
});

youtubeWebview.addEventListener('blur', () => {
  console.log('😴 WebView blurred');
  isYoutubeActive = false;
});

// Monitor URL changes
youtubeWebview.addEventListener('did-navigate', updateUrlDisplay);
youtubeWebview.addEventListener('did-navigate-in-page', updateUrlDisplay);

console.log('✅ WebView event listeners attached');

// Polling mechanism to check for markers
let lastProcessedMarkerTime = -1;
setInterval(() => {
  youtubeWebview
    .executeJavaScript(`
      (function() {
        if (window.__lastMarkerCapture) {
          console.log('[YouTube] Returning marker:', window.__lastMarkerCapture);
          return window.__lastMarkerCapture;
        }
        return null;
      })();
    `)
    .then((markerData) => {
      if (markerData && typeof markerData.time === 'number' && markerData.time !== lastProcessedMarkerTime) {
        console.log('📨 [Poll] Marker detected:', markerData);
        lastProcessedMarkerTime = markerData.time;
        processMarker(markerData);
      }
    })
    .catch(() => {
      // Ignore polling errors  
    });
}, 100);

// Setup on webview ready
youtubeWebview.addEventListener('dom-ready', () => {
  console.log('✨ WebView DOM ready, injecting scripts...');
  injectScripts();
  // setupPolling(); // Already set up with setInterval below
  updateUrlDisplay();
  console.log('✨ Scripts injected successfully');
});

// Inject scripts into webview
function injectScripts() {
  // Inject a keydown listener into the YouTube page
  const keyListenerScript = `
    (function() {
      console.log('[YouTube Page] Setting up comma key listener...');
      
      // Use global document listener with capture phase
      document.addEventListener('keydown', function(e) {
        if (e.key === ',') {
          console.log('[YouTube Page] 🔴 COMMA KEY PRESSED! e.key=' + e.key);
          e.preventDefault();
          e.stopPropagation();
          
          // Find video element
          const videos = document.querySelectorAll('video');
          console.log('[YouTube Page] Found ' + videos.length + ' video elements');
          
          for (let v of videos) {
            if (v.offsetParent !== null) {
              console.log('[YouTube Page] ✓ Video found! Time: ' + v.currentTime + ', Duration: ' + v.duration);
              
              // Store marker data
              window.__lastMarkerCapture = {
                time: v.currentTime,
                duration: v.duration,
                url: window.location.href,
                timestamp: Date.now()
              };
              
              console.log('[YouTube Page] ✓ Marker stored:', window.__lastMarkerCapture);
              break;
            }
          }
        }
      }, true); // Capture phase
      
      // Also listen on window for extra coverage
      window.addEventListener('keydown', function(e) {
        if (e.key === ',') {
          console.log('[YouTube Page] (window) Comma key detected');
        }
      }, true);
      
      window.__youtubePageReady = true;
      console.log('[YouTube Page] ✓ Comma key listener fully initialized');
    })();
  `;

  console.log('💉 Injecting YouTube key listener...');
  youtubeWebview.executeJavaScript(keyListenerScript).catch((err) => {
    console.error('❌ Error injecting key listener:', err);
  });
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Count timestamps in a semicolon-separated string
 * e.g., "0.30;1.45;2.10" -> 3 timestamps
 */
function countTimestamps(timestampStr) {
  if (!timestampStr || timestampStr.trim() === '') return 0;
  return timestampStr.split(';').length;
}

/**
 * Count total timestamps in a row (sum of all timestamp cells)
 */
function countTotalTimestamps(row) {
  let total = 0;
  // Row alternates: url, timestamps, url, timestamps...
  // So timestamps are at odd indices (1, 3, 5, ...)
  for (let i = 1; i < row.length; i += 2) {
    total += countTimestamps(row[i]);
  }
  return total;
}

// ============================================================================
// MARKER PROCESSING
// ============================================================================

// Process marker once detected
function processMarker(videoData) {
  console.log('🎯 Processing marker:', videoData);
  
  if (!videoData || typeof videoData.time !== 'number') {
    console.error('❌ Invalid marker data:', videoData);
    return;
  }
  
  // Prevent duplicate markers
  if (Math.abs(videoData.time - lastMarkerTime) <= 0.5) {
    console.log('⏱️ Marker too close to last one, skipping');
    return;
  }
  
  const marker = {
    time: videoData.time,
    formatted: formatMarkerTime(videoData.time),
  };
  
  console.log('✅ Adding marker:', marker);
  addMarker(marker);
  lastMarkerTime = videoData.time;
  showNotification(marker.formatted);
  createTimelineMarker(videoData.time, videoData.duration);
}

// Create visual marker on timeline
function createTimelineMarker(currentTime, duration) {
  const script = `
    (function() {
      try {
        const progressBar = document.querySelector('.ytp-progress-bar');
        if (!progressBar) {
          console.log('[Marker] Progress bar not found');
          return;
        }

        const percent = (${currentTime} / ${duration}) * 100;
        console.log('[Marker] Creating at', percent + '%');
        
        // Check if marker already exists at this position
        const existing = Array.from(progressBar.children).find(el => {
          const leftPercent = parseFloat(el.style.left);
          return Math.abs(leftPercent - percent) < 1;
        });

        if (existing) {
          console.log('[Marker] Already exists at this position');
          return;
        }

        const marker = document.createElement('div');
        marker.style.cssText = 'position:absolute;left:${percent}%;width:4px;height:100%;background-color:#ff6b6b;cursor:pointer;z-index:100;transform:translateX(-50%);border-radius:2px;';
        marker.dataset.time = ${currentTime};
        marker.title = '${formatMarkerTime.toString()}' + ' at ' + ${currentTime}.toFixed(1);

        marker.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const videos = document.querySelectorAll('video');
          for (let v of videos) {
            if (v.offsetParent !== null) {
              v.currentTime = ${currentTime};
              break;
            }
          }
        });

        marker.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          marker.remove();
        });

        progressBar.appendChild(marker);
        console.log('[Marker] Successfully added');
      } catch (e) {
        console.error('Marker error:', e);
      }
    })();
  `;

  youtubeWebview.executeJavaScript(script).catch((err) => {
    console.error('Error executing marker script:', err);
  });
}

// Show notification
function showNotification(text) {
  console.log('Showing notification:', text);
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background-color: rgba(0, 0, 0, 0.9);
    color: #4fc3f7;
    padding: 12px 20px;
    border-radius: 6px;
    font-size: 14px;
    z-index: 10000;
    pointer-events: none;
    animation: slideIn 0.3s ease-out;
    border: 2px solid #4fc3f7;
    font-weight: bold;
  `;
  notification.textContent = `✓ Marker: ${text}`;

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.opacity = '0';
    notification.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => notification.remove(), 300);
  }, 2000);
}

// Update URL display
async function updateUrlDisplay() {
  try {
    youtubeWebview
      .executeJavaScript('window.location.href')
      .then((url) => {
        if (url !== currentUrl) {
          currentUrl = url;
          currentUrlInput.value = url;
        }
      })
      .catch(() => {
        // Ignore
      });
  } catch (err) {
    console.error('Error updating URL:', err);
  }
}

// Add marker to list
function addMarker(marker) {
  if (!marker || marker.time === undefined) return;

  markers.push(marker);
  updateMarkersDisplay();
}

// Update markers display
function updateMarkersDisplay() {
  markersList.innerHTML = '';
  markers.forEach((marker, index) => {
    const item = document.createElement('div');
    item.className = 'marker-item';
    item.innerHTML = `
      <span class="marker-item-time">${formatMarkerTime(marker.time)}</span>
      <span class="marker-item-remove" data-index="${index}">×</span>
    `;

    // Click to jump
    item.querySelector('.marker-item-time').addEventListener('click', () => {
      youtubeWebview.executeJavaScript(`
        (function() {
          const videos = document.querySelectorAll('video');
          for (let v of videos) {
            if (v.offsetParent !== null) {
              v.currentTime = ${marker.time};
              break;
            }
          }
        })();
      `);
    });

    // Remove button
    item.querySelector('.marker-item-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      markers.splice(index, 1);
      updateMarkersDisplay();
    });

    markersList.appendChild(item);
  });

  markerCountSpan.textContent = markers.length;
}

// Format marker time as mm.ss or hh.mm.ss
function formatMarkerTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0.00';
  
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}.${mins < 10 ? '0' : ''}${mins}.${secs < 10 ? '0' : ''}${secs}`;
  }
  return `${mins}.${secs < 10 ? '0' : ''}${secs}`;
}

// Undo last marker
function undoMarker() {
  if (markers.length > 0) {
    markers.pop();
    updateMarkersDisplay();
  }
}

// Clear current row
function clearCurrentRow() {
  if (currentRow.length === 0) {
    alert('Current row is already empty');
    return;
  }
  
  // Remove last URL + timestamps pair (2 elements)
  if (currentRow.length >= 2) {
    currentRow.pop(); // Remove timestamps
    currentRow.pop(); // Remove URL
  }
  
  updateCurrentRowDisplay();
}

// Take URL + Markers
function takeUrlAndMarkers() {
  if (!currentUrl.includes('youtube.com') && !currentUrl.includes('youtu.be')) {
    alert('Please navigate to a YouTube video first');
    return;
  }

  if (markers.length === 0) {
    alert('Please add at least one marker');
    return;
  }

  // Convert markers to semicolon-separated format using formatted time (mm.ss or hh.mm.ss)
  const timestampStr = markers.map((m) => {
    return formatMarkerTime(m.time);
  }).join(';');

  currentRow.push(currentUrl);
  currentRow.push(timestampStr);

  // Clear for next video
  markers = [];
  lastMarkerTime = -1;
  updateMarkersDisplay();
  updateCurrentRowDisplay();
}

// Next Row
function nextRow() {
  if (currentRow.length === 0) {
    alert('No data to add to next row');
    return;
  }

  rows.push([...currentRow]);
  currentRow = [];
  updateCurrentRowDisplay();
  updateRowsTable();
}

// Update current row display
function updateCurrentRowDisplay() {
  if (currentRow.length === 0) {
    currentRowDisplay.innerHTML = '<span style="color: #999;">Empty</span>';
    currentRowTimestampCount.textContent = '0';
    return;
  }

  const items = currentRow.map((item, idx) => {
    const label = idx % 2 === 0 ? 'URL' : 'Timestamps';
    const isUrl = label === 'URL';
    const displayText = isUrl ? (item.length > 40 ? item.substring(0, 40) + '...' : item) : item;
    return `<div class="row-item"><strong>${label}:</strong> ${displayText}</div>`;
  });

  currentRowDisplay.innerHTML = items.join('');
  
  // Calculate and display total timestamps in current row
  const totalTs = countTotalTimestamps(currentRow);
  currentRowTimestampCount.textContent = totalTs;
}

// Update rows table display
function updateRowsTable() {
  rowsGrid.innerHTML = '';
  rows.forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    
    // Row number cell
    const numCell = document.createElement('td');
    numCell.className = 'row-num';
    numCell.textContent = `${rowIndex + 1}`;
    tr.appendChild(numCell);
    
    // Add URL and timestamps alternately
    for (let i = 0; i < row.length; i += 2) {
      // URL cell
      const urlCell = document.createElement('td');
      urlCell.className = 'row-data';
      const url = row[i];
      urlCell.textContent = url;
      urlCell.title = url; // Full URL in tooltip
      tr.appendChild(urlCell);
      
      // Timestamps cell
      const tsCell = document.createElement('td');
      tsCell.className = 'row-data';
      const timestamps = row[i + 1] || '';
      tsCell.textContent = timestamps;
      tr.appendChild(tsCell);
    }
    
    // Add total timestamps count column
    const totalCell = document.createElement('td');
    totalCell.className = 'row-timestamp-count';
    totalCell.textContent = countTotalTimestamps(row);
    tr.appendChild(totalCell);
    
    rowsGrid.appendChild(tr);
  });
  
  rowCountSpan.textContent = rows.length;
}

// Export CSV
async function exportCSV() {
  if (currentRow.length > 0) {
    rows.push([...currentRow]);
    currentRow = [];
    updateCurrentRowDisplay();
    updateRowsTable();
  }

  if (rows.length === 0) {
    alert('No data to export');
    return;
  }

  try {
    const result = await window.electronAPI.exportCSV(rows);

    if (result.success) {
      alert(`CSV exported successfully to:\n${result.filePath}`);
      // Reset everything
      rows = [];
      currentRow = [];
      markers = [];
      currentUrl = '';
      currentUrlInput.value = '';
      lastMarkerTime = -1;
      updateCurrentRowDisplay();
      updateMarkersDisplay();
      updateRowsTable();
      rowCountSpan.textContent = '0';
    } else {
      alert(`Export failed: ${result.error}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// Periodic URL update
setInterval(updateUrlDisplay, 3000);

// ============================================================================
// YOUTUBE NAVIGATION CONTROLS
// ============================================================================

const ytBackBtn = document.querySelector('#yt-back-btn');
const ytForwardBtn = document.querySelector('#yt-forward-btn');
const ytRefreshBtn = document.querySelector('#yt-refresh-btn');
const ytUrlField = document.querySelector('#yt-url-field');

// Function to update navigation button states
function updateNavigationButtonStates() {
  const canGoBack = youtubeWebview.canGoBack();
  const canGoForward = youtubeWebview.canGoForward();
  
  ytBackBtn.disabled = !canGoBack;
  ytForwardBtn.disabled = !canGoForward;
  
  console.log(`📍 Navigation state - Back: ${canGoBack}, Forward: ${canGoForward}`);
}

// Back button
ytBackBtn.addEventListener('click', () => {
  console.log('⬅️ Going back...');
  youtubeWebview.goBack();
  setTimeout(updateNavigationButtonStates, 300);
});

// Forward button
ytForwardBtn.addEventListener('click', () => {
  console.log('➡️ Going forward...');
  youtubeWebview.goForward();
  setTimeout(updateNavigationButtonStates, 300);
});

// Refresh button
ytRefreshBtn.addEventListener('click', () => {
  console.log('🔄 Refreshing page...');
  youtubeWebview.reload();
});

// Update URL field when navigation occurs
function updateYoutubeUrlField() {
  try {
    if (!youtubeWebview || typeof youtubeWebview.executeJavaScript !== 'function') {
      console.warn('⚠️ WebView not ready or executeJavaScript not available');
      return;
    }
    youtubeWebview
      .executeJavaScript('window.location.href')
      .then((url) => {
        ytUrlField.value = url;
      })
      .catch(() => {
        ytUrlField.value = 'Unable to load URL';
      });
  } catch (err) {
    console.warn('⚠️ Error updating URL field:', err);
  }
}

// Update on navigation events
youtubeWebview.addEventListener('did-navigate', () => {
  updateYoutubeUrlField();
  setTimeout(updateNavigationButtonStates, 300);
});

youtubeWebview.addEventListener('did-navigate-in-page', () => {
  updateYoutubeUrlField();
  setTimeout(updateNavigationButtonStates, 300);
});

// Initial URL update and button state (wrapped in try-catch)
try {
  updateYoutubeUrlField();
  setTimeout(updateNavigationButtonStates, 500);
} catch (err) {
  console.warn('⚠️ Error in initial URL update:', err);
}

console.log('🎬 YouTube Video Collector - Renderer initialized and ready!');
console.log('📌 Press , to add markers');
console.log('🐛 Check console for debug messages');

// ============================================================================
// YOUTUBE TRIMMER CONTROLS
// ============================================================================

console.log('🔧🔧🔧 TRIMMER: Starting initialization...');

// Initialize trimmer when document is ready
function initTrimmer() {
  console.log('🔧🔧🔧 TRIMMER: Initialization function called');
  
  // Query trimmer DOM elements with error checking
  const trimmerOutputPath = document.querySelector('#trimmer-output-path');
  const trimmerOutputBrowseBtn = document.querySelector('#trimmer-output-browse-btn');
  const trimmerUrlInput = document.querySelector('#trimmer-url-input');
  const trimmerUrlOkBtn = document.querySelector('#trimmer-url-ok-btn');
  const trimmerWebview = document.querySelector('#trimmer-webview');

  // Timestamp inputs (start)
  const trimmerStartHours = document.querySelector('#trimmer-start-hours');
  const trimmerStartMinutes = document.querySelector('#trimmer-start-minutes');
  const trimmerStartSeconds = document.querySelector('#trimmer-start-seconds');
  const trimmerStartMs = document.querySelector('#trimmer-start-ms');

  // Timestamp inputs (end)
  const trimmerEndHours = document.querySelector('#trimmer-end-hours');
  const trimmerEndMinutes = document.querySelector('#trimmer-end-minutes');
  const trimmerEndSeconds = document.querySelector('#trimmer-end-seconds');
  const trimmerEndMs = document.querySelector('#trimmer-end-ms');

  const trimmerDownloadBtn = document.querySelector('#trimmer-download-btn');
  const trimmerLog = document.querySelector('#trimmer-log');

  let currentTrimmerUrl = '';

  // Verify all elements loaded
  const trimmerElements = {
    outputPath: trimmerOutputPath,
    browseBtn: trimmerOutputBrowseBtn,
    urlInput: trimmerUrlInput,
    okBtn: trimmerUrlOkBtn,
    webview: trimmerWebview,
    startHours: trimmerStartHours,
    startMinutes: trimmerStartMinutes,
    startSeconds: trimmerStartSeconds,
    startMs: trimmerStartMs,
    endHours: trimmerEndHours,
    endMinutes: trimmerEndMinutes,
    endSeconds: trimmerEndSeconds,
    endMs: trimmerEndMs,
    downloadBtn: trimmerDownloadBtn,
    log: trimmerLog,
  };

  let missingElements = [];
  for (const [name, element] of Object.entries(trimmerElements)) {
    if (!element) {
      console.error(`❌ TRIMMER MISSING: ${name}`);
      missingElements.push(name);
    } else {
      console.log(`✅ TRIMMER FOUND: ${name}`);
    }
  }

  if (missingElements.length > 0) {
    console.error('❌ TRIMMER FAILED - Missing elements:', missingElements);
    return;
  }
  
  console.log('✅ TRIMMER: All DOM elements loaded successfully');

  // Helper function to append log messages
  function appendTrimmerLog(message) {
    if (!trimmerLog) return;
    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ${message}`;
    trimmerLog.textContent += line + '\n';
    trimmerLog.scrollTop = trimmerLog.scrollHeight;
    console.log(`📝 [TRIMMER LOG]: ${message}`);
  }

  // Validate and extract YouTube video ID
  function extractYouTubeVideoId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  // Browse output folder
  trimmerOutputBrowseBtn.addEventListener('click', async () => {
    console.log('🟢🟢🟢 BROWSE BUTTON CLICKED 🟢🟢🟢');
    appendTrimmerLog('📂 [BROWSE] Button clicked - attempting to open folder dialog');
    
    try {
      console.log('🔵 Checking if window.electronAPI exists:', !!window.electronAPI);
      console.log('🔵 Checking if openFolderDialog exists:', !!(window.electronAPI && window.electronAPI.openFolderDialog));
      
      if (!window.electronAPI) {
        console.error('❌ ERROR: window.electronAPI does not exist');
        appendTrimmerLog('❌ [ERROR] window.electronAPI not available');
        return;
      }
      
      if (!window.electronAPI.openFolderDialog) {
        console.error('❌ ERROR: window.electronAPI.openFolderDialog does not exist');
        appendTrimmerLog('❌ [ERROR] openFolderDialog not available');
        return;
      }
      
      console.log('✅ API available, calling openFolderDialog...');
      appendTrimmerLog('⏳ [BROWSE] Waiting for folder dialog...');
      
      const result = await window.electronAPI.openFolderDialog();
      console.log('✅✅✅ Browse dialog result:', result);
      appendTrimmerLog(`✅ [BROWSE] Dialog returned: ${JSON.stringify(result)}`);
      
      if (result && result.folderPath) {
        trimmerOutputPath.value = result.folderPath;
        console.log('✅ Output path set to:', result.folderPath);
        appendTrimmerLog(`✅ [BROWSE] Output folder set: ${result.folderPath}`);
      } else {
        console.log('⚠️ No folder selected or invalid result');
        appendTrimmerLog('⚠️ [BROWSE] No folder selected');
      }
    } catch (err) {
      console.error('❌ [ERROR] Browse error:', err);
      console.error('Error stack:', err.stack);
      appendTrimmerLog(`❌ [ERROR] ${err.message}`);
    }
  });

  // URL OK button - Load video preview
  trimmerUrlOkBtn.addEventListener('click', () => {
    console.log('🟣🟣🟣 URL OK BUTTON CLICKED 🟣🟣🟣');
    appendTrimmerLog('🎬 [URL OK] Button clicked');
    
    try {
      const url = trimmerUrlInput.value.trim();
      console.log('📝 URL input value:', url);
      appendTrimmerLog(`📝 [URL OK] Input URL: ${url}`);
      
      if (!url) {
        console.log('❌ URL is empty');
        appendTrimmerLog('❌ [URL OK] URL input is empty');
        return;
      }

      console.log('🔍 Extracting video ID from URL...');
      const videoId = extractYouTubeVideoId(url);
      console.log('🔍 Extracted video ID:', videoId);
      appendTrimmerLog(`🔍 [URL OK] Extracted video ID: ${videoId}`);
      
      if (!videoId) {
        console.log('❌ Could not extract video ID');
        appendTrimmerLog('❌ [URL OK] Invalid YouTube URL format');
        return;
      }

      currentTrimmerUrl = url;
      
      // Navigate webview to YouTube video
      const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
      console.log('🔵 Navigating webview to:', youtubeUrl);
      appendTrimmerLog(`🎥 [URL OK] Loading video in webview: ${youtubeUrl}`);
      
      trimmerWebview.src = youtubeUrl;
      
      console.log('✅ Webview navigation initiated');
      appendTrimmerLog(`✅ [URL OK] Video player loaded`);
    } catch (err) {
      console.error('❌ [ERROR] URL OK error:', err);
      appendTrimmerLog(`❌ [ERROR] ${err.message}`);
    }
  });

  // Helper to get timestamps in seconds
  function getStartTimestamp() {
    const h = parseInt(trimmerStartHours?.value || 0) || 0;
    const m = parseInt(trimmerStartMinutes?.value || 0) || 0;
    const s = parseInt(trimmerStartSeconds?.value || 0) || 0;
    const ms = parseInt(trimmerStartMs?.value || 0) || 0;
    return h * 3600 + m * 60 + s + ms / 1000;
  }

  function getEndTimestamp() {
    const h = parseInt(trimmerEndHours?.value || 0) || 0;
    const m = parseInt(trimmerEndMinutes?.value || 0) || 0;
    const s = parseInt(trimmerEndSeconds?.value || 0) || 0;
    const ms = parseInt(trimmerEndMs?.value || 0) || 0;
    return h * 3600 + m * 60 + s + ms / 1000;
  }

  // Format timestamp for display
  function formatTimestamp(h, m, s, ms) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }

  // Auto-correct timestamp input values on input
  const timestampInputs = [
    trimmerStartHours, trimmerStartMinutes, trimmerStartSeconds, trimmerStartMs,
    trimmerEndHours, trimmerEndMinutes, trimmerEndSeconds, trimmerEndMs
  ];

  // Set video currentTime when timestamp input changes (on blur)
  function syncVideoTime(secondsToSeek) {
    if (!trimmerWebview) return;
    console.log(`⏱️ Setting video currentTime to ${secondsToSeek}s`);
    trimmerWebview.executeJavaScript(`
      (function() {
        try {
          const videos = document.querySelectorAll('video');
          for (let v of videos) {
            if (v.offsetParent !== null) {
              v.currentTime = ${secondsToSeek};
              console.log('✅ Video currentTime set to: ' + v.currentTime);
              break;
            }
          }
        } catch (e) {
          console.error('Error setting video time:', e);
        }
      })();
    `).catch(err => console.warn('⚠️ executeJavaScript failed:', err));
  }

  timestampInputs.forEach((input, index) => {
    if (input) {
      input.addEventListener('input', (e) => {
        let val = parseInt(e.target.value) || 0;
        
        const maxValues = {
          'trimmer-start-hours': 23, 'trimmer-end-hours': 23,
          'trimmer-start-minutes': 59, 'trimmer-end-minutes': 59,
          'trimmer-start-seconds': 59, 'trimmer-end-seconds': 59,
          'trimmer-start-ms': 999, 'trimmer-end-ms': 999,
        };
        
        const max = maxValues[e.target.id];
        if (max !== undefined) {
          val = Math.min(Math.max(val, 0), max);
          e.target.value = val;
        }
      });
      
      // Sync video time on blur for start timestamps only
      if (index < 4) {  // First 4 are start timestamps
        input.addEventListener('blur', () => syncVideoTime(getStartTimestamp()));
      }
    }
  });

  // Download trimmed video
  trimmerDownloadBtn.addEventListener('click', async () => {
    console.log('🟠🟠🟠 DOWNLOAD BUTTON CLICKED 🟠🟠🟠');
    appendTrimmerLog('⬇️ [DOWNLOAD] Button clicked');
    
    if (!currentTrimmerUrl) {
      console.log('❌ No URL loaded');
      appendTrimmerLog('❌ [DOWNLOAD] No video URL loaded - click OK button first');
      return;
    }

    if (!trimmerOutputPath.value) {
      console.log('❌ No output path selected');
      appendTrimmerLog('❌ [DOWNLOAD] No output folder selected - use Browse button');
      return;
    }

    const startSeconds = getStartTimestamp();
    const endSeconds = getEndTimestamp();

    if (startSeconds >= endSeconds) {
      console.log('❌ Start time >= end time');
      appendTrimmerLog('❌ [DOWNLOAD] Start time must be before end time');
      return;
    }

    const startDisplay = formatTimestamp(
      parseInt(trimmerStartHours?.value) || 0,
      parseInt(trimmerStartMinutes?.value) || 0,
      parseInt(trimmerStartSeconds?.value) || 0,
      parseInt(trimmerStartMs?.value) || 0
    );
    
    const endDisplay = formatTimestamp(
      parseInt(trimmerEndHours?.value) || 0,
      parseInt(trimmerEndMinutes?.value) || 0,
      parseInt(trimmerEndSeconds?.value) || 0,
      parseInt(trimmerEndMs?.value) || 0
    );

    try {
      trimmerDownloadBtn.disabled = true;
      console.log(`🚀 Starting trim: ${startDisplay} → ${endDisplay}`);
      appendTrimmerLog(`🚀 [DOWNLOAD] Starting trim: ${startDisplay} → ${endDisplay}`);
      
      const result = await window.electronAPI.trimYouTubeVideo(
        currentTrimmerUrl,
        startSeconds,
        endSeconds,
        trimmerOutputPath.value
      );

      if (result.success) {
        console.log('✅ Trim successful:', result.filePath);
        appendTrimmerLog(`✅ [DOWNLOAD] Success! Video saved: ${result.filePath}`);
      } else {
        console.log('❌ Trim failed:', result.error);
        appendTrimmerLog(`❌ [DOWNLOAD] Error: ${result.error}`);
      }
    } catch (err) {
      console.error('❌ [ERROR] Download error:', err);
      console.error('Error stack:', err.stack);
      appendTrimmerLog(`❌ [ERROR] ${err.message}`);
    } finally {
      trimmerDownloadBtn.disabled = false;
    }
  });

  // Listen for trim log messages from main process
  if (window.electronAPI && typeof window.electronAPI.onTrimLog === 'function') {
    console.log('✅ Setting up onTrimLog listener');
    window.electronAPI.onTrimLog((message) => {
      console.log('📨 [IPC] Received trim log:', message);
      appendTrimmerLog(message);
    });
  } else {
    console.warn('⚠️ onTrimLog not available');
  }
  
  console.log('✅ TRIMMER: All event listeners attached successfully');
  console.log('✅ TRIMMER INITIALIZATION COMPLETE');
  appendTrimmerLog('✅ YouTube Trimmer initialized and ready!');
}

// Call initTrimmer immediately when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTrimmer);
} else {
  initTrimmer();
}
