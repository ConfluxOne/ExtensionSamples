// 低端影视（ddys.io）Conflux Extension
//
// 参考 video-ddys（SmartBook widget）移植：首页 / 分类浏览、搜索、详情与在线播放。
// 运行时目前没有 ctx.html，所以这里用正则做轻量 HTML 解析；播放地址交给 Native 拉流。
// 站点：https://ddys.io
//
// 说明：
// - 条目 ref.source 统一用 "custom"，id 是详情页路径（如 /movie/tropical-night）。
// - 同包提供 detail / playback，因此点击卡片时优先走同源包解析。
// - 搜索用 GET /search?q=&type=movie；被 Cloudflare 拦下时退回
//   GET /api/search-suggest（无海报）。
// - 播放线路先做一次轻量探测：可用线路优先，确认 404/410 的线路会被移除；
//   请求头按浏览器补齐（UA / 页面 Referer），部分 CDN 对播放器 UA 或 root Referer 会返回 404。

var BASE_URL = "https://ddys.io";
var IMAGE_BASE = "https://img.ddys.io";
var USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
var REQUEST_TIMEOUT_MS = 20000;
var SEARCH_TIMEOUT_MS = 25000;
var MAX_DESCRIPTION_LENGTH = 2000;
var MAX_RELATED_ITEMS = 12;
var MAX_CARD_ITEMS = 60;
var PROBE_TIMEOUT_MS = 3000;
var PROBE_CACHE_TTL_MS = 10 * 60 * 1000;
var PROBE_CACHE_LIMIT = 160;

var BROWSER_HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

var CATEGORIES = [
  { value: "home", title: "首页", path: "/" },
  { value: "movie", title: "电影", path: "/movie" },
  { value: "series", title: "剧集", path: "/series" },
  { value: "variety", title: "综艺", path: "/variety" },
  { value: "anime", title: "动漫", path: "/anime" },
];

// 被 Cloudflare 人机验证拦过一次后，本次运行内直接走搜索建议接口。
var htmlSearchBlocked = false;

// ========== 文本与 URL 工具 ==========

var HTML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  middot: "·",
};

function trim(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/^\s+|\s+$/g, "");
}

function decodeEntities(value) {
  if (!value) {
    return "";
  }
  return String(value).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g, function (match, name) {
    if (name.charAt(0) === "#") {
      var code = name.charAt(1) === "x" || name.charAt(1) === "X"
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      if (isNaN(code) || code <= 0) {
        return match;
      }
      try {
        return String.fromCharCode(code);
      } catch (error) {
        return match;
      }
    }
    var entity = HTML_ENTITIES[name.toLowerCase()];
    return entity === undefined ? match : entity;
  });
}

function stripTags(value) {
  if (!value) {
    return "";
  }
  var text = String(value)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|td|span)>/gi, " ")
    .replace(/<[^>]*>/g, "");
  text = decodeEntities(text);
  return trim(text.replace(/\s+/g, " "));
}

function truncate(value, limit) {
  var text = trim(value);
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, limit) + "...";
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function resolveURL(value) {
  var url = trim(value);
  if (!url) {
    return "";
  }
  var resolved = url;
  if (url.indexOf("//") === 0) {
    resolved = "https:" + url;
  } else if (url.indexOf("http://") === 0 || url.indexOf("https://") === 0) {
    resolved = url;
  } else if (url.charAt(0) === "/") {
    resolved = BASE_URL + url;
  } else {
    resolved = BASE_URL + "/" + url;
  }
  // 站点已把海报迁到 img.ddys.io，旧页面里残留的 ddys.io/movies 图片会 404。
  if (resolved.indexOf(BASE_URL + "/movies/") === 0) {
    return IMAGE_BASE + resolved.slice(BASE_URL.length);
  }
  return resolved;
}

// 把 extern 的 id 规范成站内路径：/movie/xxx。
function refPath(value) {
  var raw = trim(value);
  if (!raw) {
    throw ExtensionError({ code: "invalid_params", message: "缺少条目地址", retryable: false });
  }
  raw = raw.replace(/^https?:\/\/[^\/]+/i, "");
  if (raw.charAt(0) !== "/") {
    raw = "/" + raw;
  }
  return raw;
}

function describeError(error) {
  if (!error) {
    return "未知错误";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error.message) {
    return String(error.message);
  }
  return String(error);
}

