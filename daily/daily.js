var DEFAULT_API_ORIGIN = "https://test.conflux.one";
var IMAGE_BASE = "https://image.tmdb.org/t/p/w500";
var PROFILE_BASE = "https://image.tmdb.org/t/p/w185";

var GENRES_ZH = {
  28: "动作",
  12: "冒险",
  16: "动画",
  35: "喜剧",
  80: "犯罪",
  99: "纪录",
  18: "剧情",
  10751: "家庭",
  14: "奇幻",
  36: "历史",
  27: "恐怖",
  10402: "音乐",
  9648: "悬疑",
  10749: "爱情",
  878: "科幻",
  10770: "电视电影",
  53: "惊悚",
  10752: "战争",
  37: "西部",
  10759: "动作冒险",
  10762: "儿童",
  10763: "新闻",
  10764: "真人秀",
  10765: "科幻奇幻",
  10766: "肥皂剧",
  10767: "脱口秀",
  10768: "战争政治",
};

var GENRES_EN = {
  28: "Action",
  12: "Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  99: "Documentary",
  18: "Drama",
  10751: "Family",
  14: "Fantasy",
  36: "History",
  27: "Horror",
  10402: "Music",
  9648: "Mystery",
  10749: "Romance",
  878: "Sci-Fi",
  10770: "TV Movie",
  53: "Thriller",
  10752: "War",
  37: "Western",
  10759: "Action & Adventure",
  10762: "Kids",
  10763: "News",
  10764: "Reality",
  10765: "Sci-Fi & Fantasy",
  10766: "Soap",
  10767: "Talk",
  10768: "War & Politics",
};

function apiOrigin(ctx) {
  var value = ctx && ctx.settings ? ctx.settings.apiOrigin : "";
  if (typeof value !== "string") {
    value = "";
  }
  value = value.replace(/^\s+|\s+$/g, "").replace(/\/+$/, "");
  if (!value) {
    return DEFAULT_API_ORIGIN;
  }
  return value;
}

function tmdbLanguage(ctx) {
  var locale = ctx && ctx.locale ? String(ctx.locale) : "";
  if (locale.toLowerCase().indexOf("zh") === 0) {
    return "zh-CN";
  }
  return "en-US";
}

function imageURL(path, base) {
  if (!path || typeof path !== "string") {
    return undefined;
  }
  if (path.indexOf("http://") === 0 || path.indexOf("https://") === 0) {
    return path;
  }
  return (base || IMAGE_BASE) + path;
}

function genreTitle(ids, language) {
  if (!ids || !ids.length) {
    return undefined;
  }
  var map = language === "zh-CN" ? GENRES_ZH : GENRES_EN;
  return map[ids[0]];
}

function movieItem(movie, language) {
  var item = {
    ref: { source: "tmdb", id: String(movie.id), mediaType: "movie" },
    title: movie.title || movie.original_title || "",
  };
  if (movie.overview) {
    item.description = movie.overview;
  }
  if (typeof movie.vote_average === "number") {
    item.rating = movie.vote_average;
  }
  if (movie.release_date) {
    item.releaseDate = movie.release_date;
  }
  var genre = genreTitle(movie.genre_ids, language);
  if (genre) {
    item.genre = genre;
  }
  var poster = imageURL(movie.poster_path);
  var backdrop = imageURL(movie.backdrop_path);
  if (poster || backdrop) {
    item.images = {};
    if (poster) {
      item.images.poster = poster;
    }
    if (backdrop) {
      item.images.backdrop = backdrop;
    }
  }
  return item;
}

function throwHTTP(status, message) {
  if (status === 404) {
    throw ExtensionError({ code: "not_found", message: message || "Not found", retryable: false });
  }
  if (status === 429) {
    throw ExtensionError({ code: "rate_limited", message: message || "Rate limited", retryable: true });
  }
  if (status >= 500) {
    throw ExtensionError({
      code: "unavailable",
      message: message || "TMDB proxy unavailable",
      retryable: true,
    });
  }
  throw ExtensionError({
    code: "unavailable",
    message: message || "Request failed (" + status + ")",
    retryable: true,
  });
}

