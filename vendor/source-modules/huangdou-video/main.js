/**
 * 黄豆短剧来源模块（huangdou-video）
 *
 * 依据 github.com/sunclx/zhenguojian-app 的 Go 实现移植。接口为二进制封包协议：
 *   POST {host}/api/drama/{rank,list,detail,play}
 *   key   = HMAC-SHA256(platformKey, hex(uuid 去横线))
 *   body  = iv(16) + AES-256-CBC-PKCS7(gzip(json{data,deviceId,token}))
 *   sign  = SHA256("Dart|sessionId|requestId|time|path") + "-" + time
 * 响应为明文 JSON 或 iv + AES 密文（解密后可能 gzip）。
 */
const siteBaseUrl = "https://hdaisp.com";
// 实测 2026-11 全部可达的镜像域名（来自官方 APK libapp.so + 参考项目）
const baseMirrors = [
  "https://hdaisp.com",
  "https://a3uygtpf.cc", "https://d3fb8wntg6.cc", "https://dryej4zgas.cc",
  "https://eyeonneb.cc", "https://hvthtcpa.top", "https://kx8reeas.cc",
  "https://m9uunysdsj.cc", "https://oynsprig.cc", "https://qicuknlj.top",
  "https://rcsm9kjf.cc", "https://rw53vjv38.cc", "https://sxqirtho.top",
  "https://ty5h39t23d.cc", "https://jfcwtmyp.cc", "https://lozmglzt.cc",
  "https://txj93dhse.cc", "https://w536xs6mj.cc",
];
const platformKey = "7961beb44246e3012ce228d6b5ced05a";
const apiVersion = "2.0.0";
const deviceType = "web";
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const searchPageSize = 30;

const categories = [
  { id: "all", name: "总榜" },
  { id: "mogai", name: "魔改榜" },
  { id: "search", name: "搜索榜" },
  { id: "favorite", name: "收藏榜" },
  { id: "finish", name: "完结榜" },
];
const rankingBoards = {
  "huangdou-all": { name: "总榜", tab: "all" },
  "huangdou-mogai": { name: "魔改榜", tab: "mogai" },
  "huangdou-search": { name: "搜索榜", tab: "search" },
  "huangdou-favorite": { name: "收藏榜", tab: "favorite" },
  "huangdou-finish": { name: "完结榜", tab: "finish" },
};

const sourceIdPattern = /^[a-zA-Z0-9_-]{1,120}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}
function mapString(row, ...keys) {
  if (!isRecord(row)) return "";
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return "";
}
function atoi(value) {
  const text = String(value == null ? "" : value).trim();
  return /^\d+$/.test(text) ? parseInt(text, 10) : 0;
}
function uuidLike() {
  const hex = host.hexEncode(host.randomBytes(16));
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}
function pkcs7Pad(bytes, block) {
  const pad = block - (bytes.length % block);
  const out = new Uint8Array(bytes.length + pad);
  out.set(bytes);
  out.fill(pad, bytes.length);
  return out;
}
function pkcs7Unpad(bytes, block) {
  if (!bytes.length || bytes.length % block !== 0) throw new Error("黄豆响应密文长度无效");
  const pad = bytes[bytes.length - 1];
  if (!(pad >= 1 && pad <= block)) throw new Error("黄豆响应填充无效");
  for (let i = bytes.length - pad; i < bytes.length; i++) {
    if (bytes[i] !== pad) throw new Error("黄豆响应填充无效");
  }
  return bytes.subarray(0, bytes.length - pad);
}
function requestKey(rid) {
  const clean = rid.replace(/-/g, "");
  return host.hmacSha256(host.utf8Encode(platformKey), host.hexDecode(clean));
}
function hostOf(base) {
  try { return host.parseUrl(base).hostname; } catch (_) { return "hdaisp.com"; }
}