function asArray(value) {
  if (value === null || value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

// ========== HTTP ==========

function mergeHeaders(extra) {
  var headers = {};
  var key;
  for (key in BROWSER_HEADERS) {
    if (hasOwn(BROWSER_HEADERS, key)) {
      headers[key] = BROWSER_HEADERS[key];
    }
  }
  if (extra) {
    for (key in extra) {
      if (hasOwn(extra, key)) {
        headers[key] = extra[key];
      }
    }
  }
  return headers;
}

function httpError(status, text, url) {
  if (status === 403 && /Just a moment|challenge-platform|cf-chl|Attention Required|cf-mitigated/i.test(text)) {
    return ExtensionError({
      code: "unavailable",
      message: "低端影视启用了人机验证（Cloudflare），暂时无法读取页面。可先换网络重试，或在浏览器里打开一次 ddys.io 完成验证。",
      retryable: true,
    });
  }
  if (status === 404) {
    return ExtensionError({ code: "not_found", message: "页面不存在：" + url, retryable: false });
  }
  if (status === 419) {
    return ExtensionError({ code: "unavailable", message: "搜索校验已过期，请重试。", retryable: true });
  }
  if (status === 429) {
    return ExtensionError({ code: "rate_limited", message: "请求过于频繁，请稍后重试。", retryable: true });
  }
  if (status === 0 || status >= 500) {
    return ExtensionError({ code: "unavailable", message: "低端影视暂时不可用（HTTP " + status + "）。", retryable: true });
  }
  return ExtensionError({ code: "internal", message: "低端影视返回异常状态（HTTP " + status + "）。", retryable: false });
}

// ctx.http.get / post 的第二个参数是 options（post 的 body 放在 options.body）。
async function requestText(ctx, method, path, options) {
  var url = path.indexOf("http") === 0 ? path : BASE_URL + path;
  var config = options || {};
  var response;
  try {
    if (method === "POST") {
      response = await ctx.http.post(url, config);
    } else {
      response = await ctx.http.get(url, config);
    }
  } catch (error) {
    throw ExtensionError({
      code: "unavailable",
      message: "无法访问低端影视：" + describeError(error),
      retryable: true,
    });
  }
  var status = response && typeof response.status === "number" ? response.status : 0;
  var data = response ? response.data : null;
  var text = typeof data === "string" ? data : "";
  if (status !== 200) {
    var error = httpError(status, text, url);
    if (data && typeof data === "object") {
      var message = trim(data.message || data.error || "");
      if (message) {
        error.message = error.message + " " + message;
      }
    }
    throw error;
  }
  return { text: text, json: data, status: status };
}

async function fetchHTML(ctx, path, extraHeaders) {
  var result = await requestText(ctx, "GET", path, {
    headers: mergeHeaders(extraHeaders),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!result.text) {
    throw ExtensionError({ code: "unavailable", message: "低端影视返回了空页面。", retryable: true });
  }
  return result.text;
}

// ========== 列表页解析 ==========

function kindMediaType(kind) {
  if (kind === "电影") {
    return "movie";
  }
  if (kind === "剧集" || kind === "电视剧" || kind === "综艺" || kind === "动漫" || kind === "纪录片") {
    return "tv";
  }
  return null;
}

function pageCountFrom(html) {
  var maxPage = 1;
  var pattern = /href="([^"]+)"/g;
  var match;
  while ((match = pattern.exec(html)) !== null) {
    var pageMatch = match[1].match(/\/page\/(\d+)/) || match[1].match(/[?&]page=(\d+)/);
    if (!pageMatch) {
      continue;
    }
    var page = parseInt(pageMatch[1], 10);
    if (!isNaN(page) && page > maxPage) {
      maxPage = page;
    }
  }
  return maxPage;
}

function parseCardSlice(slice) {
  var hrefMatch = slice.match(/<a[^>]*href="([^"]*\/movie\/[^"#?]+)"/i);
  if (!hrefMatch) {
    return null;
  }
  var id = refPath(hrefMatch[1]);
  if (id.indexOf("/movie/") !== 0) {
    return null;
  }

  var title = "";
  var titleMatch = slice.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i);
  if (titleMatch) {
    title = stripTags(titleMatch[1]);
  }
  if (!title) {
    var altMatch = slice.match(/<img[^>]*alt="([^"]*)"/i);
    if (altMatch) {
      title = stripTags(altMatch[1]);
    }
  }
  if (!title) {
    return null;
  }

  var poster = "";
  var posterMatch = slice.match(/<img[^>]*src="([^"]+)"/i) || slice.match(/<img[^>]*data-src="([^"]+)"/i);
  if (posterMatch) {
    poster = resolveURL(posterMatch[1]);
  }

  var text = stripTags(slice);
  var year = "";
  var kind = "";
  var infoMatch = text.match(/((?:19|20)\d{2})\s*·\s*(电影|剧集|电视剧|综艺|动漫|纪录片)/);
  if (!infoMatch) {
    infoMatch = text.match(/((?:19|20)\d{2})\s*·\s*([^\s·]{1,6})/);
  }
  if (infoMatch) {
    year = infoMatch[1];
    kind = infoMatch[2];
  }

  var rating = null;
  var ratingMatch = slice.match(/badge-top-right[^>]*>\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (ratingMatch) {
    var parsedRating = parseFloat(ratingMatch[1]);
    if (!isNaN(parsedRating) && parsedRating > 0) {
      rating = parsedRating;
    }
  }

  var item = { ref: { source: "custom", id: id }, title: title };
  var mediaType = kindMediaType(kind);
  if (mediaType) {
    item.ref.mediaType = mediaType;
  }
  if (year && kind) {
    item.subtitle = year + " · " + kind;
  } else if (kind) {
    item.subtitle = kind;
  } else if (year) {
    item.subtitle = year;
  }
  if (year) {
    item.releaseDate = year;
  }
  if (rating !== null) {
    item.rating = rating;
  }
  if (poster) {
    item.images = { poster: poster };
  }
  return item;
}

function buildLooseItem(href, title, before, after) {
  var id = refPath(href);
  if (id.indexOf("/movie/") !== 0) {
    return null;
  }
  var item = { ref: { source: "custom", id: id }, title: title };

  var poster = "";
  var imgMatches = before.match(/<img[^>]*src="([^"]+)"/gi);
  if (imgMatches && imgMatches.length) {
    var srcMatch = imgMatches[imgMatches.length - 1].match(/src="([^"]+)"/i);
    if (srcMatch) {
      poster = resolveURL(srcMatch[1]);
    }
  }

  var rating = null;
  var ratingPattern = /badge-top-right[^>]*>\s*([0-9]+(?:\.[0-9]+)?)/gi;
  var ratingMatch;
  while ((ratingMatch = ratingPattern.exec(before)) !== null) {
    var parsedRating = parseFloat(ratingMatch[1]);
    if (!isNaN(parsedRating) && parsedRating > 0) {
      rating = parsedRating;
    }
  }

  var year = "";
  var kind = "";
  var text = stripTags(after);
  var infoMatch = text.match(/((?:19|20)\d{2})\s*·\s*(电影|剧集|电视剧|综艺|动漫|纪录片)/);
  if (!infoMatch) {
    infoMatch = text.match(/((?:19|20)\d{2})\s*·\s*([^\s·]{1,6})/);
  }
  if (infoMatch) {
    year = infoMatch[1];
    kind = infoMatch[2];
  }

  var mediaType = kindMediaType(kind);
  if (mediaType) {
    item.ref.mediaType = mediaType;
  }
  if (year && kind) {
    item.subtitle = year + " · " + kind;
  } else if (kind) {
    item.subtitle = kind;
  } else if (year) {
    item.subtitle = year;
  }
  if (year) {
    item.releaseDate = year;
  }
  if (rating !== null) {
    item.rating = rating;
  }
  if (poster) {
    item.images = { poster: poster };
  }
  return item;
}

function parseLooseCards(html) {
  var items = [];
  var pattern = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
  var match;
  while ((match = pattern.exec(html)) !== null) {
    if (match[1].indexOf("/movie/") === -1) {
      continue;
    }
    var title = stripTags(match[2]);
    if (!title) {
      continue;
    }
    var before = html.slice(Math.max(0, match.index - 4000), match.index);
    var after = html.slice(match.index, Math.min(html.length, match.index + 2000));
    var item = buildLooseItem(match[1], title, before, after);
    if (item) {
      items.push(item);
    }
  }
  if (items.length === 0) {
    // 兜底：直接找指向 /movie/<slug> 的链接。
    var anchorPattern = /<a[^>]*href="([^"]*\/movie\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = anchorPattern.exec(html)) !== null) {
      var anchorTitle = stripTags(match[2]);
      if (!anchorTitle || anchorTitle.length > 80) {
        continue;
      }
      if (/^(上一页|下一页|首页|电影|剧集|综艺|动漫|片单|更多|查看全部|播放|详情)$/.test(anchorTitle)) {
        continue;
      }
      var anchorBefore = html.slice(Math.max(0, match.index - 3000), match.index);
      var anchorAfter = html.slice(match.index, Math.min(html.length, match.index + 1500));
      var anchorItem = buildLooseItem(match[1], anchorTitle, anchorBefore, anchorAfter);
      if (anchorItem) {
        items.push(anchorItem);
      }
    }
  }
  return items;
}

