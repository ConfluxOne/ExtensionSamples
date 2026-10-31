definePackage({
  id: "conflux.danmu",
  title: "弹幕",
  description: "兼容标准弹幕 API 的弹幕源。在设置里填写自己的 API 地址后，到 Extensions 里启用。",
  version: "1.0.0",
  engine: 1,
  permissions: { network: ["https://", "http://"] },
  settings: [
    {
      name: "apiBase",
      title: "API 地址",
      type: "text",
      required: true,
      description: "填写服务主机，例如 https://example.com。地址未包含 /api/v2 时会自动补上。",
    },
    {
      name: "appId",
      title: "AppId",
      type: "text",
      description: "服务要求的 AppId。不需要时可留空。",
    },
    {
      name: "appSecret",
      title: "AppSecret",
      type: "text",
      description: "与 AppId 配对的密钥，请求时放在 X-AppSecret。不需要时可留空。",
    },
  ],
  extensions: [
    {
      type: "danmu",
      id: "main",
      title: "弹幕",
      description: "用 match、搜索和 comment 接口匹配并加载弹幕。",
      match: async function (ctx, input) {
        requireAPIBase(ctx);
        var request = readMatchInput(input);
        var matched = [];
        var matchError = null;
        if (request.fileName) {
          try {
            matched = await matchByFile(ctx, request);
          } catch (error) {
            matchError = error;
            console.warn("match", failureMessage(error, "弹幕匹配失败"));
          }
        }
        if (matched.length) {
          console.log("match", request.fileName, matched.length);
          return dedupe(matched).slice(0, 40);
        }
        if (!request.title) {
          if (matchError) throw asExtensionError(matchError, "弹幕匹配失败");
          return [];
        }
        var found = await searchResolved(ctx, request.title, request.season, request.episode);
        console.log("match fallback", request.title, found.length);
        return found;
      },
      search: async function (ctx, input) {
        var keyword = trim(input && input.query);
        if (!keyword) return [];
        var animes = await searchAnimes(ctx, keyword);
        var items = [];
        var seen = {};
        for (var i = 0; i < animes.length && items.length < 20; i++) {
          var item = animeMatch(animes[i]);
          if (!item || seen[item.id]) continue;
          seen[item.id] = true;
          items.push(item);
        }
        console.log("search", keyword, items.length);
        return items;
      },
      episodes: async function (ctx, input) {
        var match = input && input.match;
        var id = match && match.id ? String(match.id) : "";
        if (!id) return [];
        var loaded = null;
        try {
          loaded = await loadBangumi(ctx, id);
        } catch (error) {
          if (!(error && error.code === "not_found")) throw error;
        }
        var episodes = loaded && loaded.episodes ? loaded.episodes : [];
        var title = (loaded && loaded.title) || (match && match.title) || "";
        if (!episodes.length && title) {
          var data = await apiGet(ctx, "/search/episodes", {
            anime: title,
            v2: "true",
          });
          var animes = (data && data.animes) || [];
          for (var i = 0; i < animes.length; i++) {
            var anime = animes[i];
            var animeId = anime.bangumiId ? String(anime.bangumiId) : String(anime.animeId || "");
            if (animeId !== id && String(anime.animeId || "") !== id) continue;
            episodes = anime.episodes || [];
            if (!title) title = anime.animeTitle || "";
            if (episodes.length) break;
          }
          if (!episodes.length && animes.length === 1) {
            episodes = animes[0].episodes || [];
            title = title || animes[0].animeTitle || "";
          }
        }
        var season = parseSeason(title);
        var items = [];
        for (var e = 0; e < episodes.length; e++) {
          var episode = episodeItem(episodes[e], season);
          if (episode) items.push(episode);
        }
        console.log("episodes", id, items.length);
        return items;
      },
      comments: async function (ctx, input) {
        var identity = episodeIdentity(input);
        if (!identity.id) {
          throw ExtensionError({
            code: "invalid_params",
            message: "缺少剧集编号，无法加载弹幕",
            retryable: false,
          });
        }
        var segment = input && input.segment;
        var query = { withRelated: "true", chConvert: "0", v2: "true" };
        if (segment && !identity.shift && Number(segment.start) > 0) {
          query.from = String(segment.start);
        }
        var data = await apiGet(ctx, "/comment/" + encodeURIComponent(identity.id), query);
        if (isPending(data)) {
          data = await resolvePendingComments(ctx, identity.id, data, query);
        }
        var comments = (data && data.comments) || [];
        var cues = [];
        for (var i = 0; i < comments.length; i++) {
          var cue = cueFromComment(comments[i], identity.shift);
          if (!cue || !inSegment(cue.time, segment)) continue;
          cues.push(cue);
        }
        console.log("comments", identity.id, cues.length);
        return cues;
      },
    },
  ],
});