/** 单次签名请求；返回解密后的 JSON 对象。base 为本次使用的镜像。 */
function signedCall(base, path, data) {
  const rid = uuidLike();
  const key = requestKey(rid);
  const iv = host.randomBytes(16);
  const sessionId = host.hexEncode(host.randomBytes(16));
  // Go json.Marshal(map) 按字母序排列：data, deviceId, token
  const plainText = '{"data":' + JSON.stringify(data) + ',"deviceId":' + JSON.stringify(sessionId) + ',"token":""}';
  const gz = host.gzip(host.utf8Encode(plainText));
  const padded = pkcs7Pad(gz, 16);
  const encrypted = host.aesCbcEncrypt(key, iv, padded);
  const body = new Uint8Array(iv.length + encrypted.length);
  body.set(iv, 0);
  body.set(encrypted, iv.length);

  const time = String(Math.floor(Date.now() / 1000));
  const signRaw = "Dart|" + sessionId + "|" + rid + "|" + time + "|" + path;
  const sign = host.hexEncode(host.sha256(host.utf8Encode(signRaw))) + "-" + time;
  const response = host.fetch({
    url: base.replace(/\/+$/, "") + "/api" + path,
    method: "POST",
    body: host.base64Encode(body),
    bodyBase64: true,
    binaryResponse: true,
    referer: base.replace(/\/+$/, "") + "/home",
    userAgent,
    headers: {
      "Content-Type": "application/octet-stream",
      "Accept": "*/*",
      "Origin": base,
      "version": apiVersion,
      "deviceType": deviceType,
      "requestId": rid,
      "sessionId": sessionId,
      "time": time,
      "sign": sign,
    },
    timeoutMs: 20000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error("黄豆接口返回 HTTP " + response.status);
  }
  return decodeReply(response, key, base);
}

function decodeReply(response, key, base) {
  const raw = host.base64Decode(String(response.body || ""));
  // 明文 JSON 优先
  if (raw.length && (raw[0] === 0x7b || raw[0] === 0x5b)) {
    return parseJsonBytes(raw);
  }
  if (raw.length < 32) throw new Error("黄豆响应数据过短");
  const iv = raw.subarray(0, 16);
  const padded = host.aesCbcDecrypt(key, iv, raw.subarray(16));
  let plain = pkcs7Unpad(padded, 16);
  if (plain.length >= 2 && plain[0] === 0x1f && plain[1] === 0x8b) {
    plain = host.gunzip(plain);
  }
  return parseJsonBytes(plain);
}

function parseJsonBytes(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(host.utf8Decode(bytes));
  } catch (error) {
    throw new Error("黄豆接口返回格式无效：" + error.message);
  }
  if (parsed !== null && (!isRecord(parsed) || typeof parsed.status === "string" && parsed.status !== "y")) {
    const message = firstNonEmpty(mapString(parsed, "msg", "message", "error"), String((parsed && parsed.status) || "异常"));
    throw new Error("黄豆接口拒绝请求：" + message);
  }
  return parsed;
}

/** 多镜像调用：某个域名失败时自动切换下一个。 */
function api(path, data) {
  const failures = [];
  for (const base of baseMirrors) {
    try {
      const result = signedCall(base, path, data);
      if (result === null || !isRecord(result)) throw new Error("返回类型不符");
      if (result.status !== undefined && result.status !== "y") throw new Error("接口状态异常");
      return result;
    } catch (error) {
      failures.push(hostOf(base) + ": " + error.message);
    }
  }
  throw new Error("黄豆所有线路均失败：" + failures.slice(0, 3).join("；"));
}

function dataMap(reply) {
  const data = isRecord(reply) ? reply.data : null;
  return isRecord(data) ? data : {};
}
function dataRows(reply) {
  const data = dataMap(reply);
  const list = data.list !== undefined ? data.list : data.data;
  return Array.isArray(list) ? list : [];
}

