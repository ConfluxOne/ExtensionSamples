"use strict";

/**
 * 在 Node 中加载 daily.js：注入 definePackage / ExtensionError / ctx.http，
 * 用固定的 TMDB / Trakt 响应替身跑一遍 widget / search / detail，不需要网络。
 *
 * 用法（仓库根目录）：node daily/test/harness.js
 */

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var { ExtensionError, assertError } = require("./errors");

var EXT_PATH = path.join(__dirname, "..", "daily.js");
var ORIGIN = "https://test.conflux.one";

var pkg = null;
var requests = [];
var routes = [];

function definePackage(definition) {
  pkg = definition;
}

function route(match, response) {
  routes.push({ match: match, response: response });
}

function reset() {
  requests = [];
  routes = [];
}

function findRoute(url) {
  for (var i = 0; i < routes.length; i++) {
    var m = routes[i].match;
    var hit = typeof m === "string" ? url.indexOf(m) >= 0 : m.test(url);
    if (hit) return routes[i].response;
  }
  return null;
}

async function fakeGet(url, options) {
  requests.push({ url: url, query: (options && options.query) || {} });
  var response = findRoute(url);
  if (!response) throw new Error("unexpected http GET " + url);
  return typeof response === "function" ? response(url, options) : response;
}

function ctx(settings) {
  return {
    locale: "zh-CN",
    settings: settings || {},
    http: { get: fakeGet },
  };
}

function ok(data) {
  return { status: 200, headers: {}, data: data };
}

function fail(status, message) {
  return { status: status, headers: {}, data: { status_message: message } };
}

function ext(type, id) {
  var list = (pkg && pkg.extensions) || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].type === type && list[i].id === id) return list[i];
  }
  throw new Error("missing extension " + type + "/" + id);
}

var passed = 0;
var failed = 0;