function dedupeItems(items) {
  var seen = {};
  var result = [];
  for (var i = 0; i < items.length; i++) {
    var key = items[i].ref.id;
    if (seen[key]) {
      continue;
    }
    seen[key] = true;
    result.push(items[i]);
  }
  return result;
}

function parseListPage(html) {
  var items = [];
  var pattern = /<div[^>]*class="[^"]*\bmovie-card\b[^"]*"[^>]*>/gi;
  var marks = [];
  var match;
  while ((match = pattern.exec(html)) !== null) {
    marks.push(match.index);
  }
  if (marks.length > 0) {
    for (var i = 0; i < marks.length; i++) {
      var end = i + 1 < marks.length ? marks[i + 1] : Math.min(html.length, marks[i] + 20000);
      var item = parseCardSlice(html.slice(marks[i], end));
      if (item) {
        items.push(item);
      }
    }
  } else {
    items = parseLooseCards(html);
  }
  items = dedupeItems(items);
  if (items.length > MAX_CARD_ITEMS) {
    items = items.slice(0, MAX_CARD_ITEMS);
  }
  return { items: items, pages: pageCountFrom(html) };
}

// ========== 详情页解析 ==========

function findMediaObject(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      var nested = findMediaObject(value[i]);
      if (nested) {
        return nested;
      }
    }
    return null;
  }
  var type = value["@type"];
  var typeName = Array.isArray(type) ? type.join(",") : type;
  if (typeName && /Movie|TVSeries|TVShow|TVSeason|TVEpisode/i.test(String(typeName))) {
    return value;
  }
  if (value["@graph"]) {
    return findMediaObject(value["@graph"]);
  }
  return null;
}

function parseStructuredData(html) {
  var pattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  var match;
  while ((match = pattern.exec(html)) !== null) {
    var raw = trim(match[1]);
    if (!raw) {
      continue;
    }
    var value = null;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      console.warn("JSON-LD 解析失败：" + describeError(error));
      continue;
    }
    var media = findMediaObject(value);
    if (media) {
      return media;
    }
  }
  return null;
}

function mediaTypeFromStructuredData(data) {
  if (!data) {
    return null;
  }
  var type = data["@type"];
  var typeName = Array.isArray(type) ? type.join(",") : String(type || "");
  if (/TVSeries|TVShow|TVSeason|TVEpisode/i.test(typeName)) {
    return "tv";
  }
  if (/Movie|Film/i.test(typeName)) {
    return "movie";
  }
  return null;
}

function extractNames(value) {
  var names = [];
  var list = asArray(value);
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    var name = "";
    if (typeof item === "string") {
      name = trim(item);
    } else if (item && typeof item === "object") {
      name = trim(item.name || "");
    }
    if (name) {
      names.push(name);
    }
  }
  return names;
}

function asText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    var parts = [];
    for (var i = 0; i < value.length; i++) {
      var part = asText(value[i]);
      if (part) {
        parts.push(part);
      }
    }
    return parts.join(" / ");
  }
  if (typeof value === "object") {
    return trim(value.name || value.title || "");
  }
  return String(value);
}

function contentStartIndex(html) {
  var index = html.indexOf("<main");
  return index >= 0 ? index : 0;
}

function parsePoster(content, title) {
  var pattern = /<img([^>]*)>/gi;
  var fallback = "";
  var match;
  while ((match = pattern.exec(content)) !== null) {
    var attrs = match[1];
    var srcMatch = attrs.match(/src="([^"]+)"/i);
    if (!srcMatch) {
      continue;
    }
    var src = srcMatch[1];
    if (src.indexOf("/public/") !== -1 || src.indexOf("/promo/") !== -1 || src.indexOf("/go/") !== -1) {
      continue;
    }
    var altMatch = attrs.match(/alt="([^"]*)"/i);
    var alt = altMatch ? trim(decodeEntities(altMatch[1])) : "";
    if (title && alt && alt === trim(title)) {
      return resolveURL(src);
    }
    if (!fallback && attrs.indexOf("object-cover") !== -1) {
      fallback = resolveURL(src);
    }
    if (!fallback && src.indexOf("/movies/") !== -1) {
      fallback = resolveURL(src);
    }
  }
  return fallback;
}

function parseDetailHeader(content) {
  var header = {
    title: "",
    subtitle: "",
    poster: "",
    infoText: "",
    rating: null,
    directors: [],
    actors: [],
    description: "",
  };

  var h1Match = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    var h1 = h1Match[1];
    var spanMatch = h1.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
    if (spanMatch) {
      header.subtitle = stripTags(spanMatch[1]);
    }
    header.title = stripTags(h1.replace(/<span[\s\S]*?<\/span>/i, " "));
  }

  var infoMatch = content.match(/<div[^>]*class="[^"]*text-gray-600[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (infoMatch) {
    header.infoText = stripTags(infoMatch[1]);
  }

  var ratingMatch = content.match(/<span[^>]*rating-display[^>]*>([\s\S]*?)<\/span>/i);
  if (ratingMatch) {
    var ratingText = stripTags(ratingMatch[1]);
    var ratingNumber = ratingText.match(/([0-9]+(?:\.[0-9]+)?)/);
    if (ratingNumber) {
      var parsedRating = parseFloat(ratingNumber[1]);
      if (!isNaN(parsedRating) && parsedRating > 0) {
        header.rating = parsedRating;
      }
    }
  }

  var directorMatch = content.match(/导演：<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i);
  if (directorMatch) {
    header.directors = splitNames(stripTags(directorMatch[1]));
  }
  var actorMatch = content.match(/主演：<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i);
  if (actorMatch) {
    header.actors = splitNames(stripTags(actorMatch[1]));
  }

  var proseMatch = content.match(/<div[^>]*class="[^"]*\bprose\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (proseMatch) {
    header.description = stripTags(proseMatch[1]);
  }

  header.poster = parsePoster(content, header.title);
  return header;
}

