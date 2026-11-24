// 黄果剧场独立源回归：五大排行榜标签、榜单页解析、搜索、分集与 HLS variant 选择。
// 全部用 SSR HTML fixture，不发起真实网络请求。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const file = path.resolve(root, 'vendor/source-modules/huangguo-theater/main.js');
const code = fs.readFileSync(file, 'utf8');

const SITE = 'https://huangguoai.fit';
const FALLBACK = 'https://huangguo.video';

function rankingHtml(items) {
  return '<!doctype html><html><head><title>热播排行榜 - 黄果剧场</title></head><body><ol>' +
    items.map((item, index) => `
      <li><span class="rank">${String(index + 1).padStart(2, '0')}</span>
        <a href="/${item.kind || 'series'}/${item.code}">
          ${item.img === false ? '' : `<img alt="${item.title}" src="/uploads/lib/series/${item.cover || 102}/cover.webp?v=1">`}
          <span>${item.remark || '更新至第15集'}</span>
          <p class="font-display">${item.title}</p>
        </a>
        <p class="meta">${item.metric || '4.8K 次下载'}</p>
      </li>`).join('') +
    '</ol></body></html>';
}

function cardsHtml(items) {
  return '<html><body>' + items.map((item) => `
    <article class="video-card group">
      <a href="/${item.kind || 'series'}/${item.code}">
        <img alt="${item.title}" src="/uploads/lib/series/88/cover.webp?v=2">
        <p class="font-display">${item.title}</p>
      </a>
      <span class="bg-black/55">更新至第6集</span>
    </article>`).join('') + '</body></html>';
}

const SERIES_HTML = `<!doctype html><html><head>
  <title>示例连续剧 · 黄果剧场</title>
  <meta name="description" content="这是一段剧情简介。">
  <meta property="og:image" content="/uploads/lib/series/102/cover.webp?v=3">
</head><body>
  <h1>示例连续剧</h1>
  <a class="btn-primary" href="/video/start0001">开始观看</a>
  <section><div data-episode-list data-order="desc">
    <a class="series-ep-chip focus-ring" href="/video/ep003" title="第3集 · 10:00" aria-label="第3集 · 10:00"><span class="series-ep-chip-text">3</span></a>
    <a class="series-ep-chip focus-ring" href="/video/ep002" title="第2集 · 9:00"><span class="series-ep-chip-text">2</span></a>
    <a class="series-ep-chip focus-ring" href="/video/ep001" title="第1集 · 8:00"><span class="series-ep-chip-text">1</span></a>
  </div></section>
</body></html>`;

const MASTER_URL = 'https://cdn.huangguo.video/hls/abc/master.m3u8?n=123';

function videoHtml(masterUrl) {
  return `<!doctype html><html><body>
  <h1>示例连续剧 · 第1集</h1>
  <div data-poster="/uploads/lib/series/102/cover.webp?v=3"
       data-hls="${masterUrl}"></div>
</body></html>`;
}

const VIDEO_HTML = videoHtml(MASTER_URL);

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480
480p.m3u8?n=123
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720p.m3u8?n=123
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080p.m3u8?n=123
`;

const MASTER_PLAIN = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480
480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080p.m3u8
`;

const CF_PAGE = '<html><head><title>Attention Required! | Cloudflare</title></head><body>you have been blocked</body></html>';

