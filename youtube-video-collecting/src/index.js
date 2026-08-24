const { app, BrowserWindow, ipcMain, dialog, session, webContents } = require('electron');
const path = require('node:path');
const fs = require('fs');
const { spawn, execFile, execSync } = require('child_process');
const os = require('os');
const { ElectronBlocker } = require('@cliqz/adblocker-electron');
const fetch = require('node-fetch');
const {
  buildDownloadErrorSummary,
  consumeDownloaderStdout,
  createDownloadParseState,
  mergeErrorsForCsv,
} = require('./downloader-summary');
const {
  processProjectShuffle,
  processProjectEffectAndTitle,
} = require('./capcut/draft-engine');

// Suppress MaxListenersExceededWarning
require('events').EventEmitter.defaultMaxListeners = 15;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Store download process and error tracking
let downloadProcess = null;
let downloadStopFlagPath = null;  // Path to stop flag file for graceful shutdown
let rateLimitErrors = [];  // Track rate limit errors: {url, timestamps}
let ageRestrictionErrors = [];  // Track age restriction errors: {url, timestamps}
let failedDownloadErrors = [];  // Track every failed clip, including YouTube 403s
let latestDownloadSummary = null;
let currentInputCsvPath = '';  // Store input CSV path for error extraction

// ============================================================================
// UBLOCK ORIGIN ADBLOCKER SETUP
// ============================================================================

let blocker = null;

async function initializeAdblocker() {
  try {
    console.log('🔒 Initializing uBlock Origin adblocker...');
    
    // Create blocker instance with uBlock0 filters (ads + tracking)
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
    
    console.log('✅ uBlock Origin loaded successfully');
    return true;
  } catch (error) {
    console.warn('⚠️ Adblocker initialization warning (app will continue without ad-blocking):', error.message);
    // Don't fail completely - app can work without adblocker
    return false;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get the correct path to a compiled executable based on whether app is packaged
 */
function getExecutablePath(exeName) {
  if (app.isPackaged) {
    // In packaged app: executables are in extraResources/dist folder
    return path.join(process.resourcesPath, 'dist', `${exeName}.exe`);
  } else {
    // In development: executables are in the local dist folder
    return path.join(__dirname, '..', 'dist', `${exeName}.exe`);
  }
}

/**
 * Find Python executable in system PATH or common installation locations
 * (Legacy function kept for backward compatibility)
 */
function findPythonExecutable() {
  try {
    // Try 'python' first
    const pythonPath = process.platform === 'win32' ? 'python' : 'python3';
    execSync(`${pythonPath} --version`, { stdio: 'pipe' });
    return pythonPath;
  } catch (e) {
    // Try 'python3'
    try {
      execSync('python3 --version', { stdio: 'pipe' });
      return 'python3';
    } catch (e2) {
      // Try 'python'
      try {
        execSync('python --version', { stdio: 'pipe' });
        return 'python';
      } catch (e3) {
        console.error('Python not found in PATH');
        return null;
      }
    }
  }
}

/**
 * Find AutoHotkey executable in system PATH or common installation locations
 * Compatible with AutoHotkey v1 and v2
 */
function findAutoHotkey() {
  // First check common installation paths (most reliable)
  const commonPaths = [
    'C:\\Program Files\\AutoHotkey\\AutoHotkey.exe',
    'C:\\Program Files (x86)\\AutoHotkey\\AutoHotkey.exe',
    'C:\\Program Files\\AutoHotkey v2\\AutoHotkey.exe',
    'C:\\Program Files (x86)\\AutoHotkey v2\\AutoHotkey.exe',
  ];
  
  for (const ahkPath of commonPaths) {
    if (fs.existsSync(ahkPath)) {
      console.log(`✅ Found AutoHotkey at: ${ahkPath}`);
      return ahkPath;
    }
  }
  
  // If not found in common paths, assume it's in PATH and return the command
  try {
    execSync('where AutoHotkey.exe', { stdio: 'pipe' });
    console.log('✅ Found AutoHotkey.exe in PATH');
    return 'AutoHotkey.exe';
  } catch (e) {
    console.error('❌ AutoHotkey not found in PATH or common installation directories');
    return null;
  }
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1600,
    height: 1200,
    icon: path.join(__dirname, '../assets/chitoge.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webviewTag: true,
      devTools: false,
    },
  });

  // and load the index.html of the app.
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // ========================================================================
  // YOUTUBE SHORTS BLOCKING (via Webview Injection)
  // ========================================================================
  
  // Inject blocker into the YouTube webview when it's ready
  mainWindow.webContents.on('did-finish-load', () => {
    try {
      const blockerCode = fs.readFileSync(path.join(__dirname, 'youtube-shorts-blocker.js'), 'utf8');
      
      // Inject into the webview
      mainWindow.webContents.executeJavaScript(`
        (function() {
          const youtubeWebview = document.querySelector('#youtube-webview');
          if (youtubeWebview) {
            // Try to inject immediately
            youtubeWebview.executeJavaScript(${JSON.stringify(blockerCode)}).catch(() => {});
            
            // Also listen for dom-ready in case it loads later
            youtubeWebview.addEventListener('dom-ready', () => {
              youtubeWebview.executeJavaScript(${JSON.stringify(blockerCode)}).catch(() => {});
            });
          }
        })();
      `).catch(() => {});
    } catch (error) {
      console.warn('⚠️ Failed to load YouTube shorts blocker:', error.message);
    }
  });

  // Open the DevTools.
  //mainWindow.webContents.openDevTools();

  // Enable adblocker for this window
  // DISABLED: uBlock causes issues with YouTube embeds (153 error)
  // The adblocker was having issues anyway (fetch is not a function error)
  // if (blocker) {
  //   console.log('🔒 Enabling uBlock Origin for main window...');
  //   blocker.enableBlockingInSession(mainWindow.webContents.session);
  // }

  return mainWindow;
};

