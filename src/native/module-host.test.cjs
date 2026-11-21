const test = require('node:test');
const assert = require('node:assert/strict');
const { responseHeaders } = require('./module-host');

// 剧果这类来源用 CloudFront 签名 cookie 授权播放地址，脚本按单条 Set-Cookie 解析。
// 曾经把多条 cookie join('; ') 成一个值、且只保留下划线键名，导致脚本读不到凭证，
// 表现为「列表和封面正常，一点播放就报未返回完整的媒体凭证」。
test('set-cookie stays one line per cookie under both key spellings', () => {
  const lines = [
    'CloudFront-Policy=abc; Domain=.huangju.net; Path=/; Max-Age=21600; Secure; HttpOnly',
    'CloudFront-Signature=sig; Domain=.huangju.net; Path=/; Max-Age=21600; Secure; HttpOnly',
    'CloudFront-Key-Pair-Id=K123; Domain=.huangju.net; Path=/; Max-Age=21600; Secure; HttpOnly',
  ];
  const headers = responseHeaders({ 'set-cookie': lines, 'content-type': 'application/json; charset=utf-8' });
  assert.deepEqual(headers['set-cookie'], lines);
  assert.deepEqual(headers['Set-Cookie'], lines);
  assert.equal(headers['content-type'], 'application/json; charset=utf-8');
  // 每条 cookie 的 name=value 必须能单独切出来，签名才不会丢
  const names = headers['Set-Cookie'].map(line => line.split('=')[0]);
  assert.deepEqual(names, ['CloudFront-Policy', 'CloudFront-Signature', 'CloudFront-Key-Pair-Id']);
});

test('single set-cookie value is still an array', () => {
  const headers = responseHeaders({ 'Set-Cookie': 'a=1; Path=/' });
  assert.deepEqual(headers['Set-Cookie'], ['a=1; Path=/']);
});

test('headers outside the allow list never reach scripts', () => {
  const headers = responseHeaders({ 'set-cookie': [], authorization: 'Bearer secret', 'x-internal': '1', 'retry-after': '30' });
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['x-internal'], undefined);
  assert.equal(headers['retry-after'], '30');
});