function loadModule(scenario = {}) {
  const calls = [];
  const boards = {
    '/ranking': rankingHtml([
      { code: 'bkbwwy8l', title: '榜单剧甲', metric: '4.8K 次下载', remark: '更新至第15集' },
      { code: 'nj4pvviu', title: '榜单剧乙', metric: '136 次下载', remark: '更新至第6集' },
      { code: 'wsdzh4nx', title: '榜单剧丙', metric: '16 次下载', remark: '会员更新至第1集' },
    ]),
    '/ranking/good': rankingHtml([{ code: 'sm2og5x6', title: '好评剧甲', metric: '好评 100% · 51 票', remark: '更新至第2集' }]),
    '/ranking/rising': rankingHtml([{ code: 'i25pv0wp', title: '飙升剧甲', metric: '热度 ×137', remark: '更新至第2集' }]),
    '/ranking/download': rankingHtml([{ code: 'd0o6ejhz0', kind: 'video', title: '下载单集甲', metric: '60 人下载', remark: '会员12:59' }]),
    '/ranking/new': rankingHtml([{ code: 'vtewlgyr', title: '新剧甲', metric: '5 天前上架', remark: '更新至第2集' }]),
  };
  const host = {
    source: 'huangguo-theater',
    dramaId: (v) => 'huangguo-theater:' + v,
    chapterId: (d, c) => 'huangguo-theater:' + d + ':' + c,
    fetchText(req) {
      calls.push({ method: req.method, url: req.url, headers: req.headers || {}, credentials: req.credentials });
      const url = new URL(req.url);
      if (/\.m3u8/.test(url.pathname)) return { body: scenario.plainMaster ? MASTER_PLAIN : MASTER, status: 200, url: req.url };
      if (scenario.blockPrimary && url.origin === SITE) return { body: CF_PAGE, status: 403, url: req.url };
      if (scenario.blockAll) return { body: CF_PAGE, status: 403, url: req.url };
      if (url.pathname.startsWith('/search')) return { body: cardsHtml([{ code: 'srch0001', title: '搜索结果甲' }]), status: 200, url: req.url };
      if (boards[url.pathname]) return { body: boards[url.pathname], status: 200, url: req.url };
      if (/^\/series\//.test(url.pathname)) return { body: SERIES_HTML, status: 200, url: req.url };
      if (/^\/video\//.test(url.pathname)) return { body: scenario.masterUrl ? videoHtml(scenario.masterUrl) : VIDEO_HTML, status: 200, url: req.url };
      throw new Error('来源返回 404');
    },
    finishMedia: (m) => m,
    cacheGet: () => null,
    cacheSet: () => {},
  };
  const sandbox = {
    module: { exports: {} }, exports: {}, host, console, URL, Buffer, Uint8Array,
    TextEncoder, TextDecoder, Set, Map, JSON, Math, Date, RegExp, Array, Object,
    String, Number, Boolean, Error, isNaN, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, process,
  };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file });
  return { api: sandbox.module.exports, calls };
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
}

check('发现页标签为官网五个排行榜，热播榜默认置顶', () => {
  const { api } = loadModule();
  const list = api.categories();
  assert.deepEqual(Array.from(list, (entry) => entry.name), ['热播榜', '好评榜', '飙升榜', '下载榜', '新剧榜']);
  assert.equal(api.validCategory('rank-new'), true);
  assert.equal(api.validCategory('ai-duanju'), false);
});

check('五个标签各自请求官网对应排行榜路径', () => {
  const { api, calls } = loadModule();
  for (const id of ['rank-hot', 'rank-good', 'rank-rising', 'rank-download', 'rank-new']) {
    const result = api.catalogPage(1, id);
    assert.ok(result.items.length > 0, id + ' 应有数据');
    assert.equal(result.hasMore, false, '榜单固定一页');
  }
  const paths = calls.filter((call) => call.url.startsWith(SITE)).map((call) => new URL(call.url).pathname);
  assert.deepEqual(paths, ['/ranking', '/ranking/good', '/ranking/rising', '/ranking/download', '/ranking/new']);
});

check('榜单页解析出标题、封面、集数、指标与名次', () => {
  const { api } = loadModule();
  const items = api.catalogPage(1, 'rank-hot').items;
  assert.equal(items.length, 3);
  assert.equal(items[0].title, '榜单剧甲');
  assert.equal(items[0].sourceId, 'series:bkbwwy8l');
  assert.equal(items[0].cover, SITE + '/uploads/lib/series/102/cover.webp?v=1');
  assert.equal(items[0].totalEpisode, '15');
  assert.equal(items[0].remark, '4.8K 次下载');
  assert.equal(items[0].rank, 1);
  assert.equal(items[2].title, '榜单剧丙');
});

check('下载榜的单集条目保留 video: 前缀', () => {
  const { api } = loadModule();
  const items = api.catalogPage(1, 'rank-download').items;
  assert.equal(items[0].sourceId, 'video:d0o6ejhz0');
  assert.equal(items[0].remark, '60 人下载');
});

check('无封面图的懒加载条目仍能从锚文本取到标题', () => {
  const { api } = loadModule();
  // 直接构造一个只有锚文本、没有 img 的页面，通过宿主注入
  const calls = [];
  const host = {
    source: 'huangguo-theater', dramaId: (v) => 'huangguo-theater:' + v,
    chapterId: (d, c) => 'huangguo-theater:' + d + ':' + c, finishMedia: (m) => m,
    cacheGet: () => null, cacheSet: () => {},
    fetchText() {
      return { body: '<ol><li><a href="/series/lazy0001"><span>更新至第2集</span><p class="font-display">懒加载剧</p></a><p>好评 100% · 51 票</p></li></ol>', status: 200 };
    },
  };
  const sandbox = { module: { exports: {} }, exports: {}, host, console, URL, Buffer, Uint8Array, TextEncoder, TextDecoder, Set, Map, JSON, Math, Date, RegExp, Array, Object, String, Number, Boolean, Error, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, process };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file });
  const items = sandbox.module.exports.catalogPage(1, 'rank-good').items;
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '懒加载剧');
  assert.equal(items[0].cover, '');
});