function cleanId(raw) {
  return String(raw == null ? "" : raw).trim().replace(/^rp_/, "");
}
function dramaFromMap(row, pageUrl, category) {
  const sourceId = cleanId(firstNonEmpty(mapString(row, "drama_id"), mapString(row, "id"), mapString(row, "video_id")));
  if (!sourceIdPattern.test(sourceId)) return null;
  const title = firstNonEmpty(mapString(row, "name"), mapString(row, "title"), mapString(row, "video_title"));
  if (title === "") return null;
  // 黄豆站点封面字段名是 img（不是 cover/cover_url）
  const coverRaw = firstNonEmpty(mapString(row, "img"), mapString(row, "cover"), mapString(row, "cover_url"), mapString(row, "poster"));
  const cover = coverRaw === "" ? "" : host.resolveUrl(pageUrl, coverRaw);
  const description = firstNonEmpty(mapString(row, "description"), mapString(row, "desc"), mapString(row, "intro"));
  const episodes = atoi(mapString(row, "episode_count", "episodes_count"));
  const drama = {
    id: host.dramaId(sourceId),
    sourceId,
    title,
    cover,
    description,
    source: host.source,
  };
  if (category) drama.category = category;
  if (episodes > 0) {
    drama.episodeCount = episodes;
    drama.remark = "全" + episodes + "集";
  }
  const viewCount = atoi(mapString(row, "click", "view_count", "views"));
  if (viewCount > 0) drama.viewCount = viewCount;
  return drama;
}

function chapterOf(sourceId, seq, title, locked) {
  const key = seq > 1 ? "ep-" + seq : "auto-1";
  return {
    id: host.chapterId(sourceId, key),
    source: host.source,
    title: firstNonEmpty(title, "第" + seq + "集"),
    pageUrl: siteBaseUrl + "/detail/" + sourceId,
    currentEpisode: seq,
    ...(locked ? { locked: true } : {}),
  };
}

function parseCards(rows, pageUrl, category) {
  const items = [];
  const seen = new Set();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const drama = dramaFromMap(row, pageUrl, category);
    if (drama === null || seen.has(drama.sourceId)) continue;
    seen.add(drama.sourceId);
    items.push({ drama });
  }
  return items;
}

