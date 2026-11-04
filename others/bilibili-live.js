// ============================================================================
// 哔哩哔哩直播 · Conflux 扩展包
//
// 由 video-bilibili（哔哩哔哩直播）脚本移植，接口来自 live.bilibili.com。
//
// 提供的扩展：
//   widget   rail     热门直播：按分区横向展示直播间（backdrop-rail）
//   widget   areas    直播分区：分区入口海报墙（poster-grid）
//   list     area     分区 / 二级分区 / 直播间列表（grid，支持翻页）
//   search   live     直播搜索
//   detail   room     直播间详情，清晰度作为第 1 季的「选集」
//   playback room     按所选清晰度返回 HLS / FLV 直播线路
//
// 安装：App → 设置 → 扩展 → 从 URL 或文件安装，选择本文件；
//       安装后到首页 SuperBoard 添加「热门直播」或「直播分区」小组件。
//
// 说明与已知限制：
//   - 运行时不提供 WebSocket，直播实时弹幕无法接入，因此本包不含 danmu 扩展。
//     原脚本的 startDanmaku / stopDanmaku 依赖 B 站弹幕 WebSocket 二进制协议，
//     普通 HTTP 也不提供带时间轴的直播弹幕历史。
//   - 未登录时 B 站实际只下发 250「超清」，所以未填 Cookie 时清晰度菜单只列
//     能播的档位；在包设置的「B 站 Cookie」里填入浏览器 Cookie（含 SESSDATA）
//     后，会列出登录账号可用的清晰度。
//   - 直播地址带签名和过期时间，因此 playback 默认不缓存（TTL 0），每次起播
//     重新取地址；线路另外声明了 skipRedirectProbe = true、FLV 线路标记
//     player = "app"，这两个字段留给宿主后续接入，当前宿主版本还不会读取。
//   - 直播 CDN 要求 User-Agent（只带 Referer 会 403），线路里已带上 UA 与 Referer；
//     请求 web 接口前会先从 finger/spi 取一对 buvid 写进 Cookie，降低 412 概率。
//   - 海报/封面由 App 的图片管线加载，不经过 ctx.http；包级 requestRules 给
//     *.hdslb.com 与 *.biliimg.com 补上 Referer 和浏览器 UA。小组件的
//     placeholderData 也带样例封面，安装后的骨架和添加预览不会是无图灰块。
//   - 使用到的接口：xlive/web-interface/v1/index/getList、
//     room/v1/area/getRoomList、xlive/web-interface/v1/index/getWebAreaList、
//     x/web-interface/search/type（search_type=live_room）、
//     room/v1/Room/room_init、room/v1/Room/get_info、live_user/v1/Master/info、
//     xlive/web-room/v2/index/getRoomPlayInfo，以及 x/frontend/finger/spi（buvid）。
//     其中 second/getList、second/getListByArea 现在需要 WBI 签名，
//     这里改用不需要签名的 room/v1/area/getRoomList。
// ============================================================================
// ============================================================
// 通用常量
// ============================================================

var PC_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";
var LIVE_REFERER = "https://live.bilibili.com/";
var API_LIVE = "https://api.live.bilibili.com";
var API_BILI = "https://api.bilibili.com";

// 一级分区。id 来自 xlive/web-interface/v1/index/getWebAreaList?source_id=2。
// widget 实例的 `area` 参数从这里取；“recommend” 走首页推荐流。
var AREA_OPTIONS = [
  { title: "推荐", value: "recommend" },
  { title: "网游", value: "2" },
  { title: "手游", value: "3" },
  { title: "单机游戏", value: "6" },
  { title: "虚拟主播", value: "9" },
  { title: "娱乐", value: "1" },
  { title: "电台", value: "5" },
  { title: "赛事", value: "13" },
  { title: "聊天室", value: "14" },
  { title: "生活", value: "10" },
  { title: "知识", value: "11" },
  { title: "帮我玩", value: "301" },
  { title: "互动玩法", value: "15" },
  { title: "购物", value: "16" },
];


// g_qn_desc 在个别响应里缺失时的兜底。
var QN_NAMES = {
  30000: "杜比",
  20000: "4K",
  15000: "2K",
  10000: "原画",
  401: "蓝光(杜比)",
  400: "蓝光",
  250: "超清",
  150: "高清",
  80: "流畅",
};

// ============================================================
// 基础工具
// ============================================================

function extError(message, code, retryable) {
  throw ExtensionError({
    code: code || "internal",
    message: message,
    retryable: retryable === true,
  });
}

function safeString(value) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && isFinite(value)) {
    return String(value);
  }
  return "";
}

function trimText(value) {
  return safeString(value).replace(/^[\s\u3000]+|[\s\u3000]+$/g, "");
}

var HTML_ENTITIES = {
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
};

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&([a-zA-Z]+);/g, function (match, name) {
      var value = HTML_ENTITIES[name.toLowerCase()];
      return value === undefined ? match : value;
    })
    .replace(/&#(\d+);/g, function (match, code) {
      var num = parseInt(code, 10);
      return isFinite(num) ? String.fromCharCode(num) : match;
    });
}

// 搜索接口会把命中的关键词包在 <em> 里，标题里也可能夹杂 HTML。
function plainText(value) {
  var text = safeString(value);
  if (!text) {
    return "";
  }
  return trimText(decodeEntities(text.replace(/<[^>]*>/g, "")));
}

function pageNumberOf(page) {
  if (typeof page === "number" && isFinite(page) && page >= 1) {
    return Math.floor(page);
  }
  if (page && typeof page === "object") {
    if (typeof page.page === "number" && isFinite(page.page) && page.page >= 1) {
      return Math.floor(page.page);
    }
    if (typeof page.cursor === "string") {
      var cursor = parseInt(page.cursor, 10);
      if (isFinite(cursor) && cursor >= 1) {
        return cursor;
      }
    }
  }
  return 1;
}

function pageToken(page) {
  return { type: "page", page: page };
}

function formatOnline(value) {
  var num = typeof value === "number" ? value : parseFloat(safeString(value));
  if (!isFinite(num) || num <= 0) {
    return "";
  }
  if (num >= 100000000) {
    return trimZero((num / 100000000).toFixed(1)) + "亿";
  }
  if (num >= 10000) {
    return trimZero((num / 10000).toFixed(1)) + "万";
  }
  return String(Math.floor(num));
}

function trimZero(text) {
  return text.replace(/\.0$/, "");
}

