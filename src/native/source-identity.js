/**
 * source-identity.js —— series_id / vid 的来源归属判定。
 *
 * 红果、西饭、河马、ReelShort、DramaBox 直接以来源名开头；自定义源用 custom:<uuid>；
 * 第三方脚本源用 module:<源>。下载目录归类、缓存键、权限校验都依赖这里的判定。
 */
const EXTERNAL_SOURCE_PREFIX = /^(xifan|hema|reelshort|dramabox|custom|module):/;

const isExternalSourceId = value => EXTERNAL_SOURCE_PREFIX.test(String(value || ''));

/** 取出用于缓存与下载归类的来源标识：custom:<uuid> / module:<源> / 内置源名。 */
function playbackSourceOf(value) {
  const text = String(value || '');
  const custom = /^custom:[^:]+/.exec(text);
  if (custom) return custom[0];
  const scripted = /^module:[^:]+/.exec(text);
  if (scripted) return scripted[0];
  const builtin = /^(xifan|hema|reelshort|dramabox):/.exec(text);
  return builtin ? builtin[1] : 'hongguo';
}

module.exports = { EXTERNAL_SOURCE_PREFIX, isExternalSourceId, playbackSourceOf };
