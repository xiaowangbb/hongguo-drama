// 回归：app 内封面的本地解密协议链路。
// 1) preload 出口把 http(s) cover 递归包装成 hongguo-cover://，且不碰其它字段；
// 2) query 里的原始 URL 可被主进程无损还原；
// 3) CSP / 协议注册 / 协议 handler 均就位。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

// --- 提取 preload 里的包装函数，在隔离环境执行 ---
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const start = preload.indexOf('const COVER_PREFIX');
const end = preload.indexOf('// 保留 ipcRenderer.invoke');
assert.ok(start >= 0 && end > start, 'preload 应包含封面包装函数');
const fns = preload.slice(start, end);
const ctx = vm.createContext({ encodeURIComponent, console });
vm.runInContext(fns, ctx);

const sample = {
  cover: 'https://pic.qnlycc.cn/upload_01/a.jpeg?auth_key=1-2-3&x=y',
  series_title: '测试剧',
  episodes: [{ vid: '1', cover: 'http://example.com/ep.jpg' }, { vid: '2' }],
  videoInfo: { cover: 'https://media.example/p.png' },
  detail: { cover: '' },
  poster: 'https://should.not.be.wrapped/x.jpg', // 非 cover 字段，不应改
};
const wrapped = vm.runInContext('wrapCovers(__SAMPLE__)', Object.assign(ctx, { __SAMPLE__: sample }));
const PREFIX = 'hongguo-cover://c/?url=';
assert.ok(wrapped.cover.startsWith(PREFIX), '顶层 cover 应被包装');
assert.ok(wrapped.episodes[0].cover.startsWith(PREFIX), '嵌套数组里的 cover 应被包装');
assert.equal(wrapped.episodes[1].cover, undefined, '缺失 cover 不新增字段');
assert.ok(wrapped.videoInfo.cover.startsWith(PREFIX), 'videoInfo.cover 应被包装');
assert.equal(wrapped.detail.cover, '', '空 cover 保持原样');
assert.equal(wrapped.poster, 'https://should.not.be.wrapped/x.jpg', '非 cover 字段不受影响');
assert.equal(wrapped.series_title, '测试剧', '普通字段不受影响');

// query 里的 URL 可被主进程还原（URL + searchParams 是 Node 全局，vm 里注入）
const originalUrl = 'https://pic.qnlycc.cn/upload_01/a.jpeg?auth_key=1-2-3&x=y';
const parsed = new URL(wrapped.cover);
assert.equal(parsed.hostname, 'c');
assert.equal(parsed.searchParams.get('url'), originalUrl, 'encodeURIComponent 后应无损还原');
console.log('PASS preload 递归包装 cover，非 cover 字段不动，原始 URL 可无损还原');

// --- 静态检查：CSP 与协议注册 ---
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const csp = (html.match(/content="([^"]*Content-Security-Policy[^"]*)"/) || [])[0] || html;
const meta = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/);
assert.ok(meta && /img-src[^;]*hongguo-cover:/.test(meta[1]), 'CSP img-src 必须放行 hongguo-cover:');
console.log('PASS CSP img-src 已放行 hongguo-cover:');

const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
assert.ok(/const COVER_SCHEME = 'hongguo-cover'/.test(main), '应定义 COVER_SCHEME');
assert.ok(/scheme: COVER_SCHEME/.test(main), '应注册为特权 scheme');
assert.ok(/protocol\.handle\(COVER_SCHEME/.test(main), '应注册 cover 协议 handler');
assert.ok(/registerCoverProtocol\(\);/.test(main), '启动时应调用 registerCoverProtocol');
assert.ok(/fetchDecodedCover\(source\)/.test(main), 'handler 应取回并解密封面');
console.log('PASS 主进程 cover 协议注册、handler、解密调用齐备');

const nas = fs.readFileSync(path.join(root, 'src/native/nas-export.js'), 'utf8');
assert.ok(/async function fetchDecodedCover/.test(nas), '应有 fetchDecodedCover');
assert.ok(/function coverMime/.test(nas), '应有 coverMime');
assert.ok(/module\.exports = \{[^}]*fetchDecodedCover[^}]*coverMime/.test(nas), '两个函数都应导出');
console.log('PASS nas-export 导出 fetchDecodedCover / coverMime');
