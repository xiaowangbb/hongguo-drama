// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const path = require('node:path');
const zlib = require('node:zlib');
const axios = require('axios');
const { abortError, throwIfAborted } = require('./request-signal');
const { normalizeDownloadQuality } = require('./download-quality');
const { isPublicMediaUrl } = require('./web-media-guard');

const ANONYMOUS_LIMIT_COOLDOWN_MS = 60_000;

function profilePath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'openhongguo', 'anonymous.json');
  } catch {
    const base = process.platform === 'darwin'
      ? path.join(process.env.HOME || '', 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
    return path.join(base, 'openhongguo', 'anonymous.json');
  }
}

function createLazyClient({
  loadSdk = () => import('openhongguo'),
  createTransport = axiosTransport,
  getProfilePath = profilePath,
} = {}) {
  let pending = null;
  return async () => {
    if (!pending) {
      pending = Promise.resolve()
        .then(loadSdk)
        .then(({ createClient, fileProfileStore }) => createClient({
          profile: fileProfileStore(getProfilePath()),
          transport: createTransport(),
          retryAttempts: 1,
          deviceResets: 0,
          timeoutMs: 15000,
        }))
        .catch(error => {
          pending = null;
          throw error;
        });
    }
    return pending;
  };
}

const defaultClient = createLazyClient();

/**
 * 解压响应体。
 *
 * SDK 的 TransportResponse 契约要求「body 是原始字节，不要自动解压」——
 * 意思是传输层不要依赖 axios 的自动解压（那会在解压后丢掉原始语义），
 * 但**必须自己把压缩体还原成明文**，否则 SDK 拿到的是压缩字节，
 * 它的 WASM 只认 gzip/deflate，遇到 br 就直接报
 * "transport failure: unsupported content encoding"。
 */