// 图片统一成 https；只有 i0.hdslb.com 支持稳定的尺寸变换，message.biliimg.com
// 对 @NNNw 处理参数偶发 412，所以那个域保持原图。
function imageURL(raw, width) {
  var url = trimText(raw);
  if (!url) {
    return "";
  }
  if (url.indexOf("//") === 0) {
    url = "https:" + url;
  }
  if (url.indexOf("http://") === 0) {
    url = "https://" + url.slice(7);
  }
  if (!width || url.indexOf("?") >= 0 || url.indexOf("@") >= 0) {
    return url;
  }
  if (url.indexOf("hdslb.com/") < 0) {
    return url;
  }
  if (/\.jpe?g$/i.test(url)) {
    return url + "@" + String(width) + "w.jpg";
  }
  if (/\.png$/i.test(url)) {
    return url + "@" + String(width) + "w.png";
  }
  return url;
}

function settingText(ctx, name) {
  if (!ctx || !ctx.settings) {
    return "";
  }
  return trimText(ctx.settings[name]);
}

// 未登录时用 finger/spi 拿一对 buvid，写进 Cookie；B 站风控对没有 buvid 的
// web-interface 请求更容易返回 412。结果按包私有 KV 缓存一天。
async function ensureBuvid(ctx) {
  var cached = ctx.storage.get("buvid");
  if (cached && typeof cached === "object" && cached.b3) {
    return;
  }
  var response = null;
  try {
    response = await ctx.http.get(API_BILI + "/x/frontend/finger/spi", {
      headers: { "User-Agent": PC_UA, "Referer": LIVE_REFERER },
      timeoutMs: 8000,
    });
  } catch (error) {
    return;
  }
  var body = response && response.data;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (error) {
      return;
    }
  }
  if (!body || !body.data || !body.data.b_3) {
    return;
  }
  ctx.storage.set(
    "buvid",
    { b3: safeString(body.data.b_3), b4: safeString(body.data.b_4) },
    { ttlSeconds: 86400 }
  );
}

function cookieHeader(ctx) {
  var parts = [];
  var buvid = ctx.storage.get("buvid");
  if (buvid && typeof buvid === "object" && buvid.b3) {
    parts.push("buvid3=" + safeString(buvid.b3));
    if (buvid.b4) {
      parts.push("buvid4=" + safeString(buvid.b4));
    }
  }
  var userCookie = settingText(ctx, "cookie");
  if (userCookie) {
    parts.push(userCookie);
  }
  return parts.join("; ");
}

function requestHeaders(ctx) {
  var headers = {
    "User-Agent": PC_UA,
    "Referer": LIVE_REFERER,
  };
  var cookie = cookieHeader(ctx);
  if (cookie) {
    headers["Cookie"] = cookie;
  }
  return headers;
}

// 播放地址指向 bilivideo CDN，签名已在 URL 里；这里只带 UA/Referer，
// 不把用户在设置里填的 Cookie 发给 CDN。
function playbackHeaders() {
  return {
    "User-Agent": PC_UA,
    "Referer": LIVE_REFERER,
  };
}

// ============================================================
// HTTP
// ============================================================

// ctx.http 的返回体已经尽量解析成 JSON：对象/数组直接用，字符串再尝试解析一次。
async function requestJson(ctx, url, label) {
  await ensureBuvid(ctx);
  var response = await sendJson(ctx, url, label);
  // 412 / 429 是 B 站风控：换一对新的 buvid 再试一次，通常就能过。
  if (response.status === 412 || response.status === 429) {
    ctx.storage.remove("buvid");
    await ensureBuvid(ctx);
    response = await sendJson(ctx, url, label);
  }
  if (response.status === 412 || response.status === 429) {
    extError("B 站风控校验失败，请稍后重试（" + label + "）", "rate_limited", true);
  }
  if (response.status < 200 || response.status >= 300) {
    extError(label + " 返回 HTTP " + response.status, "unavailable", response.status >= 500);
  }
  var body = response.data;
  if (typeof body === "string") {
    var text = trimText(body);
    if (!text) {
      extError(label + " 返回了空响应", "unavailable", true);
    }
    try {
      body = JSON.parse(text);
    } catch (error) {
      extError(label + " 返回了无法解析的数据", "unavailable", true);
    }
  }
  if (body === null || body === undefined) {
    extError(label + " 返回了空响应", "unavailable", true);
  }
  return body;
}

async function sendJson(ctx, url, label) {
  var response = null;
  try {
    response = await ctx.http.get(url, {
      headers: requestHeaders(ctx),
      timeoutMs: 15000,
    });
  } catch (error) {
    extError("网络请求失败：" + label, "unavailable", true);
  }
  if (!response || typeof response.status !== "number") {
    extError("网络请求失败：" + label, "unavailable", true);
  }
  return response;
}

// B 站的统一响应是 { code, message, data }；分区房间列表接口直接返回数组。
async function biliGet(ctx, url, label) {
  var body = await requestJson(ctx, url, label);
  if (typeof body !== "object" || body === null) {
    return body;
  }
  if (typeof body.code !== "number") {
    return body;
  }
  if (body.code === 0) {
    return body.data;
  }
  if (body.code === -352 || body.code === -412) {
    extError("B 站风控校验失败，请稍后重试（" + label + "）", "rate_limited", true);
  }
  if (body.code === 60004 || body.code === 19002000) {
    extError("直播间不存在或已关闭（" + label + "）", "not_found", false);
  }
  if (body.code === -400 || body.code === -1200) {
    extError(label + " 参数不合法（code " + body.code + "）", "invalid_params", false);
  }
  extError(label + " 失败：code=" + body.code + " " + safeString(body.message), "unavailable", true);
}

// ============================================================
// 条目映射
// ============================================================

function roomRef(roomId) {
  return { source: "custom", id: safeString(roomId), mediaType: "movie" };
}

function roomCover(raw) {
  return imageURL(
    raw.cover || raw.user_cover || raw.keyframe || raw.pic || raw.show_cover || raw.system_cover || "",
    520
  );
}

function roomGenre(raw) {
  var area = plainText(raw.area_v2_parent_name || raw.parent_name || raw.cate_name || raw.area_name || "");
  var online = formatOnline(raw.online);
  var parts = [];
  if (area) {
    parts.push(area);
  }
  if (online) {
    parts.push(online + "人气");
  }
  return parts.join(" · ");
}

// index/getList、area/getRoomList、search 的房间字段名不完全一致，统一在这里映射。
function roomListItem(raw) {
  var roomId = safeString(raw.roomid || raw.room_id || raw.id);
  var cover = roomCover(raw);
  var images = { backdrop: cover, cover: cover, poster: cover };
  return {
    ref: roomRef(roomId),
    title: plainText(raw.title) || "未命名直播",
    subtitle: plainText(raw.uname),
    genre: roomGenre(raw),
    images: images,
    intent: "detail",
  };
}

function areaListItem(parentId, name, cover) {
  var id = parentId === "recommend" ? "area:recommend" : "area:" + safeString(parentId);
  var image = imageURL(cover, 520);
  return {
    ref: { source: "custom", id: id },
    title: name,
    subtitle: "查看分区",
    images: { poster: image, backdrop: image, cover: image },
    intent: "list",
  };
}