function splitNames(text) {
  var names = [];
  var parts = trim(text).split("/");
  for (var i = 0; i < parts.length; i++) {
    var name = trim(parts[i]);
    if (name) {
      names.push(name);
    }
  }
  return names;
}

var CHINESE_DIGITS = {
  "一": 1,
  "二": 2,
  "两": 2,
  "三": 3,
  "四": 4,
  "五": 5,
  "六": 6,
  "七": 7,
  "八": 8,
  "九": 9,
};

function chineseNumber(text) {
  var value = trim(text);
  if (!value) {
    return NaN;
  }
  if (/^\d+$/.test(value)) {
    return parseInt(value, 10);
  }
  var tenIndex = value.indexOf("十");
  if (tenIndex >= 0) {
    var tens = tenIndex === 0 ? 1 : CHINESE_DIGITS[value.charAt(0)];
    if (!tens) {
      return NaN;
    }
    var onesText = value.slice(tenIndex + 1);
    var ones = 0;
    if (onesText) {
      ones = CHINESE_DIGITS[onesText.charAt(0)];
      if (!ones) {
        return NaN;
      }
    }
    return tens * 10 + ones;
  }
  if (value.length === 1) {
    var digit = CHINESE_DIGITS[value];
    return digit === undefined ? NaN : digit;
  }
  return NaN;
}

function seasonFromText(text) {
  var value = trim(text);
  if (!value) {
    return null;
  }
  var match = value.match(/第\s*([0-9一二三四五六七八九十两]+)\s*季/);
  if (match) {
    var season = chineseNumber(match[1]);
    if (!isNaN(season) && season > 0) {
      return season;
    }
  }
  match = value.match(/season\s*(\d+)/i);
  if (match) {
    var numbered = parseInt(match[1], 10);
    if (!isNaN(numbered) && numbered > 0) {
      return numbered;
    }
  }
  return null;
}

function seasonFromRefId(id) {
  var match = String(id || "").match(/[-\/_]season[-_]?(\d+)(?:$|[-_\/])/i);
  if (match) {
    var season = parseInt(match[1], 10);
    if (!isNaN(season) && season > 0) {
      return season;
    }
  }
  return null;
}

// 当前站点把每一季做成独立详情页，季号要从标题 / 别名 / slug 里取。
function detectPageSeason(ref, structured, header) {
  var candidates = [];
  if (structured) {
    candidates.push(structured.name);
    candidates.push(structured.alternateName);
    if (structured.partOfSeason && structured.partOfSeason.name) {
      candidates.push(structured.partOfSeason.name);
    }
  }
  if (header) {
    candidates.push(header.title);
    candidates.push(header.subtitle);
  }
  for (var i = 0; i < candidates.length; i++) {
    var season = seasonFromText(candidates[i]);
    if (season) {
      return season;
    }
  }
  return seasonFromRefId(ref && ref.id) || 1;
}

// 按钮名里写了“第 N 季”（旧版按季分组的页面）就归到那一季，否则都是当前页这一季的线路。
function seasonNumber(name, fallback) {
  var value = trim(name);
  if (value) {
    var match = value.match(/第\s*([0-9一二三四五六七八九十两]+)\s*季/);
    if (match) {
      var season = chineseNumber(match[1]);
      if (!isNaN(season) && season > 0) {
        return season;
      }
    }
    match = value.match(/season\s*(\d+)/i);
    if (match) {
      var numbered = parseInt(match[1], 10);
      if (!isNaN(numbered) && numbered > 0) {
        return numbered;
      }
    }
  }
  return fallback;
}

function episodeNumber(name, fallback) {
  var match = trim(name).match(/E\s*(\d+)/i)
    || trim(name).match(/第\s*(\d+)\s*[集话話]/)
    || trim(name).match(/^(\d{1,4})$/);
  if (match) {
    var episode = parseInt(match[1], 10);
    if (!isNaN(episode) && episode > 0) {
      return episode;
    }
  }
  return fallback;
}

function qualityFrom(name) {
  var match = trim(name).match(/(\d{3,4}P)/i);
  return match ? match[1].toUpperCase() : "";
}

function parseSourceButtons(content) {
  var buttons = [];
  var pattern = /<button[^>]*onclick="switchSource\(([\s\S]*?)\)"[^>]*>([\s\S]*?)<\/button>/gi;
  var match;
  while ((match = pattern.exec(content)) !== null) {
    var args = match[1];
    var urlMatch = args.match(/^\s*\d+\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*$/);
    if (!urlMatch) {
      urlMatch = args.match(/,\s*'([^']*)'\s*,\s*'([^']*)'\s*$/);
    }
    if (!urlMatch) {
      continue;
    }
    var url = decodeEntities(urlMatch[1]);
    if (!url) {
      continue;
    }
    buttons.push({
      url: url,
      format: trim(urlMatch[2]) || "m3u8",
      name: stripTags(match[2]),
    });
  }
  return buttons;
}

function parseEpisodes(url) {
  if (!url || url.indexOf("$") === -1) {
    return null;
  }
  var segments = String(url).split("#");
  var episodes = [];
  for (var i = 0; i < segments.length; i++) {
    var separator = segments[i].indexOf("$");
    if (separator <= 0) {
      continue;
    }
    var name = trim(segments[i].slice(0, separator));
    var episodeURL = trim(segments[i].slice(separator + 1));
    if (!episodeURL) {
      continue;
    }
    episodes.push({ name: name, url: episodeURL });
  }
  return episodes.length > 0 ? episodes : null;
}

function episodeTitle(name, number) {
  var text = trim(name);
  if (!text) {
    return "第" + number + "集";
  }
  if (/^E\s*\d+$/i.test(text) || /^第\s*\d+\s*[集话話]$/.test(text)) {
    return "第" + number + "集";
  }
  return text;
}

function groupSourceButtons(buttons, pageSeason) {
  var groups = {};
  var order = [];
  for (var i = 0; i < buttons.length; i++) {
    var button = buttons[i];
    var season = seasonNumber(button.name, null) || pageSeason || 1;
    if (!groups[season]) {
      groups[season] = [];
      order.push(season);
    }
    groups[season].push(button);
  }
  order.sort(function (a, b) {
    return a - b;
  });
  return { order: order, groups: groups };
}

