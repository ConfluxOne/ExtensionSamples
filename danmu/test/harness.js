"use strict";

/**
 * 在 Node 中加载 danmu.js：注入 definePackage / ExtensionError / ctx.http，
 * 用固定的弹幕接口响应替身跑一遍 match / search / episodes / comments，不需要网络。
 *
 * 用法（仓库根目录）：node danmu/test/harness.js
 */

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var { ExtensionError, assertError } = require("./errors");

var EXT_PATH = path.join(__dirname, "..", "danmu.js");
var API_BASE = "https://danmu.example.com";

var pkg = null;
var requests = [];
var routes = [];

function definePackage(definition) {
  pkg = definition;
}

function route(method, match, response) {
  routes.push({ method: method, match: match, response: response });
}

function reset() {
  requests = [];
  routes = [];
}

function findRoute(method, url) {
  for (var i = 0; i < routes.length; i++) {
    var r = routes[i];
    if (r.method !== method) continue;
    var hit = typeof r.match === "string" ? url.indexOf(r.match) >= 0 : r.match.test(url);
    if (hit) return r.response;
  }
  return null;
}

async function fakeRequest(method, url, options) {
  options = options || {};
  requests.push({
    method: method,
    url: url,
    headers: options.headers || {},
    query: options.query || {},
    body: options.body,
  });
  var response = findRoute(method, url);
  if (!response) throw new Error("unexpected http " + method + " " + url);
  return typeof response === "function" ? response(url, options) : response;
}

function ctx(settings) {
  return {
    locale: "zh-CN",
    settings: settings || {},
    http: {
      get: function (url, options) {
        return fakeRequest("GET", url, options);
      },
      post: function (url, options) {
        return fakeRequest("POST", url, options);
      },
    },
    storage: {
      get: function () { return undefined; },
      set: function () {},
      remove: function () {},
    },
  };
}

function settings(overrides) {
  return Object.assign({ apiBase: API_BASE }, overrides || {});
}

function ok(data) {
  return { status: 200, headers: {}, data: data };
}