function subAreaListItem(parentId, subId, name, cover) {
  var image = imageURL(cover, 520);
  return {
    ref: { source: "custom", id: "area:" + safeString(parentId) + ":" + safeString(subId) },
    title: name,
    subtitle: "查看直播",
    images: { poster: image, backdrop: image, cover: image },
    intent: "list",
  };
}

// ============================================================
// 接口封装
// ============================================================

// 直播首页聚合流：room_list（按一级分区） + recommend_room_list。
async function fetchLiveFeed(ctx, page) {
  var url = API_LIVE + "/xlive/web-interface/v1/index/getList?platform=web&page=" + String(page);
  return await biliGet(ctx, url, "直播首页");
}

// 分区房间列表。areaId 传 0 表示该一级分区下的全部房间。
async function fetchAreaRooms(ctx, parentId, areaId, page, pageSize) {
  var url =
    API_LIVE +
    "/room/v1/area/getRoomList?parent_area_id=" + encodeURIComponent(String(parentId)) +
    "&area_id=" + encodeURIComponent(String(areaId)) +
    "&page=" + String(page) +
    "&page_size=" + String(pageSize) +
    "&sort_type=online";
  var data = await biliGet(ctx, url, "分区房间");
  return Array.isArray(data) ? data : [];
}

// 一级分区 + 二级分区，缓存一天。返回 [{ id, name, subs: [{ id, name, pic }] }]。
async function fetchAreaTree(ctx) {
  var cached = ctx.storage.get("areaTree");
  if (cached && cached.v === 1 && Array.isArray(cached.tree) && cached.tree.length > 0) {
    return cached.tree;
  }
  var data = await biliGet(
    ctx,
    API_LIVE + "/xlive/web-interface/v1/index/getWebAreaList?source_id=2",
    "分区列表"
  );
  var parents = data && data.data ? data.data : data;
  var tree = [];
  if (Array.isArray(parents)) {
    for (var i = 0; i < parents.length; i++) {
      var parent = parents[i];
      var parentId = safeString(parent.id);
      var parentName = plainText(parent.name);
      if (!parentId || !parentName) {
        continue;
      }
      var subs = [];
      var rawSubs = parent.list || [];
      for (var j = 0; j < rawSubs.length; j++) {
        var sub = rawSubs[j];
        var subId = safeString(sub.id);
        var subName = plainText(sub.name);
        if (!subId || !subName) {
          continue;
        }
        subs.push({ id: subId, name: subName, pic: safeString(sub.pic) });
      }
      tree.push({ id: parentId, name: parentName, subs: subs });
    }
  }
  if (tree.length === 0) {
    extError("分区列表为空", "unavailable", true);
  }
  ctx.storage.set("areaTree", { v: 1, tree: tree }, { ttlSeconds: 86400 });
  return tree;
}

async function fetchSearch(ctx, keyword, page) {
  var url =
    API_BILI +
    "/x/web-interface/search/type?search_type=live_room" +
    "&keyword=" + encodeURIComponent(keyword) +
    "&page=" + String(page);
  return await biliGet(ctx, url, "直播搜索");
}

// room_init：把短号解析成真实房间号，同时带回开播状态。
async function fetchRoomBase(ctx, id) {
  var data = await biliGet(
    ctx,
    API_LIVE + "/room/v1/Room/room_init?id=" + encodeURIComponent(String(id)),
    "直播间初始化"
  );
  if (!data || !data.room_id) {
    extError("直播间不存在", "not_found", false);
  }
  return data;
}

async function fetchRoomInfo(ctx, roomId) {
  return await biliGet(
    ctx,
    API_LIVE + "/room/v1/Room/get_info?room_id=" + encodeURIComponent(String(roomId)),
    "直播间信息"
  );
}

async function fetchMasterInfo(ctx, uid) {
  var data = await biliGet(
    ctx,
    API_LIVE + "/live_user/v1/Master/info?uid=" + encodeURIComponent(String(uid)),
    "主播信息"
  );
  return data && data.info ? data.info : null;
}

// qn=10000 时 g_qn_desc 与 accept_qn 才能覆盖这台设备可用的全部清晰度。
async function fetchPlayInfo(ctx, roomId, qn) {
  var url =
    API_LIVE + "/xlive/web-room/v2/index/getRoomPlayInfo" +
    "?room_id=" + encodeURIComponent(String(roomId)) +
    "&protocol=0,1&format=0,1,2&codec=0,1&platform=web&qn=" + String(qn || 10000);
  var data = await biliGet(ctx, url, "直播播放信息");
  if (!data || !data.playurl_info || !data.playurl_info.playurl) {
    return null;
  }
  return data.playurl_info.playurl;
}

// ============================================================
// 清晰度与播放地址
// ============================================================

function qnName(playurl, qn) {
  var desc = QN_NAMES[qn] || (String(qn) + "P");
  var list = (playurl && playurl.g_qn_desc) || [];
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].qn) === String(qn) && list[i].desc) {
      return plainText(list[i].desc);
    }
  }
  return desc;
}

// 从 playurl_info.playurl 里取本房间可用的清晰度，按 qn 从高到低。
function collectAcceptQN(playurl, codecName, out, seen) {
  var streams = (playurl && playurl.stream) || [];
  for (var si = 0; si < streams.length; si++) {
    var formats = streams[si].format || [];
    for (var fi = 0; fi < formats.length; fi++) {
      var codecs = formats[fi].codec || [];
      for (var ci = 0; ci < codecs.length; ci++) {
        var codec = codecs[ci];
        if (codec.codec_name !== codecName) {
          continue;
        }
        var accept = codec.accept_qn || [];
        for (var qi = 0; qi < accept.length; qi++) {
          var qn = Number(accept[qi]);
          if (!isFinite(qn) || qn <= 0 || seen[qn]) {
            continue;
          }
          seen[qn] = true;
          out.push({ qn: qn, name: qnName(playurl, qn) });
        }
      }
    }
  }
}

function hasUserCookie(ctx) {
  return settingText(ctx, "cookie") !== "";
}

// 实际下发的清晰度：B 站未登录时会把 qn 降到 250，accept_qn 仍然列出原画等档位。
function collectDeliveredQN(playurl, codecName) {
  var best = 0;
  var streams = (playurl && playurl.stream) || [];
  for (var si = 0; si < streams.length; si++) {
    var formats = streams[si].format || [];
    for (var fi = 0; fi < formats.length; fi++) {
      var codecs = formats[fi].codec || [];
      for (var ci = 0; ci < codecs.length; ci++) {
        var codec = codecs[ci];
        if (codecName && codec.codec_name !== codecName) {
          continue;
        }
        var current = Number(codec.current_qn);
        if (isFinite(current) && current > best) {
          best = current;
        }
      }
    }
  }
  return best;
}

function deliveredQN(playurl) {
  var best = collectDeliveredQN(playurl, "avc");
  return best > 0 ? best : collectDeliveredQN(playurl, null);
}

