// 红果短剧 · 增强线路（Extension）
//
// 与 ../hongguo.js 共用官网数据（widget / 搜索 / 列表 / 详情），
// 区别只在 playback：优先通过本机 relay 用 openhongguo SDK 解析官方接口的
// 播放模型与 content key，返回 URL + options.decryptionKey，因此可以播全部分集。
//
// relay 只负责解析，不做解密、不转码；relay 不可用时回退官网公开线路（只有前若干集）。
// relay 代码见同目录 relay.mjs，默认 http://127.0.0.1:8787。
//
// 官网数据来源：
// - 首页 `/`：SSR `_ROUTER_DATA` → bannerList 与 homeSections
// - 榜单 `/rank/{key}`：data-fn-args JSON → rankList + pagination
// - 分类 `/category/{route}`：SSR `_ROUTER_DATA` → recommendList（24 条/页）
// - 详情 `/detail?series_id=`：SSR `_ROUTER_DATA` → seriesDetail（含完整 vid_list）
// - 搜索 `/api/search/result?aid=8662&query=&page=`：JSON，无需签名
// - 官网公开播放 `/api/video/protected/fallback-play-info`：仅作 relay 不可用时的兜底
//
// 说明：
// - `options.decryptionKey` 是 PlaybackSource 的可选字段；空字符串视为没写。
// - 官网没有分集剧照：detail 的每集 still 用剧集竖版封面兜底。
// - 所有 ref 统一使用 source "custom"，id 是红果的 series_id（纯数字字符串）。
// - 不依赖 DOM：SSR 数据用字符串定位 + JSON.parse 解析。

var BASE = "https://hongguoduanju.com";
var USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
var REQUEST_TIMEOUT_MS = 20000;
var MAX_DESCRIPTION_LENGTH = 2000;
var MAX_CARD_DESCRIPTION = 180;
var HOME_CACHE_SECONDS = 1800;
var DETAIL_CACHE_SECONDS = 600;
var VID_CACHE_TTL_SECONDS = 6 * 60 * 60;
var API_AID = "8662";
var RELAY_DEFAULT_URL = "http://127.0.0.1:8787";
var RELAY_TIMEOUT_MS = 30000;

var HOME_TABS = [
  { value: "all", title: "热播短剧" },
  { value: "human", title: "热播真人剧" },
  { value: "comic", title: "热播漫剧" },
  { value: "ai", title: "热播AI剧" },
];

var RANK_BOARDS = [
  { value: "hot-drama", title: "红果热播榜" },
  { value: "hot-real-drama", title: "真人剧热播榜" },
  { value: "hot-comic-drama", title: "漫剧热播榜" },
  { value: "hot-ai-drama", title: "AI剧热播榜" },
];

var CATEGORIES = [
  { value: "real-drama", title: "真人剧" },
  { value: "comic-drama", title: "漫剧" },
  { value: "comic", title: "漫画" },
  { value: "ai-drama", title: "AI剧" },
];

// ========== 基础工具 ==========

function trim(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/^\s+|\s+$/g, "");
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isArray(value) {
  return Object.prototype.toString.call(value) === "[object Array]";
}

function isFiniteNumber(value) {
  return typeof value === "number" && value === value && value !== Infinity && value !== -Infinity;
}

function positiveInt(value) {
  var number = Number(value);
  if (!isFiniteNumber(number) || number <= 0 || Math.floor(number) !== number) return null;
  return number;
}

function positiveRating(value) {
  var number = Number(value);
  if (!isFiniteNumber(number) || number <= 0 || number > 10) return null;
  return Math.round(number * 10) / 10;
}

function truncate(value, limit) {
  var text = trim(value);
  if (!text) return "";
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "…";
}

function joinNonEmpty(parts, separator) {
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var part = trim(parts[i]);
    if (part) out.push(part);
  }
  return out.join(separator || " · ");
}

function describeError(error) {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message) return error.message;
  return String(error);
}

function asExtensionError(error, message) {
  if (error && error.name === "ExtensionError") return error;
  return ExtensionError({
    code: "unavailable",
    message: message + "：" + describeError(error),
    retryable: true,
  });
}

function httpError(status, label) {
  if (status === 404) {
    return ExtensionError({ code: "not_found", message: label + "不存在", retryable: false });
  }
  if (status === 400 || status === 422) {
    return ExtensionError({ code: "invalid_params", message: label + "请求参数无效", retryable: false });
  }
  if (status === 429) {
    return ExtensionError({ code: "rate_limited", message: "红果短剧请求过于频繁，请稍后重试", retryable: true });
  }
  if (status === 0 || status >= 500) {
    return ExtensionError({ code: "unavailable", message: "红果短剧暂时不可用（HTTP " + status + "）", retryable: true });
  }
  return ExtensionError({ code: "unavailable", message: "红果短剧请求失败（HTTP " + status + "）", retryable: true });
}

function invalidParams(message) {
  return ExtensionError({ code: "invalid_params", message: message, retryable: false });
}

function unavailable(message) {
  return ExtensionError({ code: "unavailable", message: message, retryable: true });
}

// ========== 响应处理 ==========

