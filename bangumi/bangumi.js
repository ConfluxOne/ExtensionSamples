/*
 * Bangumi 番组计划 · Conflux 扩展包
 * 数据源：Bangumi 官方公开 API（https://api.bgm.tv），仅提供元数据，不提供播放线路。
 * 格式：Conflux Extension engine 1，脚本直接调用 runtime 注入的 definePackage。
 */

var API = "https://api.bgm.tv";
var VERSION = "1.0.0";
var UA = "conflux-bangumi/" + VERSION + " (https://conflux.one)";
var PAGE_SIZE = 24;
var SEARCH_PAGE_SIZE = 20; // /v0/search/subjects 单页最多返回 20 条

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
  var data = res.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (e) {
      fail("unavailable", "Bangumi 返回了无法解析的数据", true);
    }
  }
  return data;
}

function check(res, allow404) {
  if (!res) fail("unavailable", "Bangumi 无响应", true);
  var s = res.status;
  if (s >= 200 && s < 300) return parseData(res);
  if (s === 404 && allow404) return null;
  if (s === 404) fail("not_found", "Bangumi 上找不到该条目", false);
  if (s === 429) fail("rate_limited", "Bangumi 请求过于频繁，请稍后再试", true);
  if (s === 400 || s === 422) fail("invalid_params", "请求参数无效", false);
  fail("unavailable", "Bangumi 暂时不可用（HTTP " + s + "）", true);
}

function headers() {
  return { "User-Agent": UA, Accept: "application/json" };
}

async function apiGet(ctx, path, query, opts) {
  opts = opts || {};
  var res = await ctx.http.get(API + path, {
    headers: headers(),
    query: query || undefined,
    timeoutMs: 15000,
    cacheTtlSeconds: opts.cacheTtlSeconds,
  });
  return check(res, opts.allow404);
}

async function apiPost(ctx, path, body, query) {
  var h = headers();
  h["Content-Type"] = "application/json";
  var res = await ctx.http.post(API + path, JSON.stringify(body), {
    headers: h,
    query: query || undefined,
    timeoutMs: 15000,
  });
  return check(res, false);
}

