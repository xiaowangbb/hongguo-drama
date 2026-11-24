// 红果短剧 8.1：版本及发行状态见 package.json 和 docs/release-8.1.md。
// 红果短剧 6.2：桌面桥接入口，发行说明见 docs/release-6.0.md。
const { contextBridge, ipcRenderer: rawIpcRenderer } = require('electron');

// 封面走本地解密协议：部分来源（黄果等）的封面是 AES 混淆的二进制，浏览器直接
// 请求源站会得到乱码。把 http(s) 封面包装成 hongguo-cover://，由主进程取回并解密。
// 只在 IPC 返回值出口做递归包装，主进程内部仍保留原始 URL（落盘、导出不受影响）。
const COVER_PREFIX = 'hongguo-cover://c/?url=';
function wrapCover(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return value;
  return COVER_PREFIX + encodeURIComponent(value);
}
function wrapCovers(value) {
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = wrapCovers(value[i]); return value; }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (key === 'cover') value[key] = wrapCover(value[key]);
      else value[key] = wrapCovers(value[key]);
    }
  }
  return value;
}
// 保留 ipcRenderer.invoke(...) 的调用文本，仅替换实现：其余方法（on/removeListener/send）惰性透传。
// 惰性取值避免加载期就访问 mock 中可能不存在的方法（部分测试 stub 只提供 invoke）。
const ipcRenderer = {
  invoke: async (channel, ...args) => wrapCovers(await rawIpcRenderer.invoke(channel, ...args)),
  on: (...args) => rawIpcRenderer.on.apply(rawIpcRenderer, args),
  removeListener: (...args) => rawIpcRenderer.removeListener.apply(rawIpcRenderer, args),
  send: (...args) => rawIpcRenderer.send.apply(rawIpcRenderer, args),
};