async function test(name, fn) {
  reset();
  try {
    await fn();
    passed += 1;
    console.log("ok   " + name);
  } catch (e) {
    failed += 1;
    console.error("FAIL " + name);
    console.error("     " + (e && (e.stack || e.message || e)));
  } finally {
    reset();
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

function loadExtension() {
  var code = fs.readFileSync(EXT_PATH, "utf8");
  var sandbox = {
    definePackage: definePackage,
    ExtensionError: ExtensionError,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: EXT_PATH });
  assert(pkg, "definePackage was not called");
}

var MOVIE = {
  id: 12345,
  title: "测试电影",
  original_title: "Test Movie",
  overview: "一部测试电影。",
  vote_average: 8.4,
  release_date: "2026-02-14",
  genre_ids: [28],
  poster_path: "/poster.jpg",
  backdrop_path: "/backdrop.jpg",
};

var CHART_ROW = {
  tmdb_id: 456,
  title: "榜单电影",
  media_type: "movie",
  year: 2025,
  list_count: 18200,
  revenue: 84200000,
  watcher_count: 240000,
  poster_path: "/chart.jpg",
};

function movieListResponse() {
  return ok({ page: 1, results: [MOVIE], total_pages: 1 });
}

var EXPECTED_WIDGETS = [
  "now-playing",
  "popular",
  "hero",
  "top-rated",
  "schedule",
  "upcoming",
  "week",
  "movies-anticipated",
  "shows-anticipated",
  "box-office",
  "movies-watched",
  "shows-watched",
];

loadExtension();

(async function main() {
  await test("package metadata", function () {
    assert(pkg.id === "conflux.daily", "id");
    assert(pkg.version === "1.2.0", "version");
    assert(pkg.engine === 1, "engine");
    assert(pkg.title === "每日推荐", "title");
    var net = (pkg.permissions && pkg.permissions.network) || [];
    assert(net.indexOf(ORIGIN) >= 0, "permissions.network 应包含默认 API 地址");
    var types = pkg.extensions.map(function (e) { return e.type; });
    ["widget", "search", "detail"].forEach(function (t) {
      assert(types.indexOf(t) >= 0, "missing type " + t);
    });
    var setting = (pkg.settings || []).filter(function (s) { return s.name === "apiOrigin"; })[0];
    assert(setting, "settings.apiOrigin");
    assert(setting.default === ORIGIN, "apiOrigin default");
  });

  await test("widget inventory and placeholders", async function () {
    EXPECTED_WIDGETS.forEach(function (id) {
      var widget = ext("widget", id);
      assert(typeof widget.load === "function", id + " load");
      assert(widget.template, id + " template");
      assert(widget.placeholderData && widget.placeholderData.items.length > 0, id + " placeholderData");
    });
    for (var i = 0; i < pkg.extensions.length; i++) {
      var widget = pkg.extensions[i];
      if (widget.type !== "widget") continue;
      var content = await widget.placeholder();
      assert(content && Array.isArray(content.items) && content.items.length > 0, widget.id + " placeholder()");
    }
  });

  await test("widget popular load", async function () {
    route("/pubapi/tmdb/3/movie/popular", movieListResponse());
    var res = await ext("widget", "popular").load(ctx());
    assert(res && Array.isArray(res.items), "items");
    assert(res.items.length === 1, "items length");
    var item = res.items[0];
    assert(item.ref.source === "tmdb" && item.ref.id === "12345", "ref");
    assert(item.ref.mediaType === "movie", "ref.mediaType");
    assert(item.title === "测试电影", "title");
    assert(item.rating === 8.4, "rating");
    assert(item.releaseDate === "2026-02-14", "releaseDate");
    assert(item.genre === "动作", "genre");
    assert(item.images.poster === "https://image.tmdb.org/t/p/w500/poster.jpg", "poster");
    assert(item.images.backdrop === "https://image.tmdb.org/t/p/w500/backdrop.jpg", "backdrop");
    var req = requests[0];
    assert(req.url === ORIGIN + "/pubapi/tmdb/3/movie/popular", "request url");
    assert(req.query.language === "zh-CN", "request language");
    assert(req.query.page === "1", "request page");
  });

  await test("widget top-rated decorates rating subtitle", async function () {
    route("/pubapi/tmdb/3/movie/top_rated", movieListResponse());
    var res = await ext("widget", "top-rated").load(ctx());
    assert(res.items[0].subtitle === "8.4", "subtitle should be rating");
  });

  await test("widget hero uses day trending", async function () {
    route("/pubapi/tmdb/3/trending/movie/day", movieListResponse());
    var res = await ext("widget", "hero").load(ctx());
    assert(res.items.length === 1, "items");
    assert(requests[0].url === ORIGIN + "/pubapi/tmdb/3/trending/movie/day", "url");
  });

  await test("chart widgets render Trakt metrics", async function () {
    route("/pubapi/trakt/movies/anticipated", ok({ items: [CHART_ROW] }));
    route("/pubapi/trakt/movies/boxoffice", ok({ items: [CHART_ROW] }));
    route("/pubapi/trakt/movies/watched/weekly", ok({ items: [CHART_ROW] }));

    var anticipated = await ext("widget", "movies-anticipated").load(ctx());
    assert(anticipated.items[0].subtitle === "2025 · 1.8万片单", "lists subtitle");

    var boxOffice = await ext("widget", "box-office").load(ctx());
    assert(boxOffice.items[0].subtitle === "$84.2M", "revenue subtitle");

    var watched = await ext("widget", "movies-watched").load(ctx());
    assert(watched.items[0].subtitle === "24万观看", "watched subtitle");
    assert(watched.items[0].genre === "24万观看", "watched genre");
  });

  await test("widget schedule renders today's episodes", async function () {
    route("/pubapi/trakt/calendars/shows", ok({
      items: [
        {
          tmdb_id: 789,
          show_title: "今日剧集",
          season: 2,
          episode: 5,
          aired_at: "2026-10-31T12:30:00Z",
          poster_path: "/show.jpg",
        },
      ],
    }));
    var res = await ext("widget", "schedule").load(ctx());
    var item = res.items[0];
    assert(item.title === "今日剧集", "title");
    assert(item.ref.id === "789" && item.ref.mediaType === "tv", "ref");
    assert(item.episode.season === 2 && item.episode.episode === 5, "episode");
    assert(/^\d{2}:\d{2}$/.test(item.subtitle), "subtitle should be clock time");
    assert(item.images.poster === "https://image.tmdb.org/t/p/w500/show.jpg", "poster");
    var req = requests[0];
    assert(req.url === ORIGIN + "/pubapi/trakt/calendars/shows", "url");
    assert(/^\d{4}-\d{2}-\d{2}$/.test(req.query.date), "date query");
  });

  await test("search returns items and next page", async function () {
    route("/pubapi/tmdb/3/search/movie", ok({ results: [MOVIE], total_pages: 3 }));
    var res = await ext("search", "movie").search(ctx(), { query: "测试" });
    assert(res.items.length === 1, "items");
    assert(res.items[0].ref.id === "12345", "ref");
    assert(res.next && res.next.type === "page" && res.next.page === 2, "next page");
    assert(requests[0].query.query === "测试", "query passed");

    var last = await ext("search", "movie").search(ctx(), {
      query: "测试",
      page: { type: "page", page: 3 },
    });
    assert(!last.next, "no next page on last page");
  });

  await test("search empty query returns no items", async function () {
    var res = await ext("search", "movie").search(ctx(), { query: "" });
    assert(res && Array.isArray(res.items) && res.items.length === 0, "empty items");
    assert(requests.length === 0, "should not call http");
  });

  await test("detail movie load", async function () {
    route("/pubapi/tmdb/3/movie/550", ok({
      id: 550,
      title: "测试详情",
      original_title: "Test Detail",
      overview: "详情简介。",
      vote_average: 8.8,
      release_date: "2026-03-01",
      runtime: 139,
      genres: [{ id: 18, name: "剧情" }],
      credits: {
        crew: [{ id: 1, name: "导演甲", job: "Director", profile_path: "/director.jpg" }],
        cast: [{ id: 2, name: "演员乙", character: "主角", profile_path: "/actor.jpg" }],
      },
      images: { backdrops: [{ file_path: "/still1.jpg" }] },
      videos: { results: [{ site: "YouTube", type: "Trailer", name: "预告片", key: "abc123" }] },
    }));
    var detail = await ext("detail", "movie").load(ctx(), {
      ref: { source: "tmdb", id: "550", mediaType: "movie" },
    });
    assert(detail.ref.id === "550" && detail.ref.mediaType === "movie", "ref");
    assert(detail.title === "测试详情", "title");
    assert(detail.description === "详情简介。", "description");
    assert(detail.runtimeSeconds === 139 * 60, "runtimeSeconds");
    assert(detail.genres && detail.genres[0].title === "剧情", "genres");
    assert(detail.people.length === 2, "people");
    assert(detail.people[0].role === "导演", "director role");
    assert(detail.people[1].role === "主角", "cast role");
    assert(detail.images.stills.length === 1, "stills");
    assert(detail.trailers.length === 1, "trailers");
    assert(detail.trailers[0].url === "https://www.youtube.com/watch?v=abc123", "trailer url");
    assert(requests[0].query.append_to_response === "credits,images,videos", "append_to_response");
  });

  await test("detail tv load", async function () {
    route("/pubapi/tmdb/3/tv/1399", ok({
      id: 1399,
      name: "测试剧集",
      original_name: "Test Show",
      overview: "剧集简介。",
      vote_average: 9.2,
      first_air_date: "2024-06-01",
      episode_run_time: [55],
      genres: [{ id: 10765, name: "科幻" }],
      created_by: [{ id: 3, name: "创作者丙", profile_path: "/creator.jpg" }],
    }));
    var detail = await ext("detail", "movie").load(ctx(), {
      ref: { source: "tmdb", id: "1399", mediaType: "tv" },
    });
    assert(detail.ref.mediaType === "tv", "mediaType");
    assert(detail.title === "测试剧集", "title");
    assert(detail.runtimeSeconds === 55 * 60, "runtimeSeconds");
    assert(detail.people[0].role === "创作者", "creator role");
  });

  await test("detail ignores non-tmdb ref", async function () {
    var detail = await ext("detail", "movie").load(ctx(), {
      ref: { source: "custom", id: "1" },
    });
    assert(detail === null, "non-tmdb -> null");
    assert(requests.length === 0, "should not call http");
  });

  await test("detail 404 returns null", async function () {
    route("/pubapi/tmdb/3/movie/1", fail(404, "Not Found"));
    var detail = await ext("detail", "movie").load(ctx(), {
      ref: { source: "tmdb", id: "1", mediaType: "movie" },
    });
    assert(detail === null, "not_found -> null");
  });

  await test("http 429 maps to rate_limited", async function () {
    route("/pubapi/tmdb/3/movie/popular", fail(429, "Too Many Requests"));
    try {
      await ext("widget", "popular").load(ctx());
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "rate_limited");
    }
  });

  await test("http 500 maps to unavailable", async function () {
    route("/pubapi/tmdb/3/movie/popular", fail(500, "oops"));
    try {
      await ext("widget", "popular").load(ctx());
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "unavailable");
    }
  });

  await test("http 404 maps to not_found for widgets", async function () {
    route("/pubapi/tmdb/3/movie/popular", fail(404, "Not Found"));
    try {
      await ext("widget", "popular").load(ctx());
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "not_found");
    }
  });

  await test("apiOrigin setting overrides default", async function () {
    route("http://localhost:8080/pubapi/tmdb/3/movie/popular", movieListResponse());
    var res = await ext("widget", "popular").load(ctx({ apiOrigin: "http://localhost:8080/" }));
    assert(res.items.length === 1, "items");
    assert(
      requests[0].url === "http://localhost:8080/pubapi/tmdb/3/movie/popular",
      "custom origin trimmed"
    );
  });

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
