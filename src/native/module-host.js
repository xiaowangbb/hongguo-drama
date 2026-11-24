/**
 * module-host.js —— 第三方来源脚本的宿主（主进程侧）。
 *
 * 来源模块是同步契约，所以真正执行在 module-worker.cjs 线程里；
 * 这里负责：
 *   1. 给脚本线程提供网络/状态服务（把同步调用变成主线程的异步 axios 请求）；
 *   2. 复用应用现有的请求守卫（web-media-guard），避免脚本直连内网地址；
 *   3. 保持脚本线程常驻，缓存其内部状态，空闲后回收。
 */
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const axios = require('axios');
const { isPublicMediaUrl, webMediaRequestOptions } = require('./web-media-guard');
const { fakeIpRequestOptions } = require('./local-dns');

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SHARED_BYTES = 32 * 1024 * 1024;
const IDLE_MS = 180000;
const MAX_BODY = 8 * 1024 * 1024;

const STATE_IDLE = 0, STATE_REQUEST = 1, STATE_RESPONSE = 2;

/** 开发态与安装包（含 asar 解包）下的模块根目录。 */
function resolveModuleRoot() {
  const candidates = [];
  try {
    const { app } = require('electron');
    const appPath = app.getAppPath();
    candidates.push(path.join(appPath, 'vendor', 'source-modules'));
    candidates.push(path.join(appPath.replace(/app\.asar$/, 'app.asar.unpacked'), 'vendor', 'source-modules'));
  } catch { /* 非 Electron 环境（测试）走下面的相对路径 */ }
  candidates.push(path.join(__dirname, '..', '..', 'vendor', 'source-modules'));
  candidates.push(path.join(__dirname, '..', '..', '..', 'vendor', 'source-modules'));
  return candidates.find(candidate => { try { return fs.statSync(candidate).isDirectory(); } catch { return false; } }) || '';
}

function workerFile() {
  const local = path.join(__dirname, 'module-worker.cjs');
  try {
    const { app } = require('electron');
    const packed = path.join(app.getAppPath(), 'src', 'native', 'module-worker.cjs');
    if (packed !== local && fs.existsSync(packed)) return packed;
    const unpacked = packed.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    if (fs.existsSync(unpacked)) return unpacked;
  } catch { /* 忽略 */ }
  return local;
}

// ---------- 状态持久化（来源会话、站点状态等）----------
let stateFile = null;
let stateCache = null;
let stateTimer = null;

function stateStore() {
  if (stateCache) return stateCache;
  if (!stateFile) {
    try {
      const { app } = require('electron');
      stateFile = path.join(app.getPath('userData'), 'module-source-state.json');
    } catch { stateFile = ''; }
  }
  stateCache = {};
  if (stateFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (raw && typeof raw === 'object') stateCache = raw;
    } catch { /* 首次运行或文件损坏时从空开始 */ }
  }
  return stateCache;
}

function flushState() {
  stateTimer = null;
  if (!stateFile) return;
  try {
    const { writeJsonAtomic } = require('./atomic-json');
    writeJsonAtomic(stateFile, stateStore());
  } catch { /* 状态丢失只影响该源登录态，不阻断浏览 */ }
}

function saveStateLater() {
  if (!stateFile || stateTimer) return;
  stateTimer = setTimeout(flushState, 800);
  if (stateTimer.unref) stateTimer.unref();
}

// ---------- 响应解码 ----------
function charsetOf(contentType, buffer) {
  const fromHeader = /charset=([\w-]+)/i.exec(String(contentType || ''));
  if (fromHeader) return fromHeader[1].toLowerCase();
  const head = buffer.subarray(0, 2048).toString('latin1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  if (fromMeta) return fromMeta[1].toLowerCase();
  return 'utf-8';
}

function decodeBody(buffer, contentType) {
  const charset = charsetOf(contentType, buffer);
  const normalized = charset === 'gb2312' ? 'gbk' : charset;
  try { return new TextDecoder(normalized).decode(buffer); }
  catch { return buffer.toString('utf8'); }
}

const SAFE_HEADERS = new Set(['set-cookie', 'retry-after', 'content-type', 'date', 'location']);

/**
 * 暴露给来源脚本的响应头。
 * set-cookie 必须逐条保留：脚本按单条 cookie 解析 CloudFront 等签名凭证，
 * 合并成一个字符串会把每条 cookie 的 Domain/Path/Expires 混进值里。
 */
function responseHeaders(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const name = String(key).toLowerCase();
    if (!SAFE_HEADERS.has(name)) continue;
    if (name === 'set-cookie') {
      const lines = (Array.isArray(value) ? value : [value]).map(item => String(item == null ? '' : item)).filter(Boolean);
      out['set-cookie'] = lines;
      // 上游脚本按安卓宿主的写法读大驼峰，两种键名都给
      out['Set-Cookie'] = lines;
      continue;
    }
    out[name] = Array.isArray(value) ? value.join('; ') : String(value);
  }
  return out;
}

/** 日志里不打印查询串，避免把临时令牌写进日志。 */
function sanitize(url) {
  try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch { return '无效地址'; }
}

