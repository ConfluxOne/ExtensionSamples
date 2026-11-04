"use strict";

/**
 * 在 Node 中加载 douban.js：注入 definePackage / ExtensionError / ctx.http，
 * 用内联 fixture（真实豆瓣响应的精简版）和路由表 mock 跑一遍
 * widget / search / list / detail，不需要网络。
 *
 * 用法（仓库根目录）：
 *   node Packages/ExtensionSamples/others/douban/test/harness.js
 * 或在 Packages/ExtensionSamples 下：
 *   node others/douban/test/harness.js
 */

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var { URL } = require("url");
var { ExtensionError, assertError } = require("./errors");

var EXT_PATH = path.join(__dirname, "..", "douban.js");

var M = "https://m.douban.com";
var SUGGEST = "https://movie.douban.com";
var API = M + "/rexxar/api/v2";
var PAGE_SIZE = 18; // 榜单接口每页条数；第二页 start=18
var TOTAL = 21; // 21 = 第一页 18 + 第二页 3，正好在第二页结束

var pkg = null;
var requests = [];
var routes = [];

function definePackage(definition) {
  pkg = definition;
}

function reset() {
  requests = [];
  routes = [];
}

/* ---------- 路由与 http mock ---------- */

function route(match, response) {
  routes.push({ match: match, response: response });
}

function equalsPath(p) {
  return function (url) {
    return requestPath(url) === p;
  };
}

function requestPath(url) {
  try {
    return new URL(url).pathname;
  } catch (e) {
    return String(url).split("?")[0];
  }
}

function queryValue(url, options, key) {
  if (options && options.query && options.query[key] !== undefined && options.query[key] !== null) {
    return String(options.query[key]);
  }
  try {
    return new URL(url).searchParams.get(key);
  } catch (e) {
    return null;
  }
}

function findRoute(url) {
  for (var i = 0; i < routes.length; i++) {
    var m = routes[i].match;
    var hit = typeof m === "function" ? !!m(url) : m instanceof RegExp ? m.test(url) : url.indexOf(m) >= 0;
    if (hit) return routes[i].response;
  }
  return null;
}

function allowedOrigin(url) {
  var list = (((pkg || {}).permissions || {}).network) || [];
  try {
    return list.indexOf(new URL(url).origin) >= 0;
  } catch (e) {
    return false;
  }
}

async function fakeGet(url, options) {
  requests.push({
    url: url,
    path: requestPath(url),
    query: (options && options.query) || {},
    start: queryValue(url, options, "start"),
    count: queryValue(url, options, "count"),
  });
  if (!allowedOrigin(url)) {
    throw new ExtensionError({
      code: "internal",
      message: "origin not in permissions.network: " + url,
      retryable: false,
    });
  }
  var response = findRoute(url);
  if (!response) throw new Error("unexpected http GET " + url);
  return typeof response === "function" ? response(url, options) : response;
}

function ctx(settings) {
  var store = Object.create(null);
  return {
    locale: "zh-CN",
    settings: settings || {},
    http: {
      get: fakeGet,
      post: async function (url) {
        throw new Error("unexpected http POST " + url);
      },
    },
    storage: {
      get: function (key) {
        return store[key];
      },
      set: function (key, value) {
        store[key] = value;
      },
      remove: function (key) {
        delete store[key];
      },
    },
  };
}

function ok(data) {
  return { status: 200, headers: {}, data: data };
}

function httpStatus(status, data) {
  return { status: status, headers: {}, data: data === undefined ? {} : data };
}

function ext(type, id) {
  var list = (pkg && pkg.extensions) || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].type === type && list[i].id === id) return list[i];
  }
  throw new Error("missing extension " + type + "/" + id);
}

/* ---------- 测试框架 ---------- */

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

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || "assertion failed") + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

function loadExtension() {
  var code = fs.readFileSync(EXT_PATH, "utf8");
  var sandbox = {
    definePackage: definePackage,
    ExtensionError: ExtensionError,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    URL: URL,
    URLSearchParams: URLSearchParams,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: EXT_PATH });
  assert(pkg, "definePackage was not called");
}

/* ---------- fixtures：榜单条目 ---------- */
/* 真实 collection 响应的条目结构随榜单不同而变化：
 * - movie_top250 / movie_weekly_best / tv_*_best_weekly：cover_url + pic + photos + tags + rank
 * - movie_showing / movie_hot_gaia：没有 cover_url，海报在 cover.url
 * - tv_hot：没有 cover_url，海报在 pic.large
 * fixture 刻意保留这三种形状，验证实现的海报回退链。 */

var MOVIE_ITEMS = [
  {
    id: "1292052",
    title: "肖申克的救赎",
    type: "movie",
    subtype: "movie",
    rank: 1,
    rank_value: 1,
    rating: { count: 3361493, max: 10, star_count: 5, value: 9.7 },
    tags: [{ name: "剧情", type: "manual" }],
    photos: [
      "https://img3.doubanio.com/view/photo/m/public/p456482220.jpg",
      "https://img3.doubanio.com/view/photo/m/public/p490576110.jpg",
      "https://img2.doubanio.com/view/photo/m/public/p825401501.jpg",
      "https://img9.doubanio.com/view/photo/m/public/p825402445.jpg",
    ],
    cover_url: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2936346968.jpg",
    pic: {
      large: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2936346968.jpg",
      normal: "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2936346968.jpg",
    },
    card_subtitle: "1994 / 美国 / 剧情 犯罪 / 弗兰克·德拉邦特 / 蒂姆·罗宾斯 摩根·弗里曼",
    description: "希望让人自由。",
    url: "https://movie.douban.com/subject/1292052/",
  },
  {
    id: "1291546",
    title: "霸王别姬",
    type: "movie",
    subtype: "movie",
    rank: 2,
    rank_value: 2,
    rating: { count: 2463265, max: 10, star_count: 5, value: 9.6 },
    tags: [],
    photos: [],
    cover_url: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2911205318.jpg",
    pic: {
      large: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2911205318.jpg",
      normal: "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2911205318.jpg",
    },
    card_subtitle: "1993 / 中国大陆 中国香港 / 剧情 爱情 同性 / 陈凯歌 / 张国荣 张丰毅",
    description: "风华绝代。",
    url: "https://movie.douban.com/subject/1291546/",
  },
  {
    // movie_showing / movie_hot_gaia 的真实形状：只有 cover.url
    id: "37322586",
    title: "生日快乐",
    type: "movie",
    subtype: "",
    rank: null,
    rank_value: null,
    rating: { count: 25919, max: 10, star_count: 4.5, value: 8.9 },
    cover: {
      url: "https://img9.doubanio.com/view/photo/m_ratio_poster/public/p2935834896.jpg",
      width: 7277,
      height: 10879,
      shape: "rectangle",
    },
    cover_url: null,
    pic: null,
    release_date: "10.23",
    year: "2025",
    card_subtitle: "2025 / 埃及 / 剧情 / 萨拉·戈赫尔 / 朵哈·拉马丹 哈迪贾·艾哈迈德",
    description: "",
    url: "https://www.douban.com/doubanapp/dispatch/movie/37322586",
  },
];

