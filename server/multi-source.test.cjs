// 多来源支持的回归：第三方来源（module:<源>）在服务端与桌面端对齐。
//
// 改动背景：上游服务端把剧集 ID 写死成红果数字 ID，第三方来源的 module: 标识进不来。
// 底层取源（src/native/hongguo.js）本来就按前缀分流，这里验证服务端这层放行并正确落盘。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createApp } = require('./index.cjs');
const { Storage, seriesId, validSeriesId, readFolderOverrides } = require('./storage.cjs');
const { mediaGuard, guardFor } = require('./media.cjs');

const TOKEN = 'test-only-'.repeat(6);
const MODULE_ID = 'module:huangguo-theater:bc2VyaWVzOndvc3VrOG8x';
const MODULE_VID = `${MODULE_ID}:eyJpIjoxLCJ0Ijoi56ysMembhiIn0`;

test('剧集标识校验放行红果数字 ID 与带前缀的外部来源', () => {
  assert.equal(validSeriesId('7709737637719837721'), true);
  assert.equal(validSeriesId(MODULE_ID), true);
  assert.equal(validSeriesId(MODULE_VID), true);
  assert.equal(validSeriesId('xifan:12345'), true);
  assert.equal(validSeriesId(''), false);
  assert.equal(validSeriesId('not a series id'), false);
  assert.equal(validSeriesId('module:'), false);
  assert.equal(seriesId(MODULE_ID), MODULE_ID);
  assert.throws(() => seriesId('bad id'), /剧集标识无效/);
});

test('来源目录名按来源前缀归类，红果官方留在根目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-folder-'));
  try {
    const store = new Storage(path.join(root, 'data'), path.join(root, 'downloads'));
    assert.equal(store.sourceFolder('7709737637719837721'), '');
    assert.equal(store.sourceFolder(MODULE_ID), '第三方来源');
    assert.equal(store.sourceFolder('dramabox:12'), 'DramaBox');
    assert.equal(store.sourceFolder('reelshort:12'), 'ReelShort');
    assert.equal(store.sourceFolder('hema:12'), '河马短剧');
    assert.equal(store.sourceFolder('xifan:12'), '西饭短剧');
    assert.equal(store.sourceFolder('custom:abc'), '自定义来源');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('来源目录名可以通过配置覆盖', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-folder-override-'));
  try {
    const store = new Storage(path.join(root, 'data'), path.join(root, 'downloads'), {
      folderOverrides: { 'module:huangguo-theater': '黄果剧场', 'module:': '其它脚本源' },
    });
    assert.equal(store.sourceFolder(MODULE_ID), '黄果剧场');
    assert.equal(store.sourceFolder('module:huangguo-video:abc'), '其它脚本源');
    // 覆盖表只影响自己列出的前缀，其它来源仍走默认名。
    assert.equal(store.sourceFolder('dramabox:12'), 'DramaBox');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('覆盖表解析拒绝非法输入', () => {
  assert.deepEqual(readFolderOverrides(''), {});
  assert.deepEqual(readFolderOverrides('not json'), {});
  assert.deepEqual(readFolderOverrides(null), {});
  assert.deepEqual(readFolderOverrides(['a']), {});
  assert.deepEqual(readFolderOverrides({ 'module:x': '名字' }), { 'module:x': '名字' });
  assert.deepEqual(readFolderOverrides({ 'module:x': '' }), {});
});

test('剧集目录按来源分层，且外部来源用哈希后缀避免非法文件名', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-dir-'));
  try {
    const store = new Storage(path.join(root, 'data'), path.join(root, 'downloads'));
    const dir = store.directory({ seriesId: MODULE_ID, seriesTitle: '合租的夏天' });
    assert.equal(path.basename(path.dirname(dir)), '第三方来源');
    assert.equal(path.basename(dir), '合租的夏天_1329fbe11d3b');
    // 目录名里不能出现冒号等非法字符。
    assert.ok(!path.basename(dir).includes(':'));

    const official = store.directory({ seriesId: '7709737637719837721', seriesTitle: '红果剧' });
    assert.equal(path.dirname(official), store.root, '红果官方剧集直接落在下载根目录');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('第三方来源的下载地址不做域名白名单限制，但仍要求 HTTPS 与公网校验', () => {
  assert.throws(() => mediaGuard('https://example.invalid/a.mp4'), /片源不属于允许的 HTTPS CDN/);
  const options = guardFor(MODULE_ID, 'https://cdn.example.invalid/a.mp4');
  assert.ok(options, '第三方来源应给出可用的请求配置');
  assert.throws(() => guardFor(MODULE_ID, 'http://cdn.example.invalid/a.mp4'), /片源地址无效/);
  assert.throws(() => guardFor(MODULE_ID, 'https://user:pw@cdn.example.invalid/a.mp4'), /片源地址无效/);
});

test('服务端接受第三方来源的搜索与剧集请求', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-multi-'));
  const app = createApp({
    token: TOKEN,
    dataRoot: path.join(root, 'data'),
    downloadRoot: path.join(root, 'downloads'),
    autoStart: false,
    search: async () => ({ results: [{ series_id: MODULE_ID, series_title: '合租的夏天', cover: '', total: 4 }] }),
    media: { series: async () => ({ series_id: MODULE_ID, series_title: '合租的夏天', total: 1, episodes: [{ vid: MODULE_VID, vid_index: 1, title: '第1集' }] }) },
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (route, payload) => {
    const response = await fetch(base + route, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const search = await api(`/api/search?q=%E5%90%88%E7%A7%9F&source=module:huangguo-theater`);
  assert.equal(search.status, 200);
  assert.equal(search.body.success, true);
  assert.equal(search.body.results[0].series_id, MODULE_ID);

  const detail = await api(`/api/series/${encodeURIComponent(MODULE_ID)}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.series.series_id, MODULE_ID);
  assert.equal(detail.body.series.episodes[0].vid, MODULE_VID);

  const created = await api('/api/downloads', { seriesId: MODULE_ID, episodeIds: [MODULE_VID], quality: 'auto' });
  assert.equal(created.status, 202, '下载任务受理返回 202');
  assert.equal(created.body.success, true);
  assert.equal(created.body.tasks[0].seriesId, MODULE_ID);
});

test('红果官方来源的行为保持不变', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-official-'));
  const app = createApp({
    token: TOKEN,
    dataRoot: path.join(root, 'data'),
    downloadRoot: path.join(root, 'downloads'),
    autoStart: false,
    search: async () => ({ results: [{ series_id: '7709737637719837721', series_title: '红果剧', cover: '', total: 2 }] }),
    media: { series: async () => ({ series_id: '7709737637719837721', series_title: '红果剧', total: 1, episodes: [{ vid: '456', vid_index: 1, title: '第一集' }] }) },
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (route, payload) => {
    const response = await fetch(base + route, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const search = await api('/api/search?q=%E7%BA%A2%E6%9E%9C');
  assert.equal(search.body.results[0].series_id, '7709737637719837721');
  const created = await api('/api/downloads', { seriesId: '7709737637719837721', episodeIds: ['456'], quality: 'auto' });
  assert.equal(created.status, 202);
  assert.equal(created.body.success, true);
});
