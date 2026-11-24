const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID = /^[a-f0-9-]{36}$/;
const statuses = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
function fail(message, status = 400, code) { const error = Object.assign(new Error(message), { status }); if (code) error.code = code; return error; }
function safeError(error) {
  if (error?.code === 'ENOSPC') return '存储空间不足';
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return '存储目录不可写，请检查挂载权限';
  if (['ENOENT', 'ENOTDIR', 'ESTALE'].includes(error?.code)) return '存储路径不可用，请检查挂载';
  return String(error?.message || '操作失败').replace(/https?:\/\/[^\s"'）]+/gi, '[来源地址]').replace(/(?:Bearer\s+|decryption_key\s+)\S+/gi, '[已隐藏]').slice(0, 300);
}
function mountChanged(message) { return fail(message, 409, 'MOUNT_CHANGED'); }
function invalidArtifact() { return fail('已完成视频不可用，请重新下载', 409, 'ARTIFACT_INVALID'); }
function assertFields(value, allowed) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !allowed.includes(key))) throw fail('请求字段无效');
}
// 剧集标识：红果官方是纯数字 ID；其余来源带前缀（module: / dramabox: / reelshort: /
// custom: / hema: / xifan:）。底层取源（src/native/hongguo.js）本来就按前缀分流，
// 这里只负责放行并做形状校验，取流与解析仍由底层负责。
const SERIES = /^\d{1,30}$/;
// 外部来源标识：module:<源>:<base64url>、dramabox:<id> 等，vid 与 series_id 都可能带冒号。
const EXTERNAL_SERIES = /^(?:module|dramabox|reelshort|custom|hema|xifan):[A-Za-z0-9_:.~-]{1,240}$/;
function numericId(value) { if (typeof value !== 'string' || !SERIES.test(value)) throw fail('只支持红果剧集标识'); return value; }
function validSeriesId(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return SERIES.test(text) || EXTERNAL_SERIES.test(text);
}
function seriesId(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('剧集标识无效');
  const text = value.trim();
  if (SERIES.test(text)) return text;
  if (EXTERNAL_SERIES.test(text)) return text;
  throw fail('剧集标识无效');
}
function safeTitle(value) { return String(value || '未命名短剧').normalize('NFKC').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').replace(/^\.+|[. ]+$/g, '').slice(0, 60) || '未命名短剧'; }

/**
 * 来源目录名覆盖表。允许把某个来源前缀映射到自定义目录名，
 * 便于按自己的整理习惯摆放各来源的剧集。
 */
function readFolderOverrides(value) {
  let raw = value;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try { raw = JSON.parse(raw); } catch (_) { return {}; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, name] of Object.entries(raw)) {
    const prefix = String(key || '').trim();
    if (!prefix || typeof name !== 'string' || name.trim() === '') continue;
    out[prefix] = name.trim();
  }
  return out;
}

/**
 * 剧集目录名里的剧号后缀。
 *
 * 红果官方是纯数字，直接用（与旧版目录命名保持一致，已有任务记录不受影响）。
 * 外部来源的标识带冒号，不能直接进文件名，改用 sha256 前 12 位，
 * 与桌面端 main.js 的 seriesDownloadDir 同一套做法。
 */
function safeIdSuffix(seriesId) {
  const id = String(seriesId || '');
  if (SERIES.test(id)) return id;
  return crypto.createHash('sha256').update(id).digest('hex').slice(0, 12);
}

/** 取 module:<源> 的展示名，用作目录名。取不到时返回空串。 */
function moduleLabel(seriesId) {
  const id = String(seriesId || '');
  if (!id.startsWith('module:')) return '';
  try {
    const { labelOf } = require('../src/native/module-source');
    return labelOf(id) || '';
  } catch (_) {
    return '';
  }
}

