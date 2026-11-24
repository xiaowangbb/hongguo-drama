/**
 * 黄果剧场（huangguo.video / huangguoai.fit）独立来源脚本。
 *
 * 与内置「黄果视频」(huangguoai.com) 是两套数据：本源对接官网网页版，
 * 剧集用短码 id（/series/{code}、/video/{code}），发现页标签直接使用官网
 * 五个排行榜，数据从官网榜单页 SSR HTML 抓取。
 *
 * 参考的公开实现（站点结构，2026-10 实测）：
 *   - 列表/分类/搜索：/videos、/search?q=，卡片 <article class="video-card">
 *   - 连续剧详情：/series/{code}，分集为「第N集」+ /video/{code} 链接
 *   - 播放页：/video/{code} 的 data-hls 指向 master.m3u8，含多档 variant，
 *     直接把 master 交给播放器会因不跟随 variant 黑屏，需先挑一个具体清晰度。
 *   - 页面带 Cloudflare 盾；主域 huangguo.video 在国内常被 DNS 污染/SNI 阻断，
 *     官方公布的新域 huangguoai.fit 与它是同一站点，路径与数据完全一致。
 *
 * 网络策略：优先 huangguoai.fit，失败回退 huangguo.video；HTML 文档带浏览器头，
 * m3u8 静态资源用中性头（带文档头会被 CDN 拒绝）；年龄确认标记通过
 * credentials 声明，由宿主在同源时注入 Cookie（宿主禁止脚本自塞 Cookie）。
 */
const SITES = ['https://huangguoai.fit', 'https://huangguo.video'];
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CHANNEL = 'huangguo.video';
const MAX_ITEMS = 50;

// 发现页标签 = 官网排行榜导航。第一个是官网默认页 /ranking，作为默认选中项。
const BOARDS = [
  { id: 'rank-hot', name: '热播榜', path: '/ranking' },
  { id: 'rank-good', name: '好评榜', path: '/ranking/good' },
  { id: 'rank-rising', name: '飙升榜', path: '/ranking/rising' },
  { id: 'rank-download', name: '下载榜', path: '/ranking/download' },
  { id: 'rank-new', name: '新剧榜', path: '/ranking/new' },
];

const LINK_RE = /<a\b[^>]*href\s*=\s*["']((?:https?:\/\/[^"'\/]+)?\/(series|video)\/([A-Za-z0-9]{3,32})\/?[^"']*)["'][^>]*>/gi;
const CODE_RE = /^[A-Za-z0-9]{3,32}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

function htmlUnescape(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·' };
  return String(text || '').replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (entity, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return Object.prototype.hasOwnProperty.call(named, body) ? named[body] : entity;
  });
}

function stripTags(text) {
  return htmlUnescape(String(text || '').replace(/<[^>]*>/g, ' '));
}

function cleanText(text) {
  return htmlUnescape(String(text || ''))
    .replace(/\\/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s·|—-]+|[\s·|—-]+$/g, '')
    .trim();
}

function absoluteUrl(base, ref) {
  const value = htmlUnescape(String(ref || '')).trim();
  if (value === '') return '';
  if (value.startsWith('//')) return 'https:' + value;
  if (/^https?:\/\//i.test(value)) return value;
  // 必须用 master 自身作为 base 解析 variant：base 是站点根时拼到根路径，
  // base 是 .../master.m3u8 时相对文件名替换最后一段；base + '/' 会把
  // master.m3u8 当成目录，拼出 /master.m3u8/720p.m3u8 这种 404 地址。
  try {
    return new URL(value, base).href;
  } catch (_) {
    if (value.startsWith('/')) return String(base).replace(/\/+$/, '') + value;
    return value;
  }
}

function blockedPage(body) {
  const head = String(body || '').slice(0, 5000);
  return /Attention Required|you have been blocked|访问已被限制|ACCESS RESTRICTED|cf-error|Just a moment|cf_chl_/i.test(head);
}

/** 抓 HTML 文档；按站点顺序回退，盾页/空响应视为失败。 */
function fetchPage(path) {
  const failures = [];
  for (const base of SITES) {
    try {
      const response = host.fetchText({
        url: base + path,
        method: 'GET',
        referer: base + '/',
        userAgent: USER_AGENT,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Upgrade-Insecure-Requests': '1',
        },
        credentials: { origin: base, cookie: 'hg_age=1' },
      });
      const body = response && typeof response.body === 'string' ? response.body : '';
      if (body !== '' && !blockedPage(body)) return { body, base };
      failures.push('盾页或空响应');
    } catch (error) {
      failures.push(error.message || '请求失败');
    }
  }
  throw new Error('黄果剧场页面获取失败：' + (failures[0] || '无可用线路'));
}