// 本房间可用的清晰度，按 qn 从高到低。优先 avc，没有时退回 hevc。
// includeAll 为 false（未配置 Cookie）时只保留实际能播的档位，避免「原画」实际降级成「超清」。
function qualityList(playurl, includeAll) {
  var out = [];
  var seen = {};
  collectAcceptQN(playurl, "avc", out, seen);
  if (out.length === 0) {
    collectAcceptQN(playurl, "hevc", out, seen);
  }
  out.sort(function (a, b) {
    return b.qn - a.qn;
  });
  if (!includeAll && out.length > 1) {
    var delivered = deliveredQN(playurl);
    if (delivered > 0) {
      var playable = [];
      for (var i = 0; i < out.length; i++) {
        if (out[i].qn <= delivered) {
          playable.push(out[i]);
        }
      }
      if (playable.length > 0) {
        out = playable;
      }
    }
  }
  return out;
}

function chooseQuality(qualities, episodeNumber) {
  if (!qualities || qualities.length === 0) {
    return null;
  }
  var index = typeof episodeNumber === "number" && isFinite(episodeNumber) ? Math.floor(episodeNumber) : 0;
  if (index >= 1 && index <= qualities.length) {
    return qualities[index - 1];
  }
  return qualities[0];
}

function joinStreamURL(host, baseUrl, extra) {
  var base = safeString(baseUrl);
  if (!base) {
    return "";
  }
  var head = safeString(host);
  var tail = safeString(extra);
  if (!tail) {
    return head + base;
  }
  if (base.indexOf("?") < 0) {
    return head + base + "?" + tail;
  }
  return head + base + tail;
}

// 取出指定协议/封装/编码的全部线路；mcdn 域名放到最后。
function collectStreamURLs(playurl, protocolName, formatName, codecName) {
  var urls = [];
  var seen = {};
  var streams = (playurl && playurl.stream) || [];
  for (var si = 0; si < streams.length; si++) {
    var stream = streams[si];
    if (stream.protocol_name !== protocolName) {
      continue;
    }
    var formats = stream.format || [];
    for (var fi = 0; fi < formats.length; fi++) {
      var format = formats[fi];
      if (format.format_name !== formatName) {
        continue;
      }
      var codecs = format.codec || [];
      for (var ci = 0; ci < codecs.length; ci++) {
        var codec = codecs[ci];
        if (codec.codec_name !== codecName) {
          continue;
        }
        var infos = codec.url_info || [];
        for (var ui = 0; ui < infos.length; ui++) {
          var url = joinStreamURL(infos[ui].host, codec.base_url, infos[ui].extra);
          if (!url || seen[url]) {
            continue;
          }
          seen[url] = true;
          urls.push(url);
        }
      }
    }
  }
  urls.sort(function (a, b) {
    var aMcdn = a.indexOf("mcdn") >= 0 ? 1 : 0;
    var bMcdn = b.indexOf("mcdn") >= 0 ? 1 : 0;
    return aMcdn - bMcdn;
  });
  return urls;
}

// 一个清晰度给三条线路：HLS 主线路、HLS 备用线路、FLV 线路。
function playbackSourcesFor(ctx, playurl, qn) {
  var sources = [];
  var name = qnName(playurl, qn);
  var headers = playbackHeaders();
  var hls = collectStreamURLs(playurl, "http_hls", "fmp4", "avc");
  if (hls.length === 0) {
    hls = collectStreamURLs(playurl, "http_hls", "ts", "avc");
  }
  if (hls.length === 0) {
    hls = collectStreamURLs(playurl, "http_hls", "fmp4", "hevc");
  }
  if (hls.length === 0) {
    hls = collectStreamURLs(playurl, "http_hls", "ts", "hevc");
  }
  var flv = collectStreamURLs(playurl, "http_stream", "flv", "avc");
  if (flv.length === 0) {
    flv = collectStreamURLs(playurl, "http_stream", "flv", "hevc");
  }
  var hlsSpecs = [
    { id: "hls-main", label: "HLS", desc: "m3u8 · 主线路" },
    { id: "hls-backup", label: "HLS 备用", desc: "m3u8 · 备用线路" },
  ];
  var used = {};
  for (var i = 0; i < hls.length && sources.length < 2; i++) {
    var spec = hlsSpecs[sources.length];
    if (!spec) {
      break;
    }
    used[hls[i]] = true;
    sources.push({
      id: "hls-" + String(qn) + "-" + spec.id,
      name: name + " · " + spec.label,
      url: hls[i],
      description: spec.desc,
      headers: headers,
      skipRedirectProbe: true,
    });
  }
  for (var j = 0; j < flv.length; j++) {
    if (used[flv[j]]) {
      continue;
    }
    sources.push({
      id: "flv-" + String(qn),
      name: name + " · FLV",
      url: flv[j],
      description: "flv · 主线路",
      headers: headers,
      player: "app",
      skipRedirectProbe: true,
    });
    break;
  }
  return sources;
}
// ============================================================
// 展示层：热门直播 widget、直播分区 widget、分区列表、直播搜索
// ============================================================
// 本文件只提供 handler，不写包声明（清单由合并进最终文件的那部分提供）。
// 所有接口与映射复用 shared.js；私有工具统一加前缀，避免合并后重名。

// ---------- 私有工具 ----------

// 直播首页聚合流里的分组房间拍平：room_list[].list。
function railFeedRoomRaws(feed) {
  var out = [];
  var groups = (feed && feed.room_list) || [];
  for (var i = 0; i < groups.length; i++) {
    var list = groups[i] && groups[i].list;
    if (!list) {
      continue;
    }
    for (var j = 0; j < list.length; j++) {
      out.push(list[j]);
    }
  }
  return out;
}

// 按房间号去重，保留首次出现的顺序。
function railDedupeRooms(raws) {
  var out = [];
  var seen = {};
  for (var i = 0; i < raws.length; i++) {
    var raw = raws[i];
    if (!raw || typeof raw !== "object") {
      continue;
    }
    var roomId = safeString(raw.roomid || raw.room_id || raw.id);
    if (!roomId || seen[roomId]) {
      continue;
    }
    seen[roomId] = true;
    out.push(raw);
  }
  return out;
}

// 首页聚合流里只有 room_list[0]（推荐直播）会随 page 轮换，其余分组是同一个
// 静态列表；recommend_room_list（5）是 room_list[0].list（10）的前 5 条。
// 第一页用 recommend + room_list[0] 去重补齐，后续页直接用轮换的分组。
function railRecommendRaws(feed, page) {
  var groups = (feed && feed.room_list) || [];
  var topGroup = (groups.length > 0 && groups[0] && groups[0].list) || [];
  if (page <= 1) {
    var recommend = (feed && feed.recommend_room_list) || [];
    if (recommend.length > 0) {
      return railDedupeRooms(recommend.concat(topGroup));
    }
    if (topGroup.length > 0) {
      return topGroup;
    }
    return railDedupeRooms(railFeedRoomRaws(feed));
  }
  if (topGroup.length > 0) {
    return topGroup;
  }
  return railDedupeRooms(railFeedRoomRaws(feed));
}

