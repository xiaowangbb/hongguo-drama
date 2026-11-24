// 黄豆视频源回归：验证二进制封包签名（key 必须由 requestId 派生，非 sessionId）、
// 数据解析、预览流隔离。用真实 host 字节 API + mock 加密响应，不依赖外网。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const file = path.resolve(__dirname, '../vendor/source-modules/huangdou-video/main.js');
const code = fs.readFileSync(file, 'utf8');
const PLATFORM_KEY = '7961beb44246e3012ce228d6b5ced05a';

const bytesOf = value => Buffer.isBuffer(value) ? value : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Array.isArray(value) ? Buffer.from(value) : Buffer.from(String(value == null ? '' : value), 'utf8');

// 服务端视角：用请求里的 requestId 派生 key（正确行为），解密 body 校验客户端签名
function serverDecode(reqBodyBase64, headers) {
  const rid = headers.requestId;
  const clean = Buffer.from(rid.replace(/-/g, ''), 'hex');
  const key = crypto.createHmac('sha256', PLATFORM_KEY).update(clean).digest();
  const blob = Buffer.from(reqBodyBase64, 'base64');
  const iv = blob.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let plain = Buffer.concat([decipher.update(blob.subarray(16)), decipher.final()]);
  plain = zlib.gunzipSync(plain);
  return JSON.parse(plain.toString('utf8'));
}

function loadModule(handler) {
  const calls = [];
  const host = {
    source: 'huangdou-video',
    dramaId: v => 'huangdou-video:' + v,
    chapterId: (d, c) => 'huangdou-video:' + d + ':' + c,
    fetch(req) {
      calls.push({ req, decoded: serverDecode(req.body, req.headers) });
      return handler(req, calls);
    },
    finishMedia: m => m,
    resolveUrl: (base, ref) => new URL(ref, base).toString(),
    parseUrl: raw => { const u = new URL(raw); return { host: u.host, hostname: u.hostname, path: u.pathname }; },
    utf8Encode: v => Buffer.from(String(v == null ? '' : v), 'utf8'),
    utf8Decode: b => bytesOf(b).toString('utf8'),
    base64Encode: v => bytesOf(v).toString('base64'),
    base64Decode: s => Buffer.from(String(s || ''), 'base64'),
    hexEncode: b => bytesOf(b).toString('hex'),
    hexDecode: s => Buffer.from(String(s || ''), 'hex'),
    sha256: b => crypto.createHash('sha256').update(bytesOf(b)).digest(),
    hmacSha256: (k, v) => crypto.createHmac('sha256', bytesOf(k)).update(bytesOf(v)).digest(),
    aesCbcEncrypt: (key, iv, data) => { const c = crypto.createCipheriv(`aes-${bytesOf(key).length * 8}-cbc`, bytesOf(key), bytesOf(iv)); c.setAutoPadding(false); return Buffer.concat([c.update(bytesOf(data)), c.final()]); },
    aesCbcDecrypt: (key, iv, data) => { const d = crypto.createDecipheriv(`aes-${bytesOf(key).length * 8}-cbc`, bytesOf(key), bytesOf(iv)); d.setAutoPadding(false); return Buffer.concat([d.update(bytesOf(data)), d.final()]); },
    gzip: v => zlib.gzipSync(bytesOf(v)),
    gunzip: v => zlib.gunzipSync(bytesOf(v)),
    randomBytes: n => crypto.randomBytes(n),
  };
  const sandbox = { module: { exports: {} }, exports: {}, host, console, URL, Uint8Array, Set, Map, JSON, Math, Date, RegExp, Array, Object, String, Number, Boolean, Error, parseInt, encodeURIComponent };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file });
  return { api: sandbox.module.exports, calls };
}

function jsonReply(payload) {
  return { status: 200, body: Buffer.from(JSON.stringify(payload)).toString('base64'), headers: {} };
}

const rankRow = { drama_id: 'rp_abc123', name: '测试短剧', cover: 'https://cdn.test/c.jpg', description: '简介', episode_count: 12, click: 100 };
const detailData = { ...rankRow, episodes: [
  { seq: 1, name: '第1集', type: 'free' },
  { seq: 2, name: '第2集', type: 'vip' },
] };
const m3u8 = 'https://cdn.test/play.m3u8';

