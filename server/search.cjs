const { searchApp } = require('../src/native/hongguo-app-search');
const { searchHongguo } = require('../src/native/hongguo-search');
const moduleSource = require('../src/native/module-source');
const cursors = new Map();

/**
 * 搜索入口。
 *
 * source 为空时走红果官方（App 线路优先，回落 Web）。
 * source 为 module:<源> 时走对应第三方来源脚本，source 为 dramabox: / reelshort: 等
 * 内置外部来源时同样按前缀分流——底层 src/native/hongguo.js 已统一处理这些前缀。
 */
async function search(keyword, options) {
  const source = String(options.source || '').trim();
  if (source) return searchSource(keyword, source, options);
  const key = `${keyword}:${options.page}`, cached = cursors.get(key);
  try {
    const result = await searchApp(keyword, { ...options, cursor: cached?.expires > Date.now() ? cached.cursor : null });
    if (result.hasMore) cursors.set(`${keyword}:${options.page + 1}`, { cursor: result.cursor, expires: Date.now() + 300000 });
    while (cursors.size > 100) cursors.delete(cursors.keys().next().value);
    return result;
  } catch { return searchHongguo(keyword, options); }
}

/** 按来源前缀分流搜索。第三方脚本来源由 module-source 处理。 */
async function searchSource(keyword, source, options) {
  const page = Math.max(1, Math.min(50, Number(options.page) || 1));
  if (source.startsWith('module:')) {
    const id = source.slice('module:'.length);
    const result = await moduleSource.search(keyword, page, { source: id });
    if (result?.success === false) throw new Error(result.error || '来源搜索失败');
    return { ...result, results: (result.results || []).map(item => ({ ...item, source })) };
  }
  // 其余内置外部来源（dramabox / reelshort / hema / xifan / custom）暂不支持关键字搜索，
  // 这里明确报错而不是静默返回红果结果，避免用户以为搜的是该来源。
  throw new Error('该来源暂不支持搜索，请改用红果官方或第三方脚本来源');
}

module.exports = { search };
