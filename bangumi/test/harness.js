"use strict";

/**
 * 在 Node 中加载 bangumi.js：注入 definePackage / ExtensionError / ctx.http，
 * 并对真实 Bangumi API 跑一遍 widget / search / list / detail。
 *
 * 用法（仓库根目录）：node bangumi/test/harness.js
 */

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var { URL } = require("url");
var { ExtensionError, assertError } = require("./errors");

var EXT_PATH = path.join(__dirname, "..", "bangumi.js");
var API_ORIGIN = "https://api.bgm.tv";
var FRIEREN_ID = "400602";

var pkg = null;
var httpOverride = null;
var failed = 0;
var passed = 0;

function definePackage(definition) {
  pkg = definition;
}

function allowedOrigin(url) {
  var list = (((pkg || {}).permissions || {}).network) || [];
  return list.some(function (origin) {
    return url === origin || url.indexOf(origin.replace(/\/$/, "") + "/") === 0;
  });
}

function applyQuery(url, query) {
  if (!query) return url;
  var u = new URL(url);
  Object.keys(query).forEach(function (k) {
    if (query[k] !== undefined && query[k] !== null) u.searchParams.set(k, String(query[k]));
  });
  return u.toString();
}

async function realRequest(method, url, body, options) {
  options = options || {};
  var target = applyQuery(url, options.query);
  if (pkg && !allowedOrigin(target)) {
    throw new ExtensionError({
      code: "internal",
      message: "origin not in permissions.network: " + target,
      retryable: false,
    });
  }
  var headers = Object.assign({}, options.headers);
  var init = { method: method, headers: headers };
  if (body !== undefined && body !== null) init.body = body;
  var ctrl = typeof AbortController === "function" ? new AbortController() : null;
  if (ctrl && options.timeoutMs) {
    init.signal = ctrl.signal;
    setTimeout(function () { ctrl.abort(); }, options.timeoutMs).unref();
  }
  var res = await fetch(target, init);
  var text = await res.text();
  var data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }
  var hdrs = {};
  res.headers.forEach(function (v, k) {
    hdrs[k] = v;
  });
  return { status: res.status, headers: hdrs, data: data };
}

function http() {
  return {
    get: async function (url, options) {
      if (httpOverride && httpOverride.get) return httpOverride.get(url, options);
      return realRequest("GET", url, undefined, options);
    },
    post: async function (url, body, options) {
      if (httpOverride && httpOverride.post) return httpOverride.post(url, body, options);
      return realRequest("POST", url, body, options);
    },
  };
}

function makeStorage() {
  var store = Object.create(null);
  return {
    get: function (key) { return store[key]; },
    set: function (key, value) { store[key] = value; },
    remove: function (key) { delete store[key]; },
  };
}

function ctx(settings) {
  return {
    locale: "zh-CN",
    settings: settings || { titleLang: "cn", cover: "large" },
    http: http(),
    storage: makeStorage(),
  };
}