contextBridge.exposeInMainWorld('electronAPI', {
  getPublicDetails: (seriesId, vid) => ipcRenderer.invoke('get-public-details', seriesId, vid),
  getEpisodeComments: options => ipcRenderer.invoke('get-episode-comments', options),
  getEpisodeDanmaku: options => ipcRenderer.invoke('get-episode-danmaku', options),
  onTextExportDone: cb => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('text-export-done', listener);
    return () => ipcRenderer.removeListener('text-export-done', listener);
  },
  setStealthMode: enabled => ipcRenderer.invoke('set-stealth-mode', enabled),
  setFloatingPlayerAspectRatio: (width, height) => ipcRenderer.send('floating-player-aspect-ratio', { width, height }),
  getBossKeyState: () => ipcRenderer.invoke('get-boss-key-state'),
  setBossKey: value => ipcRenderer.invoke('set-boss-key', value),
  onBossKeyState: cb => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('boss-key-state', listener);
    return () => ipcRenderer.removeListener('boss-key-state', listener);
  },
  onStealthState: cb => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('stealth-state', listener);
    return () => ipcRenderer.removeListener('stealth-state', listener);
  },
  // 应用信息 / 官网链接
  checkAnnouncements: options => ipcRenderer.invoke('check-announcements', options),
  getCurrentAnnouncement: () => ipcRenderer.invoke('get-current-announcement'),
  acknowledgeAnnouncement: payload => ipcRenderer.invoke('acknowledge-announcement', payload),
  dismissAnnouncement: payload => ipcRenderer.invoke('dismiss-announcement', payload),
  getAnnouncementPreferences: () => ipcRenderer.invoke('get-announcement-preferences'),
  setAnnouncementPreferences: patch => ipcRenderer.invoke('set-announcement-preferences', patch),
  onAnnouncementPreferences: cb => {
    const listener = (_event, preferences) => cb(preferences);
    ipcRenderer.on('announcement-preferences-changed', listener);
    return () => ipcRenderer.removeListener('announcement-preferences-changed', listener);
  },
  checkAppUpdate: () => ipcRenderer.invoke('check-app-update'),
  openAppUpdate: () => ipcRenderer.invoke('open-app-update'),
  getAppUpdateState: () => ipcRenderer.invoke('get-app-update-state'),
  downloadAppUpdate: () => ipcRenderer.invoke('download-app-update'),
  cancelAppUpdate: () => ipcRenderer.invoke('cancel-app-update'),
  installAppUpdate: () => ipcRenderer.invoke('install-app-update'),
  onAppUpdateState: (cb) => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('app-update-state', listener);
    return () => ipcRenderer.removeListener('app-update-state', listener);
  },
  onAppUpdatePreference: cb => {
    const listener = (_event, enabled) => cb(enabled);
    ipcRenderer.on('app-update-preference', listener);
    return () => ipcRenderer.removeListener('app-update-preference', listener);
  },
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  setInterfaceLanguage: language => ipcRenderer.invoke('set-interface-language', language),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),


  // 红果解析与下载
  hongguoResolve: (input) => ipcRenderer.invoke('hongguo-resolve', input),
  hongguoDownloadBatch: (payload) => ipcRenderer.invoke('hongguo-download-batch', payload),
  downloadSeriesToNas: (seriesId, quality, options) => ipcRenderer.invoke('download-series-to-nas', seriesId, quality, options),
  onNasExportDone: cb => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('nas-export-done', listener);
    return () => ipcRenderer.removeListener('nas-export-done', listener);
  },

  // 搜索（内嵌浏览器嗅探）
  searchSeries: (keyword, options) => ipcRenderer.invoke('search-series', keyword, options),
  searchSeriesMore: (keyword, options) => ipcRenderer.invoke('search-series-more', keyword, options),
  findSeriesSequels: (seriesId, options) => ipcRenderer.invoke('find-series-sequels', seriesId, options),
  searchResolve: (seriesId) => ipcRenderer.invoke('search-resolve', seriesId),
  searchWindowShow: (visible, sourceUrl) => ipcRenderer.invoke('search-window-show', visible, sourceUrl),
  getSeriesList: (options) => ipcRenderer.invoke('get-series-list', options),
  forgetSeries: (seriesId, options) => ipcRenderer.invoke('forget-series', seriesId, options),
  removeWatchHistory: (seriesId) => ipcRenderer.invoke('remove-watch-history', seriesId),
  cleanupWatchedEpisode: (seriesId, vidIndex) => ipcRenderer.invoke('cleanup-watched-episode', seriesId, vidIndex),
  removeSeries: (seriesId) => ipcRenderer.invoke('remove-series', seriesId),
  purgeEmptySeries: () => ipcRenderer.invoke('purge-empty-series'),
  restoreDismissedSeries: () => ipcRenderer.invoke('restore-dismissed-series'),
  dismissedCount: () => ipcRenderer.invoke('dismissed-count'),
  rescanDownloads: () => ipcRenderer.invoke('rescan-downloads'),

  // 在线播放（内存或临时磁盘缓存 + 自定义流协议）
  prepareOnlinePlay: (payload) => ipcRenderer.invoke('prepare-online-play', payload),
  promoteOnlinePlay: (payload) => ipcRenderer.invoke('promote-online-play', payload),
  releaseOnlinePlay: (payload) => ipcRenderer.invoke('release-online-play', payload),
  onlineCacheStatus: () => ipcRenderer.invoke('online-cache-status'),
  discoverCastDevices: () => ipcRenderer.invoke('discover-cast-devices'),
  startCasting: payload => ipcRenderer.invoke('start-casting', payload),
  controlCasting: action => ipcRenderer.invoke('control-casting', action),
  clearSeriesPlaybackCache: seriesId => ipcRenderer.invoke('clear-series-playback-cache', seriesId),
  clearOnlineCache: () => ipcRenderer.invoke('clear-online-cache'),
  onOnlinePlayProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('online-play-progress', listener);
    return () => ipcRenderer.removeListener('online-play-progress', listener);
  },

  // 兼容模式（HEVC -> H.264 转码，解决「黑屏有声」）
  transcodeForPlayback: (payload) => ipcRenderer.invoke('transcode-for-playback', payload),
  cancelTranscodeForPlayback: (payload) => ipcRenderer.invoke('cancel-transcode-for-playback', payload),
  compatCacheStatus: () => ipcRenderer.invoke('compat-cache-status'),
  clearCompatCache: () => ipcRenderer.invoke('clear-compat-cache'),
  decodeCapability: () => ipcRenderer.invoke('decode-capability'),
  onTranscodeProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('transcode-progress', listener);
    return () => ipcRenderer.removeListener('transcode-progress', listener);
  },

  // 浏览（分类页）
  getCustomSources: () => ipcRenderer.invoke('get-custom-sources'),
  saveCustomSource: draft => ipcRenderer.invoke('save-custom-source',draft),
  deleteCustomSource: id => ipcRenderer.invoke('delete-custom-source',id),
  testCustomSource: draft => ipcRenderer.invoke('test-custom-source',draft),
  getMediaSources: () => ipcRenderer.invoke('get-media-sources'),
  setBuiltinSourceEnabled: (id, enabled) => ipcRenderer.invoke('set-builtin-source-enabled', id, enabled),
  getModuleSources: () => ipcRenderer.invoke('get-module-sources'),
  setModuleSourceEnabled: (id, enabled) => ipcRenderer.invoke('set-module-source-enabled', id, enabled),
  onMediaSourcesChanged: cb => {
    const listener = () => cb();
    ipcRenderer.on('media-sources-changed', listener);
    return () => ipcRenderer.removeListener('media-sources-changed', listener);
  },
  browseCategories: () => ipcRenderer.invoke('browse-categories'),
  browseList: (options) => ipcRenderer.invoke('browse-list', options),
  playSeries: (payload) => ipcRenderer.invoke('play-series', payload),
  onNavigate: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('navigate', listener);
    return () => ipcRenderer.removeListener('navigate', listener);
  },

  // 播放器
  getSeriesProgress: () => ipcRenderer.invoke('get-series-progress'),
  warmSeriesProgress: (seriesId) => ipcRenderer.invoke('warm-series-progress', seriesId),
  getSeriesEpisodes: (seriesId) => ipcRenderer.invoke('get-series-episodes', seriesId),
  // 只读缓存的批量进度（卡片/选择面板角标），不扫盘，避免网络盘上主进程长时间阻塞
  getSeriesProgress: () => ipcRenderer.invoke('get-series-progress'),
  // 逐部预热进度（主进程一次只扫一部，界面保持可响应）
  warmSeriesProgress: (seriesId) => ipcRenderer.invoke('warm-series-progress', seriesId),
  downloadSingleEpisode: (seriesId, vidIndex, quality) =>
    ipcRenderer.invoke('download-single-episode', seriesId, vidIndex, quality),
  downloadFollowingEpisodes: (seriesId, vidIndex, quality) =>
    ipcRenderer.invoke('download-following-episodes', seriesId, vidIndex, quality),
  savePlaybackPosition: (seriesId, vidIndex, currentTime, metadata) =>
    ipcRenderer.invoke('save-playback-position', seriesId, vidIndex, currentTime, metadata),
  getPlaybackPosition: (seriesId) => ipcRenderer.invoke('get-playback-position', seriesId),

  // 观看记录
  getWatchHistory: () => ipcRenderer.invoke('get-watch-history'),
  refreshWatchHistory: (options) => ipcRenderer.invoke('refresh-watch-history', options),
  checkWatchHistoryItem: (seriesId) => ipcRenderer.invoke('check-watch-history-item', seriesId),
  acknowledgeWatchUpdates: (seriesId, snapshot) => ipcRenderer.invoke('acknowledge-watch-updates', seriesId, snapshot),
  onWatchHistoryUpdated: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('watch-history-updated', listener);
    return () => ipcRenderer.removeListener('watch-history-updated', listener);
  },
  onWatchHistoryProgress: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('watch-history-progress', listener);
    return () => ipcRenderer.removeListener('watch-history-progress', listener);
  },

  // 红果账号（网页扫码，只读同步 APP 观看记录）
  getAccountStatus: () => ipcRenderer.invoke('get-account-status'),
  openAccountWebLogin: () => ipcRenderer.invoke('open-account-web-login'),
  startAccountLogin: () => ipcRenderer.invoke('start-account-login'),
  pollAccountLogin: (loginId) => ipcRenderer.invoke('poll-account-login', loginId),
  cancelAccountLogin: (loginId) => ipcRenderer.invoke('cancel-account-login', loginId),
  logoutAccount: () => ipcRenderer.invoke('logout-account'),
  getAccountHistory: (options) => ipcRenderer.invoke('get-account-history', options),
  playAccountHistory: (seriesId) => ipcRenderer.invoke('play-account-history', seriesId),
  onAccountUpdated: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('account-updated', listener);
    return () => ipcRenderer.removeListener('account-updated', listener);
  },

  // 一键合并
  getFfmpegStatus: () => ipcRenderer.invoke('get-ffmpeg-status'),
  mergeSeries: (seriesId, outputName, options) => ipcRenderer.invoke('merge-series', seriesId, outputName, options),
  cancelMerge: (id) => ipcRenderer.invoke('cancel-merge', id),
  getMergeTasks: () => ipcRenderer.invoke('get-merge-tasks'),
  deleteMergeTask: (id) => ipcRenderer.invoke('delete-merge-task', id),
  onMergeProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('merge-progress', listener);
    return () => ipcRenderer.removeListener('merge-progress', listener);
  },
  onMergeTaskAdded: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('merge-task-added', listener);
    return () => ipcRenderer.removeListener('merge-task-added', listener);
  },
  onMergeCompleted: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('merge-completed', listener);
    return () => ipcRenderer.removeListener('merge-completed', listener);
  },
  onMergeFailed: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('merge-failed', listener);
    return () => ipcRenderer.removeListener('merge-failed', listener);
  },

  // 设置
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getWindowLayout: () => ipcRenderer.invoke('get-window-layout'),
  setWindowLayout: (mode) => ipcRenderer.invoke('set-window-layout', mode),
  changeWindowZoom: (direction) => ipcRenderer.invoke('change-window-zoom', direction),
  onInterfaceZoomChanged: (cb) => {
    const listener = (_event, zoom) => cb(zoom);
    ipcRenderer.on('interface-zoom-changed', listener);
    return () => ipcRenderer.removeListener('interface-zoom-changed', listener);
  },
  getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('set-always-on-top', value),
  setEpisodePanelOpen: (value) => ipcRenderer.invoke('set-episode-panel-open', value),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  onStorageError: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('storage-error', listener);
    return () => ipcRenderer.removeListener('storage-error', listener);
  },

  // 网络代理
  getProxyStatus: () => ipcRenderer.invoke('get-proxy-status'),
  testProxy: (draft) => ipcRenderer.invoke('test-proxy', draft),

  // 下载管理
  getDownloadTasks: (options) => ipcRenderer.invoke('get-download-tasks', options),
  deleteTask: (taskId) => ipcRenderer.invoke('delete-task', taskId),
  deleteTasks: (taskIds) => ipcRenderer.invoke('delete-tasks', taskIds),

  // 文件清理
  deleteTaskWithFiles: (taskId, deleteFiles) => ipcRenderer.invoke('delete-task', taskId, { deleteFiles }),
  deleteTasksWithFiles: (taskIds, deleteFiles) => ipcRenderer.invoke('delete-tasks', taskIds, { deleteFiles }),
  deleteSeriesFiles: (seriesId, options) => ipcRenderer.invoke('delete-series-files', seriesId, options),
  deleteEpisodeFile: (seriesId, vidIndex) => ipcRenderer.invoke('delete-episode-file', seriesId, vidIndex),
  getStorageUsage: () => ipcRenderer.invoke('get-storage-usage'),
  deleteAllDownloaded: () => ipcRenderer.invoke('delete-all-downloaded'),
  stopDownload: (taskId) => ipcRenderer.invoke('stop-download', taskId),
  retryTask: (taskId) => ipcRenderer.invoke('retry-task', taskId),
  retryTasks: (taskIds) => ipcRenderer.invoke('retry-tasks', taskIds),
  openFolder: (taskId) => ipcRenderer.invoke('open-folder', taskId),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  openEpisodeExternal: (seriesId, vidIndex) => ipcRenderer.invoke('open-episode-external', seriesId, vidIndex),

  // 一键启动 / 一键暂停 / 队列状态
  pauseAll: () => ipcRenderer.invoke('pause-all'),
  resumeAll: () => ipcRenderer.invoke('resume-all'),
  getQueueStatus: () => ipcRenderer.invoke('get-queue-status'),

  // 事件监听
  onDownloadProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
  onDownloadTaskAdded: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-task-added', listener);
    return () => ipcRenderer.removeListener('download-task-added', listener);
  },
  onDownloadCompleted: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-completed', listener);
    return () => ipcRenderer.removeListener('download-completed', listener);
  },
  onDownloadFailed: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-failed', listener);
    return () => ipcRenderer.removeListener('download-failed', listener);
  },
  onDownloadStopped: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-stopped', listener);
    return () => ipcRenderer.removeListener('download-stopped', listener);
  },
  onDownloadQueueChanged: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-queue-changed', listener);
    return () => ipcRenderer.removeListener('download-queue-changed', listener);
  },
});