// raw -> ListItem；按房间号去重、丢弃没有房间号的条目。limit > 0 时截断。
function railRoomItems(raws, limit) {
  var items = [];
  var list = railDedupeRooms(raws || []);
  for (var i = 0; i < list.length; i++) {
    var raw = list[i];
    if (!raw || typeof raw !== "object") {
      continue;
    }
    var item = roomListItem(raw);
    if (!item.ref || !item.ref.id) {
      continue;
    }
    items.push(item);
    if (limit > 0 && items.length >= limit) {
      break;
    }
  }
  return items;
}

// “推荐”列表的一页：首页推荐流 + 与 widget 相同的取舍。
async function railRecommendPageItems(ctx, page, limit) {
  var feed = await fetchLiveFeed(ctx, page);
  return railRoomItems(railRecommendRaws(feed, page), limit);
}

// 分区封面：第一个带 pic 的二级分区；都没有时返回空串。
function areasSubCover(parent) {
  var subs = (parent && parent.subs) || [];
  for (var i = 0; i < subs.length; i++) {
    var pic = safeString(subs[i] && subs[i].pic);
    if (pic) {
      return pic;
    }
  }
  return "";
}

// 首页推荐流里的第一张房间封面；失败时静默返回空串。
async function areasFeedCover(ctx) {
  try {
    var feed = await fetchLiveFeed(ctx, 1);
    var room = null;
    var recommend = (feed && feed.recommend_room_list) || [];
    if (recommend.length > 0) {
      room = recommend[0];
    } else {
      var groups = (feed && feed.room_list) || [];
      if (groups.length > 0 && groups[0].list && groups[0].list.length > 0) {
        room = groups[0].list[0];
      }
    }
    return room ? roomCover(room) : "";
  } catch (error) {
    return "";
  }
}

// ---------- widget：热门直播（backdrop-rail） ----------

async function widgetRailLoad(ctx, input) {
  var params = (input && input.params) || {};
  var area = safeString(params.area) || "recommend";
  var page = pageNumberOf(input && input.page);
  var items = [];
  if (area === "recommend") {
    items = await railRecommendPageItems(ctx, page, 10);
  } else {
    var rooms = await fetchAreaRooms(ctx, area, 0, page, 10);
    items = railRoomItems(rooms, 10);
  }
  var content = { items: items };
  // 推荐流第一页只有 5 条，仍然给出 next，展开全部时才能继续翻到聚合流的分组房间。
  var hasMore = area === "recommend" ? items.length > 0 : items.length >= 10;
  if (hasMore && page < 20) {
    content.next = pageToken(page + 1);
  }
  console.log("[bilibili] widgetRailLoad: area=" + area + " page=" + page + " items=" + items.length);
  return content;
}

// ---------- widget：直播分区（poster-grid） ----------

async function widgetAreasLoad(ctx, input) {
  var tree = await fetchAreaTree(ctx);
  var feedCover = await areasFeedCover(ctx);
  var items = [areaListItem("recommend", "推荐", feedCover)];
  for (var i = 0; i < tree.length; i++) {
    var parent = tree[i];
    var cover = areasSubCover(parent) || feedCover;
    items.push(areaListItem(parent.id, parent.name, cover));
  }
  console.log("[bilibili] widgetAreasLoad: parents=" + tree.length + " items=" + items.length);
  return { items: items };
}

// ---------- list：分区房间（grid） ----------

// “推荐”列表：首页推荐流房间，按页返回。
function listRecommendContent(items, page) {
  var content = { items: items };
  if (items.length > 0 && page < 20) {
    content.next = { page: page + 1 };
  }
  return content;
}

async function listAreaLoad(ctx, input) {
  var ref = (input && input.ref) || {};
  var id = safeString(ref.id);
  var params = (input && input.params) || {};
  var page = pageNumberOf(input && input.page);

  // 推荐直播流：area:recommend，以及 widget 标题栏用 area:widget + params.area=recommend。
  if (id === "area:recommend") {
    var recommendItems = await railRecommendPageItems(ctx, page, 10);
    console.log("[bilibili] listAreaLoad: id=" + id + " page=" + page + " items=" + recommendItems.length);
    return listRecommendContent(recommendItems, page);
  }

  // widget 标题栏把实例 params 传进来，ref 里放不下每个实例的分区。
  if (id === "area:widget") {
    var widgetArea = safeString(params.area) || "recommend";
    if (widgetArea === "recommend") {
      var widgetRecommendItems = await railRecommendPageItems(ctx, page, 10);
      console.log(
        "[bilibili] listAreaLoad: id=" + id + " area=recommend page=" + page +
          " items=" + widgetRecommendItems.length
      );
      return listRecommendContent(widgetRecommendItems, page);
    }
    var widgetRooms = await fetchAreaRooms(ctx, widgetArea, 0, page, 30);
    var widgetRoomItems = railRoomItems(widgetRooms, 0);
    var widgetContent = { items: widgetRoomItems };
    if (widgetRoomItems.length >= 30 && page < 30) {
      widgetContent.next = { page: page + 1 };
    }
    console.log(
      "[bilibili] listAreaLoad: id=" + id + " area=" + widgetArea + " page=" + page +
        " items=" + widgetRoomItems.length
    );
    return widgetContent;
  }

  if (id.indexOf("area:") !== 0) {
    return { items: [] };
  }

  var parts = id.split(":");
  // area:<parentId>:<areaId>：该二级分区（areaId=0 表示一级分区全部）的房间。
  if (parts.length >= 3) {
    var parentId = safeString(parts[1]);
    var areaId = safeString(parts[2]);
    var rooms = await fetchAreaRooms(ctx, parentId, areaId, page, 30);
    var roomItems = railRoomItems(rooms, 0);
    var content = { items: roomItems };
    if (roomItems.length >= 30 && page < 30) {
      content.next = { page: page + 1 };
    }
    console.log(
      "[bilibili] listAreaLoad: parent=" + parentId + " area=" + areaId + " page=" + page +
        " items=" + roomItems.length
    );
    return content;
  }

  // area:<parentId>：二级分区入口（含“全部”）。
  var subParentId = safeString(parts[1]);
  var tree = await fetchAreaTree(ctx);
  var parent = null;
  for (var i = 0; i < tree.length; i++) {
    if (safeString(tree[i].id) === subParentId) {
      parent = tree[i];
      break;
    }
  }
  if (!parent) {
    console.log("[bilibili] listAreaLoad: parent=" + subParentId + " not found");
    return { items: [] };
  }
  var parentCover = areasSubCover(parent);
  var entries = [subAreaListItem(subParentId, "0", "全部" + parent.name, parentCover)];
  var subs = parent.subs || [];
  for (var j = 0; j < subs.length; j++) {
    entries.push(subAreaListItem(subParentId, subs[j].id, subs[j].name, subs[j].pic));
  }
  console.log(
    "[bilibili] listAreaLoad: parent=" + subParentId + " subs=" + subs.length + " items=" + entries.length
  );
  return { items: entries };
}

