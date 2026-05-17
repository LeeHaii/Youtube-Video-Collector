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
  extractRateLimitErrors: () => ipcRenderer.invoke('extract-rate-limit-errors'),
  extractAgeRestrictionErrors: () => ipcRenderer.invoke('extract-age-restriction-errors'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),

  // CapCut Shuffle APIs
  scanCapcutProjects: (folderPath) => ipcRenderer.invoke('scan-capcut-projects', folderPath),
  processCapcutProjects: (projectPaths, cacheBust) => ipcRenderer.invoke('process-capcut-projects', projectPaths, cacheBust),

  // Auto Add Effect & Title APIs
  processEffectTitle: (projectPaths, addEffect, addTitle, titleText) => ipcRenderer.invoke('process-effect-title', projectPaths, addEffect, addTitle, titleText),

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
  onDownloadErrorSummary: (callback) => {
    ipcRenderer.on('download-error-summary', (event, summary) => callback(summary));
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

// ============================================================================
// LICENSING API - Exposed to activation window and main app
// ============================================================================
contextBridge.exposeInMainWorld('licensingAPI', {
  submitLicenseKey: (key) => ipcRenderer.invoke('submit-license-key', key),
  checkLicenseStatus: () => ipcRenderer.invoke('check-license-status'),
});