function https(url) {
  if (typeof url !== "string" || !url) return undefined;
  return url.replace(/^http:\/\//, "https://");
}

function settingsOf(ctx) {
  var s = (ctx && ctx.settings) || {};
  return {
    titleLang: s.titleLang === "original" ? "original" : "cn",
    cover: s.cover === "common" ? "common" : "large",
  };
}

function titles(ctx, subj) {
  var cn = (subj.name_cn || "").trim();
  var orig = (subj.name || "").trim();
  var st = settingsOf(ctx);
  if (st.titleLang === "original") {
    return { title: orig || cn, subtitle: cn && cn !== orig ? cn : undefined };
  }
  return { title: cn || orig, subtitle: cn && orig && cn !== orig ? orig : undefined };
}

function poster(ctx, images) {
  if (!images) return undefined;
  var st = settingsOf(ctx);
  return https(images[st.cover] || images.large || images.common || images.medium);
}

function score(rating) {
  if (!rating || typeof rating.score !== "number" || rating.score <= 0) return undefined;
  return Math.round(rating.score * 10) / 10;
}

function mediaTypeOf(subj) {
  return subj && subj.platform === "剧场版" ? "movie" : "tv";
}

function subjectRef(subj) {
  return { source: "custom", id: String(subj.id), mediaType: mediaTypeOf(subj) };
}

function shorten(text, n) {
  if (!text) return undefined;
  var t = String(text).replace(/\r/g, "").trim();
  if (!t) return undefined;
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function toListItem(ctx, subj, extra) {
  var t = titles(ctx, subj);
  var item = {
    ref: subjectRef(subj),
    title: t.title || "未命名",
  };
  if (t.subtitle) item.subtitle = t.subtitle;
  var desc = shorten(subj.summary || subj.short_summary, 120);
  if (desc) item.description = desc;
  var r = score(subj.rating);
  if (r !== undefined) item.rating = r;
  var date = subj.date || subj.air_date;
  if (date) item.releaseDate = date;
  var genre = subj.platform || (subj.meta_tags && subj.meta_tags[0]);
  if (genre) item.genre = genre;
  var p = poster(ctx, subj.images);
  if (p) item.images = { poster: p };
  if (extra) {
    for (var k in extra) if (extra[k] !== undefined) item[k] = extra[k];
  }
  return item;
}

function pageNumber(page) {
  if (page && page.type === "page" && typeof page.page === "number" && page.page >= 1) {
    return Math.floor(page.page);
  }
  return 1;
}

function todayWeekday() {
  var d = new Date().getDay(); // 0=周日
  return d === 0 ? 7 : d;
}

function resolveWeekday(v) {
  var n = parseInt(v, 10);
  if (n >= 1 && n <= 7) return n;
  return todayWeekday();
}

function currentSeason() {
  var now = new Date();
  var m = now.getMonth() + 1;
  return { year: now.getFullYear(), month: m >= 10 ? 10 : m >= 7 ? 7 : m >= 4 ? 4 : 1 };
}

/* ---------- 数据获取 ---------- */

async function calendarItems(ctx, params) {
  params = params || {};
  var wd = resolveWeekday(params.weekday);
  var data = await apiGet(ctx, "/calendar", null, { cacheTtlSeconds: 1800 });
  if (!Array.isArray(data)) return { weekday: wd, items: [] };
  var day = null;
  for (var i = 0; i < data.length; i++) {
    if (data[i] && data[i].weekday && data[i].weekday.id === wd) day = data[i];
  }
  var list = (day && day.items) || [];
  var sort = params.sort === "rating" ? "rating" : "heat";
  list = list.slice().sort(function (a, b) {
    if (sort === "rating") return ((b.rating && b.rating.score) || 0) - ((a.rating && a.rating.score) || 0);
    return ((b.collection && b.collection.doing) || 0) - ((a.collection && a.collection.doing) || 0);
  });
  return {
    weekday: wd,
    items: list.map(function (s) { return toListItem(ctx, s); }),
  };
}

async function browse(ctx, query, page) {
  var p = pageNumber(page);
  var q = { type: 2, limit: PAGE_SIZE, offset: (p - 1) * PAGE_SIZE };
  for (var k in query) if (query[k] !== undefined && query[k] !== null && query[k] !== "") q[k] = query[k];
  var data = await apiGet(ctx, "/v0/subjects", q, { cacheTtlSeconds: 3600 });
  var rows = (data && data.data) || [];
  var out = { items: rows.map(function (s) { return toListItem(ctx, s); }) };
  var total = (data && data.total) || 0;
  if (p * PAGE_SIZE < total && rows.length > 0) out.next = { type: "page", page: p + 1 };
  return out;
}

function seasonQuery(params) {
  params = params || {};
  var cur = currentSeason();
  var year = typeof params.year === "number" && params.year > 1900 ? Math.floor(params.year) : cur.year;
  var month = parseInt(params.month, 10);
  if (!(month >= 1 && month <= 12)) month = cur.month;
  var q = { year: year, month: month, sort: params.sort === "date" ? "date" : "rank" };
  if (params.tvOnly !== false) q.cat = 1; // 1 = TV
  return q;
}

function rankQuery(params) {
  params = params || {};
  var q = { sort: "rank" };
  if (typeof params.year === "number" && params.year > 1900) q.year = Math.floor(params.year);
  return q;
}

async function fetchAllEpisodes(ctx, id) {
  var all = [];
  var offset = 0;
  var limit = 200;
  for (var guard = 0; guard < 10; guard++) {
    var data = await apiGet(ctx, "/v0/episodes", { subject_id: id, type: 0, limit: limit, offset: offset }, { allow404: true });
    if (!data || !data.data) break;
    all = all.concat(data.data);
    offset += data.data.length;
    if (data.data.length === 0 || offset >= (data.total || 0)) break;
  }
  return all;
}

async function safe(promise, fallback) {
  try {
    return await promise;
  } catch (e) {
    console.warn("bangumi: optional request failed: " + (e && e.message));
    return fallback;
  }
}

/* ---------- 占位数据（字面量，不联网） ---------- */

var SAMPLE = [
  { ref: { source: "custom", id: "400602", mediaType: "tv" }, title: "葬送的芙莉莲", subtitle: "葬送のフリーレン", rating: 8.5, releaseDate: "2023-09-29", genre: "TV" },
  { ref: { source: "custom", id: "876", mediaType: "tv" }, title: "CLANNAD 〜AFTER STORY〜", rating: 9.1, releaseDate: "2008-10-02", genre: "TV" },
  { ref: { source: "custom", id: "55770", mediaType: "tv" }, title: "进击的巨人", subtitle: "進撃の巨人", rating: 8.1, releaseDate: "2013-04-06", genre: "TV" },
];

/* ---------- 包定义 ---------- */

definePackage({
  id: "conflux.bangumi",
  title: "Bangumi 番组计划",
  description: "每日放送、季度新番、排行榜、番剧搜索与详情（数据来自 bgm.tv）",
  author: "Jian Liu",
  site: "https://bgm.tv",
  version: VERSION,
  engine: 1,
  permissions: { network: ["https://api.bgm.tv"] },
  settings: [
    {
      name: "titleLang",
      title: "标题语言",
      type: "select",
      default: "cn",
      options: [
        { title: "中文名优先", value: "cn" },
        { title: "原名优先", value: "original" },
      ],
    },
    {
      name: "cover",
      title: "封面清晰度",
      type: "select",
      default: "large",
      description: "原图更清晰，压缩图更省流量",
      options: [
        { title: "原图", value: "large" },
        { title: "压缩图", value: "common" },
      ],
    },
  ],
  extensions: [
    /* 每日放送 */
    {
      type: "widget",
      id: "daily",
      title: "每日放送",
      description: "Bangumi 每日放送表",
      template: "schedule-day",
      families: ["medium", "large"],
      header: "list",
      ref: { source: "custom", id: "list:calendar" },
      params: [
        {
          name: "weekday",
          title: "星期",
          type: "select",
          default: "today",
          options: [
            { title: "今天", value: "today" },
            { title: "周一", value: "1" },
            { title: "周二", value: "2" },
            { title: "周三", value: "3" },
            { title: "周四", value: "4" },
            { title: "周五", value: "5" },
            { title: "周六", value: "6" },
            { title: "周日", value: "7" },
          ],
        },
        {
          name: "sort",
          title: "排序",
          type: "select",
          default: "heat",
          options: [
            { title: "在看人数", value: "heat" },
            { title: "评分", value: "rating" },
          ],
        },
      ],
      cache: { ttlSeconds: 1800 },
      placeholderData: { items: SAMPLE },
      load: async function (ctx, input) {
        var params = (input && input.params) || {};
        var res = await calendarItems(ctx, params);
        var p = pageNumber(input && input.page);
        var start = (p - 1) * PAGE_SIZE;
        var out = { items: res.items.slice(start, start + PAGE_SIZE) };
        if (start + PAGE_SIZE < res.items.length) out.next = { type: "page", page: p + 1 };
        return out;
      },
    },

    /* 季度新番 */
    {
      type: "widget",
      id: "season",
      title: "季度新番",
      description: "按 Bangumi 排名列出某一季开播的番剧",
      template: "poster-grid",
      header: "list",
      ref: { source: "custom", id: "list:season" },
      params: [
        { name: "year", title: "年份（留空为当前）", type: "number" },
        {
          name: "month",
          title: "季度",
          type: "select",
          default: "auto",
          options: [
            { title: "当前季度", value: "auto" },
            { title: "1 月", value: "1" },
            { title: "4 月", value: "4" },
            { title: "7 月", value: "7" },
            { title: "10 月", value: "10" },
          ],
        },
        {
          name: "sort",
          title: "排序",
          type: "select",
          default: "rank",
          options: [
            { title: "Bangumi 排名", value: "rank" },
            { title: "开播日期", value: "date" },
          ],
        },
        { name: "tvOnly", title: "仅 TV 动画", type: "boolean", default: true },
      ],
      placeholderData: { items: SAMPLE },
      load: async function (ctx, input) {
        return browse(ctx, seasonQuery(input && input.params), input && input.page);
      },
    },

    /* 排行榜 */
    {
      type: "widget",
      id: "ranking",
      title: "番剧排行榜",
      description: "Bangumi 动画排名",
      template: "poster-ranked",
      header: "list",
      ref: { source: "custom", id: "list:rank" },
      params: [{ name: "year", title: "年份（留空为全部）", type: "number" }],
      cache: { ttlSeconds: 21600 },
      placeholderData: { items: SAMPLE },
      load: async function (ctx, input) {
        return browse(ctx, rankQuery(input && input.params), input && input.page);
      },
    },

    /* 搜索 */
    {
      type: "search",
      id: "main",
      title: "Bangumi 番剧",
      params: [
        {
          name: "sort",
          title: "排序",
          type: "select",
          default: "match",
          options: [
            { title: "匹配度", value: "match" },
            { title: "热度", value: "heat" },
            { title: "排名", value: "rank" },
            { title: "评分", value: "score" },
          ],
        },
      ],
      search: async function (ctx, input) {
        var query = ((input && input.query) || "").trim();
        if (!query) return { items: [] };
        var params = (input && input.params) || {};
        var sort = ["match", "heat", "rank", "score"].indexOf(params.sort) >= 0 ? params.sort : "match";
        var p = pageNumber(input && input.page);
        var data = await apiPost(
          ctx,
          "/v0/search/subjects",
          { keyword: query, sort: sort, filter: { type: [2] } },
          { limit: SEARCH_PAGE_SIZE, offset: (p - 1) * SEARCH_PAGE_SIZE }
        );
        var rows = (data && data.data) || [];
        var out = { items: rows.map(function (s) { return toListItem(ctx, s); }) };
        if (p * SEARCH_PAGE_SIZE < ((data && data.total) || 0) && rows.length > 0) out.next = { type: "page", page: p + 1 };
        return out;
      },
    },

    /* 全屏海报列表（widget 标题点击） */
    {
      type: "list",
      id: "posters",
      title: "Bangumi 列表",
      style: "grid",
      accepts: { sources: ["custom"] },
      load: async function (ctx, input) {
        var id = (input && input.ref && input.ref.id) || "";
        var params = (input && input.params) || {};
        var page = input && input.page;
        var p = page && typeof page.page === "number" ? page.page : 1;
        var token = { type: "page", page: p };
        var res;
        if (id === "list:calendar") {
          var cal = await calendarItems(ctx, params);
          return { items: cal.items }; // 单页
        } else if (id === "list:season") {
          res = await browse(ctx, seasonQuery(params), token);
        } else if (id === "list:rank") {
          res = await browse(ctx, rankQuery(params), token);
        } else {
          return { items: [] };
        }
        var out = { items: res.items };
        if (res.next) out.next = { page: res.next.page };
        return out;
      },
    },

    /* 详情 */
    {
      type: "detail",
      id: "main",
      title: "Bangumi 详情",
      accepts: { sources: ["custom"] },
      cache: { ttlSeconds: 3600 },
      load: async function (ctx, input) {
        var ref = input && input.ref;
        if (!ref || !/^\d+$/.test(String(ref.id))) return null;
        var id = String(ref.id);
        var subj = await apiGet(ctx, "/v0/subjects/" + id, null, { allow404: true });
        if (!subj) return null;

        var results = await Promise.all([
          safe(fetchAllEpisodes(ctx, id), []),
          safe(apiGet(ctx, "/v0/subjects/" + id + "/characters", null, { allow404: true }), []),
          safe(apiGet(ctx, "/v0/subjects/" + id + "/persons", null, { allow404: true }), []),
          safe(apiGet(ctx, "/v0/subjects/" + id + "/subjects", null, { allow404: true }), []),
        ]);
        var eps = results[0] || [];
        var chars = results[1] || [];
        var persons = results[2] || [];
        var rels = results[3] || [];

        var base = toListItem(ctx, subj);
        var detail = {
          ref: { source: "custom", id: id, mediaType: mediaTypeOf(subj) },
          title: base.title,
        };
        if (base.subtitle) detail.subtitle = base.subtitle;
        if (subj.summary) detail.description = String(subj.summary).replace(/\r/g, "").trim();
        if (base.rating !== undefined) detail.rating = base.rating;
        if (base.releaseDate) detail.releaseDate = base.releaseDate;

        var metaTags = Array.isArray(subj.meta_tags) ? subj.meta_tags : [];
        var genreNames = metaTags.filter(function (t) { return t !== subj.platform && t !== "日本"; });
        if (genreNames.length) detail.genre = genreNames.slice(0, 3).join(" / ");
        else if (subj.platform) detail.genre = subj.platform;

        var big = https(subj.images && subj.images.large);
        var p = poster(ctx, subj.images);
        if (p || big) detail.images = { poster: p || big, detailPoster: big || p };

        var seen = {};
        var genres = [];
        metaTags.concat((subj.tags || []).slice(0, 8).map(function (t) { return t.name; })).forEach(function (name) {
          if (name && !seen[name]) {
            seen[name] = true;
            genres.push({ id: name, title: name });
          }
        });
        if (genres.length) detail.genres = genres.slice(0, 10);

        var people = [];
        var staffRoles = ["导演", "原作", "系列构成", "人物设定", "音乐", "动画制作"];
        staffRoles.forEach(function (role) {
          persons.forEach(function (ps) {
            if (ps.relation === role && people.length < 8) {
              var av = https(ps.images && (ps.images.medium || ps.images.large));
              var e = { id: "person:" + ps.id, title: ps.name, role: role };
              if (av) e.avatar = av;
              people.push(e);
            }
          });
        });
        chars
          .filter(function (c) { return c.relation === "主角" || c.relation === "配角"; })
          .slice(0, 16)
          .forEach(function (c) {
            var cv = c.actors && c.actors[0] && c.actors[0].name;
            var av = https(c.images && (c.images.medium || c.images.grid || c.images.large));
            var e = { id: "character:" + c.id, title: c.name, role: cv ? "CV " + cv : c.relation };
            if (av) e.avatar = av;
            people.push(e);
          });
        if (people.length) detail.people = people;

        if (eps.length && mediaTypeOf(subj) === "tv") {
          detail.episodes = eps
            .map(function (ep) {
              var n = typeof ep.ep === "number" && ep.ep > 0 ? ep.ep : ep.sort;
              var name = (ep.name_cn || ep.name || "").trim();
              return { season: 1, episode: n, title: name ? "第" + n + "话 " + name : "第" + n + "话" };
            })
            .filter(function (e) { return typeof e.episode === "number"; });
        }
        var dur = eps[0] && eps[0].duration_seconds;
        if (typeof dur === "number" && dur > 0) detail.runtimeSeconds = dur;

        var related = rels
          .filter(function (r) { return r.type === 2; })
          .slice(0, 20)
          .map(function (r) {
            var item = toListItem(ctx, r);
            item.subtitle = r.relation + (item.subtitle ? " · " + item.subtitle : "");
            // 关联条目接口不返回 platform，mediaType 先按 tv 处理，详情页加载后会以 subject 为准
            return item;
          });
        if (related.length) detail.related = related;

        return detail;
      },
    },
  ],
});