// ---------- search：直播间搜索 ----------

// 当前 API 的 result 是数组；旧结构是 result.live_room，两者都兼容。
function searchLiveRaws(data) {
  var result = data && data.result;
  if (Array.isArray(result)) {
    return result;
  }
  if (result && Array.isArray(result.live_room)) {
    return result.live_room;
  }
  return [];
}

async function searchLive(ctx, input) {
  var query = trimText(input && input.query);
  if (!query) {
    return { items: [] };
  }
  var page = pageNumberOf(input && input.page);
  var data = await fetchSearch(ctx, query, page);
  var raws = railDedupeRooms(searchLiveRaws(data));
  var items = [];
  for (var i = 0; i < raws.length; i++) {
    var raw = raws[i];
    if (!raw || typeof raw !== "object") {
      continue;
    }
    var item = roomListItem(raw);
    if (!item.ref || !item.ref.id) {
      continue;
    }
    // 未开播的房间在标题下标注，避免点进去才发现没有画面。
    if (safeString(raw.live_status) === "0") {
      item.genre = item.genre ? "未开播 · " + item.genre : "未开播";
    }
    items.push(item);
  }
  var content = { items: items };
  var numPages = data && typeof data.numPages === "number" && isFinite(data.numPages)
    ? Math.floor(data.numPages)
    : 0;
  if (numPages > 0) {
    if (page < numPages) {
      content.next = pageToken(page + 1);
    }
  } else if (items.length >= 40) {
    content.next = pageToken(page + 1);
  }
  console.log(
    "[bilibili] searchLive: query=" + query + " page=" + page + " items=" + items.length +
      " numPages=" + numPages
  );
  return content;
}
// ============================================================
// service：直播间详情（detail）+ 播放线路（playback）
// 依赖 shared.js 中的工具、接口与映射函数；不重复声明其中任何名字。
// ============================================================

var DETAIL_COVER_WIDTH = 960;
var DETAIL_AVATAR_WIDTH = 100;

// 秒数 -> HH:MM:SS；非法值返回空串，避免出现 NaN。
function detailDurationText(seconds) {
  var total = typeof seconds === "number" ? Math.floor(seconds) : -1;
  if (!isFinite(total) || total < 0) {
    return "";
  }
  var hours = Math.floor(total / 3600);
  var minutes = Math.floor((total % 3600) / 60);
  var secs = total % 60;
  return (hours < 10 ? "0" : "") + hours + ":" +
    (minutes < 10 ? "0" : "") + minutes + ":" +
    (secs < 10 ? "0" : "") + secs;
}

// "网游 · 猎杀对决（Hunt: Showdown）"
function detailGenreText(info) {
  var parent = plainText(info && info.parent_area_name);
  var sub = plainText(info && info.area_name);
  var parts = [];
  if (parent) {
    parts.push(parent);
  }
  if (sub && sub !== parent) {
    parts.push(sub);
  }
  return parts.join(" · ");
}

// 一级分区 + 二级分区，用作详情页 genres（仅展示，当前版本不参与筛选）。
function detailAreaGenres(info) {
  var out = [];
  var parentId = safeString(info && info.parent_area_id);
  var parentName = plainText(info && info.parent_area_name);
  if (parentId && parentId !== "0" && parentName) {
    out.push({ id: parentId, title: parentName });
  }
  var areaId = safeString(info && info.area_id);
  var areaName = plainText(info && info.area_name);
  if (areaId && areaId !== "0" && areaName && areaId !== parentId) {
    out.push({ id: areaId, title: areaName });
  }
  return out;
}

// 副标题固定以开播状态开头；开播时补人气与已播时长。
// get_info 没有 epoch 开播时间（live_time 是字符串），开播时间从 room_init 的 base.live_time 取。
function detailLiveSubtitle(live, info, base) {
  if (!live) {
    return "未开播";
  }
  var text = "直播中";
  var online = formatOnline(info && info.online);
  if (online) {
    text += " · " + online + "人气";
  }
  var started = 0;
  if (base && typeof base.live_time === "number" && base.live_time > 0) {
    started = base.live_time;
  } else if (info && typeof info.live_time === "number" && info.live_time > 0) {
    started = info.live_time;
  }
  if (started > 0) {
    var elapsed = Math.floor(Date.now() / 1000) - started;
    if (elapsed < 0) {
      elapsed = 0;
    }
    var durationText = detailDurationText(elapsed);
    if (durationText) {
      text += " · 已播 " + durationText;
    }
  }
  return text;
}

// 简介为空时用主播名/分区补一句真实信息，不编造文案。
function detailFallbackDescription(masterName, genre) {
  if (masterName && genre) {
    return masterName + " · " + genre;
  }
  if (masterName) {
    return masterName + " 的直播间";
  }
  if (genre) {
    return genre + " 直播间";
  }
  return "";
}

