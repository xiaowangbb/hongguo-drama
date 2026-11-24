// 模块宿主媒体凭证注入回归：CloudFront 签名 cookie 必须同源注入、跨域不注入。
// 剧果/青空等来源的 m3u8 靠签名 cookie 授权，凭证不在 URL 里；此前 performPlaylist
// 只透传 credentials 却从未把它变成 Cookie header，导致取清单 HTTP 403。
const assert = require('node:assert/strict');
const path = require('node:path');
const { applyCredentialCookie } = require(path.resolve(__dirname, '../src/native/module-host.js'));

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
}

const CF = 'CloudFront-Policy=abc; CloudFront-Signature=def; CloudFront-Key-Pair-Id=Kid123';

check('同源 m3u8 注入签名 cookie', () => {
  const headers = applyCredentialCookie({ Referer: 'https://huangju.net/' },
    'https://video.huangju.net/hls/x/index.m3u8',
    { cookie: CF, origin: 'https://video.huangju.net' });
  assert.equal(headers.Cookie, CF);
  assert.equal(headers.Referer, 'https://huangju.net/');
});

check('跨域地址不注入 cookie（防止凭证泄露给第三方）', () => {
  const headers = applyCredentialCookie({},
    'https://cdn.attacker.example/steal.m3u8',
    { cookie: CF, origin: 'https://video.huangju.net' });
  assert.equal(headers.Cookie, undefined);
});

check('无 origin 声明时同源放行（兼容旧来源）', () => {
  const headers = applyCredentialCookie({},
    'https://any.example/play.m3u8', { cookie: CF });
  assert.equal(headers.Cookie, CF);
});

check('无 cookie 凭证时不改动请求头', () => {
  const base = { Referer: 'https://huangju.net/' };
  const headers = applyCredentialCookie(base, 'https://video.huangju.net/a.m3u8', { origin: 'https://video.huangju.net' });
  assert.deepEqual(headers, base);
  assert.equal(headers.Cookie, undefined);
});

check('端口/协议不同的同源判定', () => {
  const same = applyCredentialCookie({}, 'https://video.huangju.net:443/a.m3u8',
    { cookie: CF, origin: 'https://video.huangju.net' });
  assert.equal(same.Cookie, CF, '默认 443 端口应与无端口 origin 视为同源');
  const diffPort = applyCredentialCookie({}, 'https://video.huangju.net:8443/a.m3u8',
    { cookie: CF, origin: 'https://video.huangju.net' });
  assert.equal(diffPort.Cookie, undefined, '不同端口不得注入');
});

check('origin 带尾斜杠仍能匹配', () => {
  const headers = applyCredentialCookie({}, 'https://video.huangju.net/a.m3u8',
    { cookie: CF, origin: 'https://video.huangju.net/' });
  assert.equal(headers.Cookie, CF);
});

if (failures) { console.error(failures + ' check(s) failed'); process.exit(1); }
console.log('module credentials checks passed');
