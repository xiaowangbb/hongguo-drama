/**
 * module-worker.cjs —— 第三方来源脚本的沙箱线程。
 *
 * 这些来源模块是从安卓端的 Rhino/goja 宿主移植过来的，导出函数全部是同步签名
 * （源码里 async/await 出现 0 次）。同步调用无法直接跑在 Electron 主进程，
 * 否则每次取网页都会冻结界面。因此：脚本跑在本线程，网络等 I/O 通过共享内存
 * 同步桥交回主进程用 axios 执行，本线程只负责阻塞等待。
 */
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { sourceId, moduleFile, sab } = workerData;

// 共享内存布局：Int32 头部 [state, 保留, 请求长度, 响应长度]，正文从 64 字节起
const HEADER = new Int32Array(sab, 0, 8);
const DATA = new Uint8Array(sab, 64);
const STATE_IDLE = 0, STATE_REQUEST = 1, STATE_RESPONSE = 2;

let sequence = 0;

function rpc(op, payload, timeoutMs = 30000) {
  const body = Buffer.from(JSON.stringify({ op, payload }), 'utf8');
  if (body.length > DATA.length) throw new Error('来源请求超出允许大小');
  HEADER[2] = body.length;
  HEADER[3] = 0;
  DATA.set(body, 0);
  Atomics.store(HEADER, 0, STATE_REQUEST);
  parentPort.postMessage({ type: 'rpc', id: ++sequence });
  const waited = Atomics.wait(HEADER, 0, STATE_REQUEST, timeoutMs);
  if (waited === 'timed-out') throw new Error('来源请求超时，请稍后重试');
  const length = HEADER[3];
  const text = Buffer.from(DATA.slice(0, length)).toString('utf8');
  Atomics.store(HEADER, 0, STATE_IDLE);
  let response;
  try { response = JSON.parse(text); } catch { throw new Error('来源响应解析失败'); }
  if (response && response.error) throw new Error(response.error);
  return response ? response.value : null;
}

// ---------- HTML 树（模块需要 {tag, attrs, text, children}）----------
let parse5 = null;
try { parse5 = require('parse5'); } catch {
  for (const candidate of [
    require('node:path').join(process.resourcesPath || '', 'app.asar.unpacked/node_modules/parse5'),
    require('node:path').join(require('node:path').dirname(process.execPath), 'resources/app.asar.unpacked/node_modules/parse5'),
  ]) {
    try { parse5 = require(candidate); break; } catch { /* 继续尝试下一个位置 */ }
  }
}

function toTree(node) {
  if (node.nodeName === '#text') return { tag: '', attrs: {}, text: node.value || '', children: [] };
  if (node.nodeName === '#comment' || node.nodeName === '#documentType') return null;
  const attrs = {};
  for (const attribute of node.attrs || []) attrs[attribute.name] = attribute.value;
  const children = [];
  for (const child of node.childNodes || []) { const built = toTree(child); if (built) children.push(built); }
  return { tag: node.tagName || node.nodeName, attrs, text: '', children };
}

function htmlTree(html) {
  if (!parse5) throw new Error('来源解析组件缺失，无法解析网页');
  return toTree(parse5.parse(String(html == null ? '' : html)));
}