let mainWindow;

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Initialize adblocker before creating window
  await initializeAdblocker();

  console.log('🚀 Creating main application window...');
  mainWindow = createWindow();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ============================================================================
// IPC HANDLERS
// ============================================================================

// YouTube Collector - Export CSV
ipcMain.handle('export-csv', async (event, rows) => {
  if (!rows || rows.length === 0) {
    return { success: false, error: 'No data to export' };
  }

  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export CSV',
    defaultPath: 'markers.csv',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
  });

  if (!filePath) {
    return { success: false, error: 'Export cancelled' };
  }

  try {
    // Convert rows array to CSV format
    const csvContent = rows.map((row) => row.join(',')).join('\n');
    fs.writeFileSync(filePath, csvContent, 'utf8');
    return { success: true, filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// File Dialog - Open File
ipcMain.handle('open-file-dialog', async (event, options) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      ...options,
    });
    return { filePath: result.filePaths[0] || null };
  } catch (error) {
    throw new Error(`File dialog error: ${error.message}`);
  }
});

// File Dialog - Open Folder
ipcMain.handle('open-folder-dialog', async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return { folderPath: result.filePaths[0] || null };
  } catch (error) {
    throw new Error(`Folder dialog error: ${error.message}`);
  }
});

// YouTube Collector - Load Dialog (.rhymx or CSV)
ipcMain.handle('open-load-dialog', async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Supported Files', extensions: ['rhymx', 'csv'] },
        { name: 'Autosave Files', extensions: ['rhymx'] },
        { name: 'CSV Files', extensions: ['csv'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return { filePath: result.filePaths[0] || null };
  } catch (error) {
    throw new Error(`Load dialog error: ${error.message}`);
  }
});