function collectEpisodes(buttons, pageSeason) {
  var grouped = groupSourceButtons(buttons, pageSeason);
  var episodes = [];
  for (var g = 0; g < grouped.order.length; g++) {
    var season = grouped.order[g];
    var group = grouped.groups[season];
    var episodeMap = {};
    var numbers = [];
    for (var i = 0; i < group.length; i++) {
      var list = parseEpisodes(group[i].url);
      if (list) {
        for (var j = 0; j < list.length; j++) {
          var number = episodeNumber(list[j].name, j + 1);
          if (!episodeMap[number]) {
            episodeMap[number] = true;
            numbers.push(number);
          }
        }
      } else if (!episodeMap[1]) {
        episodeMap[1] = true;
        numbers.push(1);
      }
    }
    numbers.sort(function (a, b) {
      return a - b;
    });
    for (var n = 0; n < numbers.length; n++) {
      var episode = numbers[n];
      var title = "";
      for (var k = 0; k < group.length && !title; k++) {
        var sourceList = parseEpisodes(group[k].url);
        if (!sourceList) {
          title = episodeTitle(group[k].name, episode);
          break;
        }
        for (var m = 0; m < sourceList.length; m++) {
          if (episodeNumber(sourceList[m].name, m + 1) === episode) {
            title = episodeTitle(sourceList[m].name, episode);
            break;
          }
        }
      }
      episodes.push({ season: season, episode: episode, title: title || "第" + episode + "集" });
    }
  }
  episodes.sort(function (a, b) {
    return a.season === b.season ? a.episode - b.episode : a.season - b.season;
  });
  return episodes;
}

function resolveEpisodeURL(button, episode) {
  var list = parseEpisodes(button.url);
  if (!list || list.length === 0) {
    return button.url;
  }
  var index = -1;
  for (var i = 0; i < list.length; i++) {
    if (episodeNumber(list[i].name, i + 1) === episode) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    index = Math.min(Math.max(episode - 1, 0), list.length - 1);
  }
  return list[index].url;
}

function lineLabel(name, index) {
  var text = trim(name);
  if (text) {
    var withoutQuality = trim(text.replace(/\([^)]*P\)/gi, " ")).replace(/\s+/g, " ");
    if (withoutQuality && /播放源|线路|line/i.test(withoutQuality)) {
      return withoutQuality;
    }
  }
  return "线路 " + index;
}

function looksLikeSeries(buttons) {
  for (var i = 0; i < buttons.length; i++) {
    if (/第\s*\d+\s*季/.test(buttons[i].name) || parseEpisodes(buttons[i].url)) {
      return true;
    }
  }
  return false;
}

function parseRelated(content) {
  var index = content.indexOf("相关推荐");
  if (index < 0) {
    return [];
  }
  var end = content.indexOf("</main>", index);
  if (end < 0) {
    end = content.indexOf("<footer", index);
  }
  if (end < 0) {
    end = Math.min(content.length, index + 80000);
  }
  var section = content.slice(index, end);
  var parsed = parseListPage(section);
  var items = parsed.items;
  if (items.length === 0) {
    items = dedupeItems(parseLooseCards(section));
  }
  return items.slice(0, MAX_RELATED_ITEMS);
}

function buildDetail(html, ref) {
  var content = html.slice(contentStartIndex(html));
  var structured = parseStructuredData(html);
  var header = parseDetailHeader(content);

  var title = structured && structured.name ? stripTags(asText(structured.name)) : header.title;
  if (!title) {
    return null;
  }

  var buttons = parseSourceButtons(content);
  var pageSeason = detectPageSeason(ref, structured, header);
  var mediaType = mediaTypeFromStructuredData(structured) || ref.mediaType || null;
  if (!mediaType && buttons.length > 0) {
    mediaType = looksLikeSeries(buttons) ? "tv" : "movie";
  }

  var detailRef = { source: "custom", id: ref.id };
  if (mediaType) {
    detailRef.mediaType = mediaType;
  }

  var genres = [];
  var structuredGenres = asArray(structured ? structured.genre : null);
  for (var i = 0; i < structuredGenres.length; i++) {
    var genreName = trim(typeof structuredGenres[i] === "string" ? structuredGenres[i] : asText(structuredGenres[i]));
    if (genreName) {
      genres.push(genreName);
    }
  }
  if (genres.length === 0 && header.infoText) {
    var infoParts = header.infoText.split("·");
    if (infoParts.length >= 3) {
      var genreParts = trim(infoParts.slice(2).join("·")).split("/");
      for (var g = 0; g < genreParts.length; g++) {
        var partName = trim(genreParts[g]);
        if (partName) {
          genres.push(partName);
        }
      }
    }
  }

  var directors = extractNames(structured ? structured.director : null);
  var actors = extractNames(structured ? structured.actor : null);
  if (directors.length === 0) {
    directors = header.directors;
  }
  if (actors.length === 0) {
    actors = header.actors;
  }
  var people = [];
  for (var d = 0; d < directors.length; d++) {
    people.push({ id: "director:" + directors[d], title: directors[d], role: "导演" });
  }
  for (var a = 0; a < actors.length; a++) {
    people.push({ id: "actor:" + actors[a], title: actors[a], role: "演员" });
  }

  var description = structured && structured.description
    ? stripTags(asText(structured.description))
    : header.description;
  description = truncate(description, MAX_DESCRIPTION_LENGTH);

  var year = "";
  if (structured && structured.datePublished) {
    var dateMatch = String(structured.datePublished).match(/(\d{4})/);
    if (dateMatch) {
      year = dateMatch[1];
    }
  }
  if (!year && header.infoText) {
    var yearMatch = header.infoText.match(/((?:19|20)\d{2})/);
    if (yearMatch) {
      year = yearMatch[1];
    }
  }

  var rating = null;
  if (structured && structured.aggregateRating) {
    var ratingValue = parseFloat(structured.aggregateRating.ratingValue);
    if (!isNaN(ratingValue) && ratingValue > 0) {
      rating = ratingValue;
    }
  }
  if (rating === null && header.rating !== null) {
    rating = header.rating;
  }

  var poster = "";
  if (structured && structured.image) {
    var image = structured.image;
    if (Array.isArray(image)) {
      image = image.length > 0 ? image[0] : null;
    }
    if (image && typeof image === "object") {
      image = image.url || image.contentUrl || "";
    }
    poster = resolveURL(asText(image));
  }
  if (!poster) {
    poster = header.poster;
  }

  var detail = { ref: detailRef, title: title };
  var subtitle = structured && structured.alternateName
    ? stripTags(asText(structured.alternateName))
    : header.subtitle;
  if (subtitle && subtitle !== title) {
    detail.subtitle = subtitle;
  }
  if (description) {
    detail.description = description;
  }
  if (rating !== null) {
    detail.rating = rating;
  }
  if (year) {
    detail.releaseDate = year;
  }
  if (genres.length) {
    detail.genre = genres.join(" / ");
    detail.genres = genres.map(function (name, index) {
      return { id: "ddys-genre-" + index, title: name };
    });
  }
  if (people.length) {
    detail.people = people;
  }
  if (poster) {
    detail.images = { poster: poster, detailPoster: poster };
  }
  if (mediaType === "tv" && buttons.length) {
    var episodes = collectEpisodes(buttons, pageSeason);
    if (episodes.length) {
      detail.episodes = episodes;
    }
  }
  var related = parseRelated(content);
  if (related.length) {
    detail.related = related;
  }
  return detail;
}