function fail(status, message) {
  return { status: status, headers: {}, data: { message: message } };
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

loadExtension();

(async function main() {
  await test("package metadata", function () {
    assert(pkg.id === "conflux.danmu", "id");
    assert(pkg.version === "1.0.0", "version");
    assert(pkg.engine === 1, "engine");
    assert(pkg.title === "弹幕", "title");
    var types = pkg.extensions.map(function (e) { return e.type; });
    assert(types.indexOf("danmu") >= 0, "missing danmu type");
    var names = (pkg.settings || []).map(function (s) { return s.name; });
    ["apiBase", "appId", "appSecret"].forEach(function (name) {
      assert(names.indexOf(name) >= 0, "missing setting " + name);
    });
    var apiBase = pkg.settings.filter(function (s) { return s.name === "apiBase"; })[0];
    assert(apiBase.required === true, "apiBase should be required");
    var net = (pkg.permissions && pkg.permissions.network) || [];
    assert(net.indexOf("https://") >= 0 && net.indexOf("http://") >= 0, "network permissions");
  });

  await test("match without apiBase reports invalid_params", async function () {
    try {
      await ext("danmu", "main").match(ctx(), { fileName: "测试番_S01E01.mkv" });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "invalid_params");
    }
    assert(requests.length === 0, "should not call http");
  });

  await test("match by file name", async function () {
    route("POST", "/api/v2/match", ok({
      matches: [
        {
          episodeId: "ep100",
          animeId: "a100",
          animeTitle: "测试番",
          episodeTitle: "第1集",
          type: "tv",
          shift: 0,
        },
      ],
    }));
    var items = await ext("danmu", "main").match(ctx(settings({ appId: "app-id", appSecret: "secret" })), {
      fileName: "测试番_S01E01.mkv",
    });
    assert(items.length === 1, "items");
    var item = items[0];
    assert(item.id === "a100", "id");
    assert(item.title === "测试番", "title");
    assert(item.kind === "series", "kind");
    assert(item.episode.id === "ep100", "episode id");
    var req = requests[0];
    assert(req.url === API_BASE + "/api/v2/match", "url");
    assert(req.body.fileName === "测试番_S01E01.mkv", "file name");
    assert(req.body.matchMode === "fileNameOnly", "match mode");
    assert(req.headers["X-AppId"] === "app-id", "X-AppId");
    assert(req.headers["X-AppSecret"] === "secret", "X-AppSecret");
  });

  await test("match falls back to search when no file match", async function () {
    route("POST", "/api/v2/match", ok({ matches: [] }));
    route("GET", "/api/v2/search/episodes", ok({
      animes: [
        {
          bangumiId: "b100",
          animeTitle: "测试番 S2",
          type: "tv",
          episodes: [{ episodeId: "ep201", episodeTitle: "第2集", episodeNumber: 2 }],
        },
      ],
    }));
    var items = await ext("danmu", "main").match(ctx(settings()), {
      fileName: "测试番_S02E02.mkv",
      title: "测试番",
      season: 2,
      episode: 2,
    });
    assert(items.length === 1, "items");
    assert(items[0].episode.id === "ep201", "episode id");
    assert(items[0].episode.season === 2, "season");
    assert(items[0].episode.episode === 2, "episode number");
  });

  await test("search returns anime matches", async function () {
    route("GET", "/api/v2/search/anime", ok({
      animes: [{ bangumiId: "b100", animeTitle: "测试番", type: "tv" }],
    }));
    var items = await ext("danmu", "main").search(ctx(settings()), { query: "测试番" });
    assert(items.length === 1, "items");
    assert(items[0].id === "b100", "id");
    assert(items[0].kind === "series", "kind");
    var req = requests[0];
    assert(req.query.keyword === "测试番", "keyword");
    assert(req.query.v2 === "true", "v2");
  });

  await test("search empty query returns no items", async function () {
    var items = await ext("danmu", "main").search(ctx(), { query: "   " });
    assert(items.length === 0, "empty items");
    assert(requests.length === 0, "should not call http");
  });

  await test("episodes lists bangumi episodes", async function () {
    route("GET", "/api/v2/bangumi/b100", ok({
      bangumi: {
        animeTitle: "测试番 S2",
        type: "tv",
        episodes: [
          { episodeId: "ep201", episodeTitle: "第2集", episodeNumber: 2 },
          { episodeId: "ep202", episodeTitle: "第3集", episodeNumber: 3 },
        ],
      },
    }));
    var items = await ext("danmu", "main").episodes(ctx(settings()), { match: { id: "b100" } });
    assert(items.length === 2, "items");
    assert(items[0].id === "ep201", "first episode");
    assert(items[0].season === 2, "season parsed from title");
    assert(items[0].episode === 2, "episode number");
    assert(items[1].id === "ep202", "second episode");
  });

  await test("episodes without match id returns no items", async function () {
    var items = await ext("danmu", "main").episodes(ctx(), {});
    assert(items.length === 0, "empty items");
    assert(requests.length === 0, "should not call http");
  });

  await test("comments converts cues and filters segment", async function () {
    route("GET", "/api/v2/comment/ep201", ok({
      comments: [
        { p: "12.5,1,16777215", m: "hello", cid: "c1" },
        { p: "70,1,16777215", m: "out of segment", cid: "c2" },
        { p: "20,5,255", m: "top", cid: "c3" },
      ],
    }));
    var cues = await ext("danmu", "main").comments(ctx(settings()), {
      episode: { id: "ep201" },
      segment: { start: 0, end: 60 },
    });
    assert(cues.length === 2, "cues");
    assert(cues[0].time === 12.5, "time");
    assert(cues[0].text === "hello", "text");
    assert(cues[0].mode === "rtl", "mode rtl");
    assert(cues[0].color === "#ffffff", "color");
    assert(cues[0].id === "c1", "cue id");
    assert(cues[1].mode === "top", "mode top");
    assert(cues[1].color === "#0000ff", "color #0000ff");
    var req = requests[0];
    assert(req.url === API_BASE + "/api/v2/comment/ep201", "url");
    assert(req.query.withRelated === "true", "withRelated");
    assert(req.headers.Accept === "application/json", "Accept header");
  });

  await test("comments applies episode shift", async function () {
    route("GET", "/api/v2/comment/ep201", ok({
      comments: [{ p: "12.5,1,16777215", m: "shifted", cid: "c1" }],
    }));
    var cues = await ext("danmu", "main").comments(ctx(settings()), {
      episode: { id: "ep201@5" },
    });
    assert(cues.length === 1, "cues");
    assert(cues[0].time === 17.5, "shifted time");
    assert(requests[0].url === API_BASE + "/api/v2/comment/ep201", "shift stripped from url");
  });

  await test("comments without episode id reports invalid_params", async function () {
    try {
      await ext("danmu", "main").comments(ctx(), {});
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "invalid_params");
    }
  });

  await test("apiBase normalization", async function () {
    var payload = ok({ animes: [{ bangumiId: "b100", animeTitle: "测试番", type: "tv" }] });
    route("GET", "https://bare.example.com/api/v2/search/anime", payload);
    route("GET", "https://withpath.example.com/api/v2/search/anime", payload);

    await ext("danmu", "main").search(ctx({ apiBase: "bare.example.com" }), { query: "x" });
    assert(requests[0].url === "https://bare.example.com/api/v2/search/anime", "scheme added");

    await ext("danmu", "main").search(ctx({ apiBase: "https://withpath.example.com/api/v2/" }), {
      query: "x",
    });
    assert(
      requests[1].url === "https://withpath.example.com/api/v2/search/anime",
      "api/v2 not duplicated"
    );
  });

  await test("http 429 maps to rate_limited", async function () {
    route("GET", "/api/v2/search/anime", fail(429, "Too Many Requests"));
    route("GET", "/api/v2/search/episodes", fail(429, "Too Many Requests"));
    try {
      await ext("danmu", "main").search(ctx(settings()), { query: "x" });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "rate_limited");
    }
  });

  await test("http 401 maps to invalid_params", async function () {
    route("GET", "/api/v2/comment/ep201", fail(401, "Unauthorized"));
    try {
      await ext("danmu", "main").comments(ctx(settings()), { episode: { id: "ep201" } });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "invalid_params");
    }
  });

  await test("http 404 maps to not_found", async function () {
    route("GET", "/api/v2/comment/ep404", fail(404, "Not Found"));
    try {
      await ext("danmu", "main").comments(ctx(settings()), { episode: { id: "ep404" } });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "not_found");
    }
  });

  await test("http 500 maps to unavailable", async function () {
    route("GET", "/api/v2/comment/ep201", fail(500, "oops"));
    try {
      await ext("danmu", "main").comments(ctx(settings()), { episode: { id: "ep201" } });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "unavailable");
    }
  });

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