class Storage {
  constructor(dataRoot, downloadRoot, options = {}) {
    this.dataRoot = path.resolve(dataRoot); this.root = path.resolve(downloadRoot);
    this.folderOverrides = readFolderOverrides(options.folderOverrides);
    for (const dir of [this.dataRoot, this.root]) {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.lstatSync(dir).isSymbolicLink()) throw fail('挂载目录不可是符号链接');
    }
    this.dataRoot = fs.realpathSync(this.dataRoot); this.root = fs.realpathSync(this.root);
    this.rootStat = fs.statSync(this.root); this.dataStat = fs.statSync(this.dataRoot);
    this.stateFile = path.join(this.dataRoot, 'tasks.json');
    this.tasks = [];
    if (fs.existsSync(this.stateFile)) {
      if (!fs.lstatSync(this.stateFile).isFile() || fs.lstatSync(this.stateFile).isSymbolicLink() || fs.statSync(this.stateFile).size > 32 * 1024 * 1024) throw fail('任务记录文件无效');
      let state; try { state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { throw fail('任务记录损坏，已停止启动以保护记录'); }
      if (state.version !== 1 || !Array.isArray(state.tasks) || state.tasks.length > 10000) throw fail('任务记录损坏，已停止启动以保护记录');
      const seen = new Set();
      for (const task of state.tasks) {
        if (!ID.test(task.id) || seen.has(task.id) || !validSeriesId(task.seriesId) || !['download', 'merge'].includes(task.type) || !statuses.has(task.status)) throw fail('任务记录损坏');
        if (task.type === 'download' && (!validSeriesId(task.vid) || !Number.isInteger(task.episodeIndex) || task.episodeIndex < 1 || !['auto', '720p', '1080p'].includes(task.quality))) throw fail('下载记录损坏');
        if (task.type === 'merge' && (!Array.isArray(task.taskIds) || task.taskIds.some(id => !ID.test(id)))) throw fail('合并记录损坏');
        seen.add(task.id);
        if (task.status === 'running') { task.status = 'interrupted'; task.error = '服务已重启，请手动重试'; }
        this.tasks.push(task);
      }
    }
    this.cleanupTemporary();
    this.reconcileCompleted();
    this.save();
  }
  checkRoot() {
    try {
      const stat = fs.lstatSync(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.rootStat.dev || stat.ino !== this.rootStat.ino || fs.realpathSync(this.root) !== this.root) throw mountChanged('下载挂载已变化，请恢复原挂载后重启服务');
    } catch (error) {
      if (error.code === 'MOUNT_CHANGED') throw error;
      throw mountChanged('下载挂载已变化，请恢复原挂载后重启服务');
    }
  }
  cleanupTemporary() {
    this.checkRoot();
    // 清理上一次运行残留的下载暂存目录。
    //
    // 只认两类剧集目录：红果官方的「剧名_数字」与外部来源的「剧名_12位哈希」，
    // 且目录内的临时项必须严格匹配 .download-XXXXXX（6 位字母数字）。
    // 用户自建的 .download-notes 之类不匹配，不会被删。
    // 剧集目录可能直接挂在根目录下（红果官方），也可能落在来源子目录里，
    // 所以扫两层；来源子目录只认白名单里的名字，不按通配符乱扫。
    const roots = [this.root];
    for (const name of this.sourceFolderNames()) {
      const child = path.join(this.root, name);
      try { if (fs.statSync(child).isDirectory()) roots.push(child); } catch (_) { /* 不存在就跳过 */ }
    }
    for (const root of roots) this.cleanupTemporaryIn(root);
  }
  cleanupTemporaryIn(root) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (!/_\d{1,30}$/.test(entry.name) && !/_[0-9a-f]{12}$/.test(entry.name)) continue;
      const directory = path.join(root, entry.name);
      let children;
      try { children = fs.readdirSync(directory, { withFileTypes: true }); }
      catch { continue; }
      for (const child of children) {
        if (!/^\.download-[A-Za-z0-9]{6}$/.test(child.name)) continue;
        const temporary = path.join(directory, child.name);
        try {
          const stat = fs.lstatSync(temporary);
          if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 2 });
        } catch {}
      }
    }
  }
  /** 本程序会用到的来源子目录名白名单。 */
  sourceFolderNames() {
    const names = new Set();
    for (const [prefix, label] of Object.entries(this.folderOverrides)) names.add(safeTitle(label));
    for (const label of ['DramaBox', 'ReelShort', '河马短剧', '西饭短剧', '自定义来源', '第三方来源']) names.add(label);
    try {
      const { listSources } = require('../src/native/module-source');
      for (const source of listSources()) if (source.label) names.add(safeTitle(source.label));
    } catch (_) { /* 来源清单不可用时用默认名 */ }
    return [...names];
  }
  directory(task) {
    this.checkRoot();
    const dir = path.join(this.root, this.sourceFolder(task.seriesId), `${safeTitle(task.seriesTitle)}_${safeIdSuffix(task.seriesId)}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) throw fail('剧集目录不可是符号链接', 409);
    return dir;
  }
  /**
   * 下载根目录下的来源子目录名。与桌面端 main.js 的 sourceFolderName 对齐：
   * 红果官方剧集直接放在根目录，其余来源各自一个子目录，便于按来源整理与清理。
   * 目录名可通过 SOURCE_FOLDERS 覆盖（JSON），键是来源前缀，值是目录名。
   */
  sourceFolder(seriesId) {
    const id = String(seriesId || '');
    const overrides = this.folderOverrides;
    for (const [prefix, name] of Object.entries(overrides)) {
      if (id.startsWith(prefix)) return safeTitle(name);
    }
    if (id.startsWith('dramabox:')) return 'DramaBox';
    if (id.startsWith('reelshort:')) return 'ReelShort';
    if (id.startsWith('hema:')) return '河马短剧';
    if (id.startsWith('xifan:')) return '西饭短剧';
    if (id.startsWith('custom:')) return '自定义来源';
    if (id.startsWith('module:')) {
      const label = moduleLabel(id);
      return label ? safeTitle(label) : '第三方来源';
    }
    return '';
  }
  artifactPath(task) {
    if (!ID.test(task.id)) throw fail('任务标识无效');
    const name = task.type === 'merge' ? `合并_${task.id}.mp4` : `第${String(task.episodeIndex).padStart(3, '0')}集_${task.id}.mp4`;
    return path.join(this.directory(task), name);
  }
  output(task) {
    const file = this.artifactPath(task);
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw fail('目标文件不是普通文件', 409, 'ARTIFACT_INVALID');
    return file;
  }
  artifact(task) {
    this.checkRoot();
    const file = this.output(task);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') throw invalidArtifact();
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) throw invalidArtifact();
    const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (task.artifact && task.artifact !== fingerprint) throw invalidArtifact();
    return { file, stat, fingerprint };
  }
  complete(task) {
    const { fingerprint } = this.artifact(task);
    this.update(task, { status: 'completed', progress: 100, artifact: fingerprint });
  }
  quarantineArtifact(task) {
    const file = this.artifactPath(task);
    if (!fs.existsSync(file)) return null;
    const target = path.join(path.dirname(file), `.invalid-${task.id}-${Date.now()}-${crypto.randomUUID()}.mp4`);
    fs.renameSync(file, target);
    return target;
  }
  reconcileCompleted() {
    const before = [], failed = [];
    for (const task of this.tasks) {
      if (task.status !== 'completed') continue;
      try {
        const { fingerprint } = this.artifact(task);
        if (!task.artifact) { before.push([task, { ...task }]); task.artifact = fingerprint; }
      } catch (error) {
        if (error.code === 'MOUNT_CHANGED') throw error;
        if (error.code !== 'ARTIFACT_INVALID') throw error;
        before.push([task, { ...task }]); failed.push(task);
        try { this.quarantineArtifact(task); } catch {}
        Object.assign(task, { status: 'interrupted', progress: 0, error: '已完成视频不可用，请重新下载' });
        delete task.artifact;
      }
    }
    if (!before.length) return;
    try { this.save(); } catch (error) {
      for (const [task, old] of before) { for (const key of Object.keys(task)) delete task[key]; Object.assign(task, old); }
      throw error;
    }
    return failed;
  }
  interruptQueued(message) {
    const queued = this.tasks.filter(task => task.type === 'download' && task.status === 'queued');
    if (!queued.length) return 0;
    const before = queued.map(task => [task, { ...task }]);
    for (const task of queued) Object.assign(task, { status: 'interrupted', progress: 0, error: message, updatedAt: new Date().toISOString() });
    try { this.save(); } catch (error) {
      for (const [task, old] of before) { for (const key of Object.keys(task)) delete task[key]; Object.assign(task, old); }
      throw error;
    }
    return queued.length;
  }
  publicTask(task) {
    const { id, type, seriesId, seriesTitle, episodeTitle, episodeIndex, status, progress, error, createdAt, updatedAt, quality } = task;
    return { id, type, seriesId, seriesTitle, episodeTitle, episodeIndex, status, progress, error, createdAt, updatedAt, quality,
      ...(status === 'completed' ? { file: path.relative(this.root, this.artifact(task).file) } : {}) };
  }
  save() {
    let stat;
    try {
      stat = fs.lstatSync(this.dataRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.dataStat.dev || stat.ino !== this.dataStat.ino || fs.realpathSync(this.dataRoot) !== this.dataRoot) throw mountChanged('任务目录挂载已变化，请恢复原挂载后重启服务');
    } catch (error) {
      if (error.code === 'MOUNT_CHANGED') throw error;
      throw mountChanged('任务目录挂载已变化，请恢复原挂载后重启服务');
    }
    const temporary = `${this.stateFile}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, tasks: this.tasks })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.stateFile);
    const dir = fs.openSync(this.dataRoot, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  add(tasks) { if (this.tasks.length + tasks.length > 10000) throw fail('任务已达上限，请备份后维护任务库', 409); this.tasks.push(...tasks); try { this.save(); } catch (error) { this.tasks.splice(-tasks.length); throw error; } }
  update(task, changes) { const old = { ...task }; Object.assign(task, changes, { updatedAt: new Date().toISOString() }); try { this.save(); } catch (error) { Object.assign(task, old); throw error; } }
  get(id) { const task = this.tasks.find(item => item.id === id); if (!task) throw fail('任务不存在', 404); return task; }
}
module.exports = { Storage, fail, safeError, assertFields, numericId, seriesId, validSeriesId, safeTitle, readFolderOverrides };
