// 黄果视频源播放链路回归：验证无会话封包取流（fnOS/HGhub 同款）与预览流隔离。
// 用真实宿主字节 API + mock 网络层，避免沙箱缺全局导致假阴性。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const file = path.resolve(__dirname, '../vendor/source-modules/huangguo-video/main.js');
const code = fs.readFileSync(file, 'utf8');
const MAIN = 'https://cdn.example.test/episode/main.m3u8';
const HEVC = 'https://cdn.example.test/episode/hevc.m3u8';
const PREVIEW = 'https://cdn.example.test/episode/preview.m3u8';

const bytesOf = value => Buffer.isBuffer(value) ? value : Array.isArray(value) ? Buffer.from(value) : Buffer.from(String(value == null ? '' : value), 'utf8');

function loadModule(scenario) {
  const calls = [];
  const host = {
    source: 'huangguo-video',
    dramaId: v => 'huangguo-video:' + v,
    chapterId: (d, c) => 'huangguo-video:' + d + ':' + c,
    fetchText(req) {
      const isDirect = !String(req.url).includes('/api/edge/request');
      calls.push({ via: isDirect ? 'direct' : 'edge', method: req.method, body: req.body, url: req.url });
      if (isDirect && scenario.directThrows) throw new Error('来源返回 503');
      if (!isDirect && scenario.simpleThrows) throw new Error('来源返回 403');
      return { body: JSON.stringify(scenario.payload), url: req.url, status: 200, headers: {} };
    },
    fetch(req) {
      calls.push({ via: 'ecdh' });
      return { body: '{}', url: req.url, status: 200, headers: {} };
    },
    cacheGet: () => null,
    cacheSet: () => {},
    exclusive: fn => fn(),
    finishMedia: m => m,
    preferredSite: () => '',
    resolveUrl: (base, ref) => new URL(ref, base).toString(),
    parseUrl: raw => { const u = new URL(raw); return { scheme: u.protocol.replace(':', ' ').trim(), host: u.host, hostname: u.hostname, path: u.pathname, query: u.search.replace(/^\?/, ''), href: raw }; },
    utf8Encode: v => Buffer.from(String(v == null ? '' : v), 'utf8'),
    utf8Decode: b => bytesOf(b).toString('utf8'),
    base64Encode: v => bytesOf(v).toString('base64'),
    base64Decode: s => Buffer.from(String(s || ''), 'base64'),
    hexEncode: b => bytesOf(b).toString('hex'),
    hexDecode: s => Buffer.from(String(s || ''), 'hex'),
    sha256: b => crypto.createHash('sha256').update(b).digest(),
    hkdfSha256: (secret, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', secret, salt, info, len)),
    ecdhP256KeyPair: () => { const k = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); return { privateKey: k.privateKey.export({ format: 'der', type: 'pkcs8' }), publicKey: k.publicKey.export({ format: 'der', type: 'spki' }) }; },
    ecdhP256: () => Buffer.alloc(32, 9),
    aesGcmSeal: (key, nonce, data, aad) => { const c = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 }); c.setAAD(Buffer.from(aad)); return Buffer.concat([c.update(Buffer.from(data)), c.final(), c.getAuthTag()]); },
    aesGcmOpen: (key, nonce, data, aad) => { const tag = data.subarray(data.length - 16), ct = data.subarray(0, data.length - 16); const d = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 }); d.setAAD(Buffer.from(aad)); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]); },
  };
  const sandbox = { module: { exports: {} }, exports: {}, host, console, URL, Buffer, Uint8Array, TextEncoder, TextDecoder, Set, Map, JSON, Math, Date, RegExp, Array, Object, String, Number, Boolean, Error, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, process };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file });
  return { api: sandbox.module.exports, calls };
}

function resolve(scenario) {
  const { api, calls } = loadModule(scenario);
  let result;
  try {
    result = api.resolveMedia({ dramaId: 'huangguo-video:7012', chapter: { id: 'huangguo-video:7012:ep-2', index: 2, title: '漂亮干姐姐2' }, quality: 'auto' });
  } catch (e) { result = { error: e.message }; }
  return { result, calls };
}

const playable = main => ({ status: 1, data: { streams: { main, hevc: '', preview: PREVIEW } } });
let failures = 0;
function check(name, fn) { try { fn(); console.log('PASS ' + name); } catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); } }

check('直连 POST 取 main 正片，不触发 ECDH 握手', () => {
  const { calls } = resolve({ payload: playable(MAIN) });
  assert.equal(calls.filter(c => c.via === 'direct').length, 1);
  assert.equal(calls.some(c => c.via === 'edge'), false, '封包网关已停用，不应走封包');
  assert.equal(calls.some(c => c.via === 'ecdh'), false, '不应发起 ECDH 握手');
  assert.equal(calls[0].method, 'POST', '直连必须是 POST（GET 会落到前端 404 页面）');
});

check('直连 body 为 {} 且请求 playback 路径', () => {
  const { calls } = resolve({ payload: playable(MAIN) });
  assert.equal(calls[0].body, '{}');
  assert.match(calls[0].url, /\/api\/videos\/7012\/episodes\/2\/playback$/);
});

check('main 为空时用 hevc 兜底，且绝不采用 preview 试看流', () => {
  const payload = { status: 1, data: { streams: { main: '', hevc: HEVC, preview: PREVIEW } } };
  const { result } = resolve({ payload });
  assert.equal(result.url, HEVC);
  assert.equal(String(result.url).includes('preview'), false);
});

check('仅 preview 可用时不当正片采用', () => {
  const { result, calls } = resolve({ payload: { status: 1, data: { streams: { main: '', hevc: '', preview: PREVIEW } } } });
  assert.equal(String(result.url || '').includes('preview'), false);
  assert.equal(calls.some(c => c.via === 'direct'), true, '直连应尝试过');
});

check('直连失败时降级到旧封包，body 为 base64 e30=', () => {
  const { calls } = resolve({ directThrows: true, payload: playable(MAIN) });
  assert.equal(calls[0].via, 'direct');
  const edgeCall = calls.find(c => c.via === 'edge');
  assert.ok(edgeCall, '应降级到旧封包通道');
  const req = JSON.parse(edgeCall.body);
  assert.equal(req.method, 'POST');
  assert.equal(req.content_type, 'application/json');
  assert.equal(req.body, 'e30=');
  assert.match(req.path, /\/api\/videos\/7012\/episodes\/2\/playback$/);
  assert.equal(calls.some(c => c.via === 'ecdh'), false);
});

check('直连与封包都失败时才降级到 ECDH 会话路径', () => {
  const { calls } = resolve({ directThrows: true, simpleThrows: true, payload: playable(MAIN) });
  assert.equal(calls.some(c => c.via === 'ecdh'), true, '应降级发起 ECDH 握手');
});

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('huangguo playback checks passed');