// ========== 播放线路 ==========

function playbackPageURL(ref) {
  try {
    return BASE_URL + refPath(ref && ref.id);
  } catch (error) {
    return BASE_URL + "/";
  }
}

// 播放时尽量按浏览器的方式请求：部分 CDN 会对播放器 UA 或 root Referer 返回 404。
function playbackHeaders(ref) {
  return {
    "User-Agent": BROWSER_HEADERS["User-Agent"],
    "Accept": "*/*",
    "Accept-Language": BROWSER_HEADERS["Accept-Language"],
    "Referer": playbackPageURL(ref),
  };
}

var probeCache = {};
var probeCacheKeys = [];

function rememberProbe(url, state) {
  if (!probeCache[url]) {
    probeCacheKeys.push(url);
  }
  probeCache[url] = { state: state, at: new Date().getTime() };
  while (probeCacheKeys.length > PROBE_CACHE_LIMIT) {
    var oldest = probeCacheKeys.shift();
    delete probeCache[oldest];
  }
}

function cachedProbe(url) {
  var entry = probeCache[url];
  if (!entry) {
    return null;
  }
  // 探测失败的结论只保留一分钟，避免一次超时把线路长期判为未知。
  var ttl = entry.state === "unknown" ? 60 * 1000 : PROBE_CACHE_TTL_MS;
  if (new Date().getTime() - entry.at > ttl) {
    delete probeCache[url];
    return null;
  }
  return entry.state;
}

// 只探测 m3u8：mp4 一旦 CDN 不支持 Range 会整段下载，不能在这里探。
function probeM3U8(ctx, url, ref) {
  var cached = cachedProbe(url);
  if (cached) {
    return Promise.resolve(cached);
  }
  var headers;
  try {
    headers = playbackHeaders(ref);
  } catch (error) {
    return Promise.resolve("unknown");
  }
  headers["Range"] = "bytes=0-2047";
  headers["Origin"] = BASE_URL;
  return ctx.http.get(url, {
    headers: headers,
    timeoutMs: PROBE_TIMEOUT_MS,
  }).then(function (response) {
    var status = response && typeof response.status === "number" ? response.status : 0;
    var state = "unknown";
    if (status === 404 || status === 410) {
      state = "dead";
    } else if (status >= 200 && status < 300) {
      var text = typeof response.data === "string" ? response.data : "";
      text = text.replace(/^\uFEFF/, "").replace(/^\s+/, "");
      if (text.indexOf("#EXTM3U") === 0) {
        state = "alive";
      }
    }
    rememberProbe(url, state);
    return state;
  }, function () {
    return "unknown";
  });
}

// 可用线路放前面，确认失效的放最后；探测不到（权限/超时/拦截）保持 unknown。
async function reorderSourcesByLiveness(ctx, ref, sources) {
  if (sources.length < 2) {
    return sources;
  }
  var states = [];
  var probes = [];
  for (var i = 0; i < sources.length; i++) {
    states.push("unknown");
    if (/\.m3u8(?:\?|$)/i.test(sources[i].url)) {
      probes.push((function (index) {
        return probeM3U8(ctx, sources[index].url, ref).then(function (state) {
          states[index] = state;
        });
      })(i));
    }
  }
  if (probes.length === 0) {
    return sources;
  }
  await Promise.all(probes);
  var hasAlive = false;
  var hasDead = false;
  for (var s = 0; s < states.length; s++) {
    if (states[s] === "alive") {
      hasAlive = true;
    } else if (states[s] === "dead") {
      hasDead = true;
    }
  }
  if (!hasAlive && !hasDead) {
    return sources;
  }
  var alive = [];
  var unknown = [];
  var dead = [];
  for (var j = 0; j < sources.length; j++) {
    if (states[j] === "alive") {
      alive.push(sources[j]);
    } else if (states[j] === "dead") {
      dead.push(sources[j]);
    } else {
      unknown.push(sources[j]);
    }
  }
  var usable = alive.concat(unknown);
  if (usable.length === 0) {
    console.warn("低端影视线路检测：所有线路都不可用（" + sources.length + " 条），让上层提示没有线路");
    return [];
  }
  if (dead.length > 0) {
    console.warn("低端影视线路检测：可用 " + alive.length + " 条，未知 " + unknown.length + " 条，移除失效 " + dead.length + " 条");
  } else {
    console.warn("低端影视线路检测：可用 " + alive.length + " 条，未知 " + unknown.length + " 条");
  }
  return usable;
}

// ========== 搜索 ==========

function parseSearchItems(html) {
  var items = [];
  var pattern = /<div[^>]*class="[^"]*\bmovie-card\b[^"]*"[^>]*>/gi;
  var marks = [];
  var match;
  while ((match = pattern.exec(html)) !== null) {
    marks.push(match.index);
  }
  for (var i = 0; i < marks.length; i++) {
    var end = i + 1 < marks.length ? marks[i + 1] : Math.min(html.length, marks[i] + 20000);
    var item = parseCardSlice(html.slice(marks[i], end));
    if (item) {
      items.push(item);
    }
  }
  return dedupeItems(items).slice(0, MAX_CARD_ITEMS);
}

async function searchViaHTML(ctx, keyword) {
  // type=movie 让站点直接返回全部“影视”结果；不带它只会给每类前几条。
  var result = await requestText(ctx, "GET", "/search", {
    headers: mergeHeaders({ "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" }),
    query: { q: keyword, type: "movie" },
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  // 校验失败时站点会 302 回首页，这里会把首页卡片误当成搜索结果。
  var canonicalMatch = result.text.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/i)
    || result.text.match(/<link[^>]*href="([^"]+)"[^>]*rel="canonical"/i);
  if (canonicalMatch) {
    var canonicalPath = canonicalMatch[1].replace(/^https?:\/\/[^\/]+/i, "");
    if (!canonicalPath || canonicalPath === "/" || canonicalPath.indexOf("/login") === 0) {
      throw ExtensionError({ code: "unavailable", message: "搜索页返回异常。", retryable: true });
    }
  }
  // 结果后面跟着“不如看看”推荐卡，不能算进搜索结果。
  var cut = result.text.indexOf("不如看看");
  var resultsHTML = cut > 0 ? result.text.slice(0, cut) : result.text;
  return { items: parseSearchItems(resultsHTML) };
}

