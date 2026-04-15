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
const currentRowDisplay = document.querySelector('#current-row-display');
const rowCountSpan = document.querySelector('#row-count');
const markerCountSpan = document.querySelector('#marker-count');
const rowsGrid = document.querySelector('#rows-grid tbody');

console.log('✅ DOM elements loaded');

// Event Listeners
takeUrlBtn.addEventListener('click', takeUrlAndMarkers);
nextRowBtn.addEventListener('click', nextRow);
exportBtn.addEventListener('click', exportCSV);
undoBtn.addEventListener('click', undoMarker);

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
  setupPolling();
  updateUrlDisplay();
  console.log('✨ Scripts injected successfully');
});

// Inject scripts into webview
function injectScripts() {
  // Inject a keydown listener into the YouTube page
  const keyListenerScript = `
    (function() {
      console.log('[YouTube Page] Setting up N key listener...');
      
      // Use global document listener with capture phase
      document.addEventListener('keydown', function(e) {
        if (e.key === 'n' || e.key === 'N') {
          console.log('[YouTube Page] 🔴 N KEY PRESSED! e.key=' + e.key);
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
        if (e.key === 'n' || e.key === 'N') {
          console.log('[YouTube Page] (window) N key detected');
        }
      }, true);
      
      window.__youtubePageReady = true;
      console.log('[YouTube Page] ✓ N key listener fully initialized');
    })();
  `;

  console.log('💉 Injecting YouTube key listener...');
  youtubeWebview.executeJavaScript(keyListenerScript).catch((err) => {
    console.error('❌ Error injecting key listener:', err);
  });
}

// Setup polling (now handled by setInterval above)
function setupPolling() {
  console.log('✅ Polling initialized (100ms interval)');
}

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
    return `${hours}:${mins < 10 ? '0' : ''}${mins}.${secs < 10 ? '0' : ''}${secs}`;
  }
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// Undo last marker
function undoMarker() {
  if (markers.length > 0) {
    markers.pop();
    updateMarkersDisplay();
  }
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
    return;
  }

  const items = currentRow.map((item, idx) => {
    const label = idx % 2 === 0 ? 'URL' : 'Timestamps';
    const isUrl = label === 'URL';
    const displayText = isUrl ? (item.length > 40 ? item.substring(0, 40) + '...' : item) : item;
    return `<div class="row-item"><strong>${label}:</strong> ${displayText}</div>`;
  });

  currentRowDisplay.innerHTML = items.join('');
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

console.log('🎬 YouTube Video Collector - Renderer initialized and ready!');
console.log('📌 Press N to add markers');
console.log('🐛 Check console for debug messages');
