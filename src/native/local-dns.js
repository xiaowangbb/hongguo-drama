/**
 * local-dns.js —— 兼容本机代理 fake-ip 的请求选项。
 *
 * 应用默认用 web-media-guard 校验目标是否为公网地址。当系统 DNS 被本地代理
 * （Clash/Surge 等的 fake-ip 模式）接管时，域名会解析到 198.18.0.0/15 这类
 * 保留网段，校验会把合法站点判成内网地址而拒绝。
 *
 * 这里的做法：只有当解析结果全部落在 fake-ip 网段时才放行，交给本机代理按域名
 * 转发；其余内网地址（10/8、127/8、169.254、fc00:: 等）依旧拒绝。
 */
const dns = require('node:dns');

const FAKE_IPV4 = /^198\.1[89]\./;
const FAKE_IPV6 = /^2001:2:/i;

function isFakeAddress(address) {
  const value = String(address || '');
  return FAKE_IPV4.test(value) || FAKE_IPV6.test(value);
}

function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase();
  if (!value) return true;
  if (!value.includes(':')) {
    if (/^(0|10|127)\./.test(value)) return true;
    if (/^169\.254\./.test(value)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(value)) return true;
    if (/^192\.168\./.test(value)) return true;
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(value)) return true;
    if (/^(22[4-9]|2[3-5]\d)\./.test(value)) return true;
    return false;
  }
  if (value === '::' || value === '::1') return true;
  if (/^f[cd]/.test(value)) return true;
  if (/^fe[89ab]/.test(value)) return true;
  return false;
}

/** 给 axios 用的 fake-ip 兼容选项。 */
function fakeIpRequestOptions(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) {
    throw Object.assign(new Error('片源地址必须指向公网'), { code: 'ERR_WEB_MEDIA_ADDRESS' });
  }
  return {
    maxRedirects: 5,
    lookup(hostname, options, callback) {
      const settings = typeof options === 'number' ? { family: options } : options || {};
      dns.lookup(hostname, { ...settings, all: true }, (error, addresses) => {
        if (error) return callback(error);
        const list = Array.isArray(addresses) ? addresses : [addresses];
        if (!list.length) return callback(new Error('片源域名未解析到地址'));
        const allFake = list.every(item => isFakeAddress(item.address));
        if (!allFake && list.some(item => isPrivateAddress(item.address))) {
          return callback(Object.assign(new Error('片源地址必须指向公网'), { code: 'ERR_WEB_MEDIA_ADDRESS' }));
        }
        if (settings.all) return callback(null, list);
        callback(null, list[0].address, list[0].family);
      });
    },
    beforeRedirect(_options, response) {
      const next = new URL(response.headers.location, url);
      if (!/^https?:$/.test(next.protocol)) throw new Error('片源跳转地址无效');
    },
  };
}

module.exports = { fakeIpRequestOptions, isFakeAddress, isPrivateAddress };