// ---------- 网络 ----------
async function performFetch(request) {
  const url = String(request.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('来源地址无效');
  if (!isPublicMediaUrl(url)) throw new Error('来源地址不可访问（非公网地址）');
  const headers = { 'User-Agent': request.userAgent || DEFAULT_UA, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' };
  if (request.referer) headers.Referer = request.referer;
  if (request.headers && typeof request.headers === 'object') {
    for (const [key, value] of Object.entries(request.headers)) {
      if (!key || value == null) continue;
      // 对齐安卓宿主：脚本不允许自行塞 Cookie
      if (String(key).toLowerCase() === 'cookie') continue;
      if (!/^[A-Za-z0-9-]{1,64}$/.test(String(key))) continue;
      headers[String(key)] = String(value);
    }
  }
  const limit = Math.min(MAX_BODY, request.limit > 0 ? request.limit : MAX_BODY);
  const timeout = Math.min(45000, request.timeoutMs > 0 ? request.timeoutMs : 15000);
  // 二进制请求体：body 是 base64 文本，还原为字节；axios 收到 Buffer 会按原始字节发送
  let data = request.body == null ? undefined : request.body;
  if (request.bodyBase64 === true && typeof data === 'string') {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data.replace(/\s+/g, ''))) throw new Error('来源请求体编码无效');
    data = Buffer.from(data, 'base64');
  }
  const base = {
    url, method: request.method || 'GET', headers,
    data,
    adapter: 'http', responseType: 'arraybuffer', timeout,
    maxContentLength: limit, maxBodyLength: limit, validateStatus: () => true,
  };
  let response;
  let failure = null;
  try {
    response = await axios.request({ ...base, ...webMediaRequestOptions(url) });
  } catch (error) {
    failure = error;
    // 本机代理的 fake-ip 会被应用的公网校验误判，此时改用允许 fake-ip 的兜底校验重试一次
    if (error?.code === 'ERR_WEB_MEDIA_ADDRESS') {
      try {
        response = await axios.request({ ...base, ...fakeIpRequestOptions(url) });
        failure = null;
      } catch (retryError) { failure = retryError; }
    }
  }
  if (!response) {
    console.error('[ModuleSource] 请求失败:', sanitize(url), failure?.code || '', failure?.message || '');
    const message = failure?.code === 'ECONNABORTED' || /timeout/i.test(String(failure?.message)) ? '来源响应超时' : '来源连接失败';
    throw new Error(message);
  }
  const status = Number(response.status) || 0;
  const raw = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data || '');
  if (raw.length > limit) throw new Error('来源响应过大');
  // 二进制响应：直接回传 base64，绕过字符集解码（AES 密文等场景）
  const body = request.binaryResponse === true ? raw.toString('base64') : decodeBody(raw, response.headers?.['content-type']);
  // 脚本可用 acceptStatus 声明「这些状态码我自己处理」，用于识别 401/403 后刷新授权。
  const accepted = Array.isArray(request.acceptStatus) && request.acceptStatus.includes(status);
  if (!request.anyStatus && !accepted && (status < 200 || status >= 400)) throw new Error(`来源返回 ${status || '异常'}`);
  const outHeaders = responseHeaders(response.headers);
  return { body, url: response.request?.res?.responseUrl || url, status, headers: outHeaders, binary: request.binaryResponse === true };
}

function absoluteUrl(base, relative) {
  try { return new URL(String(relative), String(base)).toString(); } catch { return ''; }
}