async function searchViaAPI(ctx, keyword) {
  var result = await requestText(ctx, "GET", "/api/search-suggest", {
    headers: mergeHeaders({ "Accept": "application/json" }),
    query: { q: keyword },
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  var payload = result.json;
  if (!payload || typeof payload !== "object" || payload.success !== true || !payload.data) {
    return [];
  }
  var rows = payload.data;
  var items = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || !row.url) {
      continue;
    }
    var item = { ref: { source: "custom", id: refPath(row.url) }, title: trim(row.title) };
    if (!item.title) {
      continue;
    }
    var typeCode = trim(row.type_code);
    if (typeCode === "movie") {
      item.ref.mediaType = "movie";
    } else if (typeCode) {
      item.ref.mediaType = "tv";
    }
    var subtitleParts = [];
    if (row.type) {
      subtitleParts.push(trim(row.type));
    }
    if (row.year) {
      subtitleParts.push(String(row.year));
    }
    if (subtitleParts.length) {
      item.subtitle = subtitleParts.join(" · ");
    }
    if (row.year) {
      item.releaseDate = String(row.year);
    }
    var rating = parseFloat(row.rating);
    if (!isNaN(rating) && rating > 0) {
      item.rating = rating;
    }
    items.push(item);
  }
  return items;
}

function isChallengeError(error) {
  return !!error && /人机验证|Cloudflare|challenge/i.test(describeError(error));
}

// ========== 分类 / 分页 ==========

function categoryFrom(params) {
  var value = params ? params.category : null;
  if (typeof value !== "string" || !trim(value)) {
    return CATEGORIES[0];
  }
  value = trim(value);
  if (value.charAt(0) === "/") {
    return { value: "custom", title: value, path: value };
  }
  for (var i = 0; i < CATEGORIES.length; i++) {
    if (CATEGORIES[i].value === value) {
      return CATEGORIES[i];
    }
  }
  return CATEGORIES[0];
}

function categoryPagePath(category, page) {
  if (!page || page <= 1) {
    return category.path;
  }
  if (category.path === "/") {
    return "/page/" + page;
  }
  return category.path + "/page/" + page;
}

function pageNumberFromToken(token) {
  if (!token) {
    return 1;
  }
  var value = 1;
  if (typeof token === "number") {
    value = token;
  } else if (typeof token === "string") {
    value = parseInt(token, 10);
  } else if (typeof token.page === "number") {
    value = token.page;
  }
  if (typeof value === "number" && !isNaN(value) && value > 0) {
    return Math.floor(value);
  }
  return 1;
}

async function loadCategoryPage(ctx, category, page) {
  var html = await fetchHTML(ctx, categoryPagePath(category, page));
  var parsed = parseListPage(html);
  if (parsed.items.length === 0) {
    console.warn("低端影视没有解析到条目：" + category.path + " 第 " + page + " 页");
  }
  return parsed;
}

// ========== 扩展 handlers ==========

async function loadWidget(ctx, input) {
  var params = input && input.params ? input.params : {};
  var category = categoryFrom(params);
  var page = pageNumberFromToken(input ? input.page : null);
  var parsed = await loadCategoryPage(ctx, category, page);
  var result = { items: parsed.items };
  if (parsed.pages > 1 && page < parsed.pages) {
    result.next = { type: "page", page: page + 1 };
  }
  return result;
}

async function loadList(ctx, input) {
  var params = input && input.params ? input.params : {};
  var category = categoryFrom(params);
  var page = pageNumberFromToken(input ? input.page : null);
  var parsed = await loadCategoryPage(ctx, category, page);
  var result = { items: parsed.items };
  if (parsed.pages > page) {
    result.next = { page: page + 1 };
  }
  return result;
}

async function loadDetail(ctx, input) {
  var ref = input && input.ref ? input.ref : null;
  if (!ref || !ref.id) {
    throw ExtensionError({ code: "invalid_params", message: "缺少条目地址", retryable: false });
  }
  var html = await fetchHTML(ctx, refPath(ref.id));
  return buildDetail(html, ref);
}

async function playbackSources(ctx, input) {
  var ref = input && input.ref ? input.ref : null;
  if (!ref || !ref.id) {
    throw ExtensionError({ code: "invalid_params", message: "缺少条目地址", retryable: false });
  }
  var html = await fetchHTML(ctx, refPath(ref.id));
  var content = html.slice(contentStartIndex(html));
  var structured = parseStructuredData(html);
  var buttons = parseSourceButtons(content);
  if (buttons.length === 0) {
    console.warn("低端影视详情页没有解析到播放源：" + ref.id);
    return [];
  }
  var mediaType = mediaTypeFromStructuredData(structured) || ref.mediaType || null;
  if (!mediaType) {
    mediaType = looksLikeSeries(buttons) ? "tv" : "movie";
  }

  var sources = [];
  if (mediaType === "tv") {
    var header = parseDetailHeader(content);
    var pageSeason = detectPageSeason(ref, structured, header);
    var grouped = groupSourceButtons(buttons, pageSeason);
    var season = typeof input.season === "number" && input.season > 0 ? input.season : pageSeason;
    var group = grouped.groups[season];
    if (!group) {
      if (grouped.order.length === 1) {
        season = grouped.order[0];
        group = grouped.groups[season];
      } else {
        console.warn("低端影视没有找到对应季的线路：" + ref.id + " 第 " + season + " 季");
        return [];
      }
    }
    var episode = typeof input.episode === "number" && input.episode > 0 ? input.episode : 1;
    var multiSeason = grouped.order.length > 1;
    for (var t = 0; t < group.length; t++) {
      var quality = qualityFrom(group[t].name);
      var source = {
        id: (multiSeason ? "s" + season + "-" : "") + "line-" + (t + 1),
        name: lineLabel(group[t].name, t + 1),
        url: resolveEpisodeURL(group[t], episode),
        headers: playbackHeaders(ref),
      };
      if (quality) {
        source.description = quality;
      }
      sources.push(source);
    }
    return reorderSourcesByLiveness(ctx, ref, sources);
  }

  for (var i = 0; i < buttons.length; i++) {
    var movieQuality = qualityFrom(buttons[i].name);
    var movieSource = {
      id: "line-" + (i + 1),
      name: lineLabel(buttons[i].name, i + 1),
      url: buttons[i].url,
      headers: playbackHeaders(ref),
    };
    if (movieQuality) {
      movieSource.description = movieQuality;
    }
    sources.push(movieSource);
  }
  return reorderSourcesByLiveness(ctx, ref, sources);
}

