/*
 * 豆瓣 · Conflux 扩展包
 * 数据源：豆瓣移动端 rexxar JSON 接口与电影标题联想接口，仅提供元数据，不提供播放线路。
 * 格式：Conflux Extension engine 1，脚本直接调用 runtime 注入的 definePackage。
 *
 * 说明：
 * - 条目 ref.source 统一用 "douban"，id 是豆瓣条目数字 ID，mediaType 为 movie / tv。
 *   豆瓣本身是 App 认识的内置来源，但本包仍提供 detail，保证同源包优先生效、字段更完整。
 * - 小组件只做展示与点击意图；详情、搜索、全屏列表分别由同包的 detail / search / list 承担。
 * - rexxar 接口需要带 Referer 头；搜索走 /search/subjects，被限流时退回 /j/subject_suggest。
 * - 豆瓣接口是未公开接口，可能限流或要求验证；失败按 ExtensionError 语义上抛。
 * - 豆瓣图床 img*.doubanio.com 不带 Referer 会返回 HTTP 418。包级 requestRules 让 App 加载这些图片时带上 Referer。
 */

var ORIGIN = "https://m.douban.com";
var SUGGEST_ORIGIN = "https://movie.douban.com";
var VERSION = "1.1.4";
var UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

var PAGE_SIZE = 18; // 小组件“展开全部”和全屏列表每页条数，按 3 列对齐
var DETAIL_CACHE_TTL = 3600;
var SEARCH_PAGE_SIZE = 20; // /search/subjects 单页最多 50，用 20 保守取

/* ---------- 工具 ---------- */

function fail(code, message, retryable) {
  var payload = { code: code, message: message, retryable: !!retryable };
  if (typeof ExtensionError === "function") {
    throw new ExtensionError(payload);
  }
  var e = new Error(message);
  e.code = code;
  e.retryable = !!retryable;
  throw e;
}

function parseData(res) {
  var data = res && res.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (e) {
      fail("unavailable", "豆瓣返回了无法解析的数据", true);
    }
  }
  return data;
}

function check(res, allow404) {
  if (!res) fail("unavailable", "豆瓣无响应", true);
  var s = res.status;
  if (s >= 200 && s < 300) return parseData(res);
  if (s === 404 && allow404) return null;
  if (s === 404) fail("not_found", "豆瓣上找不到该条目", false);
  if (s === 403) fail("unavailable", "豆瓣拒绝了请求，请稍后再试", true);
  if (s === 429) fail("rate_limited", "豆瓣请求过于频繁，请稍后再试", true);
  if (s === 400 || s === 422) fail("invalid_params", "请求参数无效", false);
  fail("unavailable", "豆瓣暂时不可用（HTTP " + s + "）", true);
}

function apiHeaders() {
  return {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    Referer: ORIGIN + "/",
  };
}

function suggestHeaders() {
  return {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    Referer: SUGGEST_ORIGIN + "/",
  };
}

async function apiGet(ctx, path, query, opts) {
  opts = opts || {};
  var res = await ctx.http.get(ORIGIN + path, {
    headers: apiHeaders(),
    query: query || undefined,
    timeoutMs: 15000,
    cacheTtlSeconds: opts.cacheTtlSeconds,
  });
  return check(res, opts.allow404);
}

async function safe(promise, fallback) {
  try {
    return await promise;
  } catch (e) {
    console.warn("douban: optional request failed: " + (e && e.message));
    return fallback;
  }
}