async function detailRoomLoad(ctx, input) {
  var ref = input && input.ref ? input.ref : {};
  var requestedId = safeString(ref.id);
  if (!requestedId) {
    extError("直播间号无效", "invalid_params", false);
  }

  // 短号 -> 真实房间号；不存在的号由 room_init 直接抛 not_found。
  var base = await fetchRoomBase(ctx, requestedId);
  var roomId = safeString(base.room_id) || requestedId;

  var info = null;
  try {
    info = await fetchRoomInfo(ctx, roomId);
  } catch (error) {
    info = null;
  }

  var live = base.live_status === 1 || !!(info && info.live_status === 1);

  var uid = safeString((info && info.uid) || base.uid || "");
  var master = null;
  if (uid && uid !== "0") {
    try {
      master = await fetchMasterInfo(ctx, uid);
    } catch (error) {
      master = null;
    }
  }
  var masterName = trimText(master && master.uname);
  var masterFace = imageURL(master && master.face, DETAIL_AVATAR_WIDTH);

  var cover = imageURL(
    (info && (info.user_cover || info.keyframe || info.background)) || "",
    DETAIL_COVER_WIDTH
  );
  var title = plainText(info && info.title) || ("直播间 " + roomId);
  var genre = detailGenreText(info);
  var subtitle = detailLiveSubtitle(live, info, base);

  // 房间简介偶尔是几千字的 HTML，压平空白并截断，避免详情页被撑爆。
  var description = plainText(info && info.description);
  if (description) {
    description = description.replace(/\s+/g, " ");
    if (description.length > 400) {
      var cut = 400;
      var lastCode = description.charCodeAt(cut - 1);
      if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
        cut -= 1;
      }
      description = description.substring(0, cut) + "…";
    }
  }
  if (!description) {
    description = detailFallbackDescription(masterName, genre);
  }

  var item = {
    ref: roomRef(roomId),
    title: title,
    subtitle: subtitle,
  };
  if (description) {
    item.description = description;
  }
  if (genre) {
    item.genre = genre;
  }
  if (cover) {
    item.images = { backdrop: cover, cover: cover, poster: cover };
  }

  if (masterName) {
    var person = { id: uid, title: masterName, role: "主播" };
    if (masterFace) {
      person.avatar = masterFace;
    }
    item.people = [person];
  }

  var genres = detailAreaGenres(info);
  if (genres.length > 0) {
    item.genres = genres;
  }

  // 清晰度 -> season 1 的 episodes；播放时 episode 反查回 qn。
  var episodes = [];
  if (live) {
    var playurl = null;
    try {
      playurl = await fetchPlayInfo(ctx, roomId, 10000);
    } catch (error) {
      playurl = null;
    }
    var qualities = playurl ? qualityList(playurl, hasUserCookie(ctx)) : [];
    for (var qi = 0; qi < qualities.length; qi++) {
      var episode = { season: 1, episode: qi + 1, title: qualities[qi].name };
      if (cover) {
        episode.still = cover;
      }
      episodes.push(episode);
    }
  }
  item.episodes = episodes;

  // 同分区仍在直播的房间；失败只影响这一块，不拖垮详情。
  var related = [];
  var parentId = safeString(info && info.parent_area_id);
  if (parentId && parentId !== "0") {
    var rooms = null;
    try {
      rooms = await fetchAreaRooms(ctx, parentId, 0, 1, 24);
    } catch (error) {
      rooms = null;
    }
    if (rooms) {
      for (var ri = 0; ri < rooms.length && related.length < 10; ri++) {
        var rawRoom = rooms[ri];
        var rawId = safeString(rawRoom.roomid || rawRoom.room_id || rawRoom.id);
        if (!rawId || rawId === roomId) {
          continue;
        }
        related.push(roomListItem(rawRoom));
      }
    }
  }
  if (related.length > 0) {
    item.related = related;
  }

  console.log(
    "[bilibili] detail: room=" + roomId + " live=" + live +
    " episodes=" + episodes.length + " related=" + related.length
  );
  return item;
}

async function playbackRoomSources(ctx, input) {
  var ref = input && input.ref ? input.ref : {};
  var requestedId = safeString(ref.id);
  if (!requestedId) {
    extError("直播间号无效", "invalid_params", false);
  }

  var base = await fetchRoomBase(ctx, requestedId);
  var roomId = safeString(base.room_id) || requestedId;
  if (base.live_status !== 1) {
    console.log("[bilibili] playback: room=" + roomId + " offline");
    return [];
  }

  var playurl = null;
  try {
    playurl = await fetchPlayInfo(ctx, roomId, 10000);
  } catch (error) {
    playurl = null;
  }
  if (!playurl) {
    console.log("[bilibili] playback: room=" + roomId + " no playurl");
    return [];
  }

  var qualities = qualityList(playurl, hasUserCookie(ctx));
  var chosen = chooseQuality(qualities, input && input.episode);
  var qn = chosen ? chosen.qn : 10000;

  // 只有指定清晰度时才换一次播放信息；失败退回 qn=10000 的线路。
  var target = playurl;
  if (qn !== 10000) {
    try {
      var next = await fetchPlayInfo(ctx, roomId, qn);
      if (next) {
        target = next;
      }
    } catch (error) {
      target = playurl;
    }
  }

  var sources = playbackSourcesFor(ctx, target, qn);
  if (!sources || sources.length === 0) {
    console.log("[bilibili] playback: room=" + roomId + " qn=" + qn + " no sources");
    return [];
  }
  console.log(
    "[bilibili] playback: room=" + roomId + " qn=" + qn + " sources=" + sources.length
  );
  return sources;
}
// ============================================================
// 包声明
// ============================================================

