definePackage({
  id: "conflux.theintrodb",
  title: "TheIntroDB",
  description: "用 TheIntroDB 查询电影和剧集的片头、回顾、片尾和预告时间。安装后到 Extensions 里启用。",
  version: "1.0.0",
  engine: 1,
  permissions: { network: ["https://api.theintrodb.org"] },
  extensions: [
    {
      type: "timeline",
      id: "main",
      title: "TheIntroDB",
      description: "按 TMDB、IMDb 或 TVDB 查询片头、回顾、片尾和预告。",
      segments: async function (ctx, input) {
        var query = mediaQuery(input);
        if (!query) return [];
        var data = await fetchMedia(ctx, query);
        if (!data) return [];
        var segments = segmentsFromMedia(data, positiveNumber(input && input.duration));
        console.log("segments", queryLabel(query), segments.length);
        return segments;
      },
    },
  ],
});

var API_URL = "https://api.theintrodb.org/v3/media";
var SEGMENT_TYPES = ["intro", "recap", "credits", "preview"];

function trim(value) {
  if (value == null) return "";
  return String(value).replace(/^\s+|\s+$/g, "");
}

function positiveInt(value) {
  var number = Number(value);
  if (!isFiniteNumber(number) || number <= 0 || Math.floor(number) !== number) return null;
  return number;
}

function positiveNumber(value) {
  var number = Number(value);
  if (!isFiniteNumber(number) || number <= 0) return null;
  return number;
}

function isFiniteNumber(value) {
  return typeof value === "number" && value === value && value !== Infinity && value !== -Infinity;
}

function imdbID(value) {
  var id = trim(value);
  if (!id) return "";
  if (/^tt\d+$/i.test(id)) return id.toLowerCase();
  if (/^\d+$/.test(id)) return "tt" + id;
  return "";
}

function pickID(ids) {
  var tmdb = trim(ids && ids.tmdb);
  if (/^\d+$/.test(tmdb)) return { key: "tmdb_id", value: tmdb };
  var imdb = imdbID(ids && ids.imdb);
  if (imdb) return { key: "imdb_id", value: imdb };
  var tvdb = trim(ids && ids.tvdb);
  if (/^\d+$/.test(tvdb)) return { key: "tvdb_id", value: tvdb };
  return null;
}

function mediaQuery(input) {
  var picked = pickID(input && input.ids);
  if (!picked) return null;
  var query = {};
  query[picked.key] = picked.value;

  var mediaType = input && input.mediaType;
  var season = positiveInt(input && input.season);
  var episode = positiveInt(input && input.episode);
  if (mediaType === "tv") {
    if (season == null || episode == null) return null;
    query.season = String(season);
    query.episode = String(episode);
  } else if (mediaType !== "movie" && season != null && episode != null) {
    query.season = String(season);
    query.episode = String(episode);
  }

  var duration = positiveNumber(input && input.duration);
  if (duration != null) query.duration_ms = String(Math.round(duration * 1000));
  return query;
}

function queryLabel(query) {
  var keys = ["tmdb_id", "imdb_id", "tvdb_id", "season", "episode", "duration_ms"];
  var parts = [];
  for (var i = 0; i < keys.length; i++) {
    if (query[keys[i]]) parts.push(keys[i] + "=" + query[keys[i]]);
  }
  return parts.join(" ");
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
      message: "TheIntroDB 返回的不是 JSON",
      retryable: true,
    });
  }
}

function errorMessage(data, fallback) {
  if (data && typeof data === "object" && typeof data.error === "string" && data.error) return data.error;
  if (typeof data === "string" && data) return data;
  return fallback;
}

function throwHTTP(status, message) {
  if (status === 400) {
    throw ExtensionError({
      code: "invalid_params",
      message: message || "TheIntroDB 无法识别这部影片",
      retryable: false,
    });
  }
  if (status === 429) {
    throw ExtensionError({
      code: "rate_limited",
      message: message || "TheIntroDB 请求过于频繁",
      retryable: true,
    });
  }
  throw ExtensionError({
    code: "unavailable",
    message: message || "TheIntroDB 请求失败 (" + status + ")",
    retryable: true,
  });
}

async function fetchMedia(ctx, query) {
  var res;
  try {
    res = await ctx.http.get(API_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "ConfluxExtension/1.0",
      },
      query: query,
      timeoutMs: 15000,
    });
  } catch (error) {
    throw asExtensionError(error, "TheIntroDB 请求失败");
  }
  var data = responseBody(res && res.data);
  var status = res ? res.status : 0;
  if (status === 404) return null;
  if (status < 200 || status >= 300) throwHTTP(status, errorMessage(data, "TheIntroDB 请求失败"));
  return data;
}

function segmentsFromMedia(data, duration) {
  var items = [];
  if (!data || typeof data !== "object") return items;
  for (var i = 0; i < SEGMENT_TYPES.length; i++) {
    var type = SEGMENT_TYPES[i];
    var ranges = data[type];
    if (!ranges || !ranges.length) continue;
    for (var r = 0; r < ranges.length; r++) {
      var segment = segmentFromRange(type, ranges[r], duration);
      if (segment) items.push(segment);
    }
  }
  return items;
}

function segmentFromRange(type, range, duration) {
  if (!range || typeof range !== "object") return null;
  var start = range.start_ms == null ? 0 : Number(range.start_ms) / 1000;
  var end = range.end_ms == null ? duration : Number(range.end_ms) / 1000;
  if (!isFiniteNumber(start) || !isFiniteNumber(end) || start < 0 || end <= start) return null;
  return { type: type, start: start, end: end };
}