var TV_ITEMS = [
  {
    id: "37296949",
    title: "蒸蒸日上",
    type: "tv",
    subtype: "tv",
    rank: 1,
    rank_value: 1,
    rating: { count: 30690, max: 10, star_count: 4, value: 7.8 },
    tags: [{ name: "喜剧", type: "manual" }],
    photos: [
      "https://img3.doubanio.com/view/photo/m/public/p2936828812.jpg",
      "https://img3.doubanio.com/view/photo/m/public/p2936775059.jpg",
      "https://img2.doubanio.com/view/photo/m/public/p2936657181.jpg",
      "https://img2.doubanio.com/view/photo/m/public/p2936828811.jpg",
    ],
    cover_url: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2936476679.jpg",
    pic: {
      large: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2936476679.jpg",
      normal: "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2936476679.jpg",
    },
    card_subtitle: "2026 / 中国大陆 / 剧情 喜剧 / 姚婷婷 / 王皓 高叶",
    description: "女律师萧龙女因坚持正义原则离开高端律所，在大众浴池二楼组建草根律师团队。",
    url: "https://movie.douban.com/subject/37296949/",
  },
  {
    id: "38456015",
    title: "人生七年10",
    type: "tv",
    subtype: "tv",
    rank: 2,
    rank_value: 2,
    rating: { count: 2140, max: 10, star_count: 5, value: 9.5 },
    tags: [
      { name: "纪录片", type: "manual" },
      { name: "连续上榜2周", type: "continuous" },
    ],
    photos: [
      "https://img9.doubanio.com/view/photo/m/public/p2935608254.jpg",
      "https://img3.doubanio.com/view/photo/m/public/p2936082463.jpg",
      "https://img3.doubanio.com/view/photo/m/public/p2936082478.jpg",
      "https://img9.doubanio.com/view/photo/m/public/p2936098535.jpg",
    ],
    cover_url: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2936620387.jpg",
    pic: {
      large: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2936620387.jpg",
      normal: "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2936620387.jpg",
    },
    card_subtitle: "2026 / 英国 / 纪录片 / 阿斯弗·卡帕迪尔 / Tony Walker Charles Furneaux",
    description: "在该系列长期主创迈克尔·阿普特于 2021 年去世后，由阿西夫·卡帕迪亚执导的最终集。",
    url: "https://movie.douban.com/subject/38456015/",
  },
  {
    // tv_hot 的真实形状：没有 cover_url，海报在 pic.large
    id: "36675942",
    title: "小城良方",
    type: "tv",
    subtype: null,
    rank: null,
    rank_value: null,
    rating: { count: 249311, max: 10, star_count: 4, value: 8.0 },
    tags: [],
    photos: [
      "https://img9.doubanio.com/view/photo/m/public/p2936716204.jpg",
      "https://img3.doubanio.com/view/photo/m/public/p2936716088.jpg",
      "https://img9.doubanio.com/view/photo/m/public/p2936716086.jpg",
    ],
    cover_url: null,
    pic: {
      large: "https://img2.doubanio.com/view/photo/m_ratio_poster/public/p2936709341.jpg",
      normal: "https://img2.doubanio.com/view/photo/s_ratio_poster/public/p2936709341.jpg",
    },
    card_subtitle: "2026 / 中国大陆 / 剧情 / 张晓波 / 肖战 倪大红",
    description: "该剧讲述了天才医生刘铮亮（肖战饰）遭遇人生滑铁卢，被迫返回家乡从零开始的故事。",
    url: "https://movie.douban.com/subject/36675942/",
  },
];

var MOVIE_PAGE2 = [
  {
    id: "1292722",
    title: "泰坦尼克号",
    type: "movie",
    rank: 4,
    rating: { count: 2540863, max: 10, star_count: 5, value: 9.5 },
    cover_url: "https://img9.doubanio.com/view/photo/m_ratio_poster/public/p457760035.jpg",
    pic: {
      large: "https://img9.doubanio.com/view/photo/m_ratio_poster/public/p457760035.jpg",
      normal: "https://img9.doubanio.com/view/photo/s_ratio_poster/public/p457760035.jpg",
    },
    card_subtitle: "1997 / 美国 / 剧情 爱情 灾难 / 詹姆斯·卡梅隆 / 莱昂纳多·迪卡普里奥 凯特·温斯莱特",
    url: "https://movie.douban.com/subject/1292722/",
  },
  {
    id: "1295644",
    title: "这个杀手不太冷",
    type: "movie",
    rank: 5,
    rating: { count: 2400000, max: 10, star_count: 5, value: 9.4 },
    cover_url: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p511118051.jpg",
    pic: {
      large: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p511118051.jpg",
      normal: "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p511118051.jpg",
    },
    card_subtitle: "1994 / 法国 美国 / 剧情 动作 犯罪 / 吕克·贝松 / 让·雷诺 娜塔莉·波特曼",
    url: "https://movie.douban.com/subject/1295644/",
  },
  {
    id: "1292063",
    title: "阿甘正传",
    type: "movie",
    rank: 6,
    rating: { count: 2200000, max: 10, star_count: 5, value: 9.5 },
    cover_url: "https://img2.doubanio.com/view/photo/m_ratio_poster/public/p2372307693.jpg",
    pic: {
      large: "https://img2.doubanio.com/view/photo/m_ratio_poster/public/p2372307693.jpg",
      normal: "https://img2.doubanio.com/view/photo/s_ratio_poster/public/p2372307693.jpg",
    },
    card_subtitle: "1994 / 美国 / 剧情 爱情 / 罗伯特·泽米吉斯 / 汤姆·汉克斯 罗宾·怀特",
    url: "https://movie.douban.com/subject/1292063/",
  },
];