async function searchExtension(ctx, input) {
  var keyword = trim(input ? input.query : "");
  if (!keyword) {
    return { items: [] };
  }
  var items = [];
  var htmlSucceeded = false;
  if (!htmlSearchBlocked) {
    try {
      var htmlResult = await searchViaHTML(ctx, keyword);
      items = htmlResult.items;
      htmlSucceeded = true;
    } catch (error) {
      console.warn("HTML 搜索不可用：" + describeError(error));
      if (isChallengeError(error)) {
        htmlSearchBlocked = true;
      }
    }
  }
  if (!htmlSucceeded) {
    items = await searchViaAPI(ctx, keyword);
  }
  return { items: items };
}

// ========== placeholder 示例数据 ==========

function placeholderItem(id, title, subtitle, mediaType, rating) {
  var item = {
    ref: { source: "custom", id: id },
    title: title,
    subtitle: subtitle,
    images: { poster: IMAGE_BASE + "/movies/" + id.split("/").pop() + ".webp" },
  };
  if (mediaType) {
    item.ref.mediaType = mediaType;
  }
  if (subtitle) {
    var yearMatch = subtitle.match(/((?:19|20)\d{2})/);
    if (yearMatch) {
      item.releaseDate = yearMatch[1];
    }
  }
  if (typeof rating === "number") {
    item.rating = rating;
  }
  return item;
}

function placeholderContent() {
  return {
    items: [
      placeholderItem("/movie/borders-special-cases-unit", "边界者：警视厅特殊事件对策班", "2026 · 剧集", "tv"),
      placeholderItem("/movie/house-of-the-dragon-season-1", "龙之家族 第一季", "2022 · 剧集", "tv", 8.7),
      placeholderItem("/movie/sheng-tang-qi-an", "盛唐奇案", "2026 · 剧集", "tv", 6.2),
      placeholderItem("/movie/yi-chu-ji-fa-chu-fa", "特工追缉令", "2021 · 电影", "movie", 5.2),
      placeholderItem("/movie/high-country-season-one", "高地迷踪 第一季", "2024 · 剧集", "tv"),
      placeholderItem("/movie/kians-bizarre-bnb-2", "旗安84的奇趣民宿 第二季", "2026 · 综艺", "tv"),
      placeholderItem("/movie/wild-bright-time-travel", "灿烂如野", "2026 · 剧集", "tv"),
      placeholderItem("/movie/king-affection", "恋慕", "2021 · 剧集", "tv", 6.6),
      placeholderItem("/movie/you-are-my-fateful-love", "你是迟来的欢喜", "2026 · 剧集", "tv", 7.0),
      placeholderItem("/movie/boonie-bears-magic-treasures-2", "熊出没之神奇宝物2", "2026 · 动漫", "tv"),
    ],
  };
}

// ========== 包定义 ==========

definePackage({
  id: "conflux.ddys",
  title: "低端影视",
  description: "低端影视（ddys.io）在线影视资源：首页 / 电影 / 剧集 / 综艺 / 动漫分类浏览、搜索、详情与在线播放。",
  author: "Anonymous",
  site: "https://ddys.io",
  icon: "https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/others/icons/ddys.png",
  version: "1.0.4",
  engine: 1,
  permissions: {
    network: [
      "https://ddys.io",
      "https://vip1.lz-cdn.com",
      "https://vip1.lz-cdn1.com",
      "https://v.lzcdn26.com",
      "https://v.lzcdn27.com",
      "https://v.lzcdn28.com",
      "https://c1.rrcdnbf2.com",
      "https://c1.rrcdnbf4.com",
      "https://c1.rrcdnbf5.com",
      "https://c1.rrcdnbf6.com",
      "https://hn.bfvvs.com",
      "https://vv.jisuzyv.com",
      "https://v.baofeng11.com",
      "https://v.fengbao10.com",
      "https://v.fengbao11.com",
      "https://p.bvvvvvvv7f.com",
      "https://v.lfthirtytwo.com",
      "https://v2.ddys.ai",
    ],
  },
  settings: [],
  extensions: [
    {
      type: "widget",
      id: "latest",
      title: "低端影视",
      description: "浏览低端影视的最新资源，可在实例里选择分类。",
      template: "poster-grid",
      header: "list",
      ref: { source: "custom", id: "browse" },
      cache: { ttlSeconds: 600 },
      params: [
        {
          name: "category",
          title: "分类",
          type: "select",
          default: "home",
          options: [
            { title: "首页", value: "home" },
            { title: "电影", value: "movie" },
            { title: "剧集", value: "series" },
            { title: "综艺", value: "variety" },
            { title: "动漫", value: "anime" },
          ],
        },
      ],
      placeholderData: placeholderContent(),
      load: async function (ctx, input) {
        return loadWidget(ctx, input);
      },
    },
    {
      type: "list",
      id: "browse",
      title: "低端影视",
      description: "低端影视分类列表。",
      style: "grid",
      accepts: { sources: ["custom"] },
      // 列表导航栏的搜索框；关键词走同包 search "main"
      search: { id: "main" },
      cache: { ttlSeconds: 600 },
      load: async function (ctx, input) {
        return loadList(ctx, input);
      },
    },
    {
      type: "search",
      id: "main",
      title: "低端影视",
      description: "搜索低端影视站点。",
      cache: { ttlSeconds: 1800 },
      search: async function (ctx, input) {
        return searchExtension(ctx, input);
      },
    },
    {
      type: "detail",
      id: "main",
      title: "低端影视详情",
      description: "读取低端影视详情页的标题、简介、评分、演职员和剧集列表。",
      accepts: { sources: ["custom"] },
      load: async function (ctx, input) {
        return loadDetail(ctx, input);
      },
    },
    {
      type: "playback",
      id: "main",
      title: "低端影视线路",
      description: "从低端影视详情页解析在线播放线路。",
      accepts: { sources: ["custom"] },
      sources: async function (ctx, input) {
        return playbackSources(ctx, input);
      },
    },
  ],
});