function https(url) {
  if (typeof url !== "string" || !url) return undefined;
  return url.replace(/^http:\/\//, "https://");
}

// 搜索接口的封面是签名 URL，默认被压到 120×180；改 imageView2 的参数可以拿到大图，
// 实测签名仍然有效。非签名 URL 原样返回。
function bigCover(url) {
  var u = https(url);
  if (!u) return undefined;
  if (u.indexOf("qnmob3-sign.doubanio.com") < 0 || u.indexOf("imageView2/") < 0) return u;
  return u.replace(/w\/\d+\/h\/\d+/, "w/600/h/900");
}

function shorten(text, n) {
  if (!text) return undefined;
  var t = String(text).replace(/\r/g, "").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function pageNumber(page) {
  if (!page) return 1;
  var n;
  if (typeof page === "number") n = page;
  else if (page && page.type === "page") n = page.page;
  else if (page && page.page !== undefined) n = page.page;
  if (typeof n === "string") n = parseInt(n, 10);
  if (typeof n !== "number" || !isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

/* ---------- 展示字段映射 ---------- */

function posterOf(data) {
  if (!data) return undefined;
  return https(
    data.cover_url ||
      (data.pic && (data.pic.large || data.pic.normal)) ||
      (data.cover && data.cover.url) ||
      (data.cover && data.cover.image && (data.cover.image.large || data.cover.image.normal))
  );
}

function ratingOf(data) {
  var r = data && data.rating;
  if (!r) return undefined;
  var v = typeof r.value === "number" ? r.value : typeof r.score === "number" ? r.score : typeof r.rate === "number" ? r.rate : 0;
  if (!(v > 0)) return undefined;
  return round1(v);
}

function cardParts(item) {
  var card = (item && (item.card_subtitle || item.info)) || "";
  return String(card)
    .split(" / ")
    .map(function (part) {
      return part.trim();
    })
    .filter(function (part) {
      return part.length > 0;
    });
}

function yearOf(item) {
  var year = item && item.year;
  if (year && /^\d{4}$/.test(String(year).trim())) return String(year).trim();
  var parts = cardParts(item);
  var first = parts[0] || "";
  var m = first.match(/^(\d{4})$/);
  if (m) return m[1];
  m = first.match(/(19|20)\d{2}/);
  if (m) return m[0];
  return undefined;
}

function genreOf(item) {
  var parts = cardParts(item);
  if (parts.length >= 3) {
    var g = parts[2];
    if (g && !/分钟|片长/.test(g)) return g;
  }
  // 兜底：tags 里过滤奖项类标签
  var tags = (item && item.tags) || [];
  var names = tags
    .map(function (t) {
      return (t && t.name) || String(t || "");
    })
    .filter(function (name) {
      return name && !/奖|单元|入围|提名|展映|特别|最佳|导演|编剧|演员/.test(name);
    });
  if (names.length) return names.slice(0, 2).join(" ");
  return undefined;
}

function subtitleOf(year, genre) {
  if (year && genre) return year + " · " + genre;
  if (year) return year;
  if (genre) return genre;
  return undefined;
}

function refOf(item, mediaType) {
  var type = mediaType || (item && (item.type === "tv" || item.subtype === "tv") ? "tv" : "movie");
  return { source: "douban", id: String(item.id), mediaType: type };
}

function toListItem(ctx, item, mediaType) {
  if (!item || item.id === undefined || item.id === null || String(item.id) === "") return null;
  var title = String(item.title || "").replace(/\s+/g, " ").trim();
  if (!title) return null;

  var out = { ref: refOf(item, mediaType), title: title };
  var year = yearOf(item);
  var genre = genreOf(item);
  var subtitle = subtitleOf(year, genre);
  if (year) out.releaseDate = year;
  if (genre) out.genre = genre;
  if (subtitle) out.subtitle = subtitle;

  var rating = ratingOf(item);
  if (rating !== undefined) out.rating = rating;

  var desc = shorten(item.description || item.comment || item.intro, 140);
  if (desc) out.description = desc;

  var poster = posterOf(item);
  if (poster) out.images = { poster: poster };
  return out;
}

/* ---------- 榜单数据 ---------- */

var COLLECTIONS = {
  showing: { key: "movie_showing", mediaType: "movie", ttl: 1800 },
  top250: { key: "movie_top250", mediaType: "movie", ttl: 21600 },
  weekly: { key: "movie_weekly_best", mediaType: "movie", ttl: 21600 },
  hot: { key: "movie_hot_gaia", mediaType: "movie", ttl: 3600 },
  tv: { key: "tv_hot", mediaType: "tv", ttl: 3600 },
  tvRankedCn: { key: "tv_chinese_best_weekly", mediaType: "tv", ttl: 21600 },
  tvRankedGlobal: { key: "tv_global_best_weekly", mediaType: "tv", ttl: 21600 },
};

// 板块名 → 实际 collection；tvRanked 由实例参数 board 决定华语/全球。
function collectionName(name, params) {
  if (name === "tvRanked") {
    return params && params.board === "global" ? "tvRankedGlobal" : "tvRankedCn";
  }
  return name;
}

async function fetchCollection(ctx, name, params, start, count) {
  var resolved = collectionName(name, params);
  var meta = COLLECTIONS[resolved];
  if (!meta) return { total: 0, items: [], mediaType: "movie" };
  var data = await apiGet(
    ctx,
    "/rexxar/api/v2/subject_collection/" + meta.key + "/items",
    { start: start, count: count },
    { cacheTtlSeconds: meta.ttl }
  );
  var items = (data && data.subject_collection_items) || [];
  var total = data && typeof data.total === "number" ? data.total : items.length;
  return { total: total, items: items, mediaType: meta.mediaType };
}

async function loadCollectionPage(ctx, input, name) {
  var params = (input && input.params) || {};
  var page = pageNumber(input && input.page);
  var start = (page - 1) * PAGE_SIZE;
  var data = await fetchCollection(ctx, name, params, start, PAGE_SIZE);
  var items = [];
  for (var i = 0; i < data.items.length; i++) {
    var mapped = toListItem(ctx, data.items[i], data.mediaType);
    if (mapped) items.push(mapped);
  }
  var out = { items: items };
  if (items.length > 0 && start + PAGE_SIZE < data.total) {
    out.next = { type: "page", page: page + 1 };
  }
  return out;
}

/* ---------- 搜索 ---------- */

function searchSubjectsItem(row) {
  var target = row && row.target;
  if (!target || target.id === undefined || target.id === null) return null;
  // subjects 里会混入榜单（chart）等条目，只保留电影 / 剧集。
  var mediaType = row.target_type === "tv" ? "tv" : row.target_type === "movie" ? "movie" : null;
  if (!mediaType) return null;
  var title = String(target.title || "").replace(/\s+/g, " ").trim();
  if (!title) return null;

  var out = { ref: { source: "douban", id: String(target.id), mediaType: mediaType }, title: title };
  var year = target.year ? String(target.year).trim() : "";
  if (/^\d{4}$/.test(year)) out.releaseDate = year;
  var parts = String(target.card_subtitle || "").split(" / ");
  var genre = parts.length >= 2 ? parts[1].trim() : "";
  if (genre) out.genre = genre;
  var subtitle = subtitleOf(/^\d{4}$/.test(year) ? year : undefined, genre);
  if (subtitle) out.subtitle = subtitle;
  var rating = ratingOf(target);
  if (rating !== undefined) out.rating = rating;
  var cover = bigCover(target.cover_url);
  if (cover) out.images = { poster: cover };
  return out;
}

// types[0] 是「影视」类型的合并总数（movie + tv），用它来翻页。
function subjectsTotal(data) {
  var types = (data && data.types) || [];
  for (var i = 0; i < types.length; i++) {
    if (types[i] && types[i].type === "movie") {
      var n = parseInt(types[i].total, 10);
      return isFinite(n) && n > 0 ? n : 0;
    }
  }
  return 0;
}

async function searchSubjects(ctx, query, page) {
  var start = (page - 1) * SEARCH_PAGE_SIZE;
  var res = await ctx.http.get(ORIGIN + "/rexxar/api/v2/search/subjects", {
    headers: apiHeaders(),
    query: { q: query, start: start, count: SEARCH_PAGE_SIZE },
    timeoutMs: 15000,
    cacheTtlSeconds: 600,
  });
  var status = res && res.status;
  if (!res || typeof status !== "number") return { items: [], total: 0, limited: true, failed: true };
  // 豆瓣的软限流：403 need_login / 400 subject_ip_rate_limit，等一会儿会恢复。
  if (status === 403 || status === 400) return { items: [], total: 0, limited: true, failed: false };
  if (status < 200 || status >= 300) return { items: [], total: 0, limited: false, failed: true };

  var data = parseData(res);
  var rows = (data && data.subjects && data.subjects.items) || [];
  var items = [];
  for (var i = 0; i < rows.length; i++) {
    var mapped = searchSubjectsItem(rows[i]);
    if (mapped) items.push(mapped);
  }
  return { items: items, total: subjectsTotal(data), limited: false, failed: false };
}

// 兜底：标题联想接口，条数少、无分页，但限流时通常还能用。
async function searchSuggest(ctx, query) {
  var res = await ctx.http.get(SUGGEST_ORIGIN + "/j/subject_suggest", {
    headers: suggestHeaders(),
    query: { q: query },
    timeoutMs: 12000,
  });
  if (!res || res.status < 200 || res.status >= 300) return [];
  var data = parseData(res);
  if (!Array.isArray(data)) return [];
  var items = [];
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (!row || row.id === undefined || row.id === null) continue;
    var title = String(row.title || "").trim();
    if (!title) continue;
    var episode = String(row.episode == null ? "" : row.episode);
    var mediaType = /^\d+$/.test(episode) && parseInt(episode, 10) > 0 ? "tv" : "movie";
    var out = {
      ref: { source: "douban", id: String(row.id), mediaType: mediaType },
      title: title,
    };
    var year = row.year ? String(row.year) : "";
    if (/^\d{4}$/.test(year)) {
      out.releaseDate = year;
      out.subtitle = year;
    }
    var poster = https(row.img);
    if (poster) out.images = { poster: poster };
    items.push(out);
  }
  return items;
}

async function searchItems(ctx, query, page) {
  var result = null;
  try {
    result = await searchSubjects(ctx, query, page);
  } catch (e) {
    result = { items: [], total: 0, limited: false, failed: true, error: e };
  }

  if (result.items.length > 0) {
    var out = { items: result.items };
    if (result.total > page * SEARCH_PAGE_SIZE) out.next = { type: "page", page: page + 1 };
    return out;
  }

  // 第一页没结果或被限流时，退回标题联想；翻页失败则直接报错。
  if (page === 1) {
    var suggest = [];
    try {
      suggest = await searchSuggest(ctx, query);
    } catch (e) {
      suggest = [];
    }
    if (suggest.length > 0) return { items: suggest };
  }

  if (result.limited) fail("rate_limited", "豆瓣搜索过于频繁，请稍后再试", true);
  if (result.failed) {
    if (result.error && result.error.code) throw result.error;
    fail("unavailable", "豆瓣搜索暂不可用，请稍后再试", true);
  }
  return { items: [] };
}

/* ---------- 详情 ---------- */

function runtimeSecondsOf(data) {
  var durations = (data && data.durations) || [];
  var first = durations[0];
  if (typeof first === "number" && first > 0) return Math.round(first * 60);
  if (typeof first === "string") {
    var m = first.match(/(\d+)\s*分钟/);
    if (m) return parseInt(m[1], 10) * 60;
  }
  return undefined;
}

function releaseDateOf(data) {
  var pubdate = (data && data.pubdate) || [];
  for (var i = 0; i < pubdate.length; i++) {
    var m = String(pubdate[i] || "").match(/(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  var year = data && data.year;
  if (year && /^\d{4}$/.test(String(year))) return String(year);
  return undefined;
}

function peopleOf(celebrities) {
  if (!celebrities) return [];
  var out = [];
  var seen = {};
  function push(person, role) {
    if (!person || person.id === undefined || person.id === null) return;
    var key = String(person.id);
    if (seen[key]) return;
    seen[key] = true;
    var name = String(person.name || "").trim();
    if (!name) return;
    var entry = { id: key, title: name };
    var avatar = person.avatar && (person.avatar.large || person.avatar.normal);
    if (avatar) entry.avatar = https(avatar);
    if (role) entry.role = role;
    out.push(entry);
  }
  var directors = celebrities.directors || [];
  for (var i = 0; i < directors.length; i++) {
    push(directors[i], directors[i] && directors[i].character ? directors[i].character : "导演");
  }
  var actors = celebrities.actors || [];
  for (var j = 0; j < actors.length && out.length < 16; j++) {
    push(actors[j], actors[j] && actors[j].character ? actors[j].character : "演员");
  }
  return out;
}

function trailersOf(data) {
  var rows = (data && data.trailers) || [];
  var out = [];
  for (var i = 0; i < rows.length && out.length < 6; i++) {
    var row = rows[i];
    if (!row || !row.video_url) continue;
    var entry = { url: row.video_url };
    if (row.title) entry.title = row.title;
    var cover = https(row.cover_url);
    if (cover) entry.cover = cover;
    out.push(entry);
  }
  return out;
}

async function loadDetail(ctx, input) {
  var ref = (input && input.ref) || {};
  if (ref.source !== "douban") return null;
  var id = String(ref.id || "");
  if (!/^\d+$/.test(id)) return null;

  var preferred = ref.mediaType === "tv" ? "tv" : "movie";
  var alt = preferred === "tv" ? "movie" : "tv";
  var data = await apiGet(ctx, "/rexxar/api/v2/" + preferred + "/" + id, null, {
    allow404: true,
    cacheTtlSeconds: DETAIL_CACHE_TTL,
  });
  if (!data) {
    // 类型判断错了就换另一端再试；movie → tv 会 301，这里主要是 tv → movie 的兜底。
    data = await apiGet(ctx, "/rexxar/api/v2/" + alt + "/" + id, null, {
      allow404: true,
      cacheTtlSeconds: DETAIL_CACHE_TTL,
    });
  }
  if (!data || data.id === undefined || data.id === null) return null;

  var mediaType = data.type === "tv" || data.is_tv === true ? "tv" : "movie";
  var title = String(data.title || "").trim();
  if (!title) return null;

  var detail = {
    ref: { source: "douban", id: id, mediaType: mediaType },
    title: title,
  };

  var original = String(data.original_title || "").trim();
  if (original && original !== title) detail.subtitle = original;
  var intro = data.intro ? String(data.intro).replace(/\r/g, "").trim() : "";
  if (intro) detail.description = intro;

  var rating = ratingOf(data);
  if (rating !== undefined) detail.rating = rating;
  var date = releaseDateOf(data);
  if (date) detail.releaseDate = date;

  var genres = Array.isArray(data.genres) ? data.genres.filter(Boolean) : [];
  if (genres.length) {
    detail.genre = genres.slice(0, 3).join(" / ");
    detail.genres = genres.map(function (name) {
      return { id: String(name), title: String(name) };
    });
  }

  var poster = posterOf(data);
  if (poster) detail.images = { poster: poster, detailPoster: poster };

  var runtime = runtimeSecondsOf(data);
  if (runtime) detail.runtimeSeconds = runtime;

  var trailers = trailersOf(data);
  if (trailers.length) detail.trailers = trailers;

  var celebrities = await safe(
    apiGet(ctx, "/rexxar/api/v2/" + mediaType + "/" + id + "/celebrities", null, {
      allow404: true,
    }),
    null
  );
  var people = peopleOf(celebrities);
  if (people.length) detail.people = people;

  return detail;
}

/* ---------- 占位数据（本地字面量，安装时不联网） ---------- */

var SAMPLE_MOVIES = [
  {
    ref: { source: "douban", id: "1292052", mediaType: "movie" },
    title: "肖申克的救赎",
    subtitle: "1994 · 剧情 犯罪",
    releaseDate: "1994",
    genre: "剧情 犯罪",
    rating: 9.7,
    images: { poster: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2936346968.jpg" },
  },
  {
    ref: { source: "douban", id: "1291546", mediaType: "movie" },
    title: "霸王别姬",
    subtitle: "1993 · 剧情 爱情 同性",
    releaseDate: "1993",
    genre: "剧情 爱情 同性",
    rating: 9.6,
    images: { poster: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2911205318.jpg" },
  },
  {
    ref: { source: "douban", id: "1292722", mediaType: "movie" },
    title: "泰坦尼克号",
    subtitle: "1997 · 剧情 爱情 灾难",
    releaseDate: "1997",
    genre: "剧情 爱情 灾难",
    rating: 9.5,
    images: { poster: "https://img9.doubanio.com/view/photo/m_ratio_poster/public/p457760035.jpg" },
  },
  {
    ref: { source: "douban", id: "1292720", mediaType: "movie" },
    title: "阿甘正传",
    subtitle: "1994 · 剧情 爱情",
    releaseDate: "1994",
    genre: "剧情 爱情",
    rating: 9.5,
    images: { poster: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p510876253.jpg" },
  },
  {
    ref: { source: "douban", id: "1291561", mediaType: "movie" },
    title: "千与千寻",
    subtitle: "2001 · 剧情 动画 奇幻",
    releaseDate: "2001",
    genre: "剧情 动画 奇幻",
    rating: 9.4,
    images: { poster: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2557573348.jpg" },
  },
  {
    ref: { source: "douban", id: "1889243", mediaType: "movie" },
    title: "星际穿越",
    subtitle: "2014 · 剧情 科幻 冒险",
    releaseDate: "2014",
    genre: "剧情 科幻 冒险",
    rating: 9.4,
    images: { poster: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2614988097.jpg" },
  },
];

var SAMPLE_TV = [
  {
    ref: { source: "douban", id: "36675942", mediaType: "tv" },
    title: "小城良方",
    subtitle: "2026 · 剧情",
    releaseDate: "2026",
    genre: "剧情",
    rating: 8.0,
    images: { poster: "https://img2.doubanio.com/view/photo/m_ratio_poster/public/p2936709341.jpg" },
  },
  {
    ref: { source: "douban", id: "37191789", mediaType: "tv" },
    title: "嫁金钗",
    subtitle: "2026 · 剧情 古装",
    releaseDate: "2026",
    genre: "剧情 古装",
    images: { poster: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2936594583.jpg" },
  },
  {
    ref: { source: "douban", id: "37042229", mediaType: "tv" },
    title: "醉梦",
    subtitle: "2026 · 剧情 悬疑",
    releaseDate: "2026",
    genre: "剧情 悬疑",
    images: { poster: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2936594830.jpg" },
  },
  {
    ref: { source: "douban", id: "37296949", mediaType: "tv" },
    title: "蒸蒸日上",
    subtitle: "2026 · 剧情 喜剧",
    releaseDate: "2026",
    genre: "剧情 喜剧",
    rating: 7.8,
    images: { poster: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2936476679.jpg" },
  },
  {
    ref: { source: "douban", id: "37210712", mediaType: "tv" },
    title: "末路兼职",
    subtitle: "2026 · 剧情",
    releaseDate: "2026",
    genre: "剧情",
    images: { poster: "https://img9.doubanio.com/view/photo/m_ratio_poster/public/p2936279046.jpg" },
  },
  {
    ref: { source: "douban", id: "37070518", mediaType: "tv" },
    title: "玉簟秋",
    subtitle: "2026 · 剧情 古装",
    releaseDate: "2026",
    genre: "剧情 古装",
    images: { poster: "https://img2.doubanio.com/view/photo/m_ratio_poster/public/p2926678761.jpg" },
  },
];

function placeholderMovies() {
  return { items: SAMPLE_MOVIES };
}

function placeholderTV() {
  return { items: SAMPLE_TV };
}

function collectionRef(name, mediaType) {
  return { source: "douban", id: "collection:" + name, mediaType: mediaType };
}

/* ---------- 包定义 ---------- */

definePackage({
  id: "conflux.douban",
  title: "豆瓣",
  description: "豆瓣电影与剧集：正在热映、Top250、一周口碑榜、热门电影与剧集、搜索和详情（数据来自豆瓣，非官方接口）。",
  author: "Anonymous",
  site: "https://www.douban.com",
  icon: "https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/others/icons/douban.png",
  version: VERSION,
  engine: 1,
  permissions: {
    network: [ORIGIN, SUGGEST_ORIGIN],
  },
  requestRules: [
    {
      host: "img*.doubanio.com",
      headers: { Referer: ORIGIN + "/" },
    },
  ],
  extensions: [
    /* 正在热映：海报墙，适合“在映且无排名”的浏览型数据 */
    {
      type: "widget",
      id: "showing",
      title: "正在热映",
      description: "豆瓣正在热映的电影",
      template: "poster-grid",
      families: ["small", "medium", "large"],
      header: "list",
      ref: collectionRef("showing", "movie"),
      cache: { ttlSeconds: 1800 },
      placeholder: placeholderMovies,
      load: async function (ctx, input) {
        return loadCollectionPage(ctx, input, "showing");
      },
    },

    /* 豆瓣 Top250：名次稳定，前三名用扇形海报 */
    {
      type: "widget",
      id: "top250",
      title: "豆瓣电影 Top250",
      description: "豆瓣电影 Top250 排行榜",
      template: "poster-ranked",
      families: ["small", "medium", "large"],
      header: "list",
      ref: collectionRef("top250", "movie"),
      cache: { ttlSeconds: 21600 },
      placeholder: placeholderMovies,
      load: async function (ctx, input) {
        return loadCollectionPage(ctx, input, "top250");
      },
    },

    /* 一周口碑榜：正好 10 条、带名次，适合三行一列的横排榜单 */
    {
      type: "widget",
      id: "weekly",
      title: "一周口碑榜",
      description: "豆瓣一周口碑电影榜",
      template: "ranked-list",
      families: ["medium", "large"],
      header: "list",
      ref: collectionRef("weekly", "movie"),
      cache: { ttlSeconds: 21600 },
      placeholder: placeholderMovies,
      load: async function (ctx, input) {
        return loadCollectionPage(ctx, input, "weekly");
      },
    },

    /* 热门电影：条目多、以海报大图为主，适合 extraLarge 的翻页大图 */
    {
      type: "widget",
      id: "hot",
      title: "热门电影",
      description: "豆瓣热门电影",
      template: "poster-pager",
      families: ["extraLarge"],
      header: "list",
      ref: collectionRef("hot", "movie"),
      cache: { ttlSeconds: 3600 },
      placeholder: placeholderMovies,
      load: async function (ctx, input) {
        return loadCollectionPage(ctx, input, "hot");
      },
    },

    /* 热门剧集：海报 + 年份/类型，横向海报轨 */
    {
      type: "widget",
      id: "tv",
      title: "热门剧集",
      description: "豆瓣热门剧集",
      template: "poster-rail",
      families: ["extraLarge"],
      header: "list",
      ref: collectionRef("tv", "tv"),
      cache: { ttlSeconds: 3600 },
      placeholder: placeholderTV,
      load: async function (ctx, input) {
        return loadCollectionPage(ctx, input, "tv");
      },
    },

    /* 剧集口碑榜：带名次，横向排行海报轨；华语/全球可切换 */
    {
      type: "widget",
      id: "tvRanked",
      title: "剧集口碑榜",
      description: "豆瓣一周华语/全球口碑剧集榜",
      template: "ranked-rail",
      families: ["extraLarge"],
      header: "list",
      ref: collectionRef("tvRanked", "tv"),
      params: [
        {
          name: "board",
          title: "榜单",
          type: "select",
          default: "cn",
          options: [
            { title: "华语口碑剧集榜", value: "cn" },
            { title: "全球口碑剧集榜", value: "global" },
          ],
        },
      ],
      cache: { ttlSeconds: 21600 },
      placeholder: placeholderTV,
      resolveTitle: function (ctx, input) {
        var board = input && input.params ? input.params.board : undefined;
        return "剧集口碑榜 · " + (board === "global" ? "全球" : "华语");
      },
      load: async function (ctx, input) {
        return loadCollectionPage(ctx, input, "tvRanked");
      },
    },

    /* 搜索：rexxar /search/subjects 分页取影视；被限流时退回标题联想 */
    {
      type: "search",
      id: "search",
      title: "豆瓣",
      cache: { ttlSeconds: 1800 },
      search: async function (ctx, input) {
        var query = String((input && input.query) || "").trim();
        if (!query) return { items: [] };
        return await searchItems(ctx, query, pageNumber(input && input.page));
      },
    },

    /* 全屏列表：点 widget 标题时按 collection:<榜单> 打开的海报墙 */
    {
      type: "list",
      id: "collection",
      title: "豆瓣列表",
      style: "grid",
      accepts: { sources: ["douban"] },
      // 列表导航栏的搜索框；关键词走同包 search "search"，结果不分电影 / 剧集，与全局搜索一致
      search: { id: "search" },
      load: async function (ctx, input) {
        var ref = (input && input.ref) || {};
        var raw = String(ref.id || "");
        var name = raw.indexOf("collection:") === 0 ? raw.slice("collection:".length) : raw;
        if (!COLLECTIONS[collectionName(name, (input && input.params) || {})]) {
          return { items: [] };
        }
        var params = (input && input.params) || {};
        var page = pageNumber(input && input.page);
        var start = (page - 1) * PAGE_SIZE;
        var data = await fetchCollection(ctx, name, params, start, PAGE_SIZE);
        var items = [];
        for (var i = 0; i < data.items.length; i++) {
          var mapped = toListItem(ctx, data.items[i], data.mediaType);
          if (mapped) items.push(mapped);
        }
        var out = { items: items };
        if (items.length > 0 && start + PAGE_SIZE < data.total) out.next = { page: page + 1 };
        return out;
      },
    },

    /* 详情：movie 与 tv 共用；movie 端点对 tv id 会 301 到 tv，因此先按 ref.mediaType 请求并兜底 */
    {
      type: "detail",
      id: "main",
      title: "豆瓣详情",
      accepts: { sources: ["douban"], mediaTypes: ["movie", "tv"] },
      cache: { ttlSeconds: DETAIL_CACHE_TTL },
      load: async function (ctx, input) {
        return loadDetail(ctx, input);
      },
    },
  ],
});