/** 取 HLS 清单，主清单时下钻一层到码率最高的子清单。 */
async function performPlaylist(request) {
  let target = String(request.url || '');
  let playlist = '';
  let durationMs = 0;
  for (let depth = 0; depth < 3; depth++) {
    const response = await performFetch({ ...request, url: target, anyStatus: false, limit: 2 * 1024 * 1024 });
    const text = String(response.body || '').replace(/^\uFEFF/, '').trim();
    if (!text.startsWith('#EXTM3U')) throw new Error('来源未返回有效 HLS 清单');
    playlist = text;
    target = response.url || target;
    if (!/#EXT-X-STREAM-INF/i.test(text)) break;
    const lines = text.split(/\r?\n/);
    let best = null, bestBandwidth = -1;
    for (let index = 0; index < lines.length; index++) {
      if (!/^#EXT-X-STREAM-INF/i.test(lines[index])) continue;
      const bandwidth = Number((/BANDWIDTH=(\d+)/i.exec(lines[index]) || [])[1]) || 0;
      const next = (lines[index + 1] || '').trim();
      if (!next || next.startsWith('#') || bandwidth <= bestBandwidth) continue;
      best = next; bestBandwidth = bandwidth;
    }
    const nextUrl = best ? absoluteUrl(target, best) : '';
    if (!nextUrl) break;
    target = nextUrl;
  }
  for (const match of playlist.matchAll(/#EXTINF:\s*([\d.]+)/g)) durationMs += Math.round(Number(match[1]) * 1000);
  return { playlist, url: target, durationMs };
}

// ---------- 线程管理 ----------
class SourceRuntime {
  constructor(id, moduleFile) {
    this.id = id;
    this.moduleFile = moduleFile;
    this.worker = null;
    this.sab = null;
    this.header = null;
    this.data = null;
    this.queue = Promise.resolve();
    this.pending = null;
    this.ready = null;
    this.fatal = '';
    this.timer = null;
  }

  start() {
    if (this.ready) return this.ready;
    this.sab = new SharedArrayBuffer(SHARED_BYTES);
    this.header = new Int32Array(this.sab, 0, 8);
    this.data = new Uint8Array(this.sab, 64);
    this.worker = new Worker(workerFile(), { workerData: { sourceId: this.id, moduleFile: this.moduleFile, sab: this.sab } });
    this.ready = new Promise((resolve, reject) => {
      this.worker.once('message', message => {
        if (message?.type === 'ready') return resolve(message.methods || []);
        this.fatal = message?.error || '来源脚本加载失败';
        reject(new Error(this.fatal));
      });
      this.worker.once('error', error => { this.fatal = error?.message || '来源脚本线程异常'; reject(new Error(this.fatal)); });
    });
    this.worker.on('message', message => {
      if (!message) return;
      if (message.type === 'rpc') return void this.handleRpc(message.id);
      if (message.type === 'result') return this.settle(message);
      if (message.type === 'fatal') this.fatal = message.error || '来源脚本异常';
    });
    this.worker.on('error', error => { this.fatal = error?.message || '来源脚本线程异常'; this.settle({ ok: false, error: this.fatal }); });
    this.worker.on('exit', code => {
      if (this.pending) this.settle({ ok: false, error: `来源脚本已中断（${code}）` });
      this.worker = null; this.ready = null;
    });
    return this.ready;
  }

  settle(message) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error || '来源操作失败'));
  }

  async handleRpc(rpcId) {
    const length = this.header[2];
    const raw = Buffer.from(this.data.slice(0, length)).toString('utf8');
    let request = null, response = null;
    try {
      request = JSON.parse(raw);
      response = { value: await this.dispatch(request) };
    } catch (error) {
      response = { error: error?.message || '来源请求失败' };
    }
    const payload = Buffer.from(JSON.stringify(response), 'utf8');
    if (payload.length > this.data.length) {
      const fallback = Buffer.from(JSON.stringify({ error: '来源响应超出允许大小' }), 'utf8');
      this.data.set(fallback, 0);
      this.header[3] = fallback.length;
    } else {
      this.data.set(payload, 0);
      this.header[3] = payload.length;
    }
    Atomics.store(this.header, 0, STATE_RESPONSE);
    Atomics.notify(this.header, 0);
    void rpcId;
  }

  async dispatch(request) {
    const op = request?.op;
    const payload = request?.payload || {};
    if (op === 'fetch') return performFetch(payload);
    if (op === 'playlist') return performPlaylist(payload);
    if (op === 'state-load') return stateStore()[`${this.id}:${payload.name}`] ?? null;
    if (op === 'state-save') {
      const key = `${this.id}:${payload.name}`;
      if (payload.value == null) delete stateStore()[key];
      else stateStore()[key] = payload.value;
      saveStateLater();
      return null;
    }
    throw new Error('来源请求类型不受支持');
  }

  touch() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.dispose(), IDLE_MS);
    if (this.timer.unref) this.timer.unref();
  }

  async call(method, args) {
    await this.start();
    if (this.fatal) throw new Error(this.fatal);
    const run = async () => {
      this.touch();
      const id = `${method}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.settle({ ok: false, error: '来源操作超时' }), 60000);
        this.pending = { resolve, reject, timer };
        this.worker.postMessage({ type: 'call', id, method, args });
      });
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const worker = this.worker;
    this.worker = null; this.ready = null; this.pending = null;
    if (worker) worker.terminate().catch(() => {});
  }
}

const runtimes = new Map();
let moduleRoot = '';

function root() {
  if (!moduleRoot) moduleRoot = resolveModuleRoot();
  return moduleRoot;
}

function moduleFileOf(id) {
  const file = path.join(root(), String(id), 'main.js');
  try { return fs.statSync(file).isFile() ? file : ''; } catch { return ''; }
}

function runtimeFor(id) {
  const existing = runtimes.get(id);
  if (existing) return existing;
  const moduleFile = moduleFileOf(id);
  if (!moduleFile) throw new Error('来源脚本缺失，请重新安装应用');
  const runtime = new SourceRuntime(id, moduleFile);
  runtimes.set(id, runtime);
  return runtime;
}

/** 是否有可用脚本（模块是否随包分发）。 */
function hasModule(id) { return !!moduleFileOf(id); }

function call(id, method, args = []) { return runtimeFor(id).call(method, args); }

function disposeSource(id) {
  const runtime = runtimes.get(id);
  if (!runtime) return;
  runtimes.delete(id);
  runtime.dispose();
}

function disposeAll() {
  for (const id of [...runtimes.keys()]) disposeSource(id);
  if (stateTimer) { clearTimeout(stateTimer); flushState(); }
}

module.exports = { call, hasModule, disposeSource, disposeAll, resolveModuleRoot, responseHeaders, DEFAULT_UA };
