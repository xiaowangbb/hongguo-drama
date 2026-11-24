// 黄果浏览链路回归：上游停用了 /api/edge/request 封包网关（HTTP 503「接口已停用」），
// 榜单/分类/搜索/详情改为直连 GET。验证直连请求路径、返回格式解析与降级顺序。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const file = path.resolve(__dirname, '../vendor/source-modules/huangguo-video/main.js');
const code = fs.readFileSync(file, 'utf8');
const bytesOf = (v) => Buffer.isBuffer(v) ? v : Array.isArray(v) ? Buffer.from(v) : Buffer.from(String(v == null ? '' : v), 'utf8');

const rankPayload = {
  status: 1, msg: '', data: { type: 'hot', items: [
    { video_id: 117, rank: 1, title: '高三爱情故事', cover: 'https://pic.qnlycc.cn/a.jpg', episode_count: 48, metric_label: '热力指数', metric_value: 6560 },
  ] },
};
const catalogPayload = {
  status: 1, msg: '', data: { items: [
    { video_id: 88, title: '神瞳觉醒', cover: 'https://pic.qnlycc.cn/b.jpg', description: '简介', episode_count: 30 },
  ] },
};
const searchPayload = {
  status: 1, msg: '', data: { keyword: '无对', pagination: { page: 1, pages: 1, size: 20, total: 1 }, items: [
    { video_id: 99, title: '无间道之妙瓦底风云', cover: 'https://pic.qnlycc.cn/c.jpg' },
  ] },
};
const detailPayload = {
  status: 1, msg: '', data: {
    video_id: 117, title: '高三爱情故事', cover: 'https://pic.qnlycc.cn/a.jpg',
    description: '剧情简介', episodes: [{ ep_num: 1, title: '第1集' }, { ep_num: 2, title: '第2集' }],
  },
};

function loadModule(scenario = {}) {
  const calls = [];
  const host = {
    source: 'huangguo-video',
    dramaId: (v) => 'huangguo-video:' + v,
    chapterId: (d, c) => 'huangguo-video:' + d + ':' + c,
    fetchText(req) {
      calls.push({ via: 'fetchText', method: req.method, url: req.url });
      const u = new URL(req.url);
      if (u.pathname === '/api/edge/request') throw new Error('来源返回 503');
      if (scenario.directFail) throw new Error('来源返回 500');
      if (u.pathname.startsWith('/api/ranks/')) return { body: JSON.stringify(rankPayload), url: req.url, status: 200 };
      if (u.pathname.startsWith('/api/videos/category/')) return { body: JSON.stringify(catalogPayload), url: req.url, status: 200 };
      if (u.pathname === '/api/search') return { body: JSON.stringify(searchPayload), url: req.url, status: 200 };
      if (/^\/api\/videos\/\d+$/.test(u.pathname)) return { body: JSON.stringify(detailPayload), url: req.url, status: 200 };
      throw new Error('来源返回 404');
    },
    fetch: () => { throw new Error('不应发起 ECDH 握手'); },
    cacheGet: () => null, cacheSet: () => {}, exclusive: (fn) => fn(), finishMedia: (m) => m,
    preferredSite: () => '',
    resolveUrl: (b, r) => new URL(r, b).toString(),
    parseUrl: (raw) => { const u = new URL(raw); return { scheme: u.protocol.replace(':', ' ').trim(), host: u.host, hostname: u.hostname, path: u.pathname, query: u.search.replace(/^\?/, ''), href: raw }; },
    utf8Encode: (v) => Buffer.from(String(v == null ? '' : v), 'utf8'),
    utf8Decode: (b) => bytesOf(b).toString('utf8'),
    base64Encode: (v) => bytesOf(v).toString('base64'),
    base64Decode: (s) => Buffer.from(String(s || ''), 'base64'),
    hexEncode: (b) => bytesOf(b).toString('hex'),
    hexDecode: (s) => Buffer.from(String(s || ''), 'hex'),
    sha256: (b) => crypto.createHash('sha256').update(b).digest(),
    hkdfSha256: (secret, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', secret, salt, info, len)),
  };
  const sandbox = { module: { exports: {} }, exports: {}, host, console, URL, Buffer, Uint8Array, TextEncoder, TextDecoder, Set, Map, JSON, Math, Date, RegExp, Array, Object, String, Number, Boolean, Error, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, process };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file });
  return { api: sandbox.module.exports, calls };
}

let failures = 0;
function check(name, fn) { try { fn(); console.log('PASS ' + name); } catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); } }

check('榜单走直连 GET，不再 POST 封包网关', () => {
  const { api, calls } = loadModule();
  const result = api.rankingPage('huangguo-hot', 1);
  assert.ok(calls.some((c) => c.method === 'GET' && c.url.includes('/api/ranks/hot')), '应直连 GET /api/ranks/hot');
  assert.ok(!calls.some((c) => c.url.includes('/api/edge/request')), '不应再请求已停用的封包网关');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].drama.title, '高三爱情故事');
});

check('分类页走直连 GET', () => {
  const { api, calls } = loadModule();
  const result = api.catalogPage(1, 'ai-duanju');
  assert.ok(calls.some((c) => c.method === 'GET' && c.url.includes('/api/videos/category/ai-duanju')));
  assert.equal(result.items[0].title, '神瞳觉醒');
});

check('搜索走直连 GET，保留分页', () => {
  const { api, calls } = loadModule();
  const result = api.search(1, '无对');
  assert.ok(calls.some((c) => c.method === 'GET' && c.url.includes('/api/search')));
  assert.equal(result.items[0].title, '无间道之妙瓦底风云');
  assert.equal(result.hasMore, false);
});

check('详情走直连 GET，解析分集', () => {
  const { api, calls } = loadModule();
  const result = api.detail('117');
  assert.ok(calls.some((c) => c.method === 'GET' && c.url.includes('/api/videos/117')));
  assert.equal(result.drama.title, '高三爱情故事');
  assert.equal(result.chapters.length, 2);
});

check('直连失败时回退旧封包网关', () => {
  const { api, calls } = loadModule({ directFail: true });
  let error = null;
  try { api.rankingPage('huangguo-hot', 1); } catch (e) { error = e; }
  assert.ok(calls.some((c) => c.url.includes('/api/edge/request')), '应尝试封包网关兜底');
  assert.ok(error, '两路都失败时应抛错');
});

if (failures) { console.error(failures + ' check(s) failed'); process.exit(1); }
console.log('huangguo browse checks passed');
