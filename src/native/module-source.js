/**
 * module-source.js —— 把随包分发的第三方来源脚本接入应用的来源体系。
 *
 * 脚本（vendor/source-modules/<id>/main.js）来自安卓端，契约是：
 *   categories() / catalogPage(page, category) / search(page, keyword)
 *   detail(seriesId) / resolveMedia({dramaId, chapter, quality})
 * 这里把它翻译成本应用各来源统一使用的：
 *   browseList / search / fetchEpisodeList / fetchPlayUrlSingle
 *
 * 编号规则：
 *   series_id = module:<源>:<剧目原始 id 编码>
 *   vid       = series_id:<分集信息 base64url>
 * 分集信息随 vid 一起携带，重启后从历史记录继续播放不需要重新拉详情。
 */
const store = require('../store');
const host = require('./module-host');

const PREFIX = 'module';
const DETAIL_TTL_MS = 60000;
const cache = new Map();

// ---------- 源清单 ----------
let catalog = null;

function readCatalog() {
  if (catalog) return catalog;
  const fs = require('node:fs');
  const path = require('node:path');
  const root = host.resolveModuleRoot();
  const entries = [];
  if (root) {
    let index = [];
    try { index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8')).modules || []; }
    catch { index = []; }
    for (const entry of index) {
      if (!entry || !entry.id || entry.id === 'hongguo') continue;
      let manifest = {};
      try { manifest = JSON.parse(fs.readFileSync(path.join(root, String(entry.id), 'manifest.json'), 'utf8')); }
      catch { manifest = {}; }
      if (!host.hasModule(entry.id)) continue;
      entries.push({
        id: String(entry.id),
        key: `${PREFIX}:${entry.id}`,
        label: String(manifest.name || entry.name || entry.id),
        adult: manifest.adult === true || entry.adult === true,
        version: String(manifest.version || entry.version || ''),
      });
    }
  }
  catalog = entries;
  return catalog;
}

function listSources() { return readCatalog().map(entry => ({ ...entry })); }

function findSource(id) {
  const key = String(id || '');
  const name = key.startsWith(`${PREFIX}:`) ? key.slice(PREFIX.length + 1) : key;
  return readCatalog().find(entry => entry.id === name) || null;
}

function labelOf(id) {
  const source = findSource(id);
  return source ? source.label : '';
}

// ---------- 开关（默认全部关闭，设置里勾选后主页才出现）----------
function enabledMap() {
  const saved = store.getSettings() || {};
  const map = saved.module_sources;
  return map && typeof map === 'object' ? map : {};
}

function isEnabled(id) {
  const source = findSource(id);
  return !!source && enabledMap()[source.id] === true;
}

function setEnabled(id, enabled) {
  const source = findSource(id);
  if (!source) throw new Error('来源不存在');
  if (typeof enabled !== 'boolean') throw new Error('来源开关无效');
  const saved = store.getSettings() || {};
  const next = { ...(saved.module_sources || {}) };
  if (enabled) next[source.id] = true;
  else delete next[source.id];
  store.saveSettings({ ...saved, module_sources: next });
  if (!enabled) host.disposeSource(source.id);
  return { success: true };
}

function assertEnabled(value) {
  // 既接受 'module:<源>'，也接受裸源名
  const source = findSource(sourceKeyOf(value) || value);
  if (!source) throw new Error('来源不存在');
  if (enabledMap()[source.id] !== true) throw new Error('此来源已关闭，可在设置中重新开启');
  return source;
}

/** 'module:guipian:...' → 'guipian'；其它来源返回 ''。 */
function sourceKeyOf(value) {
  const text = String(value || '');
  if (!text.startsWith(`${PREFIX}:`)) return '';
  return text.slice(PREFIX.length + 1).split(':')[0];
}

function isModuleSource(value) { return !!sourceKeyOf(value); }

// ---------- 编号编解码 ----------
function base64url(text) { return Buffer.from(text, 'utf8').toString('base64url'); }
function fromBase64url(text) {
  try { return Buffer.from(String(text), 'base64url').toString('utf8'); }
  catch { return ''; }
}

function encodePart(raw) {
  const text = String(raw);
  return /^[A-Za-z0-9_-]{1,64}$/.test(text) ? text : `b${base64url(text)}`;
}

function decodePart(part) {
  const text = String(part || '');
  if (text.startsWith('b') && text.length > 1) return fromBase64url(text.slice(1));
  return text;
}

function dramaRaw(drama) {
  if (!drama) return '';
  if (drama.sourceId != null) return String(drama.sourceId);
  const id = String(drama.id || '');
  const cut = id.indexOf(':');
  return cut >= 0 ? id.slice(cut + 1) : id;
}

function encodeSeries(sourceId, raw) { return `${PREFIX}:${sourceId}:${encodePart(raw)}`; }

function parseSeries(seriesId) {
  const parts = String(seriesId || '').split(':');
  if (parts[0] !== PREFIX || parts.length < 3) throw new Error('来源剧集编号无效');
  const sourceId = parts[1];
  const raw = decodePart(parts.slice(2).join(':'));
  if (!raw) throw new Error('来源剧集编号无效');
  return { sourceId, raw, seriesId: encodeSeries(sourceId, raw) };
}

function packChapter(chapter, index) {
  const payload = {
    i: Number(chapter?.index ?? chapter?.currentEpisode ?? chapter?.episode ?? index + 1) || index + 1,
    t: String(chapter?.title || chapter?.name || ''),
    id: String(chapter?.id || ''),
  };
  if (chapter?.pageUrl) payload.u = String(chapter.pageUrl);
  if (chapter?.videoUrl) payload.v = String(chapter.videoUrl);
  return base64url(JSON.stringify(payload));
}

function unpackChapter(seriesId, vid) {
  const text = String(vid || '');
  const prefix = `${seriesId}:`;
  if (!text.startsWith(prefix)) throw new Error('来源分集编号无效');
  let payload;
  try { payload = JSON.parse(fromBase64url(text.slice(prefix.length))); }
  catch { throw new Error('来源分集编号无效'); }
  if (!payload || !payload.id) throw new Error('来源分集编号无效');
  const chapter = { id: String(payload.id), title: String(payload.t || ''), index: Number(payload.i) || 1 };
  if (payload.u) chapter.pageUrl = String(payload.u);
  if (payload.v) chapter.videoUrl = String(payload.v);
  return chapter;
}

// ---------- 归一化 ----------
function plain(value) { return String(value == null ? '' : value).replace(/<[^>]*>/g, '').trim(); }

function httpUrl(value) {
  const text = String(value || '').trim();
  if (!/^https?:\/\//i.test(text)) return '';
  return text;
}

function toSeries(source, drama) {
  const raw = dramaRaw(drama);
  if (!raw) return null;
  const title = plain(drama.title || drama.name);
  if (!title) return null;
  const tags = Array.isArray(drama.tags) ? drama.tags.map(plain).filter(Boolean).slice(0, 4) : [];
  return {
    series_id: encodeSeries(source.id, raw),
    series_title: title,
    cover: httpUrl(drama.cover || drama.coverUrl),
    // 源脚本的 detail 把剧情简介放在 intro/desc；透传为 description，
    // NAS 导出才能写出简介.txt 与 nfo 的 <plot>，不再提示「来源暂未提供剧情简介」。
    description: plain(drama.intro || drama.desc || drama.description),
    episode_count: Number(drama.totalEpisode || drama.episodeCount || drama.total) || 0,
    tags,
    source: `${PREFIX}:${source.id}`,
    url: '',
  };
}

function pageResult(source, list, page, categories, hasMore) {
  const seen = new Set();
  const results = [];
  for (const item of Array.isArray(list) ? list : []) {
    const mapped = toSeries(source, item);
    if (!mapped || seen.has(mapped.series_id)) continue;
    seen.add(mapped.series_id);
    results.push(mapped);
  }
  const more = hasMore === true;
  return {
    success: true, results, page, total: 0, totalPages: 0,
    hasMore: more, nextPage: more ? page + 1 : null,
    genres: categories.map(item => ({ slug: String(item.id), label: plain(item.name) })),
    pageTitle: source.label, sourceUrl: '',
  };
}

function wrapError(source, error) {
  const message = String(error?.message || '来源操作失败');
  if (message.includes(source.label)) return new Error(message);
  return new Error(`${source.label}：${message}`);
}

async function categoriesOf(source, force) {
  const list = await host.call(source.id, 'categories', force ? [true] : []);
  const categories = (Array.isArray(list) ? list : [])
    .map(item => ({ id: String(item?.id ?? ''), name: plain(item?.name) }))
    .filter(item => item.id && item.name);
  if (!categories.length) throw new Error('来源没有返回可用分类');
  return categories;
}

// ---------- 对外接口 ----------
async function browseList(options = {}) {
  let source = null;
  try {
    source = assertEnabled(options.source);
    const page = Math.max(1, Math.min(500, Number.parseInt(options.page, 10) || 1));
    const categories = await categoriesOf(source);
    const wanted = String(options.genre || '');
    const category = categories.find(item => item.id === wanted) || categories[0];
    const result = await host.call(source.id, 'catalogPage', [page, category.id]);
    const items = Array.isArray(result?.items) ? result.items : [];
    // 脚本明确给出 hasMore 时以它为准，否则按本页是否有条目判断
    const more = result?.hasMore === false ? false : items.length > 0;
    return pageResult(source, items, page, categories, more);
  } catch (error) {
    return { success: false, results: [], error: source ? wrapError(source, error).message : String(error.message || error) };
  }
}

async function search(keyword, page = 1, options = {}) {
  let source = null;
  try {
    const text = String(keyword || '').trim();
    if (!text) throw new Error('请输入搜索关键词');
    source = assertEnabled(options.source);
    const pg = Math.max(1, Math.min(50, Number.parseInt(page, 10) || 1));
    const result = await host.call(source.id, 'search', [pg, text]);
    const items = Array.isArray(result?.items) ? result.items : [];
    const more = result?.hasMore === false ? false : items.length > 0;
    return pageResult(source, items, pg, [], more);
  } catch (error) {
    return { success: false, results: [], error: source ? wrapError(source, error).message : String(error.message || error) };
  }
}

async function detailOf(source, raw) {
  const key = `${source.id}:${raw}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const data = await host.call(source.id, 'detail', [raw]);
  const drama = data?.drama || null;
  const chapters = Array.isArray(data?.chapters) ? data.chapters : [];
  if (!chapters.length) throw new Error('该剧没有可用分集');
  const value = { drama, chapters };
  cache.set(key, { value, expires: Date.now() + DETAIL_TTL_MS });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

async function fetchEpisodeList(seriesId, options = {}) {
  const { sourceId, raw, seriesId: canonical } = parseSeries(seriesId);
  const source = assertEnabled(sourceId);
  try {
    if (options.force === true) cache.delete(`${source.id}:${raw}`);
    const { drama, chapters } = await detailOf(source, raw);
    const seriesTitle = plain(drama?.title || drama?.name) || '未命名短剧';
    const cover = httpUrl(drama?.cover || drama?.coverUrl);
    const episodes = chapters.map((chapter, index) => {
      const video = { vid: `${canonical}:${packChapter(chapter, index)}`, vid_index: index + 1,
        title: plain(chapter.title || chapter.name), series_id: canonical, series_title: seriesTitle, cover, locked: false, source: `${PREFIX}:${source.id}` };
      return video;
    });
    episodes.sort((left, right) => left.vid_index - right.vid_index);
    return { series_id: canonical, series_title: seriesTitle, cover,
      description: plain(drama?.intro || drama?.desc || drama?.description),
      total: episodes.length, episodes, source: `${PREFIX}:${source.id}` };
  } catch (error) {
    throw wrapError(source, error);
  }
}

async function fetchPlayUrlSingle(vid, seriesId, options = {}) {
  const { sourceId, raw, seriesId: canonical } = parseSeries(seriesId || vid);
  const source = findSource(sourceId);
  if (!source) return { url: null, spadeA: null, codec: null, error: '来源不存在' };
  try {
    if (enabledMap()[source.id] !== true) throw new Error('此来源已关闭，可在设置中重新开启');
    const chapter = unpackChapter(canonical, vid);
    if (options.force === true) cache.delete(`${source.id}:${raw}`);
    const media = await host.call(source.id, 'resolveMedia', [{ dramaId: `${source.id}:${raw}`, chapter, quality: String(options.quality || '') }]);
    const url = httpUrl(media?.url);
    if (!url) throw new Error('来源未提供有效播放地址');
    const playInfo = { url, spadeA: null, codec: '', source: `${PREFIX}:${source.id}`, vid: String(vid), allowFakeIp: true };
    if (media.referer) playInfo.referer = String(media.referer);
    if (media.userAgent) playInfo.userAgent = String(media.userAgent);
    if (media.format === 'hls' || /\.m3u8(\?|$)/i.test(url)) playInfo.format = 'hls';
    else playInfo.format = 'mp4';
    const extra = media.mediaAuth && typeof media.mediaAuth === 'object' ? media.mediaAuth : null;
    if (extra && extra.header && extra.value) playInfo.headers = { [String(extra.header)]: String(extra.value) };
    // 部分来源（剧果等）用 CloudFront 签名 cookie 授权播放地址，凭证不在 URL 里，
    // 必须随每个请求发回同源；未声明的来源或跨域地址不带，避免把 cookie 送给第三方。
    const credentials = media.credentials && typeof media.credentials === 'object' ? media.credentials : null;
    if (credentials) {
      const cookie = typeof credentials.cookie === 'string' ? credentials.cookie.trim() : '';
      const cookieOrigin = typeof credentials.origin === 'string' ? credentials.origin.replace(/\/+$/, '') : '';
      let sameOrigin = false;
      try { sameOrigin = !cookieOrigin || new URL(url).origin === cookieOrigin; } catch { sameOrigin = false; }
      if (cookie && sameOrigin) playInfo.headers = { ...(playInfo.headers || {}), Cookie: cookie };
    }
    return playInfo;
  } catch (error) {
    return { url: null, spadeA: null, codec: null, source: `${PREFIX}:${source.id}`, error: wrapError(source, error).message };
  }
}

function clearCache() { cache.clear(); }

module.exports = {
  PREFIX, listSources, findSource, labelOf, isEnabled, setEnabled, assertEnabled,
  isModuleSource, sourceKeyOf, parseSeries, encodeSeries,
  browseList, search, fetchEpisodeList, fetchPlayUrlSingle, clearCache,
};
