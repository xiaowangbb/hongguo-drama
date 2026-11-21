const fs = require('node:fs');
const { createHash } = require('node:crypto');

const SAMPLE_BYTES = 16 * 1024;

// Metadata drift is common; sample three regions so same-inode rewrites still change the receipt.
function contentHash(file, size) {
  if (!Number.isSafeInteger(size) || size <= 0) return '';
  const chunk = Math.min(size, SAMPLE_BYTES);
  const starts = size <= chunk ? [0]
    : [0, Math.floor((size - chunk) / 2), size - chunk];
  const buffer = Buffer.allocUnsafe(chunk);
  const fd = fs.openSync(file, 'r');
  try {
    const hash = createHash('sha256').update(String(size));
    for (const start of starts) {
      const length = Math.min(chunk, size - start);
      const read = fs.readSync(fd, buffer, 0, length, start);
      hash.update(String(start)).update(buffer.subarray(0, read));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function readFileIdentity(file, { content = true, preloadedStat = null } = {}) {
  // Callers that already stat'ed the file can pass the result to avoid a second round-trip on
  // network filesystems. It must come from lstatSync(file, { bigint: true }).
  const stat = preloadedStat || fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('下载视频不是普通文件');
  const size = Number(stat.size);
  const identity = {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    birthtimeNs: stat.birthtimeNs == null ? '' : String(stat.birthtimeNs),
  };
  if (content) identity.contentHash = contentHash(file, size);
  return identity;
}

/**
 * 异步版内容指纹。网络盘上「open + 三段采样读 + sha256」是若干次网络往返，
 * 列表里一集一集地同步做会把主进程的事件循环堵住（界面转彩虹圈）。
 */
async function contentHashAsync(file, size) {
  if (!Number.isSafeInteger(size) || size <= 0) return '';
  const chunk = Math.min(size, SAMPLE_BYTES);
  const starts = size <= chunk ? [0]
    : [0, Math.floor((size - chunk) / 2), size - chunk];
  const buffer = Buffer.allocUnsafe(chunk);
  const fh = await fs.promises.open(file, 'r');
  try {
    const hash = createHash('sha256').update(String(size));
    for (const start of starts) {
      const length = Math.min(chunk, size - start);
      const { bytesRead } = await fh.read(buffer, 0, length, start);
      hash.update(String(start)).update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await fh.close().catch(() => {});
  }
}

async function readFileIdentityAsync(file, { content = true, preloadedStat = null } = {}) {
  const stat = preloadedStat || await fs.promises.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('下载视频不是普通文件');
  const size = Number(stat.size);
  const identity = {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    birthtimeNs: stat.birthtimeNs == null ? '' : String(stat.birthtimeNs),
  };
  if (content) identity.contentHash = await contentHashAsync(file, size);
  return identity;
}

function sameFileObject(a, b) {
  if (a === null) return b === null;
  if (!b) return false;
  if (a.dev !== b.dev || a.ino !== b.ino || a.size !== b.size) return false;
  return !a.contentHash || !b.contentHash || a.contentHash === b.contentHash;
}

module.exports = { readFileIdentity, readFileIdentityAsync, sameFileObject };