/** 抓 m3u8 文本：CDN 对文档头敏感，只带最基础的中性头。 */
function fetchPlain(url, referer) {
  const response = host.fetchText({
    url,
    method: 'GET',
    referer: referer || SITES[0] + '/',
    userAgent: USER_AGENT,
    headers: { Accept: '*/*' },
  });
  return response && typeof response.body === 'string' ? response.body : '';
}

function pickVariant(text, masterUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const variants = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].indexOf('#EXT-X-STREAM-INF') < 0) continue;
    let uri = '';
    for (let next = index + 1; next < lines.length; next++) {
      const candidate = lines[next].trim();
      if (candidate !== '') { uri = candidate; break; }
    }
    if (uri === '' || uri.charAt(0) === '#') continue;
    const resolution = lines[index].match(/RESOLUTION=\d+x(\d+)/);
    const bandwidth = lines[index].match(/BANDWIDTH=(\d+)/);
    variants.push({
      height: resolution ? parseInt(resolution[1], 10) : 0,
      bandwidth: bandwidth ? parseInt(bandwidth[1], 10) : 0,
      uri,
    });
  }
  if (variants.length === 0) return masterUrl;
  variants.sort((left, right) => right.height - left.height || right.bandwidth - left.bandwidth);
  return absoluteUrl(masterUrl, variants[0].uri);
}

function hlsFrom(html, base) {
  const match = String(html || '').match(/data-hls(?:-url)?\s*=\s*["']([^"']+)["']/i);
  if (!match) return '';
  const url = absoluteUrl(base, match[1]);
  return /\.m3u8/i.test(url) ? url : '';
}