function decodeBody(body, encoding) {
  if (!body || !body.length) return body;
  const kind = String(encoding || '').toLowerCase().trim();
  try {
    if (kind === 'br') return zlib.brotliDecompressSync(body);
    if (kind === 'gzip' || kind === 'x-gzip') return zlib.gunzipSync(body);
    if (kind === 'deflate') return zlib.inflateSync(body);
    if (kind === 'zstd' && typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(body);
  } catch {
    // 解压失败时原样返回，让 SDK 以自己的方式报错，避免掩盖真实原因。
    return body;
  }
  return body;
}

function axiosTransport({ request = axios, timeout = 15000 } = {}) {
  return async req => {
    const originalHeaders = req.headers || {};
    const response = await request({
      method: req.method || 'GET',
      url: req.url,
      // 明确只要 gzip/deflate：服务端默认会回 br，而我们的解压路径
      // 与 SDK 的能力都以这两者为准。保留调用方自己的头。
      headers: { ...originalHeaders, 'accept-encoding': 'gzip, deflate' },
      ...(req.body?.length ? { data: Buffer.from(req.body) } : {}),
      responseType: 'arraybuffer',
      responseEncoding: null,
      transformResponse: [data => data],
      decompress: false,
      maxContentLength: 8 * 1024 * 1024,
      maxRedirects: 5,
      timeout,
      validateStatus: () => true,
    });
    const headers = {};
    const cookies = {};
    for (const [name, raw] of Object.entries(response.headers || {})) {
      if (name === 'set-cookie') {
        for (const line of Array.isArray(raw) ? raw : [raw]) {
          const pair = String(line || '').split(';', 1)[0];
          const index = pair.indexOf('=');
          if (index > 0) cookies[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
        }
      } else if (name !== 'cookie' && raw !== undefined) {
        headers[name] = Array.isArray(raw) ? String(raw[0]) : String(raw);
      }
    }
    // 解压后 content-encoding / content-length 已不适用，必须去掉，
    // 否则 SDK 会按头再解压一次而失败。
    const decoded = decodeBody(Buffer.from(response.data || []), headers['content-encoding']);
    delete headers['content-encoding'];
    delete headers['content-length'];
    return {
      status: Number(response.status) || 0,
      headers,
      cookies,
      body: new Uint8Array(decoded),
    };
  };
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

function streamPixels(stream) {
  const pair = [stream?.width, stream?.height].map(Number);
  return pair.every(value => Number.isFinite(value) && value > 0) ? Math.min(...pair) : 0;
}

function selectStreams(playback, quality, allowLowerQuality) {
  const requested = normalizeDownloadQuality(quality);
  const target = requested === 'auto' ? 0 : Number(String(requested).replace(/\D/g, '')) || 0;
  const rows = (Array.isArray(playback?.streams) ? playback.streams : [])
    .filter(stream => stream && (stream.url || stream.backup_url) && !stream.dash)
    .map(stream => {
      const codec = String(stream.codec || '').toLowerCase();
      return {
        stream,
        pixels: streamPixels(stream),
        codec,
        safeUrls: [stream.url, stream.backup_url].filter(url => isPublicMediaUrl(url)),
        codecRank: ['h264', 'avc', 'avc1'].includes(codec) ? 0
          : ['bytevc1', 'hvc1', 'hev1', 'hevc', 'h265'].includes(codec) ? 1 : 9,
      };
    })
    .filter(row => row.codecRank < 9 && row.safeUrls.length > 0)
    .filter(row => requested === 'auto' || allowLowerQuality || !target || row.pixels >= target)
    .sort((a, b) => {
      if (requested === 'auto') {
        return a.codecRank - b.codecRank || b.pixels - a.pixels || (a.stream.hls ? 1 : 0) - (b.stream.hls ? 1 : 0);
      }
      const aMeets = !target || a.pixels >= target;
      const bMeets = !target || b.pixels >= target;
      if (aMeets !== bMeets) return Number(bMeets) - Number(aMeets);
      return (aMeets ? a.pixels - b.pixels : b.pixels - a.pixels)
        || a.codecRank - b.codecRank
        || (a.stream.hls ? 1 : 0) - (b.stream.hls ? 1 : 0);
    });
  if (!rows.length && requested !== 'auto' && !allowLowerQuality) {
    throw Object.assign(new Error(`本集暂无满足 ${requested} 的 openhongguo 片源，未降级`), {
      code: 'QUALITY_UNAVAILABLE', quality: requested,
    });
  }
  if (requested === 'auto' && !allowLowerQuality) {
    const best = rows[0]?.pixels || 0;
    return rows.filter(row => row.pixels === best);
  }
  return rows;
}

function candidateFrom(stream, playback, contentKey, vid) {
  const urls = [stream.url, stream.backup_url].filter(url => isPublicMediaUrl(url));
  const codec = String(stream.codec || '').toLowerCase();
  return urls.map(url => ({
    url,
    source: 'openhongguo',
    sourceProvider: 'openhongguo',
    vid: String(playback.episode_id || vid),
    codec: ['bytevc1', 'hvc1', 'hev1', 'hevc', 'h265'].includes(codec) ? 'hevc'
      : codec === 'bytevc2' ? 'bytevc2' : codec || '',
    format: stream.hls ? 'hls' : 'mp4',
    quality: stream.definition || stream.quality || '',
    width: Number(stream.width) || undefined,
    height: Number(stream.height) || undefined,
    duration: Number(playback.duration_seconds) || 0,
    contentKey,
    userAgent: 'okhttp/4.12.0',
  }));
}

function createOpenhongguoSource({
  getClient = defaultClient,
  now = Date.now,
  anonymousLimitCooldownMs = ANONYMOUS_LIMIT_COOLDOWN_MS,
} = {}) {
  let anonymousLimitedUntil = 0;
  const noteFailure = error => {
    if (error?.code === 'ANONYMOUS_LIMITED') anonymousLimitedUntil = now() + anonymousLimitCooldownMs;
    return error;
  };
  async function resolve(vid, options = {}) {
    throwIfAborted(options.signal);
    if (now() < anonymousLimitedUntil) {
      throw Object.assign(new Error('openhongguo 匿名设备暂时受限，已跳过本次请求'), {
        code: 'ANONYMOUS_LIMITED',
        cooldown: true,
      });
    }
    const client = await withAbort(getClient(), options.signal);
    let result;
    try {
      result = await withAbort(client.resolvePlayback(String(vid)), options.signal);
    } catch (error) {
      throwIfAborted(options.signal);
      noteFailure(error);
      if (error?.code === 'DEVICE_REJECTED' && typeof client.resetDevice === 'function') {
        await withAbort(client.resetDevice(), options.signal).catch(() => {});
        try {
          result = await withAbort(client.resolvePlayback(String(vid)), options.signal);
        } catch (retryError) {
          throw noteFailure(retryError);
        }
      } else throw error;
    }
    const playback = result?.playback;
    if (!playback || !Array.isArray(playback.streams) || !playback.streams.length) {
      throw Object.assign(new Error('openhongguo 未返回可播放片源'), { code: 'MISSING_MODEL' });
    }
    const contentKey = result.contentKey?.key || '';
    if (playback.protected && !/^[a-f0-9]{32}$/i.test(contentKey)) {
      throw Object.assign(new Error('openhongguo 未返回有效内容密钥'), { code: 'INVALID_RESPONSE' });
    }
    const rows = selectStreams(playback, options.quality, options.allowLowerQuality === true);
    const candidates = rows.flatMap(row => candidateFrom(row.stream, playback, contentKey || null, vid));
    if (!candidates.length) throw Object.assign(new Error('openhongguo 未返回有效视频地址'), { code: 'MISSING_MODEL' });
    return { ...candidates[0], candidates };
  }

  return { resolve };
}

const provider = createOpenhongguoSource();
module.exports = {
  profilePath,
  axiosTransport,
  createLazyClient,
  selectStreams,
  candidateFrom,
  createOpenhongguoSource,
  fetchPlayUrlSingle: (...args) => provider.resolve(...args),
};