definePackage({
  id: "conflux.bilibili.live",
  title: "哔哩哔哩直播",
  description: "哔哩哔哩直播（live.bilibili.com）：热门与分区直播、搜索、直播间详情和多清晰度线路。",
  author: "SmartBook",
  site: "https://live.bilibili.com",
  icon: "https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/others/icons/bilibili-live.png",
  version: "1.0.3",
  engine: 1,
  permissions: {
    network: ["https://api.live.bilibili.com", "https://api.bilibili.com"],
  },
  // 图片不经过 ctx.http，由 App 的图片管线加载；这里给图床补上 Referer 和浏览器 UA。
  requestRules: [
    {
      host: "*.hdslb.com",
      headers: { Referer: LIVE_REFERER, "User-Agent": PC_UA },
    },
    {
      host: "*.biliimg.com",
      headers: { Referer: LIVE_REFERER, "User-Agent": PC_UA },
    },
  ],
  settings: [
    {
      name: "cookie",
      title: "B 站 Cookie",
      type: "text",
      default: "",
      description: "选填。填入浏览器里的 Cookie（例如 SESSDATA=...; buvid3=...），用于解锁登录后才能看的清晰度。只保存在本机。",
    },
  ],
  extensions: [
    {
      type: "widget",
      id: "rail",
      title: "热门直播",
      description: "按分区横向展示正在直播的房间，点卡片看详情，点播放按钮直接起播。",
      template: "backdrop-rail",
      families: ["extraLarge"],
      header: "list",
      ref: { source: "custom", id: "area:widget" },
      params: [
        {
          name: "area",
          title: "分区",
          type: "select",
          default: "recommend",
          options: AREA_OPTIONS,
        },
      ],
      cache: { ttlSeconds: 300 },
      placeholderData: {
        items: [
          {
            ref: { source: "custom", id: "placeholder-1", mediaType: "movie" },
            title: "歌曲点唱",
            subtitle: "哔哩哔哩直播",
            genre: "娱乐 · 直播中",
            images: {
              poster: imageURL("https://i0.hdslb.com/bfs/live/new_room_cover/096b223e4e0a5e6092269b271131b324723fe6ed.jpg", 520),
              backdrop: imageURL("https://i0.hdslb.com/bfs/live/new_room_cover/096b223e4e0a5e6092269b271131b324723fe6ed.jpg", 520),
            },
          },
          {
            ref: { source: "custom", id: "placeholder-2", mediaType: "movie" },
            title: "虚拟偶像点唱厅",
            subtitle: "哔哩哔哩直播",
            genre: "聊天室 · 直播中",
            images: {
              poster: imageURL("https://i0.hdslb.com/bfs/live/new_room_cover/a0521d76b5e3d51b546ab7f47f4fc78fcf60d6f0.jpg", 520),
              backdrop: imageURL("https://i0.hdslb.com/bfs/live/new_room_cover/a0521d76b5e3d51b546ab7f47f4fc78fcf60d6f0.jpg", 520),
            },
          },
          {
            ref: { source: "custom", id: "placeholder-3", mediaType: "movie" },
            title: "深夜电台",
            subtitle: "哔哩哔哩直播",
            genre: "电台 · 直播中",
            images: {
              poster: imageURL("https://i0.hdslb.com/bfs/live/new_room_cover/3226a17a91c4f2db4a66164f67aa4f3ae3279c57.jpg", 520),
              backdrop: imageURL("https://i0.hdslb.com/bfs/live/new_room_cover/3226a17a91c4f2db4a66164f67aa4f3ae3279c57.jpg", 520),
            },
          },
          {
            ref: { source: "custom", id: "placeholder-4", mediaType: "movie" },
            title: "单机游戏",
            subtitle: "哔哩哔哩直播",
            genre: "单机游戏 · 直播中",
            images: {
              poster: imageURL("https://i0.hdslb.com/bfs/live/user_cover/6040f2a681f7b6042b162e7db65b2e744e1d0dc8.jpg", 520),
              backdrop: imageURL("https://i0.hdslb.com/bfs/live/user_cover/6040f2a681f7b6042b162e7db65b2e744e1d0dc8.jpg", 520),
            },
          },
          {
            ref: { source: "custom", id: "placeholder-5", mediaType: "movie" },
            title: "赛事直播",
            subtitle: "哔哩哔哩直播",
            genre: "网游 · 直播中",
            images: {
              poster: imageURL("https://i0.hdslb.com/bfs/live/new_room_cover/e9d437ea3476561f3a94996915dfdaba0508ad99.jpg", 520),
              backdrop: imageURL("https://i0.hdslb.com/bfs/live/new_room_cover/e9d437ea3476561f3a94996915dfdaba0508ad99.jpg", 520),
            },
          },
          {
            ref: { source: "custom", id: "placeholder-6", mediaType: "movie" },
            title: "一起看小当家",
            subtitle: "哔哩哔哩直播",
            genre: "虚拟主播 · 直播中",
            images: {
              poster: imageURL("https://i0.hdslb.com/bfs/live/new_room_cover/11a9c6e355c7af3b6b62e6a72ef4943ad545c827.jpg", 520),
              backdrop: imageURL("https://i0.hdslb.com/bfs/live/new_room_cover/11a9c6e355c7af3b6b62e6a72ef4943ad545c827.jpg", 520),
            },
          },
        ],
      },
      load: widgetRailLoad,
    },
    {
      type: "widget",
      id: "areas",
      title: "直播分区",
      description: "哔哩哔哩直播分区入口，点开查看该分区下的直播间。",
      template: "poster-grid",
      families: ["small", "medium", "large"],
      cache: { ttlSeconds: 900 },
      placeholderData: {
        items: [
          {
            ref: { source: "custom", id: "area:recommend" },
            title: "推荐",
            subtitle: "查看分区",
            intent: "list",
            images: {
              poster: imageURL("https://i0.hdslb.com/bfs/live/new_room_cover/096b223e4e0a5e6092269b271131b324723fe6ed.jpg", 520),
              backdrop: imageURL("https://i0.hdslb.com/bfs/live/new_room_cover/096b223e4e0a5e6092269b271131b324723fe6ed.jpg", 520),
            },
          },
          {
            ref: { source: "custom", id: "area:2" },
            title: "网游",
            subtitle: "查看分区",
            intent: "list",
            images: {
              poster: imageURL("https://i0.hdslb.com/bfs/vc/0e808167886ad2299971ea49aade69b3663db9b9.png", 520),
              backdrop: imageURL("https://i0.hdslb.com/bfs/vc/0e808167886ad2299971ea49aade69b3663db9b9.png", 520),
            },
          },
          {
            ref: { source: "custom", id: "area:3" },
            title: "手游",
            subtitle: "查看分区",
            intent: "list",
            images: {
              poster: imageURL("https://i0.hdslb.com/bfs/vc/0fefa924760b2dd492a12dddafe179bfa1216918.png", 520),
              backdrop: imageURL("https://i0.hdslb.com/bfs/vc/0fefa924760b2dd492a12dddafe179bfa1216918.png", 520),
            },
          },
          {
            ref: { source: "custom", id: "area:6" },
            title: "单机游戏",
            subtitle: "查看分区",
            intent: "list",
            images: {
              poster: imageURL("https://i0.hdslb.com/bfs/vc/edb636ee59f902e3134a2790545045bddd70978e.png", 520),
              backdrop: imageURL("https://i0.hdslb.com/bfs/vc/edb636ee59f902e3134a2790545045bddd70978e.png", 520),
            },
          },
          {
            ref: { source: "custom", id: "area:9" },
            title: "虚拟主播",
            subtitle: "查看分区",
            intent: "list",
            images: {
              poster: imageURL("https://i0.hdslb.com/bfs/live/e4fdb4e56af08128f8350d3a93f42ac1cd2223f7.png", 520),
              backdrop: imageURL("https://i0.hdslb.com/bfs/live/e4fdb4e56af08128f8350d3a93f42ac1cd2223f7.png", 520),
            },
          },
          {
            ref: { source: "custom", id: "area:1" },
            title: "娱乐",
            subtitle: "查看分区",
            intent: "list",
            images: {
              poster: imageURL("https://message.biliimg.com/bfs/im/5ea1fc721896f02eef1d5a712cd0bb151d1b8ca5.png", 520),
              backdrop: imageURL("https://message.biliimg.com/bfs/im/5ea1fc721896f02eef1d5a712cd0bb151d1b8ca5.png", 520),
            },
          },
        ],
      },
      load: widgetAreasLoad,
    },
    {
      type: "list",
      id: "area",
      title: "分区直播",
      description: "分区下的二级分区或直播间列表。",
      style: "grid",
      accepts: { sources: ["custom"] },
      // 列表导航栏的搜索框；关键词走同包 search "live"
      search: { id: "live" },
      cache: { ttlSeconds: 300 },
      load: listAreaLoad,
    },
    {
      type: "search",
      id: "live",
      title: "哔哩哔哩直播",
      description: "搜索正在直播的房间。",
      cache: { ttlSeconds: 300 },
      search: searchLive,
    },
    {
      type: "detail",
      id: "room",
      title: "哔哩哔哩直播详情",
      description: "直播间信息、主播信息和清晰度选集。",
      accepts: { sources: ["custom"], mediaTypes: ["movie"] },
      load: detailRoomLoad,
    },
    {
      type: "playback",
      id: "room",
      title: "哔哩哔哩直播线路",
      description: "按所选清晰度返回 HLS / FLV 直播线路。",
      accepts: { sources: ["custom"], mediaTypes: ["movie"] },
      sources: playbackRoomSources,
    },
  ],
});