function coverFrom(block, base) {
  const match = block.match(/(?:src|data-src|data-original|data-lazy)\s*=\s*["']([^"']*\/uploads\/lib\/series\/[^"']+)["']/i);
  return match ? absoluteUrl(base, match[1]) : '';
}

function titleFrom(block, code) {
  const alt = block.match(/<img\b[^>]*\salt\s*=\s*["']([^"']{2,100})["']/i);
  if (alt && cleanText(alt[1]) !== '') return cleanText(alt[1]);
  const display = block.match(/<p\b[^>]*class="[^"]*(?:font-display|text-cream)[^"]*"[^>]*>([^<]{2,100})<\/p>/i);
  if (display && cleanText(display[1]) !== '') return cleanText(display[1]);
  const anchor = block.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
  if (anchor) {
    const parts = stripTags(anchor[1]).split(/[\r\n\\]+/).map(cleanText);
    const usable = parts.filter((part) => {
      if (part.length < 2 || part.length > 100) return false;
      if (/^(?:会员)?更新至第\s*\d+\s*集|会员更新|^\d{1,3}[:.]\d{2}$/.test(part)) return false;
      if (/好评\s*\d+%|热度\s*[×↑]|\d+\s*人下载|\d+\s*天前上架|次下载|票$/.test(part)) return false;
      return true;
    });
    usable.sort((left, right) => right.length - left.length);
    if (usable.length > 0) return usable[0];
  }
  return code;
}

function episodeCountFrom(block) {
  const match = stripTags(block).match(/(?:会员)?更新至第\s*(\d+)\s*集|共\s*(\d+)\s*集|全\s*(\d+)\s*集/);
  if (!match) return '';
  const number = parseInt(match[1] || match[2] || match[3], 10);
  return number > 0 && number <= 999 ? String(number) : '';
}

function metricFrom(block) {
  const text = stripTags(block);
  const patterns = [
    /好评\s*\d+%\s*(?:·|・)?\s*\d+\s*票/,
    /热度\s*[×x↑]\s*[\d.]+\s*%?/,
    /\d+\s*人下载/,
    /\d+\s*天前上架/,
    /[\d.]+\s*[Kk]?\s*次下载/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return cleanText(match[0]);
  }
  return '';
}

function dramaOf(sourceId, title, cover, intro, episodes, boardName, metric) {
  const tags = [boardName, metric].filter((value) => typeof value === 'string' && value !== '').slice(0, 4);
  return {
    id: host.dramaId(sourceId),
    source: host.source,
    sourceId,
    title,
    name: title,
    desc: intro,
    intro,
    cover,
    coverUrl: cover,
    totalEpisode: episodes,
    episodeCount: episodes,
    categoryName: boardName || '',
    channelName: CHANNEL,
    remark: metric,
    score: '',
    views: '',
    onlineDate: '',
    releaseStatus: /已完结/.test(metric) ? 'finished' : '',
    tags,
  };
}

/**
 * 解析榜单页：页面为 SSR 的有序列表，链接顺序即名次。
 * 以每个 /series/ 或 /video/ 链接为分块起点，块内取封面、标题、集数与榜单指标，
 * 不强依赖具体 class 名，站点改版时只需调整这里的少量正则。
 */
function parseRanking(html, base, board) {
  const source = String(html || '');
  const hits = [];
  LINK_RE.lastIndex = 0;
  let match;
  while ((match = LINK_RE.exec(source)) !== null) {
    hits.push({ kind: match[2].toLowerCase(), code: match[3], start: match.index, openEnd: LINK_RE.lastIndex });
    if (hits.length >= MAX_ITEMS * 3) break;
  }
  const items = [];
  const seen = new Set();
  for (let index = 0; index < hits.length && items.length < MAX_ITEMS; index++) {
    const hit = hits[index];
    const sourceId = hit.kind + ':' + hit.code;
    if (seen.has(sourceId)) continue;
    const end = index + 1 < hits.length
      ? Math.min(hits[index + 1].start, hit.openEnd + 2000)
      : Math.min(source.length, hit.openEnd + 2000);
    const block = source.slice(hit.start, end);
    const title = titleFrom(block, hit.code);
    if (!title || title === hit.code) continue;
    seen.add(sourceId);
    const metric = metricFrom(block);
    const drama = dramaOf(sourceId, title, coverFrom(block, base), '', episodeCountFrom(block), board.name, metric);
    drama.rank = items.length + 1;
    items.push(drama);
  }
  return items;
}

/** 列表/搜索页卡片：<article class="video-card|search-content-card">…</article> */
function parseCards(html, base, label) {
  const source = String(html || '');
  const blocks = source.match(/<article\b[^>]*class="[^"]*(?:video-card|search-content-card)[^"]*"[^>]*>[\s\S]*?<\/article>/gi) || [];
  const items = [];
  const seen = new Set();
  for (const block of blocks) {
    const link = block.match(/<a\b[^>]*href\s*=\s*["']((?:https?:\/\/[^"'\/]+)?\/(series|video)\/([A-Za-z0-9]{3,32})\/?[^"']*)["']/i);
    if (!link) continue;
    const kind = link[2].toLowerCase();
    const code = link[3];
    if (!CODE_RE.test(code)) continue;
    const sourceId = kind + ':' + code;
    if (seen.has(sourceId)) continue;
    const title = titleFrom(block, code);
    if (!title || title === code) continue;
    seen.add(sourceId);
    items.push(dramaOf(sourceId, title, coverFrom(block, base), '', episodeCountFrom(block), label, metricFrom(block)));
  }
  return items;
}

function parseId(raw) {
  const text = String(raw || '').trim();
  const separator = text.indexOf(':');
  const kind = separator > 0 ? text.slice(0, separator).toLowerCase() : 'series';
  const code = separator > 0 ? text.slice(separator + 1) : text;
  if ((kind !== 'series' && kind !== 'video') || !CODE_RE.test(code)) {
    throw new Error('黄果剧场剧集编号无效');
  }
  return { kind, code, sourceId: kind + ':' + code };
}

function pageTitle(html, fallback) {
  const heading = String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (heading) {
    const value = cleanText(stripTags(heading[1]));
    if (value !== '') return value;
  }
  const title = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    const value = cleanText(stripTags(title[1]).replace(/\s*[-–|·]\s*黄果剧场.*$/u, ''));
    if (value !== '') return value;
  }
  return fallback;
}

function pageCover(html, base) {
  const og = String(html || '').match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)
    || String(html || '').match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
  if (og) return absoluteUrl(base, og[1]);
  const poster = String(html || '').match(/data-poster\s*=\s*["']([^"']+)["']/i);
  return poster ? absoluteUrl(base, poster[1]) : '';
}