function decodeUTF8(data) {
  if (!data || typeof data.byteLength !== "number") return "";
  var bytes;
  if (typeof Uint8Array === "function" && data instanceof Uint8Array) {
    bytes = data;
  } else {
    try {
      bytes = new Uint8Array(data);
    } catch (error) {
      return "";
    }
  }
  var out = "";
  var i = 0;
  while (i < bytes.length) {
    var byte = bytes[i++];
    if (byte < 0x80) {
      out += String.fromCharCode(byte);
    } else if (byte >= 0xc0 && byte < 0xe0 && i < bytes.length) {
      out += String.fromCharCode(((byte & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (byte >= 0xe0 && byte < 0xf0 && i + 1 < bytes.length) {
      out += String.fromCharCode(((byte & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    } else if (byte >= 0xf0 && i + 2 < bytes.length) {
      var code = ((byte & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    }
  }
  return out;
}

function textOfData(data) {
  if (typeof data === "string") return data;
  if (!data) return "";
  if (typeof data.byteLength === "number") return decodeUTF8(data);
  return "";
}

function jsonOfData(data) {
  if (data && typeof data === "object" && typeof data.byteLength !== "number") return data;
  var text = textOfData(data);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function normalizeResponse(response) {
  var status = response && typeof response.status === "number" ? response.status : 0;
  var data = response ? response.data : null;
  return {
    status: status,
    text: textOfData(data),
    json: jsonOfData(data),
    headers: (response && response.headers) || {},
  };
}

function webHeaders(extra) {
  var headers = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
  if (extra) {
    for (var key in extra) {
      if (hasOwn(extra, key)) headers[key] = extra[key];
    }
  }
  return headers;
}

function jsonHeaders(extra) {
  var headers = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": BASE + "/",
  };
  if (extra) {
    for (var key in extra) {
      if (hasOwn(extra, key)) headers[key] = extra[key];
    }
  }
  return headers;
}

async function httpGet(ctx, path, options) {
  var opts = options || {};
  var url = path.indexOf("http") === 0 ? path : BASE + path;
  var response;
  try {
    response = await ctx.http.get(url, {
      headers: opts.headers || webHeaders(),
      query: opts.query,
      timeoutMs: opts.timeoutMs || REQUEST_TIMEOUT_MS,
      cacheTtlSeconds: opts.cacheTtlSeconds,
    });
  } catch (error) {
    throw asExtensionError(error, "无法访问红果短剧");
  }
  return normalizeResponse(response);
}

async function httpPostJSON(ctx, path, query, body, headers) {
  var url = path.indexOf("http") === 0 ? path : BASE + path;
  var response;
  try {
    // 运行时契约是 ctx.http.post(url, options)，body 放在 options.body（不是第二参）。
    response = await ctx.http.post(url, {
      headers: headers || jsonHeaders(),
      query: query,
      body: body,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    throw asExtensionError(error, "无法访问红果短剧");
  }
  return normalizeResponse(response);
}

async function fetchPage(ctx, path, options) {
  var opts = options || {};
  var response = await httpGet(ctx, path, opts);
  if (response.status === 200 || response.status === 203) {
    if (!response.text) throw unavailable("红果短剧返回了空页面");
    return response;
  }
  if (response.status === 404) return response;
  throw httpError(response.status, opts.label || "红果短剧页面");
}

// ========== SSR / 内嵌 JSON 解析 ==========

function fromCodePoint(code) {
  if (!isFiniteNumber(code) || code < 0 || code > 0x10ffff) return "";
  if (code <= 0xffff) return String.fromCharCode(code);
  code -= 0x10000;
  return String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
}

function htmlUnescape(value) {
  return String(value)
    .replace(/&#x([0-9a-fA-F]+);/g, function (match, hex) {
      return fromCodePoint(parseInt(hex, 16));
    })
    .replace(/&#(\d+);/g, function (match, dec) {
      return fromCodePoint(parseInt(dec, 10));
    })
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// 从 start（指向 { 或 [）开始，按字符串/转义规则找到配对的收尾字符。
function balancedEnd(text, start) {
  var depth = 0;
  var inString = false;
  var escaped = false;
  for (var i = start; i < text.length; i++) {
    var ch = text.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function parseAssignedJSON(html, marker) {
  var from = 0;
  while (from < html.length) {
    var hit = html.indexOf(marker, from);
    if (hit < 0) return null;
    var eq = html.indexOf("=", hit + marker.length - 1);
    if (eq >= 0) {
      var slice = html.slice(eq + 1, eq + 4096);
      var open = slice.search(/[\{\[]/);
      if (open >= 0) {
        var start = eq + 1 + open;
        var end = balancedEnd(html, start);
        if (end > start) {
          try {
            return JSON.parse(html.slice(start, end));
          } catch (error) {
            // 继续找下一个标记
          }
        }
      }
    }
    from = hit + marker.length;
  }
  return null;
}

function extractRouterData(html) {
  return parseAssignedJSON(html, "_ROUTER_DATA");
}

function findLoaderValue(router, key) {
  if (!router || !router.loaderData || typeof router.loaderData !== "object") return null;
  var loaderData = router.loaderData;
  for (var name in loaderData) {
    if (!hasOwn(loaderData, name)) continue;
    var value = loaderData[name];
    if (value && typeof value === "object" && !isArray(value) && value[key] !== null && value[key] !== undefined) {
      return value;
    }
  }
  return null;
}

// 榜单页把数据放在 <script data-fn-args='["rank_xxx","content",{rankList:[...]}]'>；
// 页面里同时还有 mergeLoaderData 的 data-fn-args，所以逐个尝试，取带 rankList 的那个。
function parseRankContent(html) {
  var pattern = /data-fn-args=(?:"([^"]*)"|'([^']*)')/g;
  var match;
  while ((match = pattern.exec(html)) !== null) {
    var raw = match[1] !== undefined ? match[1] : match[2];
    var args;
    try {
      args = JSON.parse(htmlUnescape(raw));
    } catch (error) {
      continue;
    }
    if (!isArray(args)) continue;
    for (var i = 0; i < args.length; i++) {
      var content = args[i];
      if (content && typeof content === "object" && isArray(content.rankList)) return content;
    }
  }
  return null;
}

// ========== 字段归一化 ==========

function stringList(value) {
  var out = [];
  if (!isArray(value)) return out;
  for (var i = 0; i < value.length; i++) {
    var item = trim(value[i]);
    if (item) out.push(item);
  }
  return out;
}

function seriesIdOf(object) {
  if (!object || typeof object !== "object") return "";
  var id = object.series_id || object.seriesId || object.id || object.keyword || "";
  id = trim(id);
  return /^\d+$/.test(id) ? id : "";
}

function titleOf(object) {
  if (!object || typeof object !== "object") return "";
  return trim(object.series_title || object.series_name || object.title || object.name || "");
}

function coverOf(object) {
  if (!object || typeof object !== "object") return "";
  var url = trim(object.series_cover || object.cover || object.poster || object.cover_url || "");
  if (!/^https?:\/\//i.test(url) && !/^\/\//.test(url)) return "";
  if (/^\/\//.test(url)) url = "https:" + url;
  return url;
}

function httpsURL(value) {
  var url = trim(value);
  if (!url) return "";
  if (/^\/\//.test(url)) url = "https:" + url;
  if (!/^https?:\/\//i.test(url)) return "";
  return url;
}

function episodeLabel(object) {
  if (!object || typeof object !== "object") return "";
  var label = trim(object.episode_right_text || "");
  if (label) return label;
  var count = positiveInt(object.episode_cnt || object.episodeCount);
  return count ? "全" + count + "集" : "";
}

function hotTextOf(object) {
  if (!object || typeof object !== "object") return "";
  var text = trim(object.heatText || "");
  if (text) return text;
  if (object.hot_score_data && typeof object.hot_score_data === "object") {
    return trim(object.hot_score_data.text || "");
  }
  return "";
}

function subtitleOf(object) {
  if (!object || typeof object !== "object") return "";
  var label = episodeLabel(object);
  var hot = hotTextOf(object);
  var subtitle = joinNonEmpty([label, hot], " · ");
  if (subtitle) return subtitle;
  var text = trim(object.sub_title || "");
  return text;
}

function tagListOf(object) {
  if (!object || typeof object !== "object") return [];
  var tags = stringList(object.tags);
  if (tags.length) return tags;
  var categories = object.category_list;
  if (isArray(categories)) {
    for (var i = 0; i < categories.length; i++) {
      var category = categories[i];
      if (category && typeof category === "object") {
        var name = trim(category.name || category.category_name || "");
        if (name) tags.push(name);
      }
    }
  }
  return tags;
}

function cardGenreOf(object) {
  // 卡片底部只放前三个标签，避免搜索/分类里的长标签把一行挤爆。
  return tagListOf(object).slice(0, 3).join(" / ");
}

function descriptionOf(object) {
  if (!object || typeof object !== "object") return "";
  return trim(object.series_intro || object.description || object.intro || "");
}

function parseRatingText(value) {
  var match = String(value || "").match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  return positiveRating(match[1]);
}

function ratingOf(object) {
  if (!object || typeof object !== "object") return null;
  if (typeof object.rating === "number") {
    var rating = positiveRating(object.rating);
    if (rating !== null) return rating;
  }
  if (typeof object.score === "number") {
    var score = positiveRating(object.score);
    if (score !== null) return score;
  }
  return parseRatingText(object.scoreText || object.score_text || "");
}

function dateFromUnix(value) {
  var seconds = Number(value);
  if (!isFiniteNumber(seconds) || seconds <= 0) return "";
  // 红果的发布时间戳按北京时间展示，固定加 8 小时，避免不同时区看到不同日期。
  var date = new Date((seconds + 8 * 60 * 60) * 1000);
  if (isNaN(date.getTime())) return "";
  var year = date.getUTCFullYear();
  var month = date.getUTCMonth() + 1;
  var day = date.getUTCDate();
  return year + "-" + (month < 10 ? "0" + month : month) + "-" + (day < 10 ? "0" + day : day);
}

function dateOf(object) {
  if (!object || typeof object !== "object") return "";
  return dateFromUnix(object.first_visible_time || object.create_time || object.publish_time || object.releaseDate);
}

function normalizedRef(id, mediaType) {
  return { source: "custom", id: String(id), mediaType: mediaType || "tv" };
}

function createListItem(object, subtitle) {
  var id = seriesIdOf(object);
  var title = titleOf(object);
  if (!id || !title) return null;
  var item = {
    ref: normalizedRef(id),
    title: title,
  };
  var sub = subtitle !== undefined && subtitle !== null ? trim(subtitle) : subtitleOf(object);
  if (sub) item.subtitle = sub;
  var description = truncate(descriptionOf(object), MAX_CARD_DESCRIPTION);
  if (description) item.description = description;
  var genre = cardGenreOf(object);
  if (genre) item.genre = genre;
  var poster = coverOf(object);
  if (poster) item.images = { poster: poster, cover: poster };
  var rating = ratingOf(object);
  if (rating !== null) item.rating = rating;
  var releaseDate = dateOf(object);
  if (releaseDate) item.releaseDate = releaseDate;
  return item;
}

function createRankItem(entry) {
  if (!entry || typeof entry !== "object") return null;
  var object = {
    series_id: entry.seriesId || entry.id,
    title: entry.title,
    cover: entry.cover,
    description: entry.description,
    tags: entry.tags,
    scoreText: entry.scoreText,
  };
  var subtitle = joinNonEmpty([entry.heatText, entry.scoreText, isArray(entry.statusTags) ? entry.statusTags[0] : ""], " · ");
  return createListItem(object, subtitle);
}

function createBannerItem(banner, meta) {
  if (!banner || typeof banner !== "object") return null;
  var id = seriesIdOf(banner);
  var source = meta && typeof meta === "object" ? meta : banner;
  var title = trim(source.series_title || source.series_name || banner.series_name || banner.title || "");
  if (!id || !title) return null;
  var item = { ref: normalizedRef(id), title: title };
  // banner 自带的 series_cover 只有 156×218，优先用搜索/首页里的 640 宽海报，
  // 背景图仍用 PC banner（3840×1696）。
  var poster = httpsURL(source.series_cover) || httpsURL(banner.series_cover);
  var backdrop = httpsURL(banner.background_cover_pc || banner.background_cover) || poster;
  if (poster || backdrop) {
    item.images = {};
    if (poster) {
      item.images.poster = poster;
      item.images.cover = poster;
    }
    if (backdrop) item.images.backdrop = backdrop;
  }
  var tags = tagListOf(source);
  if (tags.length === 0) tags = tagListOf(banner);
  var genre = tags.slice(0, 3).join(" / ");
  if (genre) item.genre = genre;
  var description = truncate(source.series_intro || banner.series_intro || "", MAX_CARD_DESCRIPTION);
  if (description) item.description = description;
  var releaseDate = meta ? dateOf(meta) : "";
  if (releaseDate) item.releaseDate = releaseDate;
  return item;
}

function peopleOf(object) {
  var out = [];
  var celebrities = object && object.celebrities;
  if (!isArray(celebrities)) return out;
  for (var i = 0; i < celebrities.length; i++) {
    var person = celebrities[i];
    if (!person || typeof person !== "object") continue;
    var name = trim(person.nickname || person.name || "");
    if (!name) continue;
    var personId = trim(person.celebrity_id || person.person_id || "");
    var entry = { id: personId || "hongguo-person-" + i, title: name };
    var avatar = trim(person.avatar || "");
    if (/^https?:\/\//i.test(avatar)) entry.avatar = avatar;
    var role = trim(person.sub_title || person.role || "");
    if (role) entry.role = role;
    out.push(entry);
  }
  return out;
}

// ========== 页面抓取 ==========

async function loadHomePage(ctx) {
  var response = await fetchPage(ctx, "/", {
    headers: webHeaders(),
    cacheTtlSeconds: HOME_CACHE_SECONDS,
    label: "红果短剧首页",
  });
  if (response.status === 404) return null;
  var router = extractRouterData(response.text);
  var page = findLoaderValue(router, "homeSections");
  if (!page) throw unavailable("无法解析红果短剧首页数据");
  return page;
}

async function loadRankPage(ctx, board, pageNumber) {
  var path = "/rank/" + encodeURIComponent(board);
  var response = await fetchPage(ctx, path, {
    headers: webHeaders(),
    query: pageNumber > 1 ? { page: String(pageNumber) } : undefined,
    cacheTtlSeconds: HOME_CACHE_SECONDS,
    label: "红果短剧榜单",
  });
  if (response.status === 404) return null;
  var content = parseRankContent(response.text);
  if (!content) throw unavailable("无法解析红果短剧榜单数据");
  return content;
}

async function loadCategoryPage(ctx, category, pageNumber) {
  var path = "/category/" + encodeURIComponent(category);
  var response = await fetchPage(ctx, path, {
    headers: webHeaders(),
    query: pageNumber > 1 ? { page: String(pageNumber) } : undefined,
    cacheTtlSeconds: HOME_CACHE_SECONDS,
    label: "红果短剧分类",
  });
  if (response.status === 404) return null;
  var router = extractRouterData(response.text);
  var page = findLoaderValue(router, "recommendList");
  if (!page) throw unavailable("无法解析红果短剧分类数据");
  var items = [];
  var list = page.recommendList || [];
  for (var i = 0; i < list.length; i++) {
    var item = createListItem(list[i]);
    if (item) items.push(item);
  }
  var pagination = page.pagination || {};
  var totalPages = positiveInt(pagination.totalPages) || 1;
  var currentPage = positiveInt(pagination.pageNum) || pageNumber;
  return { items: items, page: currentPage, totalPages: totalPages };
}

async function loadVidList(ctx, seriesId) {
  var cached = readVidCache(ctx, seriesId);
  if (cached) return cached;

  var response = await fetchPage(ctx, "/player/" + encodeURIComponent(seriesId), {
    headers: webHeaders(),
    cacheTtlSeconds: HOME_CACHE_SECONDS,
    label: "红果短剧分集页",
  });
  if (response.status === 200) {
    var router = extractRouterData(response.text);
    var page = findLoaderValue(router, "seriesDetail");
    var detail = page && page.seriesDetail;
    var vids = detail ? stringList(detail.vid_list) : [];
    if (vids.length) {
      writeVidCache(ctx, seriesId, vids);
      return vids;
    }
  }

  var detailResponse = await fetchPage(ctx, "/detail", {
    headers: webHeaders(),
    query: { series_id: seriesId },
    cacheTtlSeconds: HOME_CACHE_SECONDS,
    label: "红果短剧详情页",
  });
  if (detailResponse.status === 200) {
    var detailRouter = extractRouterData(detailResponse.text);
    var detailPage = findLoaderValue(detailRouter, "seriesDetail");
    var seriesDetail = detailPage && detailPage.seriesDetail;
    var detailVids = seriesDetail ? stringList(seriesDetail.vid_list) : [];
    if (detailVids.length) {
      writeVidCache(ctx, seriesId, detailVids);
      return detailVids;
    }
  }
  return [];
}

function readVidCache(ctx, seriesId) {
  try {
    var value = ctx.storage.get("vids:" + seriesId);
    if (!value || !isArray(value.vids)) return null;
    var age = new Date().getTime() - Number(value.at || 0);
    if (!isFiniteNumber(age) || age < 0 || age > VID_CACHE_TTL_SECONDS * 1000) return null;
    return stringList(value.vids);
  } catch (error) {
    return null;
  }
}

function writeVidCache(ctx, seriesId, vids) {
  try {
    ctx.storage.set("vids:" + seriesId, { vids: vids, at: new Date().getTime() }, { ttlSeconds: VID_CACHE_TTL_SECONDS });
  } catch (error) {
    // 存储不可用时忽略，下一次重新抓取。
  }
}

// ========== 搜索 / 播放接口 ==========

async function fetchSearchPage(ctx, keyword, pageNumber) {
  var response = await httpGet(ctx, "/api/search/result", {
    headers: jsonHeaders({
      "Referer": BASE + "/search/" + encodeURIComponent(keyword),
      "X-Requested-With": "XMLHttpRequest",
    }),
    query: { aid: API_AID, query: keyword, page: String(pageNumber) },
  });
  if (response.status !== 200) throw httpError(response.status, "红果短剧搜索");
  var data = response.json;
  if (!data || typeof data !== "object") throw unavailable("红果短剧搜索没有返回数据");
  return data;
}

async function requestPublicPlayback(ctx, vid) {
  var response = await httpPostJSON(
    ctx,
    "/api/video/protected/fallback-play-info",
    { aid: API_AID },
    { item_id: vid },
    jsonHeaders({
      "Content-Type": "application/json",
      "X-Xs-From-Web": "1",
      "Referer": BASE + "/",
    })
  );
  return response;
}

async function resolvePublicPlayback(ctx, vid) {
  var response = await requestPublicPlayback(ctx, vid);
  // 偶发风控也会返回 403，和「这集不公开」共用同一个错误码，所以 403 再试一次。
  if (response.status === 403) {
    response = await requestPublicPlayback(ctx, vid);
  }
  if (response.status === 200) {
    var data = response.json || {};
    var url = trim(data.main_url || "");
    if (/^https?:\/\//i.test(url)) return { url: url, expiresAt: data.url_expire || null };
    return null;
  }
  if (response.status === 403 || response.status === 404) {
    console.warn("红果短剧该集没有公开播放地址：" + vid + "（官网只公开前若干集）");
    return null;
  }
  throw httpError(response.status, "红果短剧播放信息");
}

// ========== widget handlers ==========

async function loadHomeWidget(ctx, input) {
  var tab = normalizeHomeTab(paramOf(input, "tab"));
  var page = await loadHomePage(ctx);
  if (!page) return { items: [] };
  var sections = isArray(page.homeSections) ? page.homeSections : [];
  var section = null;
  for (var i = 0; i < sections.length; i++) {
    if (sections[i] && sections[i].tab_type === tab) {
      section = sections[i];
      break;
    }
  }
  if (!section && sections.length) section = sections[0];

  var items = [];
  var list = section && isArray(section.video_list) ? section.video_list : [];
  for (var j = 0; j < list.length; j++) {
    var item = createListItem(list[j], subtitleOf(list[j]));
    if (item) items.push(item);
  }
  if (items.length === 0) console.warn("红果短剧首页没有解析到条目（tab=" + tab + "）");
  return { items: items };
}

async function enrichSeriesMeta(ctx, banner) {
  var id = seriesIdOf(banner);
  var title = trim(banner.series_name || banner.title || "");
  if (!id || !title) return null;
  try {
    var data = await fetchSearchPage(ctx, title, 1);
    var list = isArray(data.searchList) ? data.searchList : [];
    for (var i = 0; i < list.length; i++) {
      var video = list[i] && list[i].video_data;
      if (video && String(video.series_id) === id) return video;
    }
  } catch (error) {
    console.warn("红果精选补全信息失败：" + title + "：" + describeError(error));
  }
  return null;
}

async function loadFeaturedWidget(ctx, input) {
  var page = await loadHomePage(ctx);
  if (!page) return { items: [] };
  var sections = isArray(page.homeSections) ? page.homeSections : [];
  var bySeries = {};
  for (var s = 0; s < sections.length; s++) {
    var sectionList = sections[s] && isArray(sections[s].video_list) ? sections[s].video_list : [];
    for (var i = 0; i < sectionList.length; i++) {
      var seriesId = seriesIdOf(sectionList[i]);
      if (seriesId && !bySeries[seriesId]) bySeries[seriesId] = sectionList[i];
    }
  }

  var banners = isArray(page.bannerList) ? page.bannerList : [];
  // banner 数据没有发布时间和 640 宽海报：首页同名条目优先，其次用搜索接口补全。
  var metas = await Promise.all(banners.map(function (banner) {
    var seriesId = seriesIdOf(banner);
    if (seriesId && bySeries[seriesId]) return Promise.resolve(bySeries[seriesId]);
    return enrichSeriesMeta(ctx, banner);
  }));
  var items = [];
  for (var b = 0; b < banners.length; b++) {
    var item = createBannerItem(banners[b], metas[b]);
    if (item) items.push(item);
  }

  if (items.length === 0) {
    var fallback = sections.length && isArray(sections[0].video_list) ? sections[0].video_list : [];
    for (var f = 0; f < fallback.length; f++) {
      var fallbackItem = createListItem(fallback[f], subtitleOf(fallback[f]));
      if (fallbackItem) items.push(fallbackItem);
    }
  }
  if (items.length === 0) console.warn("红果短剧精选没有解析到条目");
  return { items: items };
}

async function loadRankWidget(ctx, input) {
  var board = normalizeBoard(paramOf(input, "board"));
  var pageNumber = pageFromToken(input && input.page);
  var content = await loadRankPage(ctx, board, pageNumber);
  if (!content) return { items: [] };

  var list = isArray(content.rankList) ? content.rankList : [];
  var items = [];
  for (var i = 0; i < list.length; i++) {
    var item = createRankItem(list[i]);
    if (item) items.push(item);
  }
  if (items.length === 0) console.warn("红果短剧榜单没有解析到条目：" + board + " 第 " + pageNumber + " 页");

  var pagination = content.pagination || {};
  var totalPages = positiveInt(pagination.totalPages) || 1;
  var result = { items: items };
  if (pageNumber < totalPages) result.next = { type: "page", page: pageNumber + 1 };
  return result;
}

async function loadBrowseWidget(ctx, input) {
  var category = normalizeCategory(paramOf(input, "category"));
  var pageNumber = pageFromToken(input && input.page);
  var parsed = await loadCategoryPage(ctx, category, pageNumber);
  if (!parsed) return { items: [] };
  var result = { items: parsed.items };
  if (pageNumber < parsed.totalPages) result.next = { type: "page", page: pageNumber + 1 };
  return result;
}

// ========== list handler ==========

async function loadList(ctx, input) {
  var params = input && input.params ? input.params : {};
  var pageNumber = pageFromToken(input && input.page);
  var board = trim(params.board || "");
  var category = trim(params.category || "");

  // 榜单 widget 的标题栏把 params.board 带进来；其余走分类。
  if (board) {
    var rankContent = await loadRankPage(ctx, normalizeBoard(board), pageNumber);
    if (!rankContent) return { items: [] };
    var list = isArray(rankContent.rankList) ? rankContent.rankList : [];
    var rankItems = [];
    for (var i = 0; i < list.length; i++) {
      var rankItem = createRankItem(list[i]);
      if (rankItem) rankItems.push(rankItem);
    }
    var rankPagination = rankContent.pagination || {};
    var rankTotalPages = positiveInt(rankPagination.totalPages) || 1;
    var rankResult = { items: rankItems };
    if (pageNumber < rankTotalPages) rankResult.next = { page: pageNumber + 1 };
    console.log("list rank", board, pageNumber, rankItems.length);
    return rankResult;
  }

  var parsed = await loadCategoryPage(ctx, normalizeCategory(category), pageNumber);
  if (!parsed) return { items: [] };
  var result = { items: parsed.items };
  if (pageNumber < parsed.totalPages) result.next = { page: pageNumber + 1 };
  console.log("list category", normalizeCategory(category), pageNumber, parsed.items.length);
  return result;
}

// ========== search handler ==========

async function searchExtension(ctx, input) {
  var keyword = trim(input && input.query);
  if (!keyword) return { items: [] };
  var pageNumber = pageFromToken(input && input.page);
  var data = await fetchSearchPage(ctx, keyword, pageNumber);

  var list = isArray(data.searchList) ? data.searchList : [];
  var items = [];
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry || typeof entry !== "object") continue;
    var video = entry.video_data;
    if (!video || typeof video !== "object") continue;
    var item = createListItem(video, subtitleOf(video));
    if (item) items.push(item);
  }

  var totalPages = positiveInt(data.totalPages) || 1;
  var currentPage = positiveInt(data.pageNum) || pageNumber;
  var result = { items: items };
  if (items.length > 0 && currentPage < totalPages) {
    result.next = { type: "page", page: currentPage + 1 };
  }
  console.log("search", keyword, "page", currentPage, "items", items.length);
  return result;
}

// ========== detail handler ==========

async function loadDetail(ctx, input) {
  var ref = input && input.ref ? input.ref : null;
  var seriesId = ref ? seriesIdOf(ref) : "";
  if (!seriesId) throw invalidParams("缺少红果短剧编号");

  var response = await fetchPage(ctx, "/detail", {
    headers: webHeaders(),
    query: { series_id: seriesId },
    cacheTtlSeconds: DETAIL_CACHE_SECONDS,
    label: "红果短剧详情页",
  });
  if (response.status === 404) return null;

  var router = extractRouterData(response.text);
  var page = findLoaderValue(router, "seriesDetail");
  if (!page || !page.seriesDetail) {
    console.warn("红果短剧详情页没有解析到数据：" + seriesId);
    return null;
  }

  var series = page.seriesDetail;
  var poster = coverOf(series);
  var title = titleOf(series);
  if (!title) return null;

  var detail = {
    ref: normalizedRef(seriesId),
    title: title,
  };
  var subtitle = subtitleOf(series);
  if (subtitle) detail.subtitle = subtitle;
  var description = truncate(descriptionOf(series), MAX_DESCRIPTION_LENGTH);
  if (description) detail.description = description;

  var tags = tagListOf(series);
  if (tags.length) {
    detail.genre = tags.join(" / ");
    detail.genres = tags.map(function (name, index) {
      return { id: "hongguo-genre-" + index, title: name };
    });
  }

  var social = page.seriesSocialInfo && typeof page.seriesSocialInfo === "object" ? page.seriesSocialInfo : {};
  var rating = positiveRating(social.rating);
  if (rating === null) rating = ratingOf(series);
  if (rating !== null) detail.rating = rating;

  var releaseDate = dateOf(series);
  if (releaseDate) detail.releaseDate = releaseDate;

  if (poster) detail.images = { poster: poster, detailPoster: poster };

  var people = peopleOf(series);
  if (people.length) detail.people = people;

  var vids = stringList(series.vid_list);
  if (vids.length) {
    detail.episodes = [];
    // 官网不提供分集剧照（上游 video_detail 的 episode_cover 需要签名），
    // 先统一用剧集竖版封面兜底，保证每集都有 still 可显示。
    var episodeStill = poster || coverOf(series);
    for (var i = 0; i < vids.length; i++) {
      var episode = { season: 1, episode: i + 1, title: "第" + (i + 1) + "集" };
      if (episodeStill) episode.still = episodeStill;
      detail.episodes.push(episode);
    }
    // 详情页已经拿到完整分集列表，顺手写入缓存，播放时就不必再抓一次分集页。
    writeVidCache(ctx, seriesId, vids);
  }

  console.log("detail", seriesId, title, "episodes", vids.length);
  return detail;
}

// ========== 增强线路 relay ==========

function normalizedDecryptionKey(value) {
  var key = trim(value);
  if (!/^[0-9a-fA-F]{32}$/.test(key)) return "";
  return key.toLowerCase();
}

function relayBase(ctx) {
  var settings = ctx && ctx.settings ? ctx.settings : {};
  if (settings.useEnhancedLine === false) return "";
  var raw = trim(settings.relayUrl);
  if (!raw) raw = RELAY_DEFAULT_URL;
  if (!/^https?:\/\//i.test(raw)) return "";
  return raw.replace(/\/+$/, "");
}

function relayToken(ctx) {
  var settings = ctx && ctx.settings ? ctx.settings : {};
  return trim(settings.relayToken);
}

function definitionRank(value) {
  switch (trim(value)) {
    case "1080p": return 5;
    case "720p": return 4;
    case "540p": return 3;
    case "480p": return 2;
    case "360p": return 1;
    default: return 0;
  }
}

function relayPlaybackSources(data) {
  var key = normalizedDecryptionKey(data && data.key);
  var streams = data && isArray(data.streams) ? data.streams : [];
  var valid = [];
  for (var i = 0; i < streams.length; i++) {
    var stream = streams[i];
    if (!stream || typeof stream !== "object") continue;
    var url = trim(stream.url);
    if (!/^https?:\/\//i.test(url)) continue;
    if (stream.hls === true || stream.dash === true) continue;
    valid.push({ definition: trim(stream.definition) || "auto", url: url, size: Number(stream.size) });
  }
  valid.sort(function (a, b) {
    var rankDiff = definitionRank(b.definition) - definitionRank(a.definition);
    return rankDiff !== 0 ? rankDiff : a.definition.localeCompare(b.definition);
  });

  var sources = [];
  for (var j = 0; j < valid.length; j++) {
    var item = valid[j];
    var source = {
      id: "app-" + item.definition,
      name: "红果增强 " + item.definition,
      url: item.url,
    };
    if (isFiniteNumber(item.size) && item.size > 0) {
      source.description = item.definition + " · " + Math.round(item.size / 1024 / 1024) + " MB";
    } else {
      source.description = item.definition;
    }
    if (key) source.options = { decryptionKey: key };
    sources.push(source);
  }
  return sources;
}

async function tryRelayPlayback(ctx, relayUrl, seriesId, episode, vid) {
  var result = { sources: [], error: "" };
  var headers = { "Accept": "application/json" };
  var token = relayToken(ctx);
  if (token) headers["X-Relay-Token"] = token;
  var query = { series_id: seriesId, episode: String(episode) };
  if (vid) query.vid = vid;

  var response;
  try {
    response = await httpGet(ctx, relayUrl + "/resolve", {
      headers: headers,
      query: query,
      timeoutMs: RELAY_TIMEOUT_MS,
    });
  } catch (error) {
    result.error = "relay 无法访问：" + describeError(error);
    console.warn("红果增强线路 " + result.error);
    return result;
  }
  if (response.status !== 200) {
    result.error = "relay 返回 HTTP " + response.status;
    if (response.status === 401) result.error += "（检查 relayToken）";
    console.warn("红果增强线路 " + result.error);
    return result;
  }
  var data = response.json;
  if (!data || typeof data !== "object") {
    result.error = "relay 返回的不是 JSON";
    console.warn("红果增强线路 " + result.error);
    return result;
  }
  result.sources = relayPlaybackSources(data);
  if (result.sources.length === 0) {
    result.error = "relay 没有返回可用地址";
    console.warn("红果增强线路 " + result.error);
  }
  return result;
}

// ========== playback handler ==========

async function playbackSources(ctx, input) {
  var ref = input && input.ref ? input.ref : null;
  var seriesId = ref ? seriesIdOf(ref) : "";
  if (!seriesId) throw invalidParams("缺少红果短剧编号");

  var episode = positiveInt(input && input.episode) || 1;
  var relayUrl = relayBase(ctx);
  var relayError = "";

  // 先让 relay 用 series_id + episode 解析；这样不依赖官网分集页，也能播全部分集。
  if (relayUrl) {
    var appAttempt = await tryRelayPlayback(ctx, relayUrl, seriesId, episode, "");
    if (appAttempt.sources.length > 0) {
      console.log("relay playback", seriesId, episode, appAttempt.sources.length, "sources");
      return appAttempt.sources;
    }
    relayError = appAttempt.error;
  }

  var vids = await loadVidList(ctx, seriesId);
  if (vids.length === 0) {
    console.warn("红果短剧没有找到分集列表：" + seriesId);
    if (relayError) throw unavailable("增强线路 relay 不可用，且官网分集页不可用：" + relayError);
    return [];
  }
  if (episode > vids.length) {
    console.warn("红果短剧分集超出范围：" + seriesId + " 第 " + episode + " 集 / 共 " + vids.length + " 集");
    return [];
  }

  var vid = vids[episode - 1];

  // series + episode 映射失败时，再用官网的 vid 重试一次 relay。
  if (relayUrl) {
    var vidAttempt = await tryRelayPlayback(ctx, relayUrl, seriesId, episode, vid);
    if (vidAttempt.sources.length > 0) {
      console.log("relay playback", seriesId, episode, vidAttempt.sources.length, "sources (vid)");
      return vidAttempt.sources;
    }
    if (!relayError) relayError = vidAttempt.error;
  }

  // 兜底：官网公开线路，只覆盖前若干集。
  var playback = null;
  try {
    playback = await resolvePublicPlayback(ctx, vid);
  } catch (error) {
    console.warn("官网公开线路也不可用：" + describeError(error));
  }
  if (!playback) {
    if (relayUrl) {
      throw unavailable("增强线路 relay 没有返回播放地址（" + (relayError || "未知原因") + "），且这一集没有官网公开线路。请确认 relay.mjs 已启动、地址和令牌正确。");
    }
    return [];
  }
  return [
    {
      id: "public",
      name: "官网公开线路",
      url: playback.url,
      description: "仅前若干集",
      headers: playbackHeaders(seriesId),
    },
  ];
}

function playbackHeaders(seriesId) {
  return {
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": BASE + "/player/" + seriesId,
  };
}

// ========== 参数 / 分页 ==========

function paramOf(input, name) {
  var params = input && input.params ? input.params : {};
  if (!hasOwn(params, name)) return "";
  return trim(params[name]);
}

function pageFromToken(token) {
  if (token === null || token === undefined) return 1;
  var value = 1;
  if (typeof token === "number") {
    value = token;
  } else if (typeof token === "string") {
    value = parseInt(token, 10);
  } else if (typeof token === "object") {
    if (typeof token.page === "number") value = token.page;
    else if (typeof token.page === "string") value = parseInt(token.page, 10);
  }
  if (!isFiniteNumber(value) || value < 1) return 1;
  return Math.floor(value);
}

function normalizeHomeTab(value) {
  var text = trim(value);
  for (var i = 0; i < HOME_TABS.length; i++) {
    if (HOME_TABS[i].value === text) return text;
  }
  return HOME_TABS[0].value;
}

function normalizeBoard(value) {
  var text = trim(value);
  for (var i = 0; i < RANK_BOARDS.length; i++) {
    if (RANK_BOARDS[i].value === text) return text;
  }
  return RANK_BOARDS[0].value;
}

function boardTitle(value) {
  var board = normalizeBoard(value);
  for (var i = 0; i < RANK_BOARDS.length; i++) {
    if (RANK_BOARDS[i].value === board) return RANK_BOARDS[i].title;
  }
  return RANK_BOARDS[0].title;
}

function normalizeCategory(value) {
  var text = trim(value);
  for (var i = 0; i < CATEGORIES.length; i++) {
    if (CATEGORIES[i].value === text) return text;
  }
  return CATEGORIES[0].value;
}

function homeTabTitle(value) {
  var tab = normalizeHomeTab(value);
  for (var i = 0; i < HOME_TABS.length; i++) {
    if (HOME_TABS[i].value === tab) return HOME_TABS[i].title;
  }
  return HOME_TABS[0].title;
}

function categoryTitle(value) {
  var category = normalizeCategory(value);
  for (var i = 0; i < CATEGORIES.length; i++) {
    if (CATEGORIES[i].value === category) return CATEGORIES[i].title;
  }
  return CATEGORIES[0].title;
}

// ========== placeholder 示例数据 ==========

function placeholderItem(id, title, subtitle, poster, options) {
  var item = {
    ref: normalizedRef(id),
    title: title,
    images: { poster: poster, cover: poster },
  };
  if (subtitle) item.subtitle = subtitle;
  if (options && options.rating) item.rating = options.rating;
  if (options && options.genre) item.genre = options.genre;
  if (options && options.releaseDate) item.releaseDate = options.releaseDate;
  return item;
}

function homePlaceholder() {
  return {
    items: [
      placeholderItem("7690961604636052505", "军需处长的账本", "全46集", "https://p3-novel.byteimg.com/novel-pic/b64c314274460ede0cc7bddc1b7cea58~tplv-shrink:640:0.image", { genre: "战争 / 家国正义 / 忠诚男主", releaseDate: "2026-09-29" }),
      placeholderItem("7683373426689461273", "扁担银行", "全63集", "https://p6-novel.byteimg.com/novel-pic/d83f5907ac9dfb0ca40110b1663b16f3~tplv-shrink:640:0.image", { genre: "战争 / 抗战谍战 / 自我救赎", releaseDate: "2026-09-09" }),
      placeholderItem("7695727473111092286", "一个人的长征", "全90集", "https://p3-novel.byteimg.com/novel-pic/8ff10b53078f292f001ca2a386e859b9~tplv-shrink:640:0.image", { genre: "战争 / 家国正义 / 女扮男装", releaseDate: "2026-10-12" }),
      placeholderItem("7696091340420942872", "我们终将在湘江重逢", "全60集", "https://p6-novel.byteimg.com/novel-pic/13ffe6de870d7785aa527834dddb8cd6~tplv-shrink:640:0.image", { genre: "战争 / 家国正义 / 穿越", releaseDate: "2026-10-13" }),
      placeholderItem("7696083096164125721", "铁血信使", "全75集", "https://p3-novel.byteimg.com/novel-pic/6456fa249edd9586a9a23736d36324c6~tplv-shrink:640:0.image", { genre: "年代 / 年代风云 / 抗战谍战", releaseDate: "2026-10-13" }),
      placeholderItem("7701935931787316286", "十八岁太奶奶驾到，重整家族荣耀第五部", "全102集", "https://p3-novel.byteimg.com/novel-pic/84a71f1a5d7ef5c9c16a73b74011ef75~tplv-shrink:640:0.image", { genre: "家族 / 家族振兴 / 穿越", releaseDate: "2026-10-29" }),
    ],
  };
}

function featuredPlaceholder() {
  return {
    items: [
      placeholderItem("7503745441910017049", "宴律，你的白月光回国了", "", "https://p6-novel.byteimg.com/novel-pic/34ad28f319c9c2b6598792ce2deaaaf8~tplv-shrink:640:0.image", { genre: "都市爱情 / 都市 / 破镜重圆", releaseDate: "2025-05-13" }),
      placeholderItem("7530119479875882009", "十八岁太奶奶驾到，重整家族荣耀第二部", "", "https://p3-novel.byteimg.com/novel-pic/eaf9c4c2b89c7b69fb1426f20a4c3b05~tplv-shrink:640:0.image", { genre: "女性成长 / 穿越 / 女强", releaseDate: "2025-07-23" }),
      placeholderItem("7460844307990187033", "好一个乖乖女", "", "https://p3-novel.byteimg.com/novel-pic/ab9e0c8f7ea747da5a87f2675b7d26a6~tplv-shrink:640:0.image", { genre: "都市爱情 / 总裁 / 现代", releaseDate: "2025-01-17" }),
      placeholderItem("7527125460430375961", "一品布衣", "", "https://p3-novel.byteimg.com/novel-pic/cb0c469ccc64db96db92703c6c854f3e~tplv-shrink:640:0.image", { genre: "历史古代 / 穿越 / 逆袭", releaseDate: "2025-07-15" }),
    ],
  };
}

function rankingPlaceholder() {
  return {
    items: [
      placeholderItem("7701935931787316286", "十八岁太奶奶驾到，重整家族荣耀第五部", "10645万热度 · 评分9.5", "https://p3-novel.byteimg.com/novel-pic/84a71f1a5d7ef5c9c16a73b74011ef75~tplv-shrink:640:0.image", { rating: 9.5 }),
      placeholderItem("7698294694886788121", "和离后我带女儿横扫魔域", "8488万热度 · 评分9.0", "https://p6-novel.byteimg.com/novel-pic/c37eb63db868db08eb95e0d8bacd0129~tplv-shrink:640:0.image", { rating: 9.0 }),
      placeholderItem("7701226234214108185", "聚宝仙盆之杂灵根才是真BOSS第十五季", "8424万热度 · 评分8.9", "https://p3-novel.byteimg.com/novel-pic/63068305b1260ed6e32da41a60f539e5~tplv-shrink:640:0.image", { rating: 8.9 }),
      placeholderItem("7697622096326708286", "退役归来，这个保镖不好惹", "7972万热度 · 评分8.3", "https://p6-novel.byteimg.com/novel-pic/8824990000958fbdb28fb29dca9da667~tplv-shrink:640:0.image", { rating: 8.3 }),
      placeholderItem("7701567939715025944", "满院亲戚全是上古大妖第六季", "7254万热度 · 评分9.1", "https://p6-novel.byteimg.com/novel-pic/fb1c1c48fe7d5e4069ccdd2b0f2b9387~tplv-shrink:640:0.image", { rating: 9.1 }),
      placeholderItem("7697612795184958489", "备用联系人（完）", "6549万热度 · 评分9.0", "https://p6-novel.byteimg.com/novel-pic/f68c6dc9abe69af4b32848b17afd8f1d~tplv-shrink:640:0.image", { rating: 9.0 }),
      placeholderItem("7701334722449787928", "一念沉沦，霍总心动了", "6264万热度 · 评分9.1", "https://p3-novel.byteimg.com/novel-pic/adef31dd5cafc28d1cb9d52b0c5e2818~tplv-shrink:640:0.image", { rating: 9.1 }),
      placeholderItem("7701297357857491993", "摊牌了我真的有系统", "6121万热度 · 评分8.5", "https://p3-novel.byteimg.com/novel-pic/a81a3bfb9b5fefbd73192507e47eb20f~tplv-shrink:640:0.image", { rating: 8.5 }),
      placeholderItem("7698311709634595864", "分家没我份，破院枯井全是金条", "5957万热度 · 评分8.4", "https://p3-novel.byteimg.com/novel-pic/26b468fe5006ab210b6024b0c9f15f40~tplv-shrink:640:0.image", { rating: 8.4 }),
      placeholderItem("7700138431145315390", "边军破刀：一路砍到裂土封王第二季", "5938万热度", "https://p6-novel.byteimg.com/novel-pic/f2c21fadd934b02ed61b75e80006fbee~tplv-shrink:640:0.image"),
    ],
  };
}

function browsePlaceholder() {
  return {
    items: [
      placeholderItem("7621200213801176126", "万妖图录传第一季", "全81集", "https://p3-novel.byteimg.com/novel-pic/d276704b9a05ee371eb1a1c0e42ca581~tplv-shrink:640:0.image", { genre: "玄幻 / 穿越" }),
      placeholderItem("7690961604636052505", "军需处长的账本", "全46集", "https://p3-novel.byteimg.com/novel-pic/b64c314274460ede0cc7bddc1b7cea58~tplv-shrink:640:0.image", { genre: "战争 / 家国正义" }),
      placeholderItem("7695727473111092286", "一个人的长征", "全90集", "https://p3-novel.byteimg.com/novel-pic/8ff10b53078f292f001ca2a386e859b9~tplv-shrink:640:0.image"),
      placeholderItem("7696091340420942872", "我们终将在湘江重逢", "全60集", "https://p6-novel.byteimg.com/novel-pic/13ffe6de870d7785aa527834dddb8cd6~tplv-shrink:640:0.image"),
      placeholderItem("7696075882493905944", "追光前行", "全30集", "https://p3-novel.byteimg.com/novel-pic/0488b0a8dda74aab843d4509eef66281~tplv-shrink:640:0.image"),
      placeholderItem("7698294694886788121", "和离后我带女儿横扫魔域", "全987集", "https://p6-novel.byteimg.com/novel-pic/c37eb63db868db08eb95e0d8bacd0129~tplv-shrink:640:0.image"),
    ],
  };
}

// ========== 包定义 ==========

definePackage({
  id: "conflux.hongguo.app",
  title: "红果短剧 · 增强线路",
  description: "红果短剧（hongguoduanju.com）：官网数据 + 本地 relay 解析，可播放全部分集；relay 不可用时回退官网公开线路。",
  author: "Anonymous",
  site: "https://hongguoduanju.com",
  icon: "https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/others/icons/hongguo.png",
  version: "1.0.2",
  engine: 1,
  permissions: {
    // 后者是本地 relay 的前缀放行：http://127.0.0.1 可覆盖任意端口。
    network: ["https://hongguoduanju.com", "http://127.0.0.1", "http://localhost"],
  },
  settings: [
    {
      name: "relayUrl",
      title: "本地解析服务",
      description: "运行同目录 relay.mjs 后填写；留空使用默认地址。",
      type: "text",
      default: "http://127.0.0.1:8787",
    },
    {
      name: "relayToken",
      title: "relay 访问令牌",
      description: "可选；relay 用 RELAY_TOKEN 启动时填写。",
      type: "text",
      default: "",
    },
    {
      name: "useEnhancedLine",
      title: "优先增强线路",
      description: "关闭后只使用官网公开线路。",
      type: "boolean",
      default: true,
    },
  ],
  extensions: [
    {
      type: "widget",
      id: "home",
      title: "红果热播 · 增强",
      description: "红果短剧首页的热播推荐，可在实例里选择频道。",
      template: "poster-rail",
      families: ["extraLarge"],
      cache: { ttlSeconds: 1800 },
      params: [
        {
          name: "tab",
          title: "频道",
          type: "select",
          default: "all",
          options: HOME_TABS,
        },
      ],
      resolveTitle: function (ctx, input) {
        return homeTabTitle(paramOf(input, "tab"));
      },
      placeholderData: homePlaceholder(),
      load: async function (ctx, input) {
        return loadHomeWidget(ctx, input);
      },
    },
    {
      type: "widget",
      id: "featured",
      title: "红果精选 · 增强",
      description: "红果短剧首页的焦点推荐，横向分页大海报。",
      template: "poster-pager",
      families: ["extraLarge"],
      cache: { ttlSeconds: 1800 },
      placeholderData: featuredPlaceholder(),
      load: async function (ctx, input) {
        return loadFeaturedWidget(ctx, input);
      },
    },
    {
      type: "widget",
      id: "ranking",
      title: "红果热播榜 · 增强",
      description: "红果短剧热播榜，可在实例里选择榜单。",
      template: "ranked-list",
      header: "list",
      ref: { source: "custom", id: "browse" },
      cache: { ttlSeconds: 1800 },
      params: [
        {
          name: "board",
          title: "榜单",
          type: "select",
          default: "hot-drama",
          options: RANK_BOARDS,
        },
      ],
      placeholderData: rankingPlaceholder(),
      resolveTitle: function (ctx, input) {
        return boardTitle(paramOf(input, "board"));
      },
      load: async function (ctx, input) {
        return loadRankWidget(ctx, input);
      },
    },
    {
      type: "widget",
      id: "browse",
      title: "红果分类 · 增强",
      description: "按真人剧、漫剧、漫画、AI 剧浏览红果短剧。",
      template: "poster-grid",
      header: "list",
      ref: { source: "custom", id: "browse" },
      cache: { ttlSeconds: 1800 },
      params: [
        {
          name: "category",
          title: "分类",
          type: "select",
          default: "real-drama",
          options: CATEGORIES,
        },
      ],
      resolveTitle: function (ctx, input) {
        return "红果分类 · " + categoryTitle(paramOf(input, "category"));
      },
      placeholderData: browsePlaceholder(),
      load: async function (ctx, input) {
        return loadBrowseWidget(ctx, input);
      },
    },
    {
      type: "list",
      id: "browse",
      title: "红果短剧列表 · 增强",
      description: "红果短剧的榜单与分类全屏列表。",
      style: "grid",
      accepts: { sources: ["custom"] },
      // 列表导航栏的搜索框；关键词走同包 search "main"
      search: { id: "main" },
      cache: { ttlSeconds: 1800 },
      load: async function (ctx, input) {
        return loadList(ctx, input);
      },
    },
    {
      type: "search",
      id: "main",
      title: "红果短剧 · 增强",
      description: "搜索红果短剧。",
      cache: { ttlSeconds: 600 },
      search: async function (ctx, input) {
        return searchExtension(ctx, input);
      },
    },
    {
      type: "detail",
      id: "main",
      title: "红果短剧详情 · 增强",
      description: "读取红果短剧的标题、简介、评分、标签、演职员与全部剧集。",
      accepts: { sources: ["custom"] },
      cache: { ttlSeconds: 600 },
      load: async function (ctx, input) {
        return loadDetail(ctx, input);
      },
    },
    {
      type: "playback",
      id: "main",
      title: "红果增强线路",
      description: "优先通过本地 relay 解析，relay 不可用时回退官网公开线路。",
      accepts: { sources: ["custom"] },
      cache: { ttlSeconds: 0 },
      sources: async function (ctx, input) {
        return playbackSources(ctx, input);
      },
    },
  ],
});