function trim(value) {
  if (value == null) return "";
  return String(value).replace(/^\s+|\s+$/g, "");
}

function settingText(ctx, name) {
  var value = ctx && ctx.settings ? ctx.settings[name] : "";
  return trim(value);
}

function requireAPIBase(ctx) {
  if (!settingText(ctx, "apiBase")) {
    throw ExtensionError({
      code: "invalid_params",
      message: "请先在扩展包设置里填写弹幕 API 地址",
      retryable: false,
    });
  }
}

function apiBase(ctx) {
  requireAPIBase(ctx);
  var value = settingText(ctx, "apiBase");
  if (value.indexOf("://") < 0) {
    value = "https://" + value;
  }
  var path = value.split("#")[0].split("?")[0].replace(/\/+$/, "");
  if (/\/api\/v2$/i.test(path)) return path;
  return path + "/api/v2";
}

function authHeaders(ctx) {
  var headers = {
    Accept: "application/json",
    "User-Agent": "ConfluxExtension/1.0",
  };
  var appId = settingText(ctx, "appId");
  var appSecret = settingText(ctx, "appSecret");
  if (appId) headers["X-AppId"] = appId;
  if (appSecret) headers["X-AppSecret"] = appSecret;
  return headers;
}

function failureMessage(error, fallback) {
  if (typeof error === "string" && error) return error;
  if (error && typeof error.message === "string" && error.message) return error.message;
  return fallback;
}

function asExtensionError(error, fallback) {
  if (error && error.name === "ExtensionError") return error;
  return ExtensionError({
    code: "unavailable",
    message: failureMessage(error, fallback),
    retryable: true,
  });
}

function responseBody(data) {
  if (typeof data !== "string") return data;
  var text = trim(data);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw ExtensionError({
      code: "unavailable",
      message: "弹幕接口返回的不是 JSON",
      retryable: true,
    });
  }
}

function errorMessage(data, fallback) {
  if (data && typeof data === "object") {
    if (typeof data.errorMessage === "string" && data.errorMessage) return data.errorMessage;
    if (typeof data.message === "string" && data.message) return data.message;
    if (typeof data.error === "string" && data.error) return data.error;
  }
  if (typeof data === "string" && data) return data;
  return fallback;
}

function throwHTTP(status, message) {
  if (status === 401 || status === 403) {
    throw ExtensionError({
      code: "invalid_params",
      message: message || "API 拒绝访问，请检查 AppId 和 AppSecret",
      retryable: false,
    });
  }
  if (status === 404) {
    throw ExtensionError({ code: "not_found", message: message || "未找到弹幕数据", retryable: false });
  }
  if (status === 429) {
    throw ExtensionError({ code: "rate_limited", message: message || "请求过于频繁", retryable: true });
  }
  throw ExtensionError({
    code: "unavailable",
    message: message || "弹幕请求失败 (" + status + ")",
    retryable: true,
  });
}

function assertAPISuccess(data) {
  if (data && typeof data === "object" && data.success === false) {
    throw ExtensionError({
      code: "unavailable",
      message: errorMessage(data, "弹幕请求失败"),
      retryable: true,
    });
  }
}

