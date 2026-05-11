// Renderer process - Main UI controller

console.log('📹 Renderer process starting...');

let markers = [];
let currentRow = [];
let rows = [];
let currentUrl = '';
let lastMarkerTime = -1; // Prevent duplicate markers
let loadedRowIndex = -1; // Track which row is currently loaded for editing
let loadedUrlIndex = -1; // Track which URL in the row is being edited (-1 = entire row)

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
const loadRowBtn = document.querySelector('#load-row-btn');
const saveRowBtn = document.querySelector('#save-row-btn');

console.log('✅ DOM elements loaded');

// Event Listeners
takeUrlBtn.addEventListener('click', takeUrlAndMarkers);
nextRowBtn.addEventListener('click', nextRow);
exportBtn.addEventListener('click', exportCSV);
undoBtn.addEventListener('click', undoMarker);
clearRowBtn.addEventListener('click', clearCurrentRow);
loadRowBtn.addEventListener('click', loadRowData);
saveRowBtn.addEventListener('click', saveRowChanges);

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

// Load Row to Panel - Load URL and timestamps from a row for editing (single URL)
function loadRowToPanel(rowIndex, urlIndex) {
  const row = rows[rowIndex];
  const url = row[urlIndex];
  const timestampStr = row[urlIndex + 1] || '';

  console.log(`📂 Loading row ${rowIndex + 1}, URL index ${urlIndex}`);
  console.log(`   URL: ${url}`);
  console.log(`   Timestamps: ${timestampStr}`);

  // Load URL to YouTube webview
  youtubeWebview.src = url;
  currentUrl = url;
  currentUrlInput.value = url;

  // Parse and load timestamps to markers
  markers = [];
  if (timestampStr) {
    const timestampParts = timestampStr.split(';');
    timestampParts.forEach((ts) => {
      const seconds = parseTimeToSeconds(ts.trim());
      if (!isNaN(seconds)) {
        markers.push({
          time: seconds,
          formatted: ts.trim(),
        });
      }
    });
  }

  console.log(`   Loaded ${markers.length} markers`);
  updateMarkersDisplay();

  // Store the loaded row index and URL index for saving later
  loadedRowIndex = rowIndex;
  loadedUrlIndex = urlIndex;

  // Show the save button
  saveRowBtn.style.display = 'inline-block';

  // Scroll to the control panel
  document.querySelector('.control-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Edit Existing Row - Load entire row for adding more URLs/timestamps
function editExistingRow(rowIndex) {
  const row = rows[rowIndex];
  console.log(`✏️  Editing row ${rowIndex + 1}`);
  console.log(`   Current data:`, row);

  // Load the row data into currentRow for appending
  currentRow = [...row];
  
  // Clear markers and URL since we're in append mode
  markers = [];
  currentUrl = '';
  currentUrlInput.value = '';
  lastMarkerTime = -1;

  // Store the editing row index
  loadedRowIndex = rowIndex;
  loadedUrlIndex = -1; // -1 indicates we're editing the whole row, not a single URL

  updateCurrentRowDisplay();
  updateMarkersDisplay();

  // Show the save button
  saveRowBtn.style.display = 'inline-block';

  // Scroll to the control panel
  document.querySelector('.control-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  
  showNotification(`📝 Editing row ${rowIndex + 1}. Add new URLs and timestamps, then save.`);
}

// Parse time string (mm.ss or hh.mm.ss) to seconds
function parseTimeToSeconds(timeStr) {
  const parts = timeStr.split('.');
  if (parts.length === 2) {
    // mm.ss format
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  } else if (parts.length === 3) {
    // hh.mm.ss format
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
  }
  return NaN;
}

// Save Row Changes - Save the modified markers back to the loaded row or save entire row
function saveRowChanges() {
  if (loadedRowIndex === -1) {
    alert('No row is loaded for editing');
    return;
  }

  // Case 1: Editing a single URL in an existing row
  if (loadedUrlIndex !== -1) {
    if (markers.length === 0) {
      alert('Please add at least one marker before saving');
      return;
    }

    // Convert markers to semicolon-separated format
    const timestampStr = markers.map((m) => m.formatted).join(';');

    // Update the row with new timestamps
    const row = rows[loadedRowIndex];
    if (loadedUrlIndex >= 0 && loadedUrlIndex < row.length) {
      row[loadedUrlIndex + 1] = timestampStr;
      console.log(`✅ Updated timestamps for URL at index ${loadedUrlIndex}`);
    }
  }
  // Case 2: Editing entire row (appending new URLs)
  else {
    if (currentRow.length === 0) {
      alert('Row is empty. Please add at least one URL and marker');
      return;
    }

    // Replace the row with the updated currentRow
    rows[loadedRowIndex] = [...currentRow];
    console.log(`✅ Row ${loadedRowIndex + 1} updated with all data`);
  }

  // Reset the loaded row indices
  loadedRowIndex = -1;
  loadedUrlIndex = -1;

  // Clear markers and current row
  markers = [];
  currentRow = [];
  lastMarkerTime = -1;
  currentUrl = '';

  updateMarkersDisplay();
  updateCurrentRowDisplay();
  updateRowsTable();

  // Hide the save button
  saveRowBtn.style.display = 'none';

  showNotification('✅ Changes saved successfully!');
}

// Delete URL from a row with confirmation
function deleteUrlFromRow(rowIndex, urlIndex) {
  const row = rows[rowIndex];
  const url = row[urlIndex];
  
  // Ask for confirmation
  const confirmed = confirm(`Delete this URL and its timestamps?\n\n${url}`);
  
  if (!confirmed) {
    console.log(`Deletion cancelled for URL: ${url}`);
    return;
  }

  // Remove the URL and its timestamps
  row.splice(urlIndex, 2);
  
  // If row is now empty, optionally remove the entire row
  if (row.length === 0) {
    const rowConfirmed = confirm('This URL pair was the last in the row. Delete the entire row?');
    if (rowConfirmed) {
      rows.splice(rowIndex, 1);
      console.log(`✅ Row ${rowIndex + 1} deleted`);
    } else {
      // Re-add the deleted pair if user cancels
      row.splice(urlIndex, 0, url, '');
      console.log(`Restoration cancelled`);
      return;
    }
  } else {
    console.log(`✅ URL deleted from row ${rowIndex + 1}`);
  }

  updateRowsTable();
  showNotification('✅ URL deleted successfully!');
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
    
    // Row number cell - make it clickable button
    const numCell = document.createElement('td');
    numCell.className = 'row-num';
    
    const rowBtn = document.createElement('button');
    rowBtn.className = 'row-num-button';
    rowBtn.textContent = `${rowIndex + 1}`;
    rowBtn.title = 'Click to edit this row';
    rowBtn.addEventListener('click', () => editExistingRow(rowIndex));
    
    numCell.appendChild(rowBtn);
    tr.appendChild(numCell);
    
    // Add URL and timestamps alternately
    for (let i = 0; i < row.length; i += 2) {
      // URL cell - Make it a clickable button with delete option on hover
      const urlCell = document.createElement('td');
      urlCell.className = 'row-data url-data-cell';
      const url = row[i];
      
      // URL button
      const urlButton = document.createElement('button');
      urlButton.className = 'url-cell-button';
      urlButton.textContent = url;
      urlButton.title = `Click to load: ${url}`;
      urlButton.addEventListener('click', () => {
        loadRowToPanel(rowIndex, i);
      });
      
      urlCell.appendChild(urlButton);
      
      // Delete button (hidden by default, shown on hover)
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'delete-url-btn';
      deleteBtn.textContent = '✕';
      deleteBtn.title = 'Delete this URL';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteUrlFromRow(rowIndex, i);
      });
      
      urlCell.appendChild(deleteBtn);
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

// Load row data from .rhymx or CSV file
async function loadRowData() {
  try {
    const result = await window.electronAPI.openLoadDialog();
    
    if (!result || !result.filePath) {
      console.log('❌ No file selected');
      return;
    }

    const filePath = result.filePath;
    console.log('📂 Loading file:', filePath);

    const loadResult = await window.electronAPI.loadRowData(filePath);
    
    if (!loadResult.success) {
      console.error('❌ Load failed:', loadResult.error);
      alert(`Failed to load file: ${loadResult.error}`);
      return;
    }

    // Parse loaded data
    const { data, type } = loadResult;
    
    if (type === 'rhymx') {
      // Load from .rhymx autosave format
      console.log('✅ Loaded .rhymx autosave file');
      rows = data.rows || [];
      currentRow = data.currentRow || [];
    } else if (type === 'csv') {
      // Load from CSV format
      console.log('✅ Loaded CSV file');
      rows = data;
      currentRow = [];
    }

    // Update all displays
    updateCurrentRowDisplay();
    updateRowsTable();
    console.log(`✅ Loaded ${rows.length} rows`);
    alert(`Successfully loaded ${rows.length} rows!`);
  } catch (err) {
    console.error('❌ Load error:', err);
    alert(`Error loading file: ${err.message}`);
  }
}

// Auto-save every 5 minutes
setInterval(async () => {
  if (rows.length > 0 || currentRow.length > 0) {
    try {
      await window.electronAPI.saveRowAutosave(rows, currentRow);
      console.log('💾 Auto-saved data');
    } catch (err) {
      console.warn('⚠️ Auto-save failed:', err);
    }
  }
}, 5 * 60 * 1000); // 5 minutes

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

// ============================================================================
// CAPCUT AUTO RENDER CONTROLS
// ============================================================================

console.log('🎬 CapCut Auto Render: Starting initialization...');

// DOM Elements
const renderBrowseBtn = document.querySelector('#render-browse-btn');
const renderProjectsPath = document.querySelector('#render-projects-path');
const renderProjectsList = document.querySelector('#render-projects-list');
const renderStartBtn = document.querySelector('#render-start-btn');
const renderLog = document.querySelector('#render-log');

// Delay inputs
const delayInputs = {
  '1-2': document.querySelector('#delay-1-2'),
  '3': document.querySelector('#delay-3'),
  '4': document.querySelector('#delay-4'),
  '5': document.querySelector('#delay-5'),
  '6': document.querySelector('#delay-6'),
  '7': document.querySelector('#delay-7'),
  '8': document.querySelector('#delay-8'),
  '9-10': document.querySelector('#delay-9-10'),
  '11': document.querySelector('#delay-11'),
};

let renderProjects = [];

console.log('✅ CapCut Auto Render DOM elements loaded');

// Browse button
renderBrowseBtn.addEventListener('click', async () => {
  console.log('📂 Browse button clicked');
  try {
    const result = await window.electronAPI.openFolderDialog();
    if (result && result.folderPath) {
      renderProjectsPath.value = result.folderPath;
      await loadRenderProjects(result.folderPath);
      appendRenderLog(`📂 Folder selected: ${result.folderPath}`);
    }
  } catch (err) {
    console.error('❌ Browse error:', err);
    appendRenderLog(`❌ Error: ${err.message}`);
  }
});

// Load projects with draft_meta_info.json
async function loadRenderProjects(folderPath) {
  try {
    const result = await window.electronAPI.scanRenderProjects(folderPath);
    if (result.success) {
      renderProjects = result.projects;
      updateRenderProjectsList();
      appendRenderLog(`✅ Found ${result.projects.length} projects`);
    } else {
      appendRenderLog(`❌ Error: ${result.error}`);
    }
  } catch (err) {
    console.error('❌ Error scanning projects:', err);
    appendRenderLog(`❌ Error: ${err.message}`);
  }
}

// Update render projects list display
function updateRenderProjectsList() {
  renderProjectsList.innerHTML = '';
  renderProjects.forEach((project) => {
    const item = document.createElement('div');
    item.className = 'project-item';
    item.innerHTML = `
      <input type="checkbox" class="project-checkbox" data-path="${project.draftFoldPath}" />
      <label>${project.name}</label>
    `;
    renderProjectsList.appendChild(item);
  });
}

// Append log message
function appendRenderLog(message) {
  if (!renderLog) return;
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${message}`;
  renderLog.textContent += line + '\n';
  renderLog.scrollTop = renderLog.scrollHeight;
  console.log(`📝 [RENDER LOG]: ${message}`);
}

// Start rendering process
renderStartBtn.addEventListener('click', async () => {
  console.log('🚀 Start render button clicked');
  
  const selectedProjects = Array.from(renderProjectsList.querySelectorAll('.project-checkbox:checked'))
    .map(cb => cb.dataset.path);

  if (selectedProjects.length === 0) {
    appendRenderLog('❌ Please select at least one project');
    return;
  }

  // Collect delay values - keys MUST match Python script expectations
  const delays = {
    "1_2": parseInt(delayInputs['1-2']?.value || 1),
    "3": parseInt(delayInputs['3']?.value || 2),
    "4": parseInt(delayInputs['4']?.value || 1),
    "5": parseInt(delayInputs['5']?.value || 1),
    "6": parseInt(delayInputs['6']?.value || 2),
    "7": parseInt(delayInputs['7']?.value || 1),
    "8": parseInt(delayInputs['8']?.value || 1200),
    "9_10": parseInt(delayInputs['9-10']?.value || 1),
    "11": parseInt(delayInputs['11']?.value || 1),
  };

  console.log('📊 Collected delays:', delays);

  try {
    renderStartBtn.disabled = true;
    appendRenderLog(`🚀 Starting render for ${selectedProjects.length} projects...`);
    
    const result = await window.electronAPI.startCapcutAutoRender(selectedProjects, delays);
    
    if (result.success) {
      appendRenderLog(`✅ Rendering completed successfully!`);
    } else {
      appendRenderLog(`❌ Error: ${result.error}`);
    }
  } catch (err) {
    console.error('❌ Render error:', err);
    appendRenderLog(`❌ Error: ${err.message}`);
  } finally {
    renderStartBtn.disabled = false;
  }
});

// Listen for capcut-render-log events
if (window.electronAPI && window.electronAPI.onCapcutRenderLog) {
  window.electronAPI.onCapcutRenderLog((message) => {
    appendRenderLog(message);
  });
}
