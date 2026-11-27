import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 回归：三处 unref 导致「无网 / 请求立即失败时整体挂死」。
//
// 根因：setTimeout(...).unref() 只保证定时器不阻止进程退出，但当事件循环
// 里没有其它活跃句柄（前几路已快速失败、无 socket 保活）时，unref 的定时器
// 可能永远不被触发 —— 表现为超时机制失效、整个请求永久挂住。
//
// 这三处都是「超时/退避」定时器，必须保持 ref：
//   1. request-signal.js  boundedSignal 的超时定时器（8.5 超时基石）
//   2. hongguo.js         fetchEpisodeListFromWeb 的 hedge 先导等待
//   3. hongguo.js         apiCall 的重试退避等待

const root = new URL('../../native/', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');

/** 取出函数体（从签名开始到配平的右花括号），用于限定检查范围 */
function bodyOf(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `未找到 ${signature}`);
  let depth = 0, i = source.indexOf('{', start);
  const from = i;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return source.slice(from);
}

test('boundedSignal 的超时定时器不得 unref', () => {
  const body = bodyOf(read('request-signal.js'), 'function boundedSignal(');
  assert.match(body, /setTimeout\(/, 'boundedSignal 必须设置超时定时器');
  assert.doesNotMatch(body, /\.unref\s*\?\.\s*\(\s*\)/,
    'boundedSignal 的超时定时器不能 unref：事件循环空闲时它不会触发，请求永不超时');
  assert.match(body, /globalThis\.clearTimeout\?\./,
    'dispose 必须清理定时器，且要兼容不提供 clearTimeout 的测试沙箱');
});

test('分集网页 hedge 的先导等待不得 unref', () => {
  const body = bodyOf(read('hongguo.js'), 'async function fetchEpisodeListFromWeb(');
  const hedge = bodyOf(body, 'const hedge = (async () => {');
  assert.match(hedge, /setTimeout\(/, 'hedge 必须等待先导窗口');
  assert.doesNotMatch(hedge, /hedgeTimer\.unref/,
    'hedge 先导定时器不能 unref：前两路快速失败后它会永不触发，整个分集请求挂死');
});

test('apiCall 的重试退避不得 unref', () => {
  const body = bodyOf(read('hongguo.js'), 'async function apiCall(');
  assert.match(body, /setTimeout\(/, 'apiCall 必须有重试退避');
  // 退避等待里的 unref 会让重试流程永久停在等待点
  const backoff = body.slice(body.indexOf('const wait = 2000'), body.indexOf('const wait = 2000') + 900);
  assert.doesNotMatch(backoff, /timer\.unref/,
    '退避定时器不能 unref：重试流程会永久停住');
});

test('分集兜底路径必须按剩余 deadline 收缩预算', () => {
  const source = read('hongguo.js');
  const start = source.indexOf('return cachedRequest(`episodes:');
  assert.ok(start > 0, '未找到分集缓存入口');
  // 取到该函数的收尾（force 选项那一行）为止，覆盖整个兜底分支
  const end = source.indexOf('{ force: options.force === true });', start);
  assert.ok(end > start, '未找到分集缓存入口的收尾');
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /Date\.now\(\) \+ 5000/,
    '兜底不能固定给 5000ms：调用方给 3 秒 deadline 时会变成 8 秒');
  assert.match(body, /deadline - Date\.now\(\)/,
    '兜底必须按 deadline 剩余时间计算预算');
});

test('合并后的 asarUnpack 只有一组且含本地第三方源规则', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  const raw = fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
  const occurrences = (raw.match(/"asarUnpack"/g) || []).length;
  assert.equal(occurrences, 1, `asarUnpack 只能出现一次（重复键会让后者静默覆盖前者），实际 ${occurrences}`);
  const list = pkg.build.asarUnpack;
  for (const required of ['vendor/source-modules/**/*', 'src/native/module-worker.cjs', 'build/sdk-playback/**/*']) {
    assert.ok(list.includes(required), `asarUnpack 缺少必需项：${required}`);
  }
});