async function apiSend(ctx, method, path, options) {
  var base = apiBase(ctx);
  var url = base + (path.charAt(0) === "/" ? path : "/" + path);
  var headers = authHeaders(ctx);
  var request = {
    headers: headers,
    timeoutMs: options && options.timeoutMs ? options.timeoutMs : 15000,
  };
  if (options && options.query) request.query = options.query;
  if (options && options.body) {
    headers["Content-Type"] = "application/json";
    request.body = options.body;
  }
  var res;
  try {
    res = method === "POST" ? await ctx.http.post(url, request) : await ctx.http.get(url, request);
  } catch (error) {
    throw asExtensionError(error, "弹幕请求失败");
  }
  var data = responseBody(res && res.data);
  if (!res || res.status < 200 || res.status >= 300) {
    throwHTTP(res ? res.status : 0, errorMessage(data, "弹幕请求失败"));
  }
  assertAPISuccess(data);
  return data;
}

function apiGet(ctx, path, query) {
  return apiSend(ctx, "GET", path, { query: compactQuery(query) });
}

function apiPost(ctx, path, body) {
  return apiSend(ctx, "POST", path, { body: body, timeoutMs: 20000 });
}

function compactQuery(query) {
  var out = {};
  if (!query) return out;
  var keys = Object.keys(query);
  for (var i = 0; i < keys.length; i++) {
    var value = query[keys[i]];
    if (value == null || value === "") continue;
    out[keys[i]] = String(value);
  }
  return out;
}

