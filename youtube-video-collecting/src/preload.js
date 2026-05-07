// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

const { contextBridge, ipcRenderer } = require('electron');

// Expose safe APIs to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // YouTube Collector - Export CSV
  exportCSV: (rows) => ipcRenderer.invoke('export-csv', rows),

  // 5-Sec Downloader APIs
  openFileDialog: (options) => ipcRenderer.invoke('open-file-dialog', options),
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  startDownload: (csvPath, outputPath, clipSleepMin, clipSleepMax, rowSleepMin, rowSleepMax) => ipcRenderer.invoke('start-download', csvPath, outputPath, clipSleepMin, clipSleepMax, rowSleepMin, rowSleepMax),
  stopDownload: () => ipcRenderer.invoke('stop-download'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),

  // CapCut Shuffle APIs
  scanCapcutProjects: (folderPath) => ipcRenderer.invoke('scan-capcut-projects', folderPath),
  processCapcutProjects: (projectPaths, cacheBust) => ipcRenderer.invoke('process-capcut-projects', projectPaths, cacheBust),

  // CapCut Auto Render APIs
  scanRenderProjects: (folderPath) => ipcRenderer.invoke('scan-render-projects', folderPath),
  startCapcutAutoRender: (projectPaths, delays) => ipcRenderer.invoke('start-capcut-auto-render', projectPaths, delays),

  // YouTube Trimmer APIs
  trimYouTubeVideo: (url, startSeconds, endSeconds, outputPath) => ipcRenderer.invoke('trim-youtube-video', url, startSeconds, endSeconds, outputPath),

  // YouTube Collector - Load/Save
  openLoadDialog: () => ipcRenderer.invoke('open-load-dialog'),
  loadRowData: (filePath) => ipcRenderer.invoke('load-row-data', filePath),
  saveRowAutosave: (rows, currentRow) => ipcRenderer.invoke('save-row-autosave', rows, currentRow),
  getAutosavePath: () => ipcRenderer.invoke('get-autosave-path'),

  // Utility APIs
  openUrl: (url) => ipcRenderer.invoke('open-url', url),

  // Event Listeners for process completion
  onDownloadComplete: (callback) => {
    ipcRenderer.on('download-complete', (event, success) => callback(success));
  },
  onDownloadLog: (callback) => {
    ipcRenderer.on('download-log', (event, message) => callback(message));
  },
  onCapcutLog: (callback) => {
    ipcRenderer.on('capcut-log', (event, message) => callback(message));
  },
  onCapcutRenderLog: (callback) => {
    ipcRenderer.on('capcut-render-log', (event, message) => callback(message));
  },
  onTrimLog: (callback) => {
    ipcRenderer.on('trim-log', (event, message) => callback(message));
  },
});