function pageIntro(html) {
  const match = String(html || '').match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)
    || String(html || '').match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i);
  return match ? cleanText(match[1]) : '';
}

/**
 * 分集链接：官网 data-episode-list 区块内是倒序排列的 chip：
 *   <a href="/video/{code}" class="series-ep-chip" title="第N集 · 时长">
 *     <span class="series-ep-chip-text">N</span>
 *   </a>
 * 只在该区块内取链接，避免把区块前的「开始观看」按钮、语言切换、推荐位和广告
 * 链接误当分集；集号优先取 title/aria-label，其次是 chip 裸数字。
 */
function parseEpisodeLinks(html, base) {
  let area = String(html || '');
  const marker = area.search(/data-episode-list/i);
  if (marker >= 0) {
    area = area.slice(marker);
    const sectionEnd = area.indexOf('</section>');
    if (sectionEnd > 0) area = area.slice(0, sectionEnd);
  }
  const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const found = [];
  const seen = new Set();
  let match;
  while ((match = linkRe.exec(area)) !== null) {
    const attrs = String(match[1] || '');
    const href = attrs.match(/href\s*=\s*["']((?:https?:\/\/[^"'\/]+)?\/video\/([A-Za-z0-9]{3,32})\/?[^"']*)["']/i);
    if (!href) continue;
    const code = href[2];
    if (seen.has(code)) continue;
    const anchorText = cleanText(stripTags(match[2]));
    const attrText = (attrs.match(/(?:title|aria-label)\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const chip = String(match[2]).match(/series-ep-chip-text[^>]*>\s*(\d+)\s*</i);
    const labelled = String(attrText).match(/第\s*(\d+)\s*[集话期]/) || anchorText.match(/第\s*(\d+)\s*[集话期]/);
    let number = 0;
    if (labelled) number = parseInt(labelled[1], 10);
    else if (chip) number = parseInt(chip[1], 10);
    else if (/^\d{1,3}$/.test(anchorText)) number = parseInt(anchorText, 10);
    seen.add(code);
    found.push({
      code,
      number: number > 0 ? number : 0,
      title: number > 0 ? '第' + number + '集' : (anchorText || '正片'),
      pageUrl: base + '/video/' + code,
    });
  }
  // 官网为倒序；能解析出集号就按集号正序，否则整体反转兜底。
  if (found.length > 1 && found.every((entry) => entry.number > 0)) {
    found.sort((left, right) => left.number - right.number);
  } else {
    found.reverse();
  }
  return found.map((entry, index) => ({
    code: entry.code,
    number: entry.number > 0 ? entry.number : index + 1,
    title: entry.title,
    pageUrl: entry.pageUrl,
  }));
}

module.exports = {
  validCategory(category) {
    return BOARDS.some((board) => board.id === category);
  },

  categories() {
    return BOARDS.map((board) => ({ id: board.id, name: board.name }));
  },

  catalogPage(page, category) {
    const board = BOARDS.find((entry) => entry.id === category) || BOARDS[0];
    if (page !== 1) return { items: [], hasMore: false, warning: '' };
    // 失败必须抛错：宿主的 browseList 会忽略 warning，返回空 items 会被
    // 当成「请求成功但没数据」，发现页只显示空白，用户看不到盾页原因。
    const { body, base } = fetchPage(board.path);
    const items = parseRanking(body, base, board);
    if (items.length === 0) throw new Error(board.name + '：榜单为空或页面结构已变化');
    return { items, hasMore: false, warning: '' };
  },

  search(page, query) {
    const keyword = String(query || '').trim();
    if (keyword === '') throw new Error('请输入搜索关键词');
    const path = '/search?q=' + encodeURIComponent(keyword) + (page > 1 ? '&page=' + page : '');
    const { body, base } = fetchPage(path);
    const items = parseCards(body, base, '搜索');
    return { items, hasMore: items.length >= 20 };
  },

  detail(raw) {
    const { kind, code, sourceId } = parseId(raw);
    if (kind === 'video') {
      const { body, base } = fetchPage('/video/' + code);
      const title = pageTitle(body, '正片');
      const drama = dramaOf(sourceId, title, pageCover(body, base), pageIntro(body), '1', '', '');
      return {
        drama,
        chapters: [{
          id: host.chapterId(sourceId, 'v-' + code),
          source: host.source,
          title: '正片',
          pageUrl: base + '/video/' + code,
          currentEpisode: 1,
          index: 1,
        }],
      };
    }
    const { body, base } = fetchPage('/series/' + code);
    const episodes = parseEpisodeLinks(body, base);
    if (episodes.length === 0) throw new Error('黄果剧场未返回分集列表');
    const drama = dramaOf(sourceId, pageTitle(body, code), pageCover(body, base), pageIntro(body), String(episodes.length), '', '');
    const chapters = episodes.map((entry, index) => ({
      id: host.chapterId(sourceId, 'v-' + entry.code),
      source: host.source,
      title: entry.title,
      pageUrl: entry.pageUrl,
      currentEpisode: entry.number > 0 ? entry.number : index + 1,
      index: index + 1,
    }));
    return { drama, chapters };
  },

  resolveMedia(task) {
    const chapter = isRecord(task) && isRecord(task.chapter) ? task.chapter : {};
    let code = '';
    const fromUrl = String(chapter.pageUrl || '').match(/\/video\/([A-Za-z0-9]{3,32})/);
    if (fromUrl) code = fromUrl[1];
    if (code === '') {
      const fromId = String(chapter.id || '').match(/:v-([A-Za-z0-9]{3,32})$/);
      if (fromId) code = fromId[1];
    }
    if (code === '') throw new Error('黄果剧场分集信息无效');
    const { body, base } = fetchPage('/video/' + code);
    const master = hlsFrom(body, base);
    if (master === '') throw new Error('黄果剧场未返回播放地址');
    let playable = master;
    try {
      playable = pickVariant(fetchPlain(master, base + '/'), master) || master;
    } catch (_) { /* CDN 不返回 master 时直接退回原地址 */ }
    return host.finishMedia({
      url: playable,
      referer: base + '/',
      format: 'hls',
      credentials: { origin: base, cookie: 'hg_age=1' },
    });
  },
};
