const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readFileIdentity, readFileIdentityAsync, sameFileObject } = require('./file-identity');

function fileIdentity(resolved) {
  try { return readFileIdentity(resolved); }
  catch (_) { return null; }
}

// 内容指纹缓存：读文件采样并算 sha256 在网络盘上是好几次往返，同一份文件反复列目录
// 没必要重复算。键里带上 inode/大小/mtime/ctime，文件一有变化（含原地改写）就重新采样。
const CONTENT_HASH_CACHE_LIMIT = 4096;
const contentHashCache = new Map();

async function cachedFileIdentityAsync(resolved) {
  let stat;
  try { stat = await fs.promises.lstat(resolved, { bigint: true }); } catch (_) { return null; }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const meta = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const cached = contentHashCache.get(resolved);
  if (cached && cached.meta === meta) return cached.identity;
  try {
    const identity = await readFileIdentityAsync(resolved, { content: true, preloadedStat: stat });
    if (contentHashCache.size >= CONTENT_HASH_CACHE_LIMIT) contentHashCache.clear();
    contentHashCache.set(resolved, { meta, identity });
    return identity;
  } catch (_) { return null; }
}

function createMediaAccess(devUrl) {
  const files = new Map(), ids = new Map();
  const devOrigin = devUrl ? new URL(devUrl).origin : '';
  const allowed = origin => origin === 'null' || origin === 'file://' || (!!devOrigin && origin === devOrigin);
  return {
    localUrl(file, validate) {
      const resolved = path.resolve(String(file));
      const identity = fileIdentity(resolved);
      let id = ids.get(resolved);
      if (id) {
        const entry = files.get(id);
        if (!sameFileObject(entry.identity, identity)) { ids.delete(resolved); files.delete(id); id = undefined; }
        else {
          entry.identity = identity;
          if (typeof validate === 'function') entry.validate = validate;
        }
      }
      if (!id) { id = randomUUID(); ids.set(resolved, id); files.set(id, { file:resolved, identity, validate }); }
      return `hongguo-local://f/${id}`;
    },
    /**
     * 与 localUrl 同样的语义，只是把「读文件算内容指纹」换成异步 I/O。
     * 列出一部剧的全部分集时会为每一集发一次地址，网络盘上同步做会阻塞主进程。
     */
    async localUrlAsync(file, validate) {
      const resolved = path.resolve(String(file));
      const identity = await cachedFileIdentityAsync(resolved);
      let id = ids.get(resolved);
      if (id) {
        const entry = files.get(id);
        if (!entry || !sameFileObject(entry.identity, identity)) { ids.delete(resolved); if (entry) files.delete(id); id = undefined; }
        else {
          entry.identity = identity;
          if (typeof validate === 'function') entry.validate = validate;
        }
      }
      if (!id) { id = randomUUID(); ids.set(resolved, id); files.set(id, { file:resolved, identity, validate }); }
      return `hongguo-local://f/${id}`;
    },
    resolveLocal(value) {
      const url = new URL(value);
      if (url.hostname !== 'f' || url.search || url.hash) return null;
      return files.get(url.pathname.slice(1))?.file || null;
    },
    isValid(value) {
      try {
        const url = new URL(value);
        const id = url.hostname === 'f' && !url.search && !url.hash ? url.pathname.slice(1) : null;
        const entry = id && files.get(id);
        if (!entry) return false;
        if (entry.identity === null) return false;
        if (!sameFileObject(entry.identity, fileIdentity(entry.file))) {
          files.delete(id);
          if (ids.get(entry.file) === id) ids.delete(entry.file);
          return false;
        }
        return typeof entry.validate === 'function' && entry.validate(entry.file) === true;
      } catch (_) { return false; }
    },
    corsHeaders(request) {
      const origin = request.headers.get('origin');
      // Opaque origins are not identities: unguessable media capabilities remain mandatory.
      if ((origin && !allowed(origin)) || (request.initiatorOrigin && !allowed(request.initiatorOrigin))) return null;
      if (origin && request.initiatorOrigin && origin !== request.initiatorOrigin && !(origin === 'null' && request.initiatorOrigin === 'file://')) return null;
      return { 'Access-Control-Allow-Origin': origin || 'null', Vary: 'Origin', 'Cache-Control': 'no-store' };
    },
    clear() { files.clear(); ids.clear(); contentHashCache.clear(); },
  };
}
module.exports = { createMediaAccess };