/** 播放接口：返回 m3u8（自带 EXT-X-KEY，下游自动解密）。 */
function playUrl(sourceId, episode) {
  if (!sourceIdPattern.test(sourceId) || !(episode >= 1)) throw new Error("黄豆集数无效");
  const reply = api("/drama/play", { id: sourceId, seq: String(episode) });
  const data = dataMap(reply);
  // 上游免费集给 m3u8（同源签名地址），付费集只给 is_preview=true 的 10 秒试看 MP4。
  // 先把候选收齐，再只用真正的 .m3u8 正片，绝不把 preview-r*.mp4 当成分集。
  const candidates = [mapString(data, "m3u8"), mapString(data, "url"), mapString(data, "play_url"), mapString(data, "playUrl")];
  const lines = Array.isArray(data.lines) ? data.lines : [];
  for (const line of lines) {
    if (isRecord(line)) candidates.push(mapString(line, "url"));
  }
  const preview = firstNonEmpty(mapString(data, "preview_m3u8"), mapString(data, "preview_url"));
  const markedPreview = data.is_preview === true || data.isPreview === true;
  let m3u8 = "";
  for (const candidate of candidates) {
    if (!candidate) continue;
    const url = /^https?:\/\//i.test(candidate) ? candidate : host.resolveUrl(siteBaseUrl + "/", candidate);
    // 正片必须是 HLS；试看 mp4（含 preview-r10.mp4）一律不算。
    if (/\.m3u8(?:[?#]|$)/i.test(url) && !/\/preview-r\d+\.mp4/i.test(url)) { m3u8 = url; break; }
  }
  if (m3u8 === "") {
    if (markedPreview || preview !== "") throw new Error("黄豆该集为付费/VIP 内容，仅提供试看，暂无正片");
    if (candidates.some(Boolean)) throw new Error("黄豆未提供可播放的 HLS 正片地址");
    throw new Error("黄豆未提供播放地址");
  }
  return m3u8;
}

module.exports = {
  validCategory(category) {
    return categories.some((entry) => entry.id === category);
  },

  categories() {
    return categories.slice();
  },

  catalogPage(page, category) {
    const tab = categories.some((entry) => entry.id === category) ? category : "all";
    const reply = api("/drama/rank", { tab, page: String(page) });
    const items = parseCards(dataRows(reply), siteBaseUrl + "/", "");
    return { items, hasMore: items.length >= searchPageSize };
  },

  search(page, query) {
    query = String(query == null ? "" : query).trim();
    if (query === "") throw new Error("黄豆搜索关键词无效");
    // 接口 list 不支持关键词，拉多页后本地过滤（与参考实现一致）
    const items = [];
    const seen = new Set();
    for (let p = 1; p <= Math.max(1, page) && p <= 10; p++) {
      let rows = [];
      try {
        rows = dataRows(api("/drama/list", { page: String(p), page_size: String(searchPageSize) }));
      } catch (_) { break; }
      for (const row of rows) {
        const title = firstNonEmpty(mapString(row, "name"), mapString(row, "title"));
        const description = firstNonEmpty(mapString(row, "description"), mapString(row, "desc"));
        if (!title.toLowerCase().includes(query.toLowerCase()) && !description.toLowerCase().includes(query.toLowerCase())) continue;
        const drama = dramaFromMap(row, siteBaseUrl + "/", "");
        if (drama === null || seen.has(drama.sourceId)) continue;
        seen.add(drama.sourceId);
        items.push({ drama });
      }
      if (rows.length < searchPageSize) break;
    }
    return { items, hasMore: false };
  },

  detail(sourceId) {
    sourceId = String(sourceId == null ? "" : sourceId).trim().replace(/^\/+|\/+$/g, "");
    if (!sourceIdPattern.test(sourceId)) throw new Error("无效的黄豆剧集 ID");
    const reply = api("/drama/detail", { id: sourceId });
    const data = dataMap(reply);
    const drama = dramaFromMap(
      { ...data, drama_id: firstNonEmpty(mapString(data, "drama_id"), mapString(data, "id"), sourceId) },
      siteBaseUrl + "/",
      firstNonEmpty(mapString(data, "category")),
    );
    if (drama === null || drama.sourceId !== sourceId) throw new Error("黄豆详情与请求剧集不符");
    const rows = Array.isArray(data.episodes) ? data.episodes : [];
    let chapters = [];
    for (const row of rows) {
      const seq = atoi(mapString(row, "seq", "episode", "ep"));
      if (!(seq >= 1)) continue;
      const type = mapString(row, "type").toLowerCase();
      const locked = type === "vip" || type === "buy" || mapString(row, "is_buy") === "false";
      chapters.push(chapterOf(sourceId, seq, mapString(row, "name", "title"), locked));
    }
    if (chapters.length === 0) {
      const count = atoi(mapString(data, "episode_count", "free_episodes")) || 1;
      for (let seq = 1; seq <= Math.min(count, 10000); seq++) chapters.push(chapterOf(sourceId, seq, ""));
    }
    chapters.sort((a, b) => a.currentEpisode - b.currentEpisode);
    return { drama, chapters };
  },

  resolveMedia(task) {
    const dramaId = String(task.dramaId || "");
    const separator = dramaId.indexOf(":");
    const sourceId = separator < 0 ? "" : dramaId.slice(separator + 1).trim();
    if (!sourceIdPattern.test(sourceId)) throw new Error("黄豆剧集信息无效");
    const episode = Number(task.chapter && task.chapter.currentEpisode) || Number(task.index) || 1;
    const address = playUrl(sourceId, episode);
    return host.finishMedia({ url: address, referer: siteBaseUrl + "/", format: "hls" });
  },

  rankingPage(boardId, page) {
    const board = rankingBoards[boardId];
    if (!board) throw new Error("未知的黄豆榜单");
    const reply = api("/drama/rank", { tab: board.tab, page: String(page) });
    const rows = dataRows(reply);
    const items = [];
    const seen = new Set();
    rows.forEach((row, index) => {
      const drama = dramaFromMap(row, siteBaseUrl + "/", "");
      if (drama === null || seen.has(drama.sourceId)) return;
      seen.add(drama.sourceId);
      items.push({ rank: index + 1, drama });
    });
    if (items.length === 0) throw new Error("黄豆未返回有效榜单");
    return { items, totalPages: 1 };
  },
};