function tmdbErrorMessage(data, fallback) {
  if (data && typeof data === "object") {
    if (typeof data.status_message === "string" && data.status_message) {
      return data.status_message;
    }
    if (typeof data.message === "string" && data.message) {
      return data.message;
    }
  }
  if (typeof data === "string" && data) {
    return data;
  }
  return fallback;
}

function tmdbBody(data) {
  if (typeof data === "string") {
    var trimmed = data.replace(/^\s+|\s+$/g, "");
    if (!trimmed) {
      return null;
    }
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw ExtensionError({
        code: "unavailable",
        message: "Invalid TMDB JSON",
        retryable: true,
      });
    }
  }
  return data;
}

function failureMessage(error, fallback) {
  if (typeof error === "string" && error) {
    return error;
  }
  if (error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return fallback;
}

function logRequest(label, url, query) {
  console.log(label, "GET", url, JSON.stringify(query || {}));
}

function logResponse(label, url, status) {
  console.log(label, "GET", status, url);
}

async function httpGet(ctx, label, url, query) {
  logRequest(label, url, query);
  var res;
  try {
    res = await ctx.http.get(url, {
      query: query,
      timeoutMs: 15000,
    });
  } catch (error) {
    console.log(label, "GET failed", url, failureMessage(error, "request failed"));
    throw error;
  }
  logResponse(label, url, res.status);
  return res;
}

async function tmdbGet(ctx, path, query) {
  var url = apiOrigin(ctx) + "/pubapi/tmdb/3" + path;
  var res;
  try {
    res = await httpGet(ctx, "tmdb", url, query);
  } catch (error) {
    throw ExtensionError({
      code: "unavailable",
      message: failureMessage(error, "TMDB request failed"),
      retryable: true,
    });
  }
  var data = tmdbBody(res.data);
  if (res.status < 200 || res.status >= 300) {
    console.log("tmdb", "GET error", res.status, url, tmdbErrorMessage(data, ""));
    throwHTTP(res.status, tmdbErrorMessage(data, "TMDB request failed (" + res.status + ")"));
  }
  return data;
}

function movieResults(data) {
  if (!data || typeof data !== "object") {
    throw ExtensionError({
      code: "unavailable",
      message: "Unexpected TMDB response",
      retryable: true,
    });
  }
  return data.results || [];
}

async function loadMovieList(ctx, path) {
  var language = tmdbLanguage(ctx);
  var data = await tmdbGet(ctx, path, {
    language: language,
    page: "1",
  });
  var results = movieResults(data);
  console.log(path, language, "items", results.length);
  return {
    items: results.map(function (movie) {
      return movieItem(movie, language);
    }),
  };
}

function copyListItem(item) {
  var next = {
    ref: item.ref,
    title: item.title,
  };
  if (item.description) {
    next.description = item.description;
  }
  if (typeof item.rating === "number") {
    next.rating = item.rating;
  }
  if (item.releaseDate) {
    next.releaseDate = item.releaseDate;
  }
  if (item.genre) {
    next.genre = item.genre;
  }
  if (item.subtitle) {
    next.subtitle = item.subtitle;
  }
  if (item.images) {
    next.images = item.images;
  }
  if (item.episode) {
    next.episode = item.episode;
  }
  return next;
}

function withScoreSubtitle(item) {
  var next = copyListItem(item);
  if (typeof next.rating === "number") {
    next.subtitle = next.rating.toFixed(1);
  } else {
    next.subtitle = "8.0";
  }
  return next;
}

function pad2(value) {
  return value < 10 ? "0" + value : String(value);
}

function localDate() {
  var date = new Date();
  return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
}

function clockTime(iso) {
  var date = new Date(iso);
  if (isNaN(date.getTime())) {
    return "";
  }
  return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
}

async function traktGet(ctx, path, query) {
  var url = apiOrigin(ctx) + "/pubapi/trakt" + path;
  var res;
  try {
    res = await httpGet(ctx, "trakt", url, query);
  } catch (error) {
    throw ExtensionError({
      code: "unavailable",
      message: failureMessage(error, "Trakt request failed"),
      retryable: true,
    });
  }
  var data = tmdbBody(res.data);
  if (res.status < 200 || res.status >= 300) {
    console.log("trakt", "GET error", res.status, url, tmdbErrorMessage(data, ""));
    throwHTTP(res.status, tmdbErrorMessage(data, "Trakt request failed (" + res.status + ")"));
  }
  return data;
}

async function loadSchedule(ctx) {
  var data = await traktGet(ctx, "/calendars/shows", { date: localDate() });
  var rows = data && data.items ? data.items : [];
  return {
    items: rows.map(function (row) {
      var item = {
        ref: { source: "tmdb", id: String(row.tmdb_id), mediaType: "tv" },
        title: row.show_title || "",
        episode: { season: row.season, episode: row.episode },
      };
      var time = clockTime(row.aired_at);
      if (time) {
        item.subtitle = time;
      }
      var poster = imageURL(row.poster_path);
      var backdrop = imageURL(row.backdrop_path);
      if (poster || backdrop) {
        item.images = {};
        if (poster) {
          item.images.poster = poster;
        }
        if (backdrop) {
          item.images.backdrop = backdrop;
        }
      }
      return item;
    }),
  };
}

function pageToken(input) {
  if (input && input.page && input.page.type === "page" && typeof input.page.page === "number" && input.page.page > 0) {
    return input.page.page;
  }
  return 1;
}

var placeholderItems = [
  {
    ref: { source: "tmdb", id: "969681", mediaType: "movie" },
    title: "蜘蛛侠：崭新之日",
    releaseDate: "2026-07-29",
    genre: "科幻",
    images: {
      poster: "https://image.tmdb.org/t/p/w500/bjiS5ipwxb9JFy3XRRN4OAilSeX.jpg",
      backdrop: "https://image.tmdb.org/t/p/w500/qeQJx07rK2xm8SD2sJxFKhE7gs0.jpg",
    },
  },
  {
    ref: { source: "tmdb", id: "1368337", mediaType: "movie" },
    title: "奥德赛",
    releaseDate: "2026-07-15",
    genre: "冒险",
    images: {
      poster: "https://image.tmdb.org/t/p/w500/5rhTDKUhPYvpdQIijFIs5VoWsON.jpg",
      backdrop: "https://image.tmdb.org/t/p/w500/twiVn9oFXOVR0uoYgawyEBlnFu8.jpg",
    },
  },
  {
    ref: { source: "tmdb", id: "1288445", mediaType: "movie" },
    title: "怒之杀",
    releaseDate: "2026-08-19",
    genre: "动作",
    images: {
      poster: "https://image.tmdb.org/t/p/w500/pu2VxGlpGwffOx292w18b1tv96j.jpg",
      backdrop: "https://image.tmdb.org/t/p/w500/qDa0fqDqIBCovRp975RvtGPcuN3.jpg",
    },
  },
  {
    ref: { source: "tmdb", id: "1204680", mediaType: "movie" },
    title: "歪心狼对阵ACME",
    releaseDate: "2026-08-20",
    genre: "喜剧",
    images: {
      poster: "https://image.tmdb.org/t/p/w500/orkLtdgMGiO9rTVMqJ1kKwrnup1.jpg",
      backdrop: "https://image.tmdb.org/t/p/w500/l9mFW9HQnAZ4r1ChZJHoOT3jaal.jpg",
    },
  },
  {
    ref: { source: "tmdb", id: "1516698", mediaType: "movie" },
    title: "最后的曙光",
    releaseDate: "2026-08-26",
    genre: "爱情",
    images: {
      poster: "https://image.tmdb.org/t/p/w500/3PWJqDfygN0YNNjWsDUOXclCp3h.jpg",
      backdrop: "https://image.tmdb.org/t/p/w500/zFCWfU2ViMIm38G1W8UsnSpqmWn.jpg",
    },
  },
  {
    ref: { source: "tmdb", id: "1386315", mediaType: "movie" },
    title: "生死时限",
    releaseDate: "2026-09-03",
    genre: "惊悚",
    images: {
      poster: "https://image.tmdb.org/t/p/w500/uxCaBoYXsDC4A0SqTm3SISj0OwK.jpg",
      backdrop: "https://image.tmdb.org/t/p/w500/ziXF8wIBguHNCeplNthUlDTCZP8.jpg",
    },
  },
];

var scheduleTimes = ["19:00", "19:30", "20:00", "20:45", "21:15", "22:00"];

function placeholderContent(count, decorate) {
  return {
    items: placeholderItems.slice(0, count).map(function (item, index) {
      var next = copyListItem(item);
      return decorate ? decorate(next, index) : next;
    }),
  };
}

function placeholderSchedule() {
  return {
    items: placeholderItems.slice(0, 6).map(function (item, index) {
      var next = copyListItem(item);
      next.ref = { source: "tmdb", id: item.ref.id, mediaType: "tv" };
      next.subtitle = scheduleTimes[index];
      next.episode = { season: 1, episode: index + 1 };
      return next;
    }),
  };
}

function trimOneDecimal(value) {
  var rounded = Math.round(value * 10) / 10;
  if (rounded === Math.floor(rounded)) {
    return String(Math.floor(rounded));
  }
  return String(rounded);
}

function compactCount(value) {
  if (typeof value !== "number" || isNaN(value)) {
    return "";
  }
  var sign = value < 0 ? "-" : "";
  var abs = Math.abs(value);
  if (abs >= 100000000) {
    return sign + trimOneDecimal(abs / 100000000) + "亿";
  }
  if (abs >= 10000) {
    return sign + trimOneDecimal(abs / 10000) + "万";
  }
  return sign + String(Math.round(abs));
}

function compactUSD(value) {
  if (typeof value !== "number" || isNaN(value)) {
    return "";
  }
  var abs = Math.abs(value);
  var body;
  if (abs >= 1000000000) {
    body = trimOneDecimal(abs / 1000000000) + "B";
  } else if (abs >= 1000000) {
    body = trimOneDecimal(abs / 1000000) + "M";
  } else if (abs >= 1000) {
    body = trimOneDecimal(abs / 1000) + "K";
  } else {
    body = String(Math.round(abs));
  }
  return (value < 0 ? "-$" : "$") + body;
}

var placeholderMetrics = [
  { year: 2026, list_count: 18200, revenue: 84200000, watcher_count: 240000 },
  { year: 2026, list_count: 14600, revenue: 61300000, watcher_count: 180000 },
  { year: 2026, list_count: 12100, revenue: 45800000, watcher_count: 96000 },
  { year: 2026, list_count: 9800, revenue: 22100000, watcher_count: 54000 },
  { year: 2026, list_count: 7600, revenue: 15700000, watcher_count: 31000 },
  { year: 2026, list_count: 5400, revenue: 9200000, watcher_count: 18000 },
];

function applyChartMetric(item, metric, row) {
  if (metric === "lists") {
    var lists = compactCount(row.list_count);
    if (lists && row.year) {
      item.subtitle = row.year + " · " + lists + "片单";
    } else if (lists) {
      item.subtitle = lists + "片单";
    }
  } else if (metric === "revenue") {
    var revenue = compactUSD(row.revenue);
    if (revenue) {
      item.subtitle = revenue;
    }
  } else if (metric === "watched") {
    var watchers = compactCount(row.watcher_count);
    if (watchers) {
      item.genre = watchers + "观看";
      item.subtitle = item.genre;
    }
  }
}

function chartItem(row, metric) {
  var mediaType = row.media_type === "tv" ? "tv" : "movie";
  var item = {
    ref: { source: "tmdb", id: String(row.tmdb_id), mediaType: mediaType },
    title: row.title || "",
  };
  if (row.year) {
    item.releaseDate = String(row.year);
  }
  var poster = imageURL(row.poster_path);
  var backdrop = imageURL(row.backdrop_path);
  if (poster || backdrop) {
    item.images = {};
    if (poster) {
      item.images.poster = poster;
    }
    if (backdrop) {
      item.images.backdrop = backdrop;
    }
  }
  applyChartMetric(item, metric, row);
  return item;
}

async function loadChart(ctx, path, metric) {
  var data = await traktGet(ctx, path, {});
  var rows = data && data.items ? data.items : [];
  console.log(path, "items", rows.length);
  return {
    items: rows.map(function (row) {
      return chartItem(row, metric);
    }),
  };
}

function placeholderChart(count, metric, mediaType) {
  return {
    items: placeholderItems.slice(0, count).map(function (item, index) {
      var next = copyListItem(item);
      if (mediaType === "tv") {
        next.ref = { source: "tmdb", id: item.ref.id, mediaType: "tv" };
      }
      applyChartMetric(next, metric, placeholderMetrics[index] || placeholderMetrics[0]);
      return next;
    }),
  };
}

function chartWidget(id, title, template, path, metric, options) {
  options = options || {};
  var count = options.count || 6;
  var mediaType = options.mediaType;
  var widget = {
    type: "widget",
    id: id,
    title: title,
    template: template,
    cache: { ttlSeconds: 21600 },
    placeholderData: placeholderChart(count, metric, mediaType),
    load: async function (ctx) {
      return loadChart(ctx, path, metric);
    },
    placeholder: async function () {
      return placeholderChart(count, metric, mediaType);
    },
  };
  if (options.families && options.families.length) {
    widget.families = options.families;
  }
  return widget;
}

function listWidget(id, title, template, path, count, options) {
  options = options || {};
  var widget = {
    type: "widget",
    id: id,
    title: title,
    template: template,
    cache: { ttlSeconds: options.ttlSeconds || 21600 },
    placeholderData: placeholderContent(count, options.decorate),
    load: async function (ctx) {
      var content = await loadMovieList(ctx, path);
      if (options.decorate) {
        content.items = content.items.map(function (item, index) {
          return options.decorate(item, index);
        });
      }
      return content;
    },
    placeholder: async function () {
      return placeholderContent(count, options.decorate);
    },
  };
  if (options.families && options.families.length) {
    widget.families = options.families;
  }
  return widget;
}

async function loadTVDetail(ctx, ref) {
  var language = tmdbLanguage(ctx);
  var data;
  try {
    data = await tmdbGet(ctx, "/tv/" + encodeURIComponent(ref.id), {
      language: language,
      append_to_response: "credits,images,videos",
      include_image_language: "zh,en,null",
    });
  } catch (error) {
    if (error && error.code === "not_found") {
      return null;
    }
    throw error;
  }
  if (!data || data.id == null) {
    return null;
  }
  var item = movieItem(
    {
      id: data.id,
      title: data.name || data.original_name,
      original_title: data.original_name,
      overview: data.overview,
      vote_average: data.vote_average,
      release_date: data.first_air_date,
      poster_path: data.poster_path,
      backdrop_path: data.backdrop_path,
      genre_ids: (data.genres || []).map(function (genre) {
        return genre.id;
      }),
    },
    language
  );
  item.ref = { source: "tmdb", id: String(data.id), mediaType: "tv" };
  var runtimes = data.episode_run_time || [];
  if (runtimes.length && typeof runtimes[0] === "number" && runtimes[0] > 0) {
    item.runtimeSeconds = runtimes[0] * 60;
  }
  if (data.genres && data.genres.length) {
    item.genres = data.genres.map(function (genre) {
      return { id: String(genre.id), title: genre.name };
    });
    if (!item.genre && item.genres[0]) {
      item.genre = item.genres[0].title;
    }
  }
  var people = [];
  var creatorRole = language === "zh-CN" ? "创作者" : "Creator";
  var creators = data.created_by || [];
  for (var i = 0; i < creators.length; i++) {
    var creator = creators[i];
    var person = { id: String(creator.id), title: creator.name, role: creatorRole };
    var creatorAvatar = imageURL(creator.profile_path, PROFILE_BASE);
    if (creatorAvatar) {
      person.avatar = creatorAvatar;
    }
    people.push(person);
  }
  var cast = ((data.credits || {}).cast) || [];
  for (var c = 0; c < cast.length && people.length < 16; c++) {
    var actor = cast[c];
    var actorItem = { id: String(actor.id), title: actor.name };
    if (actor.character) {
      actorItem.role = actor.character;
    }
    var avatar = imageURL(actor.profile_path, PROFILE_BASE);
    if (avatar) {
      actorItem.avatar = avatar;
    }
    people.push(actorItem);
  }
  if (people.length) {
    item.people = people;
  }
  var stills = [];
  var backdrops = ((data.images || {}).backdrops) || [];
  for (var b = 0; b < backdrops.length && stills.length < 12; b++) {
    var still = imageURL(backdrops[b].file_path);
    if (still) {
      stills.push(still);
    }
  }
  if (stills.length) {
    if (!item.images) {
      item.images = {};
    }
    item.images.stills = stills;
  }
  var trailers = [];
  var videos = ((data.videos || {}).results) || [];
  for (var v = 0; v < videos.length && trailers.length < 6; v++) {
    var video = videos[v];
    if (video.site !== "YouTube") {
      continue;
    }
    if (video.type !== "Trailer" && video.type !== "Teaser") {
      continue;
    }
    trailers.push({
      title: video.name,
      url: "https://www.youtube.com/watch?v=" + video.key,
    });
  }
  if (trailers.length) {
    item.trailers = trailers;
  }
  return item;
}

definePackage({
  id: "conflux.daily",
  title: "每日推荐",
  description: "TMDB 与 Trakt 每日推荐：正在热映、热门、今日推荐、高分、即将上映、本周热门、今日播出，以及 Trakt 期待榜、票房和本周观看。",
  icon: "https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/daily/icon.png",
  version: "1.2.1",
  engine: 1,
  permissions: {
    network: [
      "https://test.conflux.one",
      "http://127.0.0.1:8080",
      "http://localhost:8080",
    ],
  },
  settings: [
    {
      name: "apiOrigin",
      title: "API 地址",
      type: "text",
      default: "https://test.conflux.one",
      description: "调试时改成 http://127.0.0.1:8080 或 http://localhost:8080。留空则用默认地址。改完完全退出再打开，不用重装。",
    },
  ],
  extensions: [
    listWidget("now-playing", "正在热映", "poster-grid", "/movie/now_playing", 6),
    listWidget("popular", "热门电影", "poster-ranked", "/movie/popular", 3),
    listWidget("hero", "今日推荐", "backdrop-hero", "/trending/movie/day", 1),
    listWidget("top-rated", "高分电影", "ranked-list", "/movie/top_rated", 6, {
      decorate: withScoreSubtitle,
    }),
    {
      type: "widget",
      id: "schedule",
      title: "今日播出",
      template: "schedule-day",
      cache: { ttlSeconds: 3600 },
      placeholderData: placeholderSchedule(),
      load: async function (ctx) {
        return loadSchedule(ctx);
      },
      placeholder: async function () {
        return placeholderSchedule();
      },
    },
    listWidget("upcoming", "即将上映", "poster-pager", "/movie/upcoming", 6, {
      families: ["extraLarge"],
    }),
    listWidget("week", "本周热门", "ranked-rail", "/trending/movie/week", 6, {
      families: ["extraLarge"],
    }),
    chartWidget("movies-anticipated", "最期待电影", "ranked-list", "/movies/anticipated", "lists"),
    chartWidget("shows-anticipated", "最期待剧集", "ranked-list", "/shows/anticipated", "lists", {
      mediaType: "tv",
    }),
    chartWidget("box-office", "票房榜", "ranked-list", "/movies/boxoffice", "revenue"),
    chartWidget("movies-watched", "本周电影观看", "ranked-rail", "/movies/watched/weekly", "watched", {
      families: ["extraLarge"],
    }),
    chartWidget("shows-watched", "本周剧集观看", "ranked-rail", "/shows/watched/weekly", "watched", {
      families: ["extraLarge"],
      mediaType: "tv",
    }),
    {
      type: "search",
      id: "movie",
      title: "电影搜索",
      search: async function (ctx, input) {
        var query = input.query || "";
        if (!query) {
          return { items: [] };
        }
        var language = tmdbLanguage(ctx);
        var page = pageToken(input);
        var data = await tmdbGet(ctx, "/search/movie", {
          query: query,
          language: language,
          page: String(page),
        });
        var results = movieResults(data);
        var content = {
          items: results.map(function (movie) {
            return movieItem(movie, language);
          }),
        };
        var totalPages = data && data.total_pages;
        if (typeof totalPages === "number" && page < totalPages) {
          content.next = { type: "page", page: page + 1 };
        }
        return content;
      },
    },
    {
      type: "detail",
      id: "movie",
      title: "影视详情",
      accepts: { sources: ["tmdb"], mediaTypes: ["movie", "tv"] },
      cache: { ttlSeconds: 3600 },
      load: async function (ctx, input) {
        var ref = input.ref || {};
        if (ref.source !== "tmdb" || !ref.id) {
          return null;
        }
        if (ref.mediaType === "tv") {
          return loadTVDetail(ctx, ref);
        }
        if (ref.mediaType && ref.mediaType !== "movie") {
          return null;
        }
        var language = tmdbLanguage(ctx);
        var data;
        try {
          data = await tmdbGet(ctx, "/movie/" + encodeURIComponent(ref.id), {
            language: language,
            append_to_response: "credits,images,videos",
            include_image_language: "zh,en,null",
          });
        } catch (error) {
          if (error && error.code === "not_found") {
            return null;
          }
          throw error;
        }
        if (!data || data.id == null) {
          return null;
        }
        var item = movieItem(
          {
            id: data.id,
            title: data.title,
            original_title: data.original_title,
            overview: data.overview,
            vote_average: data.vote_average,
            release_date: data.release_date,
            poster_path: data.poster_path,
            backdrop_path: data.backdrop_path,
            genre_ids: (data.genres || []).map(function (genre) {
              return genre.id;
            }),
          },
          language
        );
        item.ref = { source: "tmdb", id: String(data.id), mediaType: "movie" };
        if (typeof data.runtime === "number" && data.runtime > 0) {
          item.runtimeSeconds = data.runtime * 60;
        }
        if (data.genres && data.genres.length) {
          item.genres = data.genres.map(function (genre) {
            return { id: String(genre.id), title: genre.name };
          });
          if (!item.genre && item.genres[0]) {
            item.genre = item.genres[0].title;
          }
        }
        var people = [];
        var credits = data.credits || {};
        var crew = credits.crew || [];
        var directorRole = language === "zh-CN" ? "导演" : "Director";
        for (var i = 0; i < crew.length; i++) {
          var member = crew[i];
          if (member.job !== "Director") {
            continue;
          }
          var director = { id: String(member.id), title: member.name, role: directorRole };
          var directorAvatar = imageURL(member.profile_path, PROFILE_BASE);
          if (directorAvatar) {
            director.avatar = directorAvatar;
          }
          people.push(director);
        }
        var cast = credits.cast || [];
        for (var c = 0; c < cast.length && people.length < 16; c++) {
          var actor = cast[c];
          var person = { id: String(actor.id), title: actor.name };
          if (actor.character) {
            person.role = actor.character;
          }
          var avatar = imageURL(actor.profile_path, PROFILE_BASE);
          if (avatar) {
            person.avatar = avatar;
          }
          people.push(person);
        }
        if (people.length) {
          item.people = people;
        }
        var stills = [];
        var backdrops = ((data.images || {}).backdrops) || [];
        for (var b = 0; b < backdrops.length && stills.length < 12; b++) {
          var still = imageURL(backdrops[b].file_path);
          if (still) {
            stills.push(still);
          }
        }
        if (stills.length) {
          if (!item.images) {
            item.images = {};
          }
          item.images.stills = stills;
        }
        var trailers = [];
        var videos = ((data.videos || {}).results) || [];
        for (var v = 0; v < videos.length && trailers.length < 6; v++) {
          var video = videos[v];
          if (video.site !== "YouTube") {
            continue;
          }
          if (video.type !== "Trailer" && video.type !== "Teaser") {
            continue;
          }
          trailers.push({
            title: video.name,
            url: "https://www.youtube.com/watch?v=" + video.key,
          });
        }
        if (trailers.length) {
          item.trailers = trailers;
        }
        return item;
      },
    },
  ],
});