// ---------- 编解码与密码学（对齐安卓 SourceRuntimeSupport）----------
const bytesOf = value => {
  if (value == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Buffer.from(value.map(byte => Number(byte) & 255));
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.alloc(0);
};

const cryptoApi = {
  utf8Encode: value => Buffer.from(String(value == null ? '' : value), 'utf8'),
  utf8Decode: value => bytesOf(value).toString('utf8'),
  hexEncode: value => bytesOf(value).toString('hex'),
  hexDecode: value => {
    const text = String(value == null ? '' : value).trim();
    if (!/^[0-9a-fA-F]*$/.test(text) || text.length % 2 !== 0) throw new Error('来源十六进制数据无效');
    return Buffer.from(text, 'hex');
  },
  base64Encode: value => bytesOf(value).toString('base64'),
  base64Decode: value => {
    const text = String(value == null ? '' : value).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('来源 Base64 数据无效');
    return Buffer.from(text, 'base64');
  },
  md5: value => crypto.createHash('md5').update(bytesOf(value)).digest(),
  sha256: value => crypto.createHash('sha256').update(bytesOf(value)).digest(),
  randomBytes: count => crypto.randomBytes(Math.max(0, Math.min(4096, Number(count) || 0))),
  aesCbcEncrypt: (key, iv, data) => {
    const cipher = crypto.createCipheriv(`aes-${bytesOf(key).length * 8}-cbc`, bytesOf(key), bytesOf(iv));
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(bytesOf(data)), cipher.final()]);
  },
  aesCbcDecrypt: (key, iv, data) => {
    const decipher = crypto.createDecipheriv(`aes-${bytesOf(key).length * 8}-cbc`, bytesOf(key), bytesOf(iv));
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(bytesOf(data)), decipher.final()]);
  },
  aesGcmSeal: (key, iv, data, aad) => {
    if (bytesOf(iv).length !== 12) throw new Error('来源加密参数无效');
    const cipher = crypto.createCipheriv(`aes-${bytesOf(key).length * 8}-gcm`, bytesOf(key), bytesOf(iv));
    if (bytesOf(aad).length) cipher.setAAD(bytesOf(aad));
    const payload = Buffer.concat([cipher.update(bytesOf(data)), cipher.final()]);
    return Buffer.concat([payload, cipher.getAuthTag()]);
  },
  aesGcmOpen: (key, iv, data, aad) => {
    if (bytesOf(iv).length !== 12) throw new Error('来源加密参数无效');
    const raw = bytesOf(data);
    if (raw.length < 16) throw new Error('来源密文损坏');
    const decipher = crypto.createDecipheriv(`aes-${bytesOf(key).length * 8}-gcm`, bytesOf(key), bytesOf(iv));
    if (bytesOf(aad).length) decipher.setAAD(bytesOf(aad));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
  },
  ecdhP256KeyPair: () => {
    const pair = crypto.createECDH('prime256v1');
    pair.generateKeys();
    return { privateKey: pair.getPrivateKey(), publicKey: pair.getPublicKey(null, 'uncompressed') };
  },
  ecdhP256: (privateKey, publicKey) => {
    const pair = crypto.createECDH('prime256v1');
    pair.setPrivateKey(bytesOf(privateKey));
    return pair.computeSecret(bytesOf(publicKey));
  },
  hkdfSha256: (secret, salt, info, length) => {
    const size = Math.max(0, Math.min(1024, Number(length) || 0));
    const saltBytes = bytesOf(salt);
    const prk = crypto.createHmac('sha256', saltBytes.length ? saltBytes : Buffer.alloc(32)).update(bytesOf(secret)).digest();
    const out = Buffer.alloc(size);
    let previous = Buffer.alloc(0), offset = 0;
    for (let counter = 1; offset < size; counter++) {
      previous = crypto.createHmac('sha256', prk).update(Buffer.concat([previous, bytesOf(info), Buffer.from([counter & 255])])).digest();
      offset += previous.copy(out, offset, 0, Math.min(previous.length, size - offset));
    }
    return out;
  },
};

// ---------- 缓存 / 状态 ----------
const cache = new Map();
function cacheGet(key) {
  const entry = cache.get(String(key));
  if (!entry) return null;
  if (entry.expires && entry.expires <= Date.now()) { cache.delete(String(key)); return null; }
  return entry.value;
}
function cacheSet(key, value, ttlMs) {
  if (value == null) { cache.delete(String(key)); return; }
  const ttl = Number(ttlMs) || 0;
  cache.set(String(key), { value: String(value), expires: ttl > 0 ? Date.now() + ttl : 0 });
}

let reserveTicket = 0;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