// YouTube Collector - Load Row Data from File
ipcMain.handle('load-row-data', async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' };
    }

    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.rhymx') {
      // Load .rhymx autosave format (JSON)
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      return { success: true, type: 'rhymx', data };
    } else if (ext === '.csv') {
      // Parse CSV file - load rows with youtube URLs
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.trim().split('\n');
      const rows = [];

      for (const line of lines) {
        const cells = line.split(',');
        // Check if row contains at least 1 URL with "yout" (youtube.com or youtu.be)
        const hasYoutubeUrl = cells.some((cell) =>
          cell.toLowerCase().includes('yout')
        );

        if (hasYoutubeUrl) {
          rows.push(cells);
        }
      }

      if (rows.length === 0) {
        return {
          success: false,
          error: 'No rows with YouTube URLs found in CSV',
        };
      }

      return { success: true, type: 'csv', data: rows };
    } else {
      return {
        success: false,
        error: 'Unsupported file format. Use .rhymx or .csv',
      };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// YouTube Collector - Auto-save to .rhymx
ipcMain.handle('save-row-autosave', async (event, rows, currentRow) => {
  try {
    const tempDir = os.tmpdir();
    const autosaveDir = path.join(tempDir, 'youtube-collector-autosaves');
    
    // Create autosave directory if it doesn't exist
    if (!fs.existsSync(autosaveDir)) {
      fs.mkdirSync(autosaveDir, { recursive: true });
    }

    // Generate filename with date and time
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    
    const filename = `youtube-collector-autosave-${year}-${month}-${day}-${hours}-${minutes}-${seconds}.rhymx`;
    const autosavePath = path.join(autosaveDir, filename);

    const data = {
      timestamp: new Date().toISOString(),
      version: '1.0',
      rows,
      currentRow,
    };

    fs.writeFileSync(autosavePath, JSON.stringify(data, null, 2), 'utf8');
    console.log('💾 Auto-saved to:', autosavePath);
    return { success: true, filePath: autosavePath };
  } catch (error) {
    console.warn('⚠️ Auto-save failed:', error.message);
    return { success: false, error: error.message };
  }
});

// YouTube Collector - Get Autosave Path (returns most recent)
ipcMain.handle('get-autosave-path', async (event) => {
  try {
    const tempDir = os.tmpdir();
    const autosaveDir = path.join(tempDir, 'youtube-collector-autosaves');
    
    if (!fs.existsSync(autosaveDir)) {
      return { success: true, path: autosaveDir, exists: false, mostRecent: null };
    }

    // Get all .rhymx files in the autosave directory
    const files = fs.readdirSync(autosaveDir).filter(f => f.endsWith('.rhymx'));
    
    if (files.length === 0) {
      return { success: true, path: autosaveDir, exists: false, mostRecent: null };
    }

    // Sort by filename (timestamp format ensures correct sort order)
    files.sort((a, b) => b.localeCompare(a));
    const mostRecentFile = files[0];
    const mostRecentPath = path.join(autosaveDir, mostRecentFile);

    return { 
      success: true, 
      path: autosaveDir, 
      exists: true, 
      mostRecent: mostRecentPath,
      totalFiles: files.length,
      files: files
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 5-Sec Downloader - Start Download
ipcMain.handle('start-download', async (event, csvPath, outputPath, clipSleepMin, clipSleepMax, rowSleepMin, rowSleepMax) => {
  try {
    if (downloadProcess && downloadProcess.exitCode === null) {
      return { success: false, error: 'A download is already running or stopping. Please wait for it to finish.' };
    }

    // Reset error tracking
    rateLimitErrors = [];
    ageRestrictionErrors = [];
    failedDownloadErrors = [];
    latestDownloadSummary = null;
    currentInputCsvPath = csvPath;

    // Verify files exist
    if (!fs.existsSync(csvPath)) {
      throw new Error('CSV file not found');
    }
    if (!fs.existsSync(outputPath)) {
      throw new Error('Output folder not found');
    }

    // Get the path to the compiled executable
    const exePath = getExecutablePath('5_sec_downloader');
    
    if (!fs.existsSync(exePath)) {
      throw new Error(`Executable not found: ${exePath}. Please run "npm run build-exe" first.`);
    }

    console.log(`🚀 Starting 5-Sec Downloader Executable`);
    console.log(`📄 Executable: ${exePath}`);
    console.log(`📋 CSV: ${csvPath}`);
    console.log(`📁 Output: ${outputPath}`);
    console.log(`⏱️  Clip Sleep: ${clipSleepMin}-${clipSleepMax}s`);
    console.log(`⏱️  Row Sleep: ${rowSleepMin}-${rowSleepMax}s`);

    // Create a unique stop flag file path for graceful shutdown
    const stopFlagPath = path.join(os.tmpdir(), `downloader-stop-flag-${Date.now()}.txt`);
    downloadStopFlagPath = stopFlagPath;
    console.log(`⚠️  Stop flag path: ${stopFlagPath}`);

    // Spawn executable process WITHOUT shell to properly handle spaces in paths
    const childProcess = spawn(exePath, [csvPath, outputPath, clipSleepMin, clipSleepMax, rowSleepMin, rowSleepMax, stopFlagPath], {
      stdio: 'pipe',
      shell: false,
      // The packaged Python process writes to pipes, which are otherwise block-buffered.
      // Force current and future executable builds to stream each log line immediately.
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
      },
    });
    downloadProcess = childProcess;

    const parseState = createDownloadParseState();

    // Handle errors
    childProcess.on('error', (error) => {
      console.error(`❌ Failed to start download process: ${error.message}`);
      mainWindow.webContents.send('download-log', `❌ ERROR: Failed to start process: ${error.message}\n`);
      if (downloadProcess === childProcess) downloadProcess = null;
    });

    // Send output to renderer and parse the downloader's chunk-safe structured report.
    childProcess.stdout.on('data', (data) => {
      const message = data.toString();
      console.log(`[Download stdout]: ${message}`);
      consumeDownloaderStdout(parseState, message);
      mainWindow.webContents.send('download-log', message);
    });

    childProcess.stderr.on('data', (data) => {
      const message = data.toString();
      console.error(`[Download stderr]: ${message}`);
      mainWindow.webContents.send('download-log', `ERROR: ${message}`);
    });

    childProcess.on('close', (code) => {
      consumeDownloaderStdout(parseState, '', true);
      failedDownloadErrors = parseState.errors;
      rateLimitErrors = failedDownloadErrors.filter((item) => item.category === 'RATE_LIMIT');
      ageRestrictionErrors = failedDownloadErrors.filter((item) => item.category === 'AGE_RESTRICTION');
      latestDownloadSummary = buildDownloadErrorSummary(parseState);

      console.log(`✅ Download process exited with code: ${code}`);
      console.log('📊 Download summary:', latestDownloadSummary);
      mainWindow.webContents.send('download-error-summary', latestDownloadSummary);
      mainWindow.webContents.send('download-complete', {
        success: code === 0,
        partial: code === 2,
        canceled: code === 3 || latestDownloadSummary.canceled,
        code,
        summary: latestDownloadSummary,
      });
      if (downloadProcess === childProcess) downloadProcess = null;
      
      // Clean up stop flag file
      if (fs.existsSync(stopFlagPath)) {
        try {
          fs.unlinkSync(stopFlagPath);
          console.log('🗑️  Stop flag file cleaned up');
        } catch (err) {
          console.warn('⚠️  Failed to delete stop flag file:', err.message);
        }
      }
      if (downloadStopFlagPath === stopFlagPath) downloadStopFlagPath = null;
    });

    return { success: true };
  } catch (error) {
    console.error(`❌ Download error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// 5-Sec Downloader - Stop Download
ipcMain.handle('stop-download', async (event) => {
  const processToStop = downloadProcess;
  const stopFlagPath = downloadStopFlagPath;
  if (processToStop && processToStop.exitCode === null && stopFlagPath) {
    // Create the stop flag file to signal graceful shutdown
    try {
      if (fs.existsSync(stopFlagPath)) {
        return { success: true, alreadyStopping: true };
      }
      fs.writeFileSync(stopFlagPath, 'STOP', 'utf8');
      console.log('⏹️  Stop flag created, waiting for process to exit gracefully...');
      // Give the process 5 seconds to exit gracefully
      setTimeout(() => {
        if (processToStop.exitCode === null && !processToStop.killed) {
          console.log('⚠️  Process did not exit gracefully, killing it...');
          processToStop.kill();
        }
      }, 5000);
      return { success: true };
    } catch (err) {
      console.error('Error creating stop flag:', err.message);
      // Fallback to killing the process
      if (processToStop.exitCode === null && !processToStop.killed) processToStop.kill();
      return { success: true };
    }
  }
  return { success: false, error: 'No download in progress' };
});

function formatDownloadErrorsCsv(errors) {
  return mergeErrorsForCsv(errors).map((errorItem) => {
    const timestamps = errorItem.timestamps.map((timestamp) => {
      const hours = Math.floor(timestamp / 3600);
      const minutes = Math.floor((timestamp % 3600) / 60);
      const seconds = Math.floor(timestamp % 60);
      if (hours > 0) {
        return `${hours}.${String(minutes).padStart(2, '0')}.${String(seconds).padStart(2, '0')}`;
      }
      return `${minutes}.${String(seconds).padStart(2, '0')}`;
    }).join(';');
    const escapedUrl = `"${errorItem.url.replaceAll('"', '""')}"`;
    return `${escapedUrl},${timestamps}`;
  }).join('\n') + '\n';
}

// 5-Sec Downloader - Extract all failed clips to CSV. The legacy IPC name is
// retained so installed renderer bundles remain compatible during upgrades.
ipcMain.handle('extract-rate-limit-errors', async (event) => {
  try {
    if (failedDownloadErrors.length === 0) {
      return { success: false, error: 'No failed clips to extract' };
    }

    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Failed Clips CSV',
      defaultPath: 'failed_downloads.csv',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });

    if (!filePath) {
      return { success: false, error: 'Save dialog cancelled' };
    }

    const csvContent = formatDownloadErrorsCsv(failedDownloadErrors);
    fs.writeFileSync(filePath, csvContent, 'utf-8');
    console.log(`💾 Failed clips saved to: ${filePath}`);
    return { success: true, filePath };
  } catch (error) {
    console.error(`❌ Error extracting failed clips: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// 5-Sec Downloader - Extract Age Restriction Errors to CSV
ipcMain.handle('extract-age-restriction-errors', async (event) => {
  try {
    if (ageRestrictionErrors.length === 0) {
      return { success: false, error: 'No age restriction errors to extract' };
    }

    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Age Restriction Errors CSV',
      defaultPath: 'age_restriction_errors.csv',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });

    if (!filePath) {
      return { success: false, error: 'Save dialog cancelled' };
    }

    // Create CSV content in the same format as input
    let csvContent = '';
    for (const errorItem of ageRestrictionErrors) {
      const url = errorItem.url;
      const timestamps = errorItem.timestamps
        .map(ts => {
          // Convert seconds to mm.ss or hh.mm.ss format
          const hours = Math.floor(ts / 3600);
          const minutes = Math.floor((ts % 3600) / 60);
          const seconds = Math.floor(ts % 60);
          
          if (hours > 0) {
            return `${hours}.${String(minutes).padStart(2, '0')}.${String(seconds).padStart(2, '0')}`;
          } else {
            return `${minutes}.${String(seconds).padStart(2, '0')}`;
          }
        })
        .join(';');
      
      csvContent += `${url},${timestamps}\n`;
    }

    fs.writeFileSync(filePath, csvContent, 'utf-8');
    console.log(`💾 Age restriction errors saved to: ${filePath}`);
    return { success: true, filePath };
  } catch (error) {
    console.error(`❌ Error extracting age restriction errors: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Open Folder
ipcMain.handle('open-folder', async (event, folderPath) => {
  try {
    const { exec } = require('child_process');
    if (process.platform === 'win32') {
      exec(`explorer "${folderPath}"`);
    } else if (process.platform === 'darwin') {
      exec(`open "${folderPath}"`);
    } else {
      exec(`xdg-open "${folderPath}"`);
    }
    return { success: true };
  } catch (error) {
    throw new Error(`Error opening folder: ${error.message}`);
  }
});

// CapCut - Scan Projects
ipcMain.handle('scan-capcut-projects', async (event, folderPath) => {
  try {
    if (!fs.existsSync(folderPath)) {
      throw new Error('Folder not found');
    }

    const projects = [];
    const items = fs.readdirSync(folderPath);

    for (const item of items) {
      const itemPath = path.join(folderPath, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        const draftJsonPath = path.join(itemPath, 'draft_content.json');
        if (fs.existsSync(draftJsonPath)) {
          projects.push({ name: item, path: itemPath });
        }
      }
    }

    return { projects: projects.sort((a, b) => a.name.localeCompare(b.name)) };
  } catch (error) {
    throw new Error(`Error scanning projects: ${error.message}`);
  }
});

// CapCut - Process Projects
ipcMain.handle('process-capcut-projects', async (event, projectPaths, cacheBust) => {
  try {
    console.log(`🎬 Starting CapCut Shuffle Engine`);
    console.log(`🎯 Projects to process: ${projectPaths.length}`);
    console.log(`🔄 Cache bust: ${cacheBust}`);

    let processedCount = 0;
    const failed = [];

    const logToRenderer = (msg) => {
      console.log(`[CapCut]: ${msg}`);
      mainWindow.webContents.send('capcut-log', `${msg}\n`);
    };

    for (let i = 0; i < projectPaths.length; i++) {
      const projectPath = projectPaths[i];
      
      if (!fs.existsSync(projectPath)) {
        console.warn(`⚠️ Project path not found: ${projectPath}`);
        failed.push(`${path.basename(projectPath)}: Path not found`);
        continue;
      }

      logToRenderer(`\n[${i + 1}/${projectPaths.length}] Processing: ${path.basename(projectPath)}`);

      try {
        const result = processProjectShuffle(projectPath, Boolean(cacheBust), logToRenderer);
        processedCount += result.processedCount;
        logToRenderer(`✅ Successfully processed project ${i + 1}`);
      } catch (err) {
        console.error(`❌ Error processing project: ${err.message}`);
        logToRenderer(`❌ Error: ${err.message}`);
        failed.push(`${path.basename(projectPath)}: ${err.message}`);
      }
    }

    return { success: true, processedCount, failed };
  } catch (error) {
    console.error(`❌ CapCut processing error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Open URL
ipcMain.handle('open-url', async (event, url) => {
  try {
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new Error('Invalid or unsupported URL scheme');
    }
    await require('electron').shell.openExternal(url);
    return { success: true };
  } catch (error) {
    throw new Error(`Error opening URL: ${error.message}`);
  }
});

// Auto Add Effect & Title - Process Projects
ipcMain.handle('process-effect-title', async (event, projectPaths, addEffect, addTitle, titleText, logMarkersTime, skipIntro) => {
  try {
    console.log(`🎨 Starting Auto Add Effect & Title Engine`);
    console.log(`🎯 Projects to process: ${projectPaths.length}`);
    console.log(`✨ Add Effect: ${addEffect}, Add Title: ${addTitle}, Log Markers Time: ${logMarkersTime}, Skip Intro: ${skipIntro}`);

    let processedCount = 0;
    const failed = [];

    const logToRenderer = (msg) => {
      console.log(`[Effect & Title]: ${msg}`);
      mainWindow.webContents.send('capcut-log', `${msg}\n`);
    };

    for (let i = 0; i < projectPaths.length; i++) {
      const projectPath = projectPaths[i];
      
      if (!fs.existsSync(projectPath)) {
        console.warn(`⚠️ Project path not found: ${projectPath}`);
        failed.push(`${path.basename(projectPath)}: Path not found`);
        continue;
      }

      logToRenderer(`\n[${i + 1}/${projectPaths.length}] Processing: ${path.basename(projectPath)}`);

      try {
        const result = processProjectEffectAndTitle(projectPath, {
          addEffect: Boolean(addEffect),
          addTitle: Boolean(addTitle),
          titleText: titleText || '',
          logMarkersTime: Boolean(logMarkersTime),
          skipIntro: Boolean(skipIntro),
        }, logToRenderer);

        processedCount += result.processedCount;
        logToRenderer(`✅ Successfully processed project ${i + 1}`);
      } catch (err) {
        console.error(`❌ Error processing project: ${err.message}`);
        logToRenderer(`❌ Error: ${err.message}`);
        failed.push(`${path.basename(projectPath)}: ${err.message}`);
      }
    }

    return { success: true, processedCount, failed };
  } catch (error) {
    console.error(`❌ Auto Add Effect & Title error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.on('webview-message', (event, { channel, args }) => {
  // Forward messages from webview to renderer
  mainWindow.webContents.send(channel, ...args);
});

ipcMain.handle('get-webview-cookies', async (event, webContentsId, url) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) {
      throw new Error('WebContents not found for id: ' + webContentsId);
    }
    const wcSession = wc.session || session.defaultSession;
    const cookies = await wcSession.cookies.get({ url });
    if (!cookies || cookies.length === 0) {
      return '';
    }
    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  } catch (error) {
    console.error('❌ Failed to get webview cookies:', error.message);
    return '';
  }
});

// YouTube Trimmer - Trim Video
ipcMain.handle('trim-youtube-video', async (event, url, startSeconds, endSeconds, outputPath, cookieHeader) => {
  try {
    // Verify output folder exists
    if (!fs.existsSync(outputPath)) {
      throw new Error('Output folder not found');
    }

    // Get the path to the compiled executable
    const exePath = getExecutablePath('youtube_trimmer');
    
    if (!fs.existsSync(exePath)) {
      throw new Error(`Executable not found: ${exePath}. Please run "npm run build-exe" first.`);
    }

    console.log(`✂️ Starting YouTube Trimmer Executable`);
    console.log(`📄 Executable: ${exePath}`);
    console.log(`🎬 URL: ${url}`);
    console.log(`⏱️ Trim: ${startSeconds}s to ${endSeconds}s`);
    console.log(`📁 Output: ${outputPath}`);
    if (cookieHeader) {
      console.log('🔐 Using cookie header for authenticated download');
    }

    // Spawn executable process
    const args = [
      url,
      startSeconds.toString(),
      endSeconds.toString(),
      outputPath,
    ];
    if (cookieHeader) {
      args.push('--cookie-header', cookieHeader);
    }
    const trimProcess = spawn(exePath, args, {
      stdio: 'pipe',
      shell: false,
    });

    let trimmedFilePath = '';

    return new Promise((resolve, reject) => {
      trimProcess.stdout.on('data', (data) => {
        const message = data.toString();
        console.log(`[Trimmer stdout]: ${message}`);
        mainWindow.webContents.send('trim-log', message);
        
        // Extract output filename from stdout
        if (message.includes('OUTPUT_FILE:')) {
          trimmedFilePath = message.split('OUTPUT_FILE:')[1].trim();
        }
      });

      trimProcess.stderr.on('data', (data) => {
        const message = data.toString();
        console.error(`[Trimmer stderr]: ${message}`);
        mainWindow.webContents.send('trim-log', `ERROR: ${message}`);
      });

      trimProcess.on('close', (code) => {
        console.log(`✅ Trimmer process exited with code: ${code}`);
        if (code === 0) {
          resolve({
            success: true,
            filePath: trimmedFilePath || path.join(outputPath, 'trimmed_video.mp4')
          });
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      });

      trimProcess.on('error', (error) => {
        console.error(`❌ Failed to start trimmer: ${error.message}`);
        reject(new Error(`Process failed to start: ${error.message}`));
      });
    });
  } catch (error) {
    console.error(`❌ Trimmer error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// CapCut Auto Render - Scan Projects with draft_meta_info.json
ipcMain.handle('scan-render-projects', async (event, folderPath) => {
  try {
    if (!fs.existsSync(folderPath)) {
      return { success: false, error: 'Folder not found' };
    }

    const projects = [];
    const items = fs.readdirSync(folderPath);

    for (const item of items) {
      const itemPath = path.join(folderPath, item);
      const stats = fs.statSync(itemPath);

      if (stats.isDirectory()) {
        // Check for draft_meta_info.json
        const metaPath = path.join(itemPath, 'draft_meta_info.json');
        if (fs.existsSync(metaPath)) {
          try {
            const metaData = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            const draftFoldPath = metaData.draft_fold_path || itemPath;
            // Extract project name from the end of the path
            const projectName = path.basename(draftFoldPath);

            projects.push({
              name: projectName,
              path: itemPath,
              draftFoldPath: draftFoldPath,
              metaPath: metaPath,
            });
          } catch (err) {
            console.warn(`⚠️ Error parsing metadata for ${item}:`, err.message);
          }
        }
      }
    }

    console.log(`✅ Found ${projects.length} CapCut projects`);
    return { success: true, projects };
  } catch (error) {
    console.error('❌ Error scanning render projects:', error);
    return { success: false, error: error.message };
  }
});

// CapCut Auto Render - Start Rendering
let capcutRenderProcess = null;

ipcMain.handle('start-capcut-auto-render', async (event, selectedProjects, delays) => {
  try {
    if (!selectedProjects || selectedProjects.length === 0) {
      return { success: false, error: 'No projects selected' };
    }

    if (capcutRenderProcess) {
      return { success: false, error: 'Render process already running' };
    }

    // Get the path to the compiled executable
    const exePath = getExecutablePath('capcut_auto_render');
    
    if (!fs.existsSync(exePath)) {
      const errorMsg = `Executable not found: ${exePath}. Please run "npm run build-exe" first.`;
      mainWindow.webContents.send('capcut-render-log', `❌ ${errorMsg}`);
      return { success: false, error: errorMsg };
    }

    // Build project list and delays as arguments
    const projectList = selectedProjects.join('|');
    const delaysStr = JSON.stringify(delays);

    // Log start message
    mainWindow.webContents.send('capcut-render-log', `🚀 Starting CapCut Auto Render for ${selectedProjects.length} projects`);
    mainWindow.webContents.send('capcut-render-log', `📍 Using Executable: ${exePath}`);
    mainWindow.webContents.send('capcut-render-log', `⏱️ Delays: Step 1-2=${delays.step1_2}s, Step 3=${delays.step3}s, Step 4=${delays.step4}s, Step 5=${delays.step5}s, Step 6=${delays.step6}s, Step 7=${delays.step7}s, Step 8=${delays.step8}s, Step 9-10=${delays.step9_10}s`);

    // Spawn executable process
    capcutRenderProcess = spawn(exePath, [projectList, delaysStr], {
      stdio: 'pipe',
      shell: false,
    });

    capcutRenderProcess.stdout.on('data', (data) => {
      const message = data.toString('utf8').trim();
      if (message) {
        console.log(`[Python]: ${message}`);
        mainWindow.webContents.send('capcut-render-log', `${message}`);
      }
    });

    capcutRenderProcess.stderr.on('data', (data) => {
      const message = data.toString('utf8').trim();
      if (message) {
        console.error(`[Python Error]: ${message}`);
        mainWindow.webContents.send('capcut-render-log', `❌ ${message}`);
      }
    });

    capcutRenderProcess.on('close', (code) => {
      console.log(`[Python] Process exited with code ${code}`);
      mainWindow.webContents.send('capcut-render-log', `✅ Render process completed (exit code: ${code})`);
      capcutRenderProcess = null;
    });

    return { success: true, message: 'Render process started' };
  } catch (error) {
    console.error('❌ Error starting render process:', error);
    mainWindow.webContents.send('capcut-render-log', `❌ Error: ${error.message}`);
    capcutRenderProcess = null;
    return { success: false, error: error.message };
  }
});