function positiveInt(value) {
  var number = Number(value);
  if (!isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function pad2(value) {
  var text = String(value);
  return text.length < 2 ? "0" + text : text;
}

function readMatchInput(input) {
  input = input || {};
  var season = positiveInt(input.season);
  var episode = positiveInt(input.episode);
  var title = trim(input.title);
  var fileName = trim(input.fileName);
  var assembled = assembledFileName(title, season, episode);
  var matchName = "";
  if (season > 0 || episode > 0) {
    matchName = assembled || fileName;
  } else {
    matchName = fileName || assembled;
  }
  var duration = Number(input.duration);
  var fileSize = Number(input.fileSize);
  return {
    title: title,
    season: season,
    episode: episode,
    fileName: matchName,
    fileHash: trim(input.fileHash),
    fileSize: isFinite(fileSize) && fileSize > 0 ? Math.round(fileSize) : 0,
    duration: isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
  };
}

function assembledFileName(title, season, episode) {
  var tag = "";
  if (episode > 0) {
    tag = season > 0 ? "S" + pad2(season) + "E" + pad2(episode) : "E" + pad2(episode);
  }
  if (!title && !tag) return "";
  if (!title) return tag + ".mkv";
  if (!tag) return title + ".mkv";
  return title + "_" + tag + ".mkv";
}

function parseSeason(text) {
  var value = String(text || "");
  var patterns = [
    /(?:^|[^A-Za-z0-9])S0*(\d{1,2})(?![A-Za-z])/i,
    /season\s*0*(\d{1,2})/i,
    /第\s*(\d{1,2})\s*季/,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var found = patterns[i].exec(value);
    var parsed = found ? positiveInt(found[1]) : 0;
    if (parsed > 0) return parsed;
  }
  var chinese = /第\s*([一二三四五六七八九十零〇两]+)\s*季/.exec(value);
  if (!chinese) return 0;
  return chineseNumeral(chinese[1]);
}

function chineseNumeral(text) {
  var map = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (text === "十") return 10;
  if (text.length === 1 && map[text] > 0) return map[text];
  if (text.length === 2 && text.charAt(0) === "十" && map[text.charAt(1)] > 0 && map[text.charAt(1)] < 10) {
    return 10 + map[text.charAt(1)];
  }
  if (text.length === 2 && text.charAt(1) === "十" && map[text.charAt(0)] > 0 && map[text.charAt(0)] < 10) {
    return map[text.charAt(0)] * 10;
  }
  return 0;
}

function seasonMatches(season, title) {
  if (!(season > 0)) return true;
  var parsed = parseSeason(title);
  if (parsed > 0) return parsed === season;
  return season === 1;
}

function kindOf(type) {
  var value = String(type || "").toLowerCase();
  if (value === "movie" || value === "jpmovie") return "movie";
  return "series";
}

function animeIdentity(anime) {
  if (!anime) return "";
  if (anime.bangumiId) return String(anime.bangumiId);
  if (anime.animeId) return String(anime.animeId);
  return "";
}

function episodeNumberValue(episode) {
  if (!episode || episode.episodeNumber == null || episode.episodeNumber === "") return 0;
  return positiveInt(episode.episodeNumber);
}

function episodeRef(episodeId, title, shift, season, episodeNumber) {
  var id = String(episodeId);
  if (!id || id === "0") return null;
  if (shift) id = id + "@" + shift;
  var item = { id: id, title: title || id };
  if (season > 0) item.season = season;
  if (episodeNumber > 0) item.episode = episodeNumber;
  return item;
}

function episodeIdentity(input) {
  var episode = (input && input.episode) || (input && input.match && input.match.episode) || null;
  var raw = episode && episode.id ? String(episode.id) : "";
  var at = raw.lastIndexOf("@");
  if (at <= 0) return { id: raw, shift: 0 };
  var shift = Number(raw.slice(at + 1));
  if (!isFinite(shift)) return { id: raw, shift: 0 };
  return { id: raw.slice(0, at), shift: shift };
}

function matchItem(id, title, type, episode) {
  if (!id || !episode) return null;
  return {
    id: String(id),
    title: title || String(id),
    kind: kindOf(type),
    episode: episode,
  };
}

function hitMatch(hit) {
  if (!hit || !hit.episodeId) return null;
  var title = trim(hit.animeTitle) || trim(hit.episodeTitle) || String(hit.episodeId);
  var episodeTitle = trim(hit.episodeTitle) || title;
  var shift = Number(hit.shift);
  if (!isFinite(shift)) shift = 0;
  var episode = episodeRef(hit.episodeId, episodeTitle, shift, 0, 0);
  var id = hit.animeId ? String(hit.animeId) : String(hit.episodeId);
  return matchItem(id, title, hit.type, episode);
}

async function matchByFile(ctx, request) {
  var body = {
    fileName: request.fileName,
    matchMode: request.fileHash ? "hashAndFileName" : "fileNameOnly",
  };
  if (request.fileHash) body.fileHash = request.fileHash;
  if (request.fileSize) body.fileSize = request.fileSize;
  if (request.duration) body.videoDuration = request.duration;
  var data = await apiPost(ctx, "/match", body);
  var matches = (data && data.matches) || [];
  var items = [];
  for (var i = 0; i < matches.length; i++) {
    var item = hitMatch(matches[i]);
    if (item) items.push(item);
  }
  return items;
}

function animeMatch(anime) {
  var id = animeIdentity(anime);
  if (!id || id === "0") return null;
  var title = trim(anime.animeTitle) || id;
  var item = { id: id, title: title };
  if (kindOf(anime.type) !== "movie") item.kind = "series";
  return item;
}

function animeEpisodeMatch(anime, episode, requestSeason) {
  if (!anime || !episode || !episode.episodeId) return null;
  var title = trim(anime.animeTitle) || trim(episode.episodeTitle) || String(episode.episodeId);
  var number = episodeNumberValue(episode);
  var season = parseSeason(title);
  if (!(season > 0) && requestSeason > 0 && seasonMatches(requestSeason, title)) {
    season = requestSeason;
  }
  var episodeTitle = trim(episode.episodeTitle) || (number > 0 ? "第" + number + "集" : title);
  return matchItem(
    animeIdentity(anime) || String(episode.episodeId),
    title,
    anime.type,
    episodeRef(episode.episodeId, episodeTitle, 0, season, number)
  );
}

function pickEpisodeRecord(episodes, episodeNumber) {
  if (!episodes || !episodes.length) return null;
  if (episodeNumber > 0) {
    for (var i = 0; i < episodes.length; i++) {
      if (episodeNumberValue(episodes[i]) === episodeNumber) return episodes[i];
    }
  }
  return episodes[0];
}

function collectEpisodes(animes, season, episodeNumber) {
  var results = [];
  for (var i = 0; i < animes.length; i++) {
    var anime = animes[i];
    var episodes = anime.episodes || [];
    if (!episodes.length) continue;
    var matched = seasonMatches(season, anime.animeTitle || "");
    var chosen = [];
    if (episodeNumber > 0) {
      for (var e = 0; e < episodes.length; e++) {
        if (episodeNumberValue(episodes[e]) === episodeNumber) chosen.push(episodes[e]);
      }
      if (!chosen.length) chosen = [episodes[0]];
    } else {
      chosen = [episodes[0]];
    }
    for (var c = 0; c < chosen.length; c++) {
      var item = animeEpisodeMatch(anime, chosen[c], season);
      if (item) results.push({ match: item, seasonMatched: matched });
    }
  }
  return results;
}

async function loadSearchAnimes(ctx, title, episodeQuery) {
  var firstError = null;
  try {
    var episodes = await apiGet(ctx, "/search/episodes", {
      anime: title,
      episode: episodeQuery,
      v2: "true",
    });
    var found = (episodes && episodes.animes) || [];
    if (found.length) return found;
  } catch (error) {
    firstError = error;
  }
  try {
    var animes = await apiGet(ctx, "/search/anime", {
      keyword: title,
      episode: episodeQuery,
      v2: "true",
    });
    return (animes && animes.animes) || [];
  } catch (error) {
    throw asExtensionError(firstError || error, "弹幕搜索失败");
  }
}

async function searchResolved(ctx, title, season, episodeNumber) {
  var animes = await loadSearchAnimes(ctx, title, episodeNumber > 0 ? String(episodeNumber) : "");
  var collected = collectEpisodes(animes, season, episodeNumber);
  var results = [];
  for (var i = 0; i < collected.length; i++) {
    if (collected[i].seasonMatched) results.push(collected[i].match);
  }
  if (!results.length) {
    var limit = animes.length < 8 ? animes.length : 8;
    for (var a = 0; a < limit; a++) {
      var anime = animes[a];
      if (!seasonMatches(season, anime.animeTitle || "")) continue;
      var picked = anime.episodes && anime.episodes.length
        ? animeEpisodeMatch(anime, pickEpisodeRecord(anime.episodes, episodeNumber), season)
        : null;
      if (picked) {
        results.push(picked);
        continue;
      }
      var bangumiId = animeIdentity(anime);
      if (!bangumiId || bangumiId === "0") continue;
      try {
        var loaded = await loadBangumi(ctx, bangumiId);
        if (!loaded || !loaded.episodes || !loaded.episodes.length) continue;
        var record = pickEpisodeRecord(loaded.episodes, episodeNumber);
        var fromBangumi = animeEpisodeMatch(
          {
            animeId: loaded.animeId || anime.animeId,
            bangumiId: loaded.bangumiId || bangumiId,
            animeTitle: loaded.title || anime.animeTitle,
            type: loaded.type || anime.type,
          },
          record,
          season
        );
        if (fromBangumi) results.push(fromBangumi);
      } catch (error) {
        console.warn("bangumi", bangumiId, failureMessage(error, "failed"));
      }
    }
  }
  for (var u = 0; u < collected.length; u++) {
    if (!collected[u].seasonMatched) results.push(collected[u].match);
  }
  return dedupe(results).slice(0, 40);
}

async function searchAnimes(ctx, keyword) {
  var firstError = null;
  try {
    var animes = await apiGet(ctx, "/search/anime", { keyword: keyword, v2: "true" });
    var found = (animes && animes.animes) || [];
    if (found.length) return found;
  } catch (error) {
    if (!(error && error.code === "not_found")) firstError = error;
  }
  try {
    var episodes = await apiGet(ctx, "/search/episodes", { anime: keyword, v2: "true" });
    return (episodes && episodes.animes) || [];
  } catch (error) {
    throw asExtensionError(firstError || error, "弹幕搜索失败");
  }
}

async function loadBangumi(ctx, id) {
  var data = await apiGet(ctx, "/bangumi/" + encodeURIComponent(id));
  var bangumi = data && data.bangumi && typeof data.bangumi === "object" ? data.bangumi : data;
  if (!bangumi || typeof bangumi !== "object") return null;
  return {
    animeId: bangumi.animeId,
    bangumiId: bangumi.bangumiId || id,
    title: trim(bangumi.animeTitle),
    type: bangumi.type,
    episodes: bangumi.episodes || [],
  };
}

function episodeItem(episode, season) {
  if (!episode || !episode.episodeId) return null;
  var number = episodeNumberValue(episode);
  var title = trim(episode.episodeTitle) || (number > 0 ? "第" + number + "集" : String(episode.episodeId));
  var item = episodeRef(episode.episodeId, title, 0, season, number);
  return item;
}

function dedupe(items) {
  var seen = {};
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var episode = item && item.episode;
    var key = episode && episode.id ? "e:" + episodeIdentity({ episode: episode }).id : "m:" + item.id;
    if (!key || seen[key]) continue;
    seen[key] = true;
    out.push(item);
  }
  return out;
}

function isPending(data) {
  if (!data || typeof data !== "object") return false;
  var status = String(data.status || "").toLowerCase();
  if (status === "pending") return true;
  var comments = data.comments || [];
  if (data.taskId && !comments.length && status !== "completed") return true;
  return false;
}

async function resolvePendingComments(ctx, episodeId, data, query) {
  var taskId = data && data.taskId ? String(data.taskId) : "";
  if (!taskId) {
    throw ExtensionError({ code: "unavailable", message: "弹幕仍在生成，请稍后重试", retryable: true });
  }
  var task = await apiGet(ctx, "/taskcomment/" + encodeURIComponent(taskId));
  var status = String((task && task.status) || "").toLowerCase();
  if (status === "failed" || status === "error") {
    throw ExtensionError({
      code: "unavailable",
      message: (task && task.description) || "弹幕任务失败",
      retryable: true,
    });
  }
  if (status !== "completed") {
    throw ExtensionError({ code: "unavailable", message: "弹幕仍在生成，请稍后重试", retryable: true });
  }
  return apiGet(ctx, "/comment/" + encodeURIComponent(episodeId), query);
}

function parseP(value) {
  var text = String(value || "");
  if (!text) return null;
  var parts = text.split(",");
  var time = Number(parts[0]);
  var mode = parts.length > 1 ? Number(parts[1]) : 1;
  var color = parts.length > 2 ? Number(parts[2]) : 16777215;
  return {
    time: isFinite(time) ? time : 0,
    mode: isFinite(mode) ? mode : 1,
    color: isFinite(color) ? color : 16777215,
  };
}

function cueMode(mode) {
  if (mode === 4) return "bottom";
  if (mode === 5) return "top";
  return "rtl";
}

function colorHex(value) {
  var number = Number(value);
  if (!isFinite(number) || number < 0) number = 16777215;
  number = number & 0xffffff;
  var hex = number.toString(16);
  while (hex.length < 6) hex = "0" + hex;
  return "#" + hex;
}

function cueFromComment(comment, shift) {
  if (!comment) return null;
  var parsed = parseP(comment.p);
  var time = parsed ? parsed.time : Number(comment.time);
  if (!isFinite(time)) time = 0;
  if (shift) time += shift;
  var text = trim(comment.m != null ? comment.m : comment.text);
  if (!text) return null;
  var cue = {
    time: time,
    text: text,
    mode: cueMode(parsed ? parsed.mode : Number(comment.mode)),
    color: colorHex(parsed ? parsed.color : comment.color),
  };
  if (comment.cid != null && String(comment.cid) !== "") cue.id = String(comment.cid);
  return cue;
}

function inSegment(time, segment) {
  if (!segment) return true;
  var start = Number(segment.start);
  var end = Number(segment.end);
  if (isFinite(start) && time < start) return false;
  if (isFinite(end) && time >= end) return false;
  return true;
}
