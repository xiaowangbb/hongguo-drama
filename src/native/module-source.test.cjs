const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../store');
const sources = require('./module-source');
const { getMediaSources } = require('./media-sources');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-module-source-'));
store.init(path.join(directory, 'settings.json'));

test('series and episode ids round-trip through opaque source payloads', () => {
  const raw = 'https://guipianwu.com/play/5432-0-0.html';
  const seriesId = sources.encodeSeries('guipian', raw);
  assert.equal(seriesId, `module:guipian:b${Buffer.from(raw).toString('base64url')}`);
  assert.deepEqual(sources.parseSeries(seriesId), { sourceId: 'guipian', raw, seriesId });
  // 短且安全的原始 id 直接使用，便于阅读与排障
  assert.equal(sources.encodeSeries('guipian', '5432'), 'module:guipian:5432');
  assert.equal(sources.parseSeries('module:guipian:5432').raw, '5432');
  // 含冒号的原始 id 必须能完整还原
  const nested = sources.encodeSeries('guipian', 'a:b:c');
  assert.equal(sources.parseSeries(nested).raw, 'a:b:c');
  for (const value of ['', 'guipian:5432', 'module:', 'module:guipian', 'custom:a:b']) {
    assert.throws(() => sources.parseSeries(value), /来源剧集编号无效/);
  }
});

test('source keys are recognised only for module-prefixed ids', () => {
  assert.equal(sources.sourceKeyOf('module:guipian:b123'), 'guipian');
  assert.equal(sources.sourceKeyOf('module:sorani'), 'sorani');
  assert.equal(sources.isModuleSource('module:guipian:5432'), true);
  for (const value of ['guipian', 'custom:a', 'xifan:huabo:a', 'module', '', null]) {
    assert.equal(sources.sourceKeyOf(value), '');
    assert.equal(sources.isModuleSource(value), false);
  }
});

test('scripted sources stay closed until the setting is ticked, then join the homepage list', () => {
  const all = sources.listSources();
  assert.ok(all.length > 0, '随包的来源脚本必须能被枚举');
  assert.ok(all.every(source => source.id !== 'hongguo'), '红果由内建来源提供，不参与脚本来源');
  const target = all.find(source => !source.adult) || all[0];
  assert.equal(sources.isEnabled(target.id), false, '默认全部关闭');
  assert.deepEqual(getMediaSources(store.getSettings()).map(source => source.id).filter(id => id.startsWith('module:')), []);
  assert.throws(() => sources.assertEnabled(`module:${target.id}`), /此来源已关闭/);

  sources.setEnabled(target.id, true);
  assert.equal(sources.isEnabled(`module:${target.id}`), true);
  const homepage = getMediaSources(store.getSettings());
  assert.deepEqual(homepage.filter(source => source.id.startsWith('module:')).map(source => source.id), [`module:${target.id}`]);
  assert.equal(homepage.find(source => source.id === `module:${target.id}`).label, target.label);
  assert.doesNotThrow(() => sources.assertEnabled(`module:${target.id}`));

  sources.setEnabled(target.id, false);
  assert.equal(sources.isEnabled(target.id), false);
  assert.deepEqual(getMediaSources(store.getSettings()).filter(source => source.id.startsWith('module:')), []);
  assert.throws(() => sources.assertEnabled(target.id), /此来源已关闭/);
  assert.throws(() => sources.setEnabled('not-a-source', true), /来源不存在/);
  assert.throws(() => sources.setEnabled(target.id, 'true'), /开关无效/);
});

test('adult sources are flagged so the settings page can separate them', () => {
  const adult = sources.listSources().filter(source => source.adult);
  for (const source of adult) {
    assert.equal(typeof source.label, 'string');
    assert.ok(source.label.length > 0);
    assert.deepEqual(getMediaSources({ module_sources: { [source.id]: true } })
      .filter(item => item.id === `module:${source.id}`).map(item => item.adult), [true]);
  }
});

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
