"use strict";

/**
 * 在 Node 中加载 theintrodb.js：注入 definePackage / ExtensionError / ctx.http，
 * 用固定的 TheIntroDB 响应替身校验查询参数、时间轴转换与错误映射。
 * 默认不需要网络；设置 CONFLUX_LIVE=1 会额外跑一次真实接口查询。
 *
 * 用法（仓库根目录）：node theintrodb/test/harness.js
 */

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var { ExtensionError, assertError } = require("./errors");

var EXT_PATH = path.join(__dirname, "..", "theintrodb.js");
var API_URL = "https://api.theintrodb.org/v3/media";
var LIVE = process.env.CONFLUX_LIVE === "1";

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
  requests.push({ url: url, headers: (options && options.headers) || {}, query: (options && options.query) || {} });
  var response = findRoute(url);
  if (!response) throw new Error("unexpected http GET " + url);
  return typeof response === "function" ? response(url, options) : response;
}

function ctx() {
  return {
    locale: "zh-CN",
    settings: {},
    http: { get: fakeGet },
  };
}

function ok(data) {
  return { status: 200, headers: {}, data: data };
}

function fail(status, body) {
  return { status: status, headers: {}, data: body };
}

function segmentsExt() {
  var list = (pkg && pkg.extensions) || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].type === "timeline") return list[i];
  }
  throw new Error("missing timeline extension");
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

function mediaResponse() {
  return ok({
    intro: [{ start_ms: 0, end_ms: 90000 }],
    recap: [{ start_ms: 10000, end_ms: 40000 }],
    credits: [{ start_ms: 3300000, end_ms: 3350000 }],
    preview: [{ start_ms: 3500000, end_ms: 3560000 }],
  });
}

loadExtension();