var TV_PAGE2 = [
  {
    id: "35597204",
    title: "漫长的季节",
    type: "tv",
    rank: 3,
    rating: { count: 900000, max: 10, star_count: 5, value: 9.4 },
    cover_url: "https://img2.doubanio.com/view/photo/m_ratio_poster/public/p2890602537.jpg",
    pic: {
      large: "https://img2.doubanio.com/view/photo/m_ratio_poster/public/p2890602537.jpg",
      normal: "https://img2.doubanio.com/view/photo/s_ratio_poster/public/p2890602537.jpg",
    },
    card_subtitle: "2023 / 中国大陆 / 剧情 悬疑 犯罪 / 辛爽 / 范伟 秦昊",
    url: "https://movie.douban.com/subject/35597204/",
  },
  {
    id: "34990033",
    title: "重启人生",
    type: "tv",
    rank: 4,
    rating: { count: 400000, max: 10, star_count: 5, value: 9.3 },
    cover_url: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2886338575.jpg",
    pic: {
      large: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2886338575.jpg",
      normal: "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2886338575.jpg",
    },
    card_subtitle: "2023 / 日本 / 剧情 奇幻 / 水野格 / 安藤樱 夏帆",
    url: "https://movie.douban.com/subject/34990033/",
  },
  {
    id: "35158607",
    title: "三体",
    type: "tv",
    rank: 5,
    rating: { count: 400000, max: 10, star_count: 4.5, value: 8.7 },
    cover_url: "https://img9.doubanio.com/view/photo/m_ratio_poster/public/p2887147696.jpg",
    pic: {
      large: "https://img9.doubanio.com/view/photo/m_ratio_poster/public/p2887147696.jpg",
      normal: "https://img9.doubanio.com/view/photo/s_ratio_poster/public/p2887147696.jpg",
    },
    card_subtitle: "2023 / 中国大陆 / 剧情 科幻 / 杨磊 / 张鲁一 于和伟",
    url: "https://movie.douban.com/subject/35158607/",
  },
];

function expectedPoster(item) {
  return (
    item.cover_url ||
    (item.cover && item.cover.url) ||
    (item.pic && (item.pic.large || item.pic.normal)) ||
    (item.photos && item.photos[0])
  );
}

function collectionBody(items, total, start) {
  return { total: total, start: start, count: items.length, subject_collection_items: items };
}

/** mock 任意 subject_collection 的 items 接口，按 start 返回第一页/第二页/空页 */
function mockCollection(key, items, page2Items, total) {
  route(
    equalsPath("/rexxar/api/v2/subject_collection/" + key + "/items"),
    function (url, options) {
      var start = parseInt(queryValue(url, options, "start") || "0", 10) || 0;
      if (start === 0) return ok(collectionBody(items, total, 0));
      if (start === PAGE_SIZE) return ok(collectionBody(page2Items || items, total, PAGE_SIZE));
      return ok(collectionBody([], total, start));
    }
  );
}

/* ---------- fixtures：详情与演职员 ---------- */

var MOVIE_DETAIL = {
  id: "26266893",
  title: "流浪地球",
  original_title: "",
  type: "movie",
  subtype: "movie",
  is_tv: false,
  year: "2019",
  genres: ["科幻", "冒险", "灾难"],
  rating: { count: 2061008, max: 10, star_count: 4, value: 7.9 },
  cover_url: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2545472803.jpg",
  pic: {
    large: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2545472803.jpg",
    normal: "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2545472803.jpg",
  },
  url: "https://movie.douban.com/subject/26266893/",
  card_subtitle: "2019 / 中国大陆 / 科幻 冒险 灾难 / 郭帆 / 吴京 屈楚萧",
  intro:
    "近未来，科学家们发现太阳急速衰老膨胀，短时间内包括地球在内的整个太阳系都将被太阳所吞没。为了自救，人类提出一个名为“流浪地球”的大胆计划，即倾全球之力在地球表面建造上万座发动机和转向发动机，推动地球离开太阳系。",
  pubdate: ["2019-02-05(中国大陆)"],
  durations: ["125分钟", "137分钟(重映版)"],
  countries: ["中国大陆"],
  languages: ["汉语普通话", "英语"],
  directors: [{ name: "郭帆" }],
  actors: [{ name: "吴京" }, { name: "屈楚萧" }, { name: "李光洁" }],
  tags: [],
  aka: ["The Wandering Earth"],
};

var TV_DETAIL = {
  id: "37296949",
  title: "蒸蒸日上",
  original_title: "",
  type: "tv",
  subtype: "tv",
  is_tv: true,
  year: "2026",
  genres: ["剧情", "喜剧"],
  rating: { count: 30690, max: 10, star_count: 4, value: 7.8 },
  cover_url: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2936476679.jpg",
  pic: {
    large: "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2936476679.jpg",
    normal: "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2936476679.jpg",
  },
  url: "https://movie.douban.com/subject/37296949/",
  card_subtitle: "2026 / 中国大陆 / 剧情 喜剧 / 姚婷婷 / 王皓 高叶",
  intro:
    "烟火气十足的东北某城律师街上，为人侠气、幽默的女律师萧龙女在大众浴池楼上开了一家律师事务所。她曾在当地最高端的泓湖律所里工作，却因一起案件中的正义之举而离职。",
  pubdate: ["2026-10-08"],
  durations: ["45分钟"],
  episodes_count: 22,
  episodes_info: "22集全",
  countries: ["中国大陆"],
  languages: ["汉语普通话"],
  directors: [{ name: "姚婷婷" }],
  actors: [{ name: "王皓" }, { name: "高叶" }, { name: "韩东君" }],
  tags: [],
};

