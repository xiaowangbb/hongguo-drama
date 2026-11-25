// SPDX-License-Identifier: GPL-3.0-only
'use strict';

// 可用的取源标识（用于校验用户设置，顺序无关）。
const SOURCE_IDS = Object.freeze(['openhongguo', 'sdk', 'app', 'web']);

// 默认取流顺序。
//
// 上游 8.3 把 openhongguo 放在首位，但它走匿名设备身份，在当前网络下
// 服务端会返回空 body（ANONYMOUS_LIMITED），拿不到任何片源；
// 排在首位只会先浪费一轮请求，最后仍要回落到 app/sdk。
// 这里改回 8.2 的有效顺序：app → sdk 优先，openhongguo 作为最后补充。
// 用户仍可在设置里自行调整。
const DEFAULT_SOURCE_ORDER = Object.freeze(['app', 'sdk', 'web', 'openhongguo']);

let activeOrder = [...DEFAULT_SOURCE_ORDER];

function normalizeSourceOrder(input) {
  const requested = Array.isArray(input) ? input.map(String) : [];
  const order = [];
  for (const id of requested) {
    if (SOURCE_IDS.includes(id) && !order.includes(id)) order.push(id);
  }
  for (const id of DEFAULT_SOURCE_ORDER) if (!order.includes(id)) order.push(id);
  return order;
}

function setSourceOrder(value) {
  activeOrder = normalizeSourceOrder(value);
  return [...activeOrder];
}

function getSourceOrder() {
  return [...activeOrder];
}

module.exports = { SOURCE_IDS, DEFAULT_SOURCE_ORDER, normalizeSourceOrder, setSourceOrder, getSourceOrder };
