const test = require('node:test');
const assert = require('node:assert/strict');
const { isFakeAddress, isPrivateAddress, fakeIpRequestOptions } = require('./local-dns');
const { isExternalSourceId, playbackSourceOf, EXTERNAL_SOURCE_PREFIX } = require('./source-identity');

test('fake-ip answers are recognised separately from real private ranges', () => {
  for (const address of ['198.18.0.1', '198.18.2.149', '198.19.255.254', '2001:2::134']) assert.equal(isFakeAddress(address), true);
  for (const address of ['10.0.0.1', '198.17.0.1', '198.20.0.1', '1.1.1.1', '2400:3200::1']) assert.equal(isFakeAddress(address), false);
  for (const address of ['10.1.2.3', '127.0.0.1', '169.254.1.1', '172.20.0.1', '192.168.1.1', '100.64.0.1', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '']) assert.equal(isPrivateAddress(address), true);
  for (const address of ['1.1.1.1', '198.18.2.149', '2400:3200::1']) assert.equal(isPrivateAddress(address), false);
});

test('the fake-ip lookup still refuses private destinations other than fake-ip', async () => {
  const lookup = (hostname, host) => new Promise((resolve, reject) => {
    fakeIpRequestOptions(`https://${host}/`).lookup(hostname, {}, (error, address) => error ? reject(error) : resolve(address));
  });
  assert.equal(await lookup('198.18.2.149', '198.18.2.149'), '198.18.2.149');
  assert.equal(await lookup('1.1.1.1', '1.1.1.1'), '1.1.1.1');
  await assert.rejects(lookup('10.0.0.7', '10.0.0.7'), error => error.code === 'ERR_WEB_MEDIA_ADDRESS');
  await assert.rejects(lookup('127.0.0.1', '127.0.0.1'), error => error.code === 'ERR_WEB_MEDIA_ADDRESS');
  for (const value of ['file:///etc/passwd', 'ftp://example.com/a']) assert.throws(() => fakeIpRequestOptions(value));
});

test('source identity separates scripted, custom and built-in ids', () => {
  assert.match(EXTERNAL_SOURCE_PREFIX.source, /module/);
  for (const value of ['xifan:huabo:a', 'hema:1', 'reelshort:2', 'dramabox:3', 'custom:abc', 'module:guipian:5432']) {
    assert.equal(isExternalSourceId(value), true, value);
  }
  for (const value of ['123', 'hongguo', 'guipian:1', '', null, undefined]) assert.equal(isExternalSourceId(value), false);
  assert.equal(playbackSourceOf('module:guipian:5432:abc'), 'module:guipian');
  assert.equal(playbackSourceOf('custom:9f1c:x:1'), 'custom:9f1c');
  assert.equal(playbackSourceOf('xifan:huabo:a:2'), 'xifan');
  assert.equal(playbackSourceOf('dramabox:77:1'), 'dramabox');
  assert.equal(playbackSourceOf('123456'), 'hongguo');
  assert.equal(playbackSourceOf(''), 'hongguo');
});