var MOVIE_CELEBS = {
  total: 3,
  directors: [
    {
      id: "1274997",
      name: "郭帆",
      latin_name: "Frant Gwo",
      character: "导演",
      roles: ["导演", "编剧"],
      avatar: {
        large: "https://img3.doubanio.com/view/personage/m/public/447904432aa50f51b594a78dbf951fdb.jpg",
        normal: "https://img3.doubanio.com/view/personage/m/public/447904432aa50f51b594a78dbf951fdb.jpg",
      },
      url: "https://movie.douban.com/celebrity/1274997/",
    },
  ],
  actors: [
    {
      id: "1274883",
      name: "吴京",
      latin_name: "Jing Wu",
      character: "饰 刘培强",
      roles: ["演员"],
      avatar: {
        large: "https://img9.doubanio.com/view/personage/m/public/50311d02cfdb9c33b52032c84c864484.jpg",
        normal: "https://img9.doubanio.com/view/personage/m/public/50311d02cfdb9c33b52032c84c864484.jpg",
      },
      url: "https://movie.douban.com/celebrity/1274883/",
    },
    {
      id: "1352761",
      name: "屈楚萧",
      latin_name: "Chuxiao Qu",
      character: "饰 刘启",
      roles: ["演员"],
      avatar: {
        large: "https://img3.doubanio.com/view/personage/m/public/45704aa544cb96232e8f77313681236d.jpg",
        normal: "https://img3.doubanio.com/view/personage/m/public/45704aa544cb96232e8f77313681236d.jpg",
      },
      url: "https://movie.douban.com/celebrity/1352761/",
    },
  ],
};

var TV_CELEBS = {
  total: 4,
  directors: [
    {
      id: "1324487",
      name: "姚婷婷",
      latin_name: "Tingting Yao",
      character: "导演",
      roles: ["导演", "编剧"],
      avatar: {
        large: "https://img3.doubanio.com/view/personage/m/public/447904432aa50f51b594a78dbf951fdb.jpg",
        normal: "https://img3.doubanio.com/view/personage/m/public/447904432aa50f51b594a78dbf951fdb.jpg",
      },
      url: "https://movie.douban.com/celebrity/1324487/",
    },
  ],
  actors: [
    {
      id: "1464754",
      name: "王皓",
      latin_name: "Hao Wang",
      character: "饰 董北虎",
      roles: ["演员"],
      avatar: {
        large: "https://img9.doubanio.com/view/personage/m/public/50311d02cfdb9c33b52032c84c864484.jpg",
        normal: "https://img9.doubanio.com/view/personage/m/public/50311d02cfdb9c33b52032c84c864484.jpg",
      },
      url: "https://movie.douban.com/celebrity/1464754/",
    },
    {
      id: "1322964",
      name: "高叶",
      latin_name: "Ye Gao",
      character: "饰 萧龙女",
      roles: ["演员"],
      avatar: {
        large: "https://img3.doubanio.com/view/personage/m/public/45704aa544cb96232e8f77313681236d.jpg",
        normal: "https://img3.doubanio.com/view/personage/m/public/45704aa544cb96232e8f77313681236d.jpg",
      },
      url: "https://movie.douban.com/celebrity/1322964/",
    },
  ],
};

/* ---------- fixtures：搜索（rexxar JSON 主路径 + 标题联想兜底） ---------- */
/* 搜索主路径 /rexxar/api/v2/search/subjects 返回 types（各类型总数）与
 * subjects.items（target_type + target）；封面是 qnmob3-sign 签名 URL。
 * 标题联想兜底 /j/subject_suggest 返回 JSON 数组，episode 为正整数即剧集。 */

var SIGNED_MOVIE_COVER =
  "https://qnmob3-sign.doubanio.com/view/photo/m/public/p2545472803.jpg?sa_cv=1ff98d06bc5dc3667e4936ffb0787d49&sa_ct=6ae836fd&imageView2/0/q/80/w/9999/h/120/format/jpg";
// douban.js 会把签名封面的 imageView2 尺寸改成 600×900，避免 120×180 的小图。
var BIG_MOVIE_COVER = SIGNED_MOVIE_COVER.replace(/w\/\d+\/h\/\d+/, "w/600/h/900");
var SIGNED_TV_COVER =
  "https://qnmob3-sign.doubanio.com/view/photo/m/public/p2887147696.jpg?sa_cv=7c2c3a02e2b1d5c0a3f41a1a5c0de1c2&sa_ct=6ae836fd";
var SIGNED_PAGE2_COVER =
  "https://qnmob3-sign.doubanio.com/view/photo/m/public/p457760035.jpg?sa_cv=b3e18e61f5a6c9d8e0d4a2b7c1f39a20&sa_ct=6ae836fd";
var SUGGEST_COVER = "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2545472803.jpg";

var SEARCH_TOTAL = 45; // 影视合并总数；45 > 20、40，所以前两页都有 next

function searchRow(targetType, target) {
  return { target_type: targetType, target: target };
}

var SEARCH_PAGE1_ITEMS = [
  searchRow("movie", {
    id: "26266893",
    title: "流浪地球",
    year: "2019",
    card_subtitle: "2019 / 中国大陆 / 科幻 冒险 灾难 / 郭帆 / 吴京 屈楚萧",
    cover_url: SIGNED_MOVIE_COVER,
    rating: { value: 7.9, count: 2061008 },
  }),
  searchRow("tv", {
    id: "26647087",
    title: "三体",
    year: "2023",
    card_subtitle: "2023 / 中国大陆 / 剧情 科幻 / 杨磊 / 张鲁一 于和伟",
    cover_url: SIGNED_TV_COVER,
    rating: { value: 8.7, count: 400000 },
  }),
  // subjects 里会混入榜单（chart），实现应过滤掉
  searchRow("chart", {
    id: "ECAUOWGNQ",
    title: "华语冒险片榜",
    year: "",
    card_subtitle: "",
    cover_url: "https://img9.doubanio.com/img/files/file-1543564940.png",
    rating: null,
  }),
];

var SEARCH_PAGE2_ITEMS = [
  searchRow("movie", {
    id: "1292722",
    title: "泰坦尼克号",
    year: "1997",
    card_subtitle: "1997 / 美国 / 剧情 爱情 灾难 / 詹姆斯·卡梅隆 / 莱昂纳多·迪卡普里奥 凯特·温斯莱特",
    cover_url: SIGNED_PAGE2_COVER,
    rating: { value: 9.5, count: 2540863 },
  }),
  searchRow("tv", {
    id: "35597204",
    title: "漫长的季节",
    year: "2023",
    card_subtitle: "2023 / 中国大陆 / 剧情 悬疑 犯罪 / 辛爽 / 范伟 秦昊",
    cover_url: SIGNED_PAGE2_COVER,
    rating: { value: 9.4, count: 900000 },
  }),
];

