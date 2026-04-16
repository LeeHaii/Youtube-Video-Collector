const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const os = require('os');

// Suppress MaxListenersExceededWarning
require('events').EventEmitter.defaultMaxListeners = 15;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Store download process
let downloadProcess = null;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Find Python executable in system PATH or common installation locations
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

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1600,
    height: 1200,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webviewTag: true,
    },
  });

  // and load the index.html of the app.
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open the DevTools.
  mainWindow.webContents.openDevTools();

  return mainWindow;
};

let mainWindow;

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
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

// 5-Sec Downloader - Start Download
ipcMain.handle('start-download', async (event, csvPath, outputPath) => {
  try {
    // Verify files exist
    if (!fs.existsSync(csvPath)) {
      throw new Error('CSV file not found');
    }
    if (!fs.existsSync(outputPath)) {
      throw new Error('Output folder not found');
    }

    // Find Python executable
    const pythonExe = findPythonExecutable();
    if (!pythonExe) {
      throw new Error('Python not found. Please install Python and add to PATH.');
    }

    // Get the path to the Python script
    const pythonScriptPath = path.join(__dirname, '..', 'tools', '5_sec_downloader.py');
    
    if (!fs.existsSync(pythonScriptPath)) {
      throw new Error(`Python script not found: ${pythonScriptPath}`);
    }

    console.log(`🐍 Starting 5-Sec Downloader with Python: ${pythonExe}`);
    console.log(`📄 Script: ${pythonScriptPath}`);
    console.log(`📋 CSV: ${csvPath}`);
    console.log(`📁 Output: ${outputPath}`);

    // Spawn Python process WITHOUT shell to properly handle spaces in paths
    downloadProcess = spawn(pythonExe, [pythonScriptPath, csvPath, outputPath], {
      stdio: 'pipe',
      shell: false,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    // Handle errors
    downloadProcess.on('error', (error) => {
      console.error(`❌ Failed to start download process: ${error.message}`);
      mainWindow.webContents.send('download-log', `❌ ERROR: Failed to start process: ${error.message}\n`);
      downloadProcess = null;
    });

    // Send output to renderer
    downloadProcess.stdout.on('data', (data) => {
      const message = data.toString();
      console.log(`[Download stdout]: ${message}`);
      mainWindow.webContents.send('download-log', message);
    });

    downloadProcess.stderr.on('data', (data) => {
      const message = data.toString();
      console.error(`[Download stderr]: ${message}`);
      mainWindow.webContents.send('download-log', `ERROR: ${message}`);
    });

    downloadProcess.on('close', (code) => {
      console.log(`✅ Download process exited with code: ${code}`);
      mainWindow.webContents.send('download-complete', code === 0);
      downloadProcess = null;
    });

    return { success: true };
  } catch (error) {
    console.error(`❌ Download error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// 5-Sec Downloader - Stop Download
ipcMain.handle('stop-download', async (event) => {
  if (downloadProcess) {
    downloadProcess.kill();
    downloadProcess = null;
    return { success: true };
  }
  return { success: false, error: 'No download in progress' };
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
    // Find Python executable
    const pythonExe = findPythonExecutable();
    if (!pythonExe) {
      throw new Error('Python not found. Please install Python and add to PATH.');
    }

    // Get the path to the Python script
    const pythonScriptPath = path.join(__dirname, '..', 'tools', 'suffle_capcu_track.py');
    
    if (!fs.existsSync(pythonScriptPath)) {
      throw new Error(`Python script not found: ${pythonScriptPath}`);
    }

    console.log(`🎬 Starting CapCut Shuffle with Python: ${pythonExe}`);
    console.log(`📄 Script: ${pythonScriptPath}`);
    console.log(`🎯 Projects to process: ${projectPaths.length}`);
    console.log(`🔄 Cache bust: ${cacheBust}`);

    let processedCount = 0;
    const failed = [];

    for (let i = 0; i < projectPaths.length; i++) {
      const projectPath = projectPaths[i];
      
      if (!fs.existsSync(projectPath)) {
        console.warn(`⚠️ Project path not found: ${projectPath}`);
        failed.push(`${path.basename(projectPath)}: Path not found`);
        continue;
      }

      console.log(`\n[${i + 1}/${projectPaths.length}] Processing: ${projectPath}`);

      try {
        await new Promise((resolve, reject) => {
          const python = spawn(pythonExe, [pythonScriptPath, projectPath, cacheBust ? '1' : '0'], {
            stdio: 'pipe',
            shell: false,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          });

          let output = '';

          // Handle errors
          python.on('error', (error) => {
            console.error(`❌ Failed to start CapCut process: ${error.message}`);
            mainWindow.webContents.send('capcut-log', `❌ ERROR: Failed to start process: ${error.message}\n`);
            reject(new Error(`Process failed to start: ${error.message}`));
          });

          python.stdout.on('data', (data) => {
            const message = data.toString();
            output += message;
            console.log(`[CapCut stdout]: ${message}`);
            mainWindow.webContents.send('capcut-log', message);
          });

          python.stderr.on('data', (data) => {
            const message = data.toString();
            output += message;
            console.error(`[CapCut stderr]: ${message}`);
            mainWindow.webContents.send('capcut-log', `ERROR: ${message}`);
          });

          python.on('close', (code) => {
            console.log(`✅ CapCut process exited with code: ${code}`);
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Process exited with code ${code}`));
            }
          });
        });

        processedCount++;
        console.log(`✅ Successfully processed project ${i + 1}`);
      } catch (err) {
        console.error(`❌ Error processing project: ${err.message}`);
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
    require('electron').shell.openExternal(url);
    return { success: true };
  } catch (error) {
    throw new Error(`Error opening URL: ${error.message}`);
  }
});

ipcMain.on('webview-message', (event, { channel, args }) => {
  // Forward messages from webview to renderer
  mainWindow.webContents.send(channel, ...args);
});