function routeHandler(req) {
  const path = new URL(req.url).pathname;
  if (path === '/api/drama/rank') return jsonReply({ status: 'y', data: { list: [rankRow] } });
  if (path === '/api/drama/list') return jsonReply({ status: 'y', data: { list: [rankRow] } });
  if (path === '/api/drama/detail') return jsonReply({ status: 'y', data: detailData });
  if (path === '/api/drama/play') return jsonReply({ status: 'y', data: { m3u8, preview_m3u8: 'https://cdn.test/preview.mp4' } });
  return jsonReply({ status: 'n', error: '未知接口' });
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); }
}

check('签名 key 由 requestId 派生：服务端能用 requestId 解开 body', () => {
  const { api, calls } = loadModule(routeHandler);
  api.catalogPage(1, 'all');
  assert.ok(calls.length >= 1, '应发起请求');
  const decoded = calls[0].decoded;
  assert.equal(decoded.data.tab, 'all');
  assert.equal(decoded.data.page, '1');
  assert.equal(decoded.token, '');
  assert.ok(decoded.deviceId && decoded.deviceId.length === 32, 'deviceId 为 32 位 hex');
});

check('签名头齐全：version/deviceType/requestId/sessionId/time/sign', () => {
  const { api, calls } = loadModule(routeHandler);
  api.catalogPage(1, 'all');
  const h = calls[0].req.headers;
  assert.equal(h.version, '2.0.0');
  assert.equal(h.deviceType, 'web');
  assert.match(h.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(h.sign, /^[0-9a-f]{64}-\d+$/);
  assert.equal(calls[0].req.bodyBase64, true);
  assert.equal(calls[0].req.binaryResponse, true);
});

check('catalogPage 解析榜单为 drama 项', () => {
  const { api } = loadModule(routeHandler);
  const page = api.catalogPage(1, 'all');
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].drama.sourceId, 'abc123');
  assert.equal(page.items[0].drama.title, '测试短剧');
});

check('detail 解析详情与分集，VIP 集标记 locked', () => {
  const { api } = loadModule(routeHandler);
  const { drama, chapters } = api.detail('abc123');
  assert.equal(drama.sourceId, 'abc123');
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].currentEpisode, 1);
  assert.equal(chapters[1].locked, true);
});

check('search 从 list 本地过滤关键词', () => {
  const { api } = loadModule(routeHandler);
  const res = api.search(1, '测试');
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].drama.sourceId, 'abc123');
});

check('resolveMedia 取正片 m3u8，不用 preview 试看', () => {
  const { api, calls } = loadModule(routeHandler);
  const media = api.resolveMedia({ dramaId: 'huangdou-video:abc123', chapter: { currentEpisode: 2 }, index: 2 });
  assert.equal(media.url, m3u8);
  assert.equal(media.format, 'hls');
  const playCall = calls.find(c => new URL(c.req.url).pathname === '/api/drama/play');
  assert.equal(playCall.decoded.data.seq, '2');
});

check('只有 preview 没有正片时报错，不把试看当正片', () => {
  const handler = req => new URL(req.url).pathname === '/api/drama/play'
    ? jsonReply({ status: 'y', data: { preview_m3u8: 'https://cdn.test/preview.mp4' } })
    : routeHandler(req);
  const { api } = loadModule(handler);
  assert.throws(() => api.resolveMedia({ dramaId: 'huangdou-video:abc123', chapter: { currentEpisode: 1 }, index: 1 }), /试看/);
});

check('rankingPage 五个榜单均可解析', () => {
  for (const board of ['huangdou-all', 'huangdou-mogai', 'huangdou-search', 'huangdou-favorite', 'huangdou-finish']) {
    const { api } = loadModule(routeHandler);
    const page = api.rankingPage(board, 1);
    assert.equal(page.items.length, 1);
  }
});

check('多镜像回退：首个域名失败时自动切换', () => {
  let count = 0;
  const handler = req => { count++; if (count === 1) throw new Error('线路故障'); return routeHandler(req); };
  const { api } = loadModule(handler);
  const page = api.catalogPage(1, 'all');
  assert.equal(page.items.length, 1);
  assert.ok(count >= 2, '应重试过第二个镜像');
});

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