function searchSubjectsBody(items, total) {
  return {
    types: [
      { type: "movie", type_name: "影视", total: String(total) },
      { type: "book", type_name: "图书", total: "23" },
    ],
    subjects: { items: items },
  };
}

function mockSearchSubjects(page1Items, page2Items, total) {
  route(
    equalsPath("/rexxar/api/v2/search/subjects"),
    function (url, options) {
      var start = parseInt(queryValue(url, options, "start") || "0", 10) || 0;
      var items = start === 0 ? page1Items : page2Items || [];
      return ok(searchSubjectsBody(items, total));
    }
  );
}

var SEARCH_SUGGEST_ITEMS = [
  {
    id: "26266893",
    title: "流浪地球",
    img: SUGGEST_COVER,
    year: "2019",
    episode: "",
  },
  {
    id: "26647087",
    title: "三体",
    img: SUGGEST_COVER,
    year: "2023",
    episode: "1", // 正整数 → tv
  },
];


/* ---------- 固定契约 ---------- */

var WIDGETS = [
  {
    id: "showing",
    title: "正在热映",
    template: "poster-grid",
    families: ["small", "medium", "large"],
    collection: "movie_showing",
    mediaType: "movie",
    items: MOVIE_ITEMS,
    page2: MOVIE_PAGE2,
  },
  {
    id: "top250",
    title: "豆瓣电影 Top250",
    template: "poster-ranked",
    families: ["small", "medium", "large"],
    collection: "movie_top250",
    mediaType: "movie",
    items: MOVIE_ITEMS,
    page2: MOVIE_PAGE2,
  },
  {
    id: "weekly",
    title: "一周口碑榜",
    template: "ranked-list",
    families: ["medium", "large"],
    collection: "movie_weekly_best",
    mediaType: "movie",
    items: MOVIE_ITEMS,
    page2: MOVIE_PAGE2,
  },
  {
    id: "hot",
    title: "热门电影",
    template: "poster-pager",
    families: ["extraLarge"],
    collection: "movie_hot_gaia",
    mediaType: "movie",
    items: MOVIE_ITEMS,
    page2: MOVIE_PAGE2,
  },
  {
    id: "tv",
    title: "热门剧集",
    template: "poster-rail",
    families: ["extraLarge"],
    collection: "tv_hot",
    mediaType: "tv",
    items: TV_ITEMS,
    page2: TV_PAGE2,
  },
  {
    id: "tvRanked",
    title: "剧集口碑榜",
    template: "ranked-rail",
    families: ["extraLarge"],
    collection: "tv_chinese_best_weekly",
    globalCollection: "tv_global_best_weekly",
    mediaType: "tv",
    items: TV_ITEMS,
    page2: TV_PAGE2,
    params: { board: "cn" },
  },
];

function widgetParams(widget) {
  return widget.id === "tvRanked" ? { board: "cn" } : {};
}

loadExtension();