function ext(type, id) {
  var list = (pkg && pkg.extensions) || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].type === type && list[i].id === id) return list[i];
  }
  throw new Error("missing extension " + type + "/" + id);
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("ok   " + name);
  } catch (e) {
    failed += 1;
    console.error("FAIL " + name);
    console.error("     " + (e && (e.stack || e.message || e)));
  } finally {
    httpOverride = null;
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
    assert(pkg.id === "conflux.bangumi", "id");
    assert(pkg.version === "1.0.0", "version");
    assert(pkg.engine === 1, "engine");
    assert(pkg.title === "Bangumi 番组计划", "title");
    var net = (pkg.permissions && pkg.permissions.network) || [];
    assert(net.indexOf(API_ORIGIN) >= 0, "permissions.network");
    var types = pkg.extensions.map(function (e) { return e.type; });
    ["widget", "search", "list", "detail"].forEach(function (t) {
      assert(types.indexOf(t) >= 0, "missing type " + t);
    });
  });

  await test("widget daily load (live calendar)", async function () {
    var res = await ext("widget", "daily").load(ctx(), {
      params: { weekday: "1", sort: "heat" },
    });
    assert(res && Array.isArray(res.items), "items array");
    assert(res.items.length > 0, "calendar should have Monday items");
    var item = res.items[0];
    assert(item.ref && item.ref.source === "custom", "ref.source");
    assert(item.ref.id && /^\d+$/.test(String(item.ref.id)), "ref.id");
    assert(item.title, "title");
  });

  await test("widget season load (live subjects)", async function () {
    var res = await ext("widget", "season").load(ctx(), {
      params: { year: 2023, month: "10", sort: "rank", tvOnly: true },
    });
    assert(res && Array.isArray(res.items), "items array");
    assert(res.items.length > 0, "2023-10 season should have items");
    assert(res.items.some(function (it) { return it.ref && it.ref.id; }), "item ref");
  });

  await test("widget ranking load (live rank)", async function () {
    var res = await ext("widget", "ranking").load(ctx(), { params: { year: 2023 } });
    assert(res && Array.isArray(res.items), "items array");
    assert(res.items.length > 0, "2023 ranking should have items");
    var rated = res.items.filter(function (it) { return typeof it.rating === "number"; });
    assert(rated.length > 0, "some items should have ratings");
  });

  await test("search 芙莉莲 (live)", async function () {
    var res = await ext("search", "main").search(ctx(), {
      query: "芙莉莲",
      params: { sort: "match" },
    });
    assert(res && Array.isArray(res.items), "items array");
    assert(res.items.length > 0, "search should return results");
    var hit = res.items.find(function (it) {
      return it.ref && String(it.ref.id) === FRIEREN_ID;
    }) || res.items[0];
    assert(hit.title, "search hit title");
    assert(hit.ref && hit.ref.source === "custom", "search hit ref");
  });

  await test("search empty query returns no items", async function () {
    var res = await ext("search", "main").search(ctx(), { query: "   " });
    assert(res && Array.isArray(res.items) && res.items.length === 0, "empty items");
  });

  await test("list posters calendar (live)", async function () {
    var res = await ext("list", "posters").load(ctx(), {
      ref: { source: "custom", id: "list:calendar" },
      params: { weekday: "1" },
    });
    assert(res && Array.isArray(res.items), "items array");
    assert(res.items.length > 0, "calendar list items");
  });

  await test("detail 葬送的芙莉莲 (live)", async function () {
    var detail = await ext("detail", "main").load(ctx(), {
      ref: { source: "custom", id: FRIEREN_ID, mediaType: "tv" },
    });
    assert(detail, "detail present");
    assert(detail.ref && String(detail.ref.id) === FRIEREN_ID, "ref.id");
    assert(detail.title && /芙莉莲|フリーレン/.test(detail.title), "title mentions Frieren");
    assert(detail.description, "description");
    assert(Array.isArray(detail.episodes) && detail.episodes.length > 0, "episodes");
    assert(detail.images && detail.images.poster, "poster");
  });

  await test("detail invalid id returns null", async function () {
    var detail = await ext("detail", "main").load(ctx(), {
      ref: { source: "custom", id: "not-a-number" },
    });
    assert(detail === null, "invalid id -> null");
  });

  await test("detail missing subject returns null (live 404)", async function () {
    var detail = await ext("detail", "main").load(ctx(), {
      ref: { source: "custom", id: "1", mediaType: "tv" },
    });
    // id=1 可能存在；用一个极大且几乎不可能存在的数字
    detail = await ext("detail", "main").load(ctx(), {
      ref: { source: "custom", id: "999999999", mediaType: "tv" },
    });
    assert(detail === null, "unknown subject -> null");
  });

  await test("http 429 maps to rate_limited", async function () {
    httpOverride = {
      get: async function () {
        return { status: 429, headers: {}, data: { title: "Too Many Requests" } };
      },
    };
    try {
      await ext("widget", "daily").load(ctx(), { params: { weekday: "1" } });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "rate_limited");
    }
  });

  await test("http 400 maps to invalid_params", async function () {
    httpOverride = {
      get: async function () {
        return { status: 400, headers: {}, data: { title: "Bad Request" } };
      },
    };
    try {
      await ext("widget", "ranking").load(ctx(), { params: {} });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "invalid_params");
    }
  });

  await test("http 500 maps to unavailable", async function () {
    httpOverride = {
      get: async function () {
        return { status: 500, headers: {}, data: "oops" };
      },
    };
    try {
      await ext("widget", "ranking").load(ctx(), { params: {} });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "unavailable");
    }
  });

  await test("http 404 maps to not_found when not allowed", async function () {
    httpOverride = {
      get: async function () {
        return { status: 404, headers: {}, data: { title: "Not Found" } };
      },
    };
    try {
      await ext("widget", "daily").load(ctx(), { params: { weekday: "1" } });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "not_found");
    }
  });

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