check('搜索走 /search?q= 并解析卡片', () => {
  const { api, calls } = loadModule();
  const result = api.search(1, '示例 关键词');
  assert.ok(calls.some((call) => new URL(call.url).pathname === '/search' && new URL(call.url).searchParams.get('q') === '示例 关键词'));
  assert.equal(result.items[0].title, '搜索结果甲');
});

check('详情页分集按集号正序，pageUrl 指向 /video/', () => {
  const { api, calls } = loadModule();
  const result = api.detail('series:bkbwwy8l');
  assert.ok(calls.some((call) => call.url.endsWith('/series/bkbwwy8l')));
  assert.equal(result.drama.title, '示例连续剧');
  assert.equal(result.drama.cover, SITE + '/uploads/lib/series/102/cover.webp?v=3');
  assert.equal(result.drama.intro, '这是一段剧情简介。');
  assert.equal(result.chapters.length, 3, '区块外的「开始观看」不能算作分集');
  assert.deepEqual(Array.from(result.chapters, (chapter) => chapter.title), ['第1集', '第2集', '第3集']);
  assert.deepEqual(Array.from(result.chapters, (chapter) => chapter.currentEpisode), [1, 2, 3]);
  assert.equal(result.chapters[0].pageUrl, SITE + '/video/ep001');
});

check('取流解析 data-hls 并挑最高清晰度 variant', () => {
  const { api, calls } = loadModule();
  const media = api.resolveMedia({ dramaId: 'huangguo-theater:series:bkbwwy8l', chapter: { id: 'huangguo-theater:series:bkbwwy8l:v-ep001', pageUrl: SITE + '/video/ep001' }, index: 1 });
  assert.ok(calls.some((call) => call.url.endsWith('/video/ep001')));
  assert.equal(media.url, 'https://cdn.huangguo.video/hls/abc/1080p.m3u8?n=123');
  assert.equal(media.format, 'hls');
  assert.equal(media.referer, SITE + '/');
  assert.equal(media.credentials.cookie, 'hg_age=1');
});

check('年龄确认凭证通过 credentials 声明，不自塞 Cookie 头', () => {
  const { api, calls } = loadModule();
  api.catalogPage(1, 'rank-hot');
  const request = calls[0];
  assert.equal(request.headers.Cookie, undefined);
  assert.equal(request.credentials.cookie, 'hg_age=1');
  assert.equal(request.credentials.origin, SITE);
});

check('主域被盾时回退到备用域名', () => {
  const { api, calls } = loadModule({ blockPrimary: true });
  const result = api.catalogPage(1, 'rank-hot');
  assert.ok(calls.some((call) => call.url.startsWith(SITE)), '先试主域');
  assert.ok(calls.some((call) => call.url.startsWith(FALLBACK)), '再试备用域');
  assert.ok(result.items.length > 0);
});

check('master 不带查询串时 variant 仍解析为同级路径', () => {
  const { api } = loadModule({ plainMaster: true, masterUrl: 'https://cdn.huangguo.video/hls/abc/master.m3u8' });
  const media = api.resolveMedia({ dramaId: 'huangguo-theater:series:bkbwwy8l', chapter: { id: 'huangguo-theater:series:bkbwwy8l:v-ep001', pageUrl: SITE + '/video/ep001' }, index: 1 });
  assert.equal(media.url, 'https://cdn.huangguo.video/hls/abc/1080p.m3u8');
});

check('全部线路被盾时抛出明确错误，不产出脏数据', () => {
  const { api } = loadModule({ blockAll: true });
  assert.throws(() => api.catalogPage(1, 'rank-hot'), /盾页|获取失败/);
});

check('index.json 中本源的 sha256 与文件一致', () => {
  const index = JSON.parse(fs.readFileSync(path.resolve(root, 'vendor/source-modules/index.json'), 'utf8'));
  const entry = (index.modules || []).find((item) => item.id === 'huangguo-theater');
  assert.ok(entry, 'index.json 应注册 huangguo-theater');
  for (const name of ['manifest.json', 'main.js']) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.resolve(root, 'vendor/source-modules/huangguo-theater', name))).digest('hex');
    assert.equal(entry.sha256[name], digest, name + ' 的 sha256 应与文件一致');
  }
});

if (failures > 0) {
  console.error('\n' + failures + ' 项失败');
  process.exit(1);
}
console.log('\n黄果剧场独立源全部检查通过');
