const assert = require('node:assert/strict');
const { test } = require('node:test');
const order = require('./source-order');

// 默认顺序以 app/sdk 优先：openhongguo 走匿名设备身份，
// 服务端常返回空 body，排首位只会先浪费一轮请求。
test('playback source order drops unknowns, duplicates and appends missing providers', () => {
  assert.deepEqual(order.getSourceOrder(), ['app', 'sdk', 'web', 'openhongguo']);
  assert.deepEqual(order.normalizeSourceOrder(['sdk', 'bad', 'sdk', 'app']), ['sdk', 'app', 'web', 'openhongguo']);
  assert.deepEqual(order.normalizeSourceOrder([]), ['app', 'sdk', 'web', 'openhongguo']);
  assert.deepEqual(order.setSourceOrder(['web', 'sdk']), ['web', 'sdk', 'app', 'openhongguo']);
  assert.deepEqual(order.getSourceOrder(), ['web', 'sdk', 'app', 'openhongguo']);
  order.setSourceOrder(['app', 'sdk', 'web', 'openhongguo']);
});

test('explicit user order is preserved verbatim when complete', () => {
  assert.deepEqual(order.normalizeSourceOrder(['openhongguo', 'sdk', 'app', 'web']), ['openhongguo', 'sdk', 'app', 'web']);
  order.setSourceOrder(['app', 'sdk', 'web', 'openhongguo']);
});