(async function main() {
  await test("package metadata", function () {
    assert(pkg.id === "conflux.theintrodb", "id");
    assert(pkg.version === "1.0.0", "version");
    assert(pkg.engine === 1, "engine");
    assert(pkg.title === "TheIntroDB", "title");
    var types = pkg.extensions.map(function (e) { return e.type; });
    assert(types.indexOf("timeline") >= 0, "missing timeline type");
    var net = (pkg.permissions && pkg.permissions.network) || [];
    assert(net.length === 1 && net[0] === "https://api.theintrodb.org", "network permissions");
    var ext = segmentsExt();
    assert(ext.id === "main", "timeline id");
    assert(typeof ext.segments === "function", "segments function");
  });

  await test("movie segments by tmdb id", async function () {
    route("/v3/media", mediaResponse());
    var segments = await segmentsExt().segments(ctx(), {
      ids: { tmdb: "550" },
      mediaType: "movie",
    });
    assert(segments.length === 4, "segments");
    assert(segments[0].type === "intro", "intro first");
    assert(segments[0].start === 0 && segments[0].end === 90, "intro range");
    assert(segments[1].type === "recap", "recap");
    assert(segments[1].start === 10 && segments[1].end === 40, "recap range");
    assert(segments[2].type === "credits", "credits");
    assert(segments[2].start === 3300 && segments[2].end === 3350, "credits range");
    assert(segments[3].type === "preview", "preview");
    assert(segments[3].start === 3500 && segments[3].end === 3560, "preview range");
    var req = requests[0];
    assert(req.url === API_URL, "url");
    assert(req.query.tmdb_id === "550", "tmdb_id");
    assert(!req.query.media_type, "unexpected media_type query");
    assert(req.headers.Accept === "application/json", "Accept header");
  });

  await test("numeric imdb id is normalised", async function () {
    route("/v3/media", ok({ intro: [{ start_ms: 0, end_ms: 60000 }] }));
    await segmentsExt().segments(ctx(), { ids: { imdb: "1234567" }, mediaType: "movie" });
    assert(requests[0].query.imdb_id === "tt1234567", "imdb_id normalised");
  });

  await test("tv query includes season and episode", async function () {
    route("/v3/media", ok({ intro: [{ start_ms: 0, end_ms: 45000 }] }));
    var segments = await segmentsExt().segments(ctx(), {
      ids: { tmdb: "1399" },
      mediaType: "tv",
      season: 1,
      episode: 2,
    });
    assert(segments.length === 1, "segments");
    assert(requests[0].query.season === "1", "season");
    assert(requests[0].query.episode === "2", "episode");
  });

  await test("tv without episode returns empty", async function () {
    var segments = await segmentsExt().segments(ctx(), {
      ids: { tmdb: "1399" },
      mediaType: "tv",
      season: 1,
    });
    assert(segments.length === 0, "empty segments");
    assert(requests.length === 0, "should not call http");
  });

  await test("missing ids returns empty", async function () {
    var segments = await segmentsExt().segments(ctx(), { mediaType: "movie" });
    assert(segments.length === 0, "empty segments");
    assert(requests.length === 0, "should not call http");
  });

  await test("duration fills missing end and is sent as duration_ms", async function () {
    route("/v3/media", ok({ credits: [{ start_ms: 3000000 }] }));
    var segments = await segmentsExt().segments(ctx(), {
      ids: { tmdb: "550" },
      mediaType: "movie",
      duration: 3600,
    });
    assert(segments.length === 1, "segments");
    assert(segments[0].start === 3000, "start");
    assert(segments[0].end === 3600, "end from duration");
    assert(requests[0].query.duration_ms === "3600000", "duration_ms");
  });

  await test("invalid ranges are dropped", async function () {
    route("/v3/media", ok({
      intro: [{ start_ms: 5000, end_ms: 5000 }],
      credits: [{ start_ms: 9000, end_ms: 1000 }],
    }));
    var segments = await segmentsExt().segments(ctx(), {
      ids: { tmdb: "550" },
      mediaType: "movie",
    });
    assert(segments.length === 0, "invalid ranges dropped");
  });

  await test("media 404 returns empty", async function () {
    route("/v3/media", fail(404, { error: "not found" }));
    var segments = await segmentsExt().segments(ctx(), {
      ids: { tmdb: "1" },
      mediaType: "movie",
    });
    assert(segments.length === 0, "empty segments");
  });

  await test("http 400 maps to invalid_params", async function () {
    route("/v3/media", fail(400, { error: "unknown media" }));
    try {
      await segmentsExt().segments(ctx(), { ids: { tmdb: "1" }, mediaType: "movie" });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "invalid_params");
    }
  });

  await test("http 429 maps to rate_limited", async function () {
    route("/v3/media", fail(429, { error: "rate limited" }));
    try {
      await segmentsExt().segments(ctx(), { ids: { tmdb: "1" }, mediaType: "movie" });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "rate_limited");
    }
  });

  await test("http 500 maps to unavailable", async function () {
    route("/v3/media", fail(500, { error: "oops" }));
    try {
      await segmentsExt().segments(ctx(), { ids: { tmdb: "1" }, mediaType: "movie" });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "unavailable");
    }
  });

  await test("non-json response maps to unavailable", async function () {
    route("/v3/media", ok("<html>oops</html>"));
    try {
      await segmentsExt().segments(ctx(), { ids: { tmdb: "1" }, mediaType: "movie" });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "unavailable");
    }
  });

  if (LIVE) {
    await test("live segments for TMDB 550", async function () {
      var liveCtx = {
        locale: "zh-CN",
        settings: {},
        http: {
          get: async function (url, options) {
            var target = url;
            if (options && options.query) {
              var qs = Object.keys(options.query)
                .map(function (k) { return k + "=" + encodeURIComponent(options.query[k]); })
                .join("&");
              target = url + "?" + qs;
            }
            var res = await fetch(target, { headers: (options && options.headers) || {} });
            var text = await res.text();
            var data = text;
            try { data = JSON.parse(text); } catch (e) { data = text; }
            return { status: res.status, headers: {}, data: data };
          },
        },
      };
      var segments = await segmentsExt().segments(liveCtx, {
        ids: { tmdb: "550" },
        mediaType: "movie",
      });
      assert(Array.isArray(segments), "segments array");
      segments.forEach(function (segment) {
        assert(typeof segment.type === "string", "segment type");
        assert(segment.start >= 0 && segment.end > segment.start, "segment range");
      });
    });
  }

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
