// 回归：SMB 网络盘上 FFmpeg 刚写完的 MP4 首次 ffprobe 探测可能读到空轨道，
// verifyDownloadQuality 必须对非空文件做退避重试，而不是直接判定文件损坏。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const harness = fs.readFileSync(path.join(__dirname, 'check-download-quality-integration.cjs'), 'utf8').split('const payload =')[0];
const moduleStub = { exports: {} };
vm.runInNewContext(harness + '\nmodule.exports = { fixture };', { module: moduleStub, require, __dirname, console, process, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout });
const { fixture } = moduleStub.exports;

(async () => {
  const h = fixture();
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  h.run(source.slice(source.indexOf('async function verifyDownloadQuality('), source.indexOf('async function publishDownloadFile(')));
  h.run('resolveFfmpeg = () => "/fixture/ffprobe"');
  h.run('verifyDownloadDecode = async () => {}');

  const file = path.join(h.root, 'remote.mp4');
  fs.writeFileSync(file, Buffer.alloc(4096, 7)); // 非空文件（模拟已落盘但探测竞态）

  // 前 2 次返回 null（空轨道竞态），第 3 次返回有效信息
  h.context.file = file;
  h.context.probeSequence = [null, null, { w: 1920, h: 1080, duration: 12, codec: 'h264' }];
  h.run('probeVideoInfo = async () => probeSequence.shift()');
  h.context.probeCalls = 0;
  h.run('const _origProbe = probeVideoInfo; probeVideoInfo = async (...a) => { probeCalls++; return _origProbe(...a); }');

  const result = await h.run('verifyDownloadQuality(file, "auto", false, false, null, 0)');
  assert.equal(result, '1080p');
  assert.equal(h.run('probeCalls'), 3, '应在第 3 次探测成功');
  console.log('PASS 竞态空轨道：退避重试 3 次后通过，未误判损坏');

  // 始终无效：重试耗尽后仍按损坏处理
  const h2 = fixture();
  h2.run(source.slice(source.indexOf('async function verifyDownloadQuality('), source.indexOf('async function publishDownloadFile(')));
  h2.run('resolveFfmpeg = () => "/fixture/ffprobe"; verifyDownloadDecode = async () => {}');
  h2.run('probeVideoInfo = async () => null');
  h2.context.file = file;
  h2.context.probeCalls2 = 0;
  h2.run('const _p2 = probeVideoInfo; probeVideoInfo = async (...a) => { probeCalls2++; return _p2(...a); }');
  await assert.rejects(h2.run('verifyDownloadQuality(file, "auto", false, false, null, 0)'), /缺少有效视频轨|分辨率|时长/);
  assert.equal(h2.run('probeCalls2'), 4, '非空损坏文件应重试 4 次后判失败');
  console.log('PASS 真实损坏：重试耗尽后仍判失败');

  // 空文件：不重试，直接失败
  const empty = path.join(h.root, 'empty.mp4');
  fs.writeFileSync(empty, Buffer.alloc(0));
  const h3 = fixture();
  h3.run(source.slice(source.indexOf('async function verifyDownloadQuality('), source.indexOf('async function publishDownloadFile(')));
  h3.run('resolveFfmpeg = () => "/fixture/ffprobe"; verifyDownloadDecode = async () => {}');
  h3.context.probeCount = 0;
  h3.run('probeVideoInfo = async () => { probeCount++; return null; }');
  h3.context.file = empty;
  await assert.rejects(h3.run('verifyDownloadQuality(file, "auto", false, false, null, 0)'), /缺少有效视频轨|分辨率|时长/);
  assert.equal(h3.run('probeCount'), 1, '空文件无需重试');
  console.log('PASS 空文件：仅探测一次直接失败');

  for (const dir of []) void dir;
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