(async function main() {
  /* ---------- 包元数据 ---------- */

  await test("package metadata", function () {
    assertEq(pkg.id, "conflux.douban", "id");
    assertEq(pkg.title, "豆瓣", "title");
    assertEq(pkg.version, "1.1.3", "version");
    var rules = pkg.requestRules || [];
    assertEq(rules.length, 1, "requestRules");
    assertEq(rules[0].host, "img*.doubanio.com", "requestRules host");
    assertEq(rules[0].headers.Referer, "https://m.douban.com/", "requestRules Referer");
    assertEq(pkg.engine, 1, "engine");
    assertEq(pkg.author, "Anonymous", "author");
    assertEq(pkg.site, "https://www.douban.com", "site");
    assertEq(
      pkg.icon,
      "https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/others/icons/douban.png",
      "icon"
    );
    assert(typeof pkg.description === "string" && pkg.description.length > 0, "description");

    var net = (pkg.permissions && pkg.permissions.network) || [];
    assertEq(net.length, 2, "permissions.network 只应有 2 个 origin（m.douban.com / movie.douban.com）");
    [M, SUGGEST].forEach(function (origin) {
      assert(net.indexOf(origin) >= 0, "permissions.network 缺少 " + origin);
    });
    assert(net.indexOf("https://search.douban.com") < 0, "search.douban.com 已移除，不应再声明");

    var types = (pkg.extensions || []).map(function (e) {
      return e.type;
    });
    ["widget", "search", "list", "detail"].forEach(function (t) {
      assert(types.indexOf(t) >= 0, "missing extension type " + t);
    });
    assertEq(pkg.extensions.length, 9, "extensions 数量（6 widget + search + list + detail）");
  });

  await test("extension inventory matches the contract", function () {
    WIDGETS.forEach(function (w) {
      var widget = ext("widget", w.id);
      assertEq(widget.title, w.title, w.id + ".title");
      assertEq(widget.template, w.template, w.id + ".template");
      assertEq(
        JSON.stringify(widget.families || []),
        JSON.stringify(w.families),
        w.id + ".families"
      );
      assertEq(widget.header, "list", w.id + ".header");
      assert(widget.ref, w.id + ".ref");
      assertEq(widget.ref.source, "douban", w.id + ".ref.source");
      assertEq(widget.ref.id, "collection:" + w.id, w.id + ".ref.id");
      assertEq(widget.ref.mediaType, w.mediaType, w.id + ".ref.mediaType");
      assert(typeof widget.load === "function", w.id + ".load");
    });

    var tvRanked = ext("widget", "tvRanked");
    var board = (tvRanked.params || []).filter(function (p) {
      return p.name === "board";
    })[0];
    assert(board, "tvRanked.params.board");
    assertEq(board.type, "select", "board.type");
    var values = (board.options || []).map(function (o) {
      return o.value;
    });
    assert(values.indexOf("cn") >= 0 && values.indexOf("global") >= 0, "board options cn/global");

    var search = ext("search", "search");
    assert(typeof search.search === "function", "search.search");
    assert(search.cache && search.cache.ttlSeconds === 1800, "search.cache.ttlSeconds 应为 1800");

    var list = ext("list", "collection");
    assertEq(list.style, "grid", "list.style");
    assertEq(JSON.stringify((list.accepts || {}).sources || []), JSON.stringify(["douban"]), "list.accepts.sources");
    assert(typeof list.load === "function", "list.load");
    assert(list.search && list.search.id === "search", "list.search.id 应指向同包 search");
    assert(ext("search", list.search.id), "list.search 指向的 search 扩展存在");

    var detail = ext("detail", "main");
    assertEq(JSON.stringify((detail.accepts || {}).sources || []), JSON.stringify(["douban"]), "detail.accepts.sources");
    assertEq(
      JSON.stringify(((detail.accepts || {}).mediaTypes || []).slice().sort()),
      JSON.stringify(["movie", "tv"]),
      "detail.accepts.mediaTypes"
    );
    assert(typeof detail.load === "function", "detail.load");
  });

  /* ---------- 六个 widget ---------- */

  for (const w of WIDGETS) {
    await test("widget " + w.id + " load page 1", async function () {
      mockCollection(w.collection, w.items, w.page2, TOTAL);
      var res = await ext("widget", w.id).load(ctx(), {
        params: widgetParams(w),
        family: w.families[0],
      });
      assert(res && Array.isArray(res.items), "items 数组");
      assertEq(res.items.length, w.items.length, "items 长度");
      res.items.forEach(function (item, idx) {
        var expected = w.items[idx];
        assert(item.ref && item.ref.source === "douban", "items[" + idx + "].ref.source");
        assert(/^\d+$/.test(String(item.ref.id)), "items[" + idx + "].ref.id 应为纯数字字符串");
        assertEq(item.ref.id, expected.id, "items[" + idx + "].ref.id");
        assertEq(item.ref.mediaType, w.mediaType, "items[" + idx + "].ref.mediaType");
        assertEq(item.title, expected.title, "items[" + idx + "].title");
        assert(item.images && item.images.poster, "items[" + idx + "].images.poster");
        assertEq(item.images.poster, expectedPoster(expected), "items[" + idx + "].images.poster");
      });
      assert(res.next, "第一页应有 next");
      assertEq(res.next.type, "page", "widget next.type");
      assertEq(res.next.page, 2, "widget next.page");
    });

    await test("widget " + w.id + " load page 2 uses start=18 and ends", async function () {
      mockCollection(w.collection, w.items, w.page2, TOTAL);
      var res = await ext("widget", w.id).load(ctx(), {
        params: widgetParams(w),
        family: w.families[0],
        page: { type: "page", page: 2 },
      });
      var page2Request = requests.filter(function (r) {
        return r.start === String(PAGE_SIZE);
      })[0];
      assert(page2Request, "第二页请求应带 start=" + PAGE_SIZE);
      assert(res && Array.isArray(res.items), "items 数组");
      assertEq(res.items.length, w.page2.length, "第二页 items 长度");
      assertEq(res.items[0].ref.id, w.page2[0].id, "第二页第一条 id");
      assert(!res.next, "末页不应有 next");
      requests.forEach(function (r) {
        assertEq(r.path, "/rexxar/api/v2/subject_collection/" + w.collection + "/items", "请求路径");
      });
    });
  }

  await test("widget tvRanked switches collection key by board", async function () {
    mockCollection("tv_chinese_best_weekly", TV_ITEMS, TV_PAGE2, TOTAL);
    mockCollection("tv_global_best_weekly", TV_ITEMS, TV_PAGE2, TOTAL);

    await ext("widget", "tvRanked").load(ctx(), {
      params: { board: "cn" },
      family: "extraLarge",
    });
    var cnPaths = requests.map(function (r) {
      return r.path;
    });
    assert(
      cnPaths.indexOf("/rexxar/api/v2/subject_collection/tv_chinese_best_weekly/items") >= 0,
      "board=cn 应请求 tv_chinese_best_weekly，实际: " + cnPaths.join(", ")
    );

    reset();
    mockCollection("tv_chinese_best_weekly", TV_ITEMS, TV_PAGE2, TOTAL);
    mockCollection("tv_global_best_weekly", TV_ITEMS, TV_PAGE2, TOTAL);
    await ext("widget", "tvRanked").load(ctx(), {
      params: { board: "global" },
      family: "extraLarge",
    });
    var globalPaths = requests.map(function (r) {
      return r.path;
    });
    assert(
      globalPaths.indexOf("/rexxar/api/v2/subject_collection/tv_global_best_weekly/items") >= 0,
      "board=global 应请求 tv_global_best_weekly，实际: " + globalPaths.join(", ")
    );
  });

  /* ---------- 搜索：rexxar /search/subjects 主路径 ---------- */

  await test("search empty query returns no items without http", async function () {
    var res = await ext("search", "search").search(ctx(), { query: "   ", params: {} });
    assert(res && Array.isArray(res.items) && res.items.length === 0, "空关键词应返回空数组");
    assertEq(requests.length, 0, "空关键词不应发起请求");
  });

  await test("search uses rexxar subjects JSON, filters chart and keeps signed cover", async function () {
    mockSearchSubjects(SEARCH_PAGE1_ITEMS, SEARCH_PAGE2_ITEMS, SEARCH_TOTAL);
    var res = await ext("search", "search").search(ctx(), { query: "流浪地球", params: {} });

    var searchRequest = requests.filter(function (r) {
      return r.path === "/rexxar/api/v2/search/subjects";
    })[0];
    assert(searchRequest, "应请求 m.douban.com/rexxar/api/v2/search/subjects");
    assertEq(queryValue(searchRequest.url, { query: searchRequest.query }, "q"), "流浪地球", "q");
    assertEq(searchRequest.start, "0", "第一页 start=0");
    assertEq(queryValue(searchRequest.url, { query: searchRequest.query }, "count"), "20", "count=20");

    assert(res && Array.isArray(res.items), "items 数组");
    assertEq(res.items.length, 2, "只保留 movie/tv，chart 应被过滤");
    res.items.forEach(function (item) {
      assert(item.ref && item.ref.source === "douban", "search ref.source");
      assert(/^\d+$/.test(String(item.ref.id)), "search ref.id");
      assert(item.ref.mediaType === "movie" || item.ref.mediaType === "tv", "search ref.mediaType");
      assert(item.title, "search title");
    });
    var movie = res.items.filter(function (it) {
      return it.ref.mediaType === "movie";
    })[0];
    var tv = res.items.filter(function (it) {
      return it.ref.mediaType === "tv";
    })[0];
    assert(movie && movie.title === "流浪地球" && movie.ref.id === "26266893", "movie 条目");
    assert(tv && tv.title === "三体" && tv.ref.id === "26647087", "tv 条目");
    assertEq(movie.images.poster, BIG_MOVIE_COVER, "签名封面应放大到 600×900");
    assertEq(tv.images.poster, SIGNED_TV_COVER, "无 imageView2 的封面应原样保留");
    assert(JSON.stringify(res.items).indexOf("华语冒险片榜") < 0, "chart 条目不应出现");
    assert(res.next, "types 里影视 total 大于 20 时应有 next");
    assertEq(res.next.type, "page", "search next.type");
    assertEq(res.next.page, 2, "search next.page");
  });

  await test("search page 2 requests start=20", async function () {
    mockSearchSubjects(SEARCH_PAGE1_ITEMS, SEARCH_PAGE2_ITEMS, SEARCH_TOTAL);
    var first = await ext("search", "search").search(ctx(), { query: "流浪地球", params: {} });
    assert(first.next && first.next.page === 2, "第一页 next.page=2");

    var second = await ext("search", "search").search(ctx(), {
      query: "流浪地球",
      params: {},
      page: { type: "page", page: 2 },
    });
    var page2Request = requests.filter(function (r) {
      return r.start === "20";
    })[0];
    assert(page2Request, "第二页请求应带 start=20");
    assertEq(second.items.length, SEARCH_PAGE2_ITEMS.length, "第二页 items 长度");
    assertEq(second.items[0].title, "泰坦尼克号", "第二页首条");
    assert(
      second.next && second.next.type === "page" && second.next.page === 3,
      "45 > 40 时第二页 next.page=3"
    );
  });

  /* ---------- 搜索：限流回退 subject_suggest ---------- */

  await test("search falls back to subject_suggest on 403 and detects tv by episode", async function () {
    route(equalsPath("/rexxar/api/v2/search/subjects"), httpStatus(403, { msg: "need_login", code: 103 }));
    route(equalsPath("/j/subject_suggest"), ok(SEARCH_SUGGEST_ITEMS));

    var res = await ext("search", "search").search(ctx(), { query: "流浪地球", params: {} });
    var paths = requests.map(function (r) {
      return r.path;
    });
    assert(paths.indexOf("/rexxar/api/v2/search/subjects") >= 0, "应先请求搜索主路径");
    var suggestRequest = requests.filter(function (r) {
      return r.path === "/j/subject_suggest";
    })[0];
    assert(suggestRequest, "403 后应回退 movie.douban.com/j/subject_suggest");
    assertEq(queryValue(suggestRequest.url, { query: suggestRequest.query }, "q"), "流浪地球", "suggest q");

    assert(res && Array.isArray(res.items) && res.items.length === 2, "应得到联想条目");
    var movie = res.items.filter(function (it) {
      return it.ref.mediaType === "movie";
    })[0];
    var tv = res.items.filter(function (it) {
      return it.ref.mediaType === "tv";
    })[0];
    assert(movie && movie.ref.id === "26266893" && movie.title === "流浪地球", "movie 联想条目");
    assert(tv && tv.ref.id === "26647087" && tv.title === "三体", "episode 为正整数应判为 tv");
    assertEq(movie.images.poster, SUGGEST_COVER, "联想条目的 img 作为 poster");
    assertEq(tv.releaseDate, "2023", "联想条目 year");
  });

  await test("search 403 + suggest failure maps to rate_limited", async function () {
    route(equalsPath("/rexxar/api/v2/search/subjects"), httpStatus(403, { msg: "need_login", code: 103 }));
    route(equalsPath("/j/subject_suggest"), httpStatus(500));
    try {
      await ext("search", "search").search(ctx(), { query: "流浪地球", params: {} });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "rate_limited");
    }
  });

  await test("search 5xx + suggest failure maps to unavailable", async function () {
    route(equalsPath("/rexxar/api/v2/search/subjects"), httpStatus(500));
    route(equalsPath("/j/subject_suggest"), httpStatus(500));
    try {
      await ext("search", "search").search(ctx(), { query: "流浪地球", params: {} });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, "unavailable");
    }
  });

  /* ---------- list ---------- */

  var LIST_CASES = [
    { token: "collection:showing", collection: "movie_showing", mediaType: "movie", items: MOVIE_ITEMS, page2: MOVIE_PAGE2 },
    { token: "collection:top250", collection: "movie_top250", mediaType: "movie", items: MOVIE_ITEMS, page2: MOVIE_PAGE2 },
    { token: "collection:weekly", collection: "movie_weekly_best", mediaType: "movie", items: MOVIE_ITEMS, page2: MOVIE_PAGE2 },
    { token: "collection:hot", collection: "movie_hot_gaia", mediaType: "movie", items: MOVIE_ITEMS, page2: MOVIE_PAGE2 },
    { token: "collection:tv", collection: "tv_hot", mediaType: "tv", items: TV_ITEMS, page2: TV_PAGE2 },
    { token: "collection:tvRanked", collection: "tv_chinese_best_weekly", mediaType: "tv", items: TV_ITEMS, page2: TV_PAGE2 },
  ];

  for (const c of LIST_CASES) {
    await test("list opens " + c.token + " and paginates", async function () {
      mockCollection(c.collection, c.items, c.page2, TOTAL);
      var list = ext("list", "collection");
      var first = await list.load(ctx(), {
        ref: { source: "douban", id: c.token, mediaType: c.mediaType },
        params: c.token === "collection:tvRanked" ? { board: "cn" } : {},
      });
      assert(first && Array.isArray(first.items), "items 数组");
      assertEq(first.items.length, c.items.length, "第一页 items 长度");
      assertEq(first.items[0].ref.mediaType, c.mediaType, "mediaType");
      assert(first.next, "list 第一页应有 next");
      assertEq(first.next.page, 2, "list next.page");
      assertEq(first.next.type, undefined, "list next 应是原样 JSON（不带 type）");

      var second = await list.load(ctx(), {
        ref: { source: "douban", id: c.token, mediaType: c.mediaType },
        params: c.token === "collection:tvRanked" ? { board: "cn" } : {},
        page: { page: 2 },
      });
      var page2Request = requests.filter(function (r) {
        return r.start === String(PAGE_SIZE);
      })[0];
      assert(page2Request, "list 第二页请求应带 start=" + PAGE_SIZE);
      assertEq(second.items.length, c.page2.length, "第二页 items 长度");
      assert(!second.next, "list 末页不应有 next");
    });
  }

  await test("list ignores unknown ref ids", async function () {
    var res = await ext("list", "collection").load(ctx(), {
      ref: { source: "douban", id: "collection:unknown", mediaType: "movie" },
      params: {},
    });
    assert(res && Array.isArray(res.items), "items 数组");
    assertEq(res.items.length, 0, "未知 collection 返回空数组");
    assertEq(requests.length, 0, "未知 collection 不应发起请求");
  });

  /* ---------- 详情 ---------- */

  await test("detail movie returns ref/title/genres/people/rating", async function () {
    route(equalsPath("/rexxar/api/v2/movie/26266893"), ok(MOVIE_DETAIL));
    route(equalsPath("/rexxar/api/v2/movie/26266893/celebrities"), ok(MOVIE_CELEBS));

    var detail = await ext("detail", "main").load(ctx(), {
      ref: { source: "douban", id: "26266893", mediaType: "movie" },
    });
    assert(detail, "detail 非空");
    assert(detail.ref && detail.ref.source === "douban", "detail.ref.source");
    assertEq(detail.ref.id, "26266893", "detail.ref.id");
    assertEq(detail.ref.mediaType, "movie", "detail.ref.mediaType");
    assertEq(detail.title, "流浪地球", "detail.title");
    assertEq(detail.rating, 7.9, "detail.rating");
    assert(detail.description && detail.description.indexOf("太阳") >= 0, "detail.description 来自 intro");
    assert(Array.isArray(detail.genres) && detail.genres.length > 0, "detail.genres");
    var genreTitles = detail.genres.map(function (g) {
      return typeof g === "string" ? g : g.title;
    });
    assert(genreTitles.indexOf("科幻") >= 0, "genres 含科幻，实际: " + genreTitles.join(","));
    assert(Array.isArray(detail.people) && detail.people.length >= 2, "detail.people");
    detail.people.forEach(function (p) {
      assert(p.id, "people.id");
      assert(p.title, "people.title");
    });
    var director = detail.people.filter(function (p) {
      return p.title === "郭帆";
    })[0];
    var actor = detail.people.filter(function (p) {
      return p.title === "吴京";
    })[0];
    assert(director, "people 应包含导演郭帆");
    assert(actor, "people 应包含演员吴京");
    assert(detail.images && detail.images.poster, "detail.images.poster");
  });

  await test("detail tv handles /movie/{id} redirecting to tv JSON", async function () {
    // 豆瓣对 tv id 的 /movie/{id} 会 301 到 /tv/{id}；mock 直接返回重定向后的 tv JSON。
    // 这里故意用 mediaType: "movie" 进入，验证实现能按返回的 tv JSON 判定为剧集。
    route(equalsPath("/rexxar/api/v2/movie/37296949"), ok(TV_DETAIL));
    route(equalsPath("/rexxar/api/v2/tv/37296949"), ok(TV_DETAIL));
    route(equalsPath("/rexxar/api/v2/tv/37296949/celebrities"), ok(TV_CELEBS));
    route(equalsPath("/rexxar/api/v2/movie/37296949/celebrities"), ok(TV_CELEBS));

    var detail = await ext("detail", "main").load(ctx(), {
      ref: { source: "douban", id: "37296949", mediaType: "movie" },
    });
    var moviePathHit = requests.filter(function (r) {
      return r.path === "/rexxar/api/v2/movie/37296949";
    })[0];
    assert(moviePathHit, "应先请求 /movie/37296949（豆瓣 301 到 /tv/37296949）");
    assert(detail, "detail 非空");
    assertEq(detail.ref.id, "37296949", "detail.ref.id");
    assertEq(detail.ref.mediaType, "tv", "detail.ref.mediaType（应据返回的 tv JSON 判定）");
    assertEq(detail.title, "蒸蒸日上", "detail.title");
    assertEq(detail.rating, 7.8, "detail.rating");
    assert(Array.isArray(detail.genres) && detail.genres.length > 0, "detail.genres");
    var genreTitles = detail.genres.map(function (g) {
      return typeof g === "string" ? g : g.title;
    });
    assert(genreTitles.indexOf("剧情") >= 0, "genres 含剧情");
    assert(Array.isArray(detail.people) && detail.people.length >= 2, "detail.people");
    assert(
      detail.people.some(function (p) {
        return p.title === "姚婷婷";
      }),
      "people 应包含导演姚婷婷"
    );
    assert(
      detail.people.some(function (p) {
        return p.title === "王皓";
      }),
      "people 应包含演员王皓"
    );
    assert(detail.images && detail.images.poster, "detail.images.poster");
    // 豆瓣没有可用的分集接口：允许没有 episodes
    if (detail.episodes !== undefined) {
      assert(Array.isArray(detail.episodes), "episodes 若存在应为数组");
    }
  });

  await test("detail invalid id returns null without http", async function () {
    var detail = await ext("detail", "main").load(ctx(), {
      ref: { source: "douban", id: "not-a-number", mediaType: "movie" },
    });
    assertEq(detail, null, "非法 id 应返回 null");
    assertEq(requests.length, 0, "非法 id 不应发起请求");
  });

  await test("detail 404 returns null", async function () {
    route(equalsPath("/rexxar/api/v2/movie/999999999"), httpStatus(404));
    route(equalsPath("/rexxar/api/v2/tv/999999999"), httpStatus(404));
    var detail = await ext("detail", "main").load(ctx(), {
      ref: { source: "douban", id: "999999999", mediaType: "movie" },
    });
    assertEq(detail, null, "详情 404 应返回 null");
  });

  /* ---------- 错误码 ---------- */

  async function expectWidgetError(status, code) {
    route(equalsPath("/rexxar/api/v2/subject_collection/movie_top250/items"), httpStatus(status));
    try {
      await ext("widget", "top250").load(ctx(), { params: {}, family: "medium" });
      throw new Error("expected ExtensionError");
    } catch (e) {
      if (e.message === "expected ExtensionError") throw e;
      assertError(e, code);
    }
  }

  await test("http 429 maps to rate_limited", async function () {
    await expectWidgetError(429, "rate_limited");
  });

  await test("http 500 maps to unavailable", async function () {
    await expectWidgetError(500, "unavailable");
  });

  await test("http 400 maps to invalid_params", async function () {
    await expectWidgetError(400, "invalid_params");
  });

  await test("http 404 maps to not_found for widgets", async function () {
    await expectWidgetError(404, "not_found");
  });

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