// ---------- 宿主对象 ----------
const host = Object.assign({}, cryptoApi, {
  source: sourceId,
  dramaId: value => `${sourceId}:${value}`,
  chapterId: (drama, chapter) => `${sourceId}:${drama}:${chapter}`,
  parseUrl: raw => {
    const url = new URL(String(raw));
    return {
      scheme: url.protocol.replace(':', ''), hostname: url.hostname, host: url.host,
      port: url.port, path: url.pathname, query: url.search.replace(/^\?/, ''),
      fragment: url.hash.replace(/^#/, ''), userInfo: !!url.username, href: String(raw),
    };
  },
  resolveUrl: (base, relative) => new URL(String(relative), String(base)).toString(),
  parseHtml: htmlTree,
  preserveIntegers: value => value,
  fetchText: request => rpc('fetch', normalizeRequest(request), 45000),
  fetch: request => rpc('fetch', normalizeRequest(request), 45000),
  fetchPlaylist: request => rpc('playlist', normalizeRequest(request), 45000),
  prepareWebMedia: (media, ...rest) => normalizeMedia(media, rest),
  finishMedia: (media, ...rest) => normalizeMedia(media, rest),
  cacheGet,
  cacheSet,
  // 安卓宿主对未保存的状态返回空串（模块会按 raw === "" 判定未登录）
  loadState: name => {
    const stored = rpc('state-load', { name: String(name) }, 15000);
    return stored == null ? '' : String(stored);
  },
  saveState: (name, value) => rpc('state-save', { name: String(name), value: value == null ? null : String(value) }, 15000),
  preferredSite: () => '',
  catalogContext: () => ({ more: false, background: false, page: 1 }),
  isKnown: () => false,
  reportProgress: () => null,
  log: () => null,
  sleep: ms => {
    const wait = Math.max(0, Math.min(30000, Number(ms) || 0));
    if (wait > 0) Atomics.wait(sleepCell, 0, 0, wait);
  },
  exclusive: task => (typeof task === 'function' ? task() : null),
  reserve: () => ++reserveTicket,
  retries: () => 1,
  maxPages: () => 100,
});

function normalizeRequest(request) {
  const input = typeof request === 'string' ? { url: request } : (request || {});
  return {
    url: String(input.url || ''), method: String(input.method || 'GET').toUpperCase(),
    headers: input.headers && typeof input.headers === 'object' ? input.headers : null,
    body: typeof input.body === 'string' ? input.body : (input.body == null ? null : String(input.body)),
    referer: input.referer ? String(input.referer) : '', userAgent: input.userAgent ? String(input.userAgent) : '',
    limit: Number(input.limit) > 0 ? Number(input.limit) : 0,
    timeoutMs: Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : 0,
    anyStatus: input.anyStatus === true, credentials: input.credentials || null,
    // 脚本声明可自行处理的状态码（如 401/403 后刷新访客授权），不是错误。
    acceptStatus: Array.isArray(input.acceptStatus)
      ? input.acceptStatus.map(Number).filter(value => Number.isInteger(value) && value >= 100 && value <= 599).slice(0, 8)
      : null,
  };
}

// 对齐安卓 prepareMedia：只保留播放器需要的字段，其它键丢弃
function normalizeMedia(media) {
  const input = media || {};
  const raw = String(input.url || '');
  const path = (() => { try { return new URL(raw).pathname.toLowerCase(); } catch { return ''; } })();
  let format = String(input.format || '');
  if (format !== 'hls' && format !== 'mp4') format = path.endsWith('.m3u8') ? 'hls' : 'mp4';
  const output = { url: raw, format };
  for (const key of ['referer', 'userAgent', 'credentials', 'variants', 'playlist', 'durationMs', 'quality', 'width', 'height', 'mediaAuth']) {
    if (input[key] !== undefined) output[key] = input[key];
  }
  return output;
}

// ---------- 载入脚本 ----------
function loadModule() {
  const code = fs.readFileSync(moduleFile, 'utf8');
  const sandbox = {
    module: { exports: {} }, exports: {}, host,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    URL, URLSearchParams, TextDecoder, TextEncoder,
    setTimeout: (task) => { if (typeof task === 'function') task(); return 0; },
    clearTimeout: () => {},
  };
  sandbox.exports = sandbox.module.exports;
  sandbox.globalThis = sandbox;
  const context = require('node:vm').createContext(sandbox);
  new (require('node:vm').Script)(`'use strict';\n${code}`, { filename: moduleFile }).runInContext(context, { timeout: 20000 });
  const api = sandbox.module.exports;
  if (!api || typeof api !== 'object') throw new Error('来源脚本未导出任何能力');
  return api;
}

let api = null;
try {
  api = loadModule();
  parentPort.postMessage({ type: 'ready', methods: Object.keys(api) });
} catch (error) {
  parentPort.postMessage({ type: 'fatal', error: error.message || '来源脚本加载失败' });
}

parentPort.on('message', message => {
  if (!message || message.type !== 'call') return;
  const { id, method, args } = message;
  try {
    if (!api) throw new Error('来源脚本加载失败');
    const fn = api[method];
    if (typeof fn !== 'function') throw new Error('来源不支持该操作');
    const value = fn.apply(api, Array.isArray(args) ? args : []);
    parentPort.postMessage({ type: 'result', id, ok: true, value: value === undefined ? null : value });
  } catch (error) {
    parentPort.postMessage({ type: 'result', id, ok: false, error: (error && error.message) || '来源操作失败' });
  }
});
