#!/usr/bin/env node
/**
 * 红果增强线路 relay
 *
 * 只做一件事：用 openhongguo SDK（匿名设备）解析某一集的官方播放模型，
 * 返回播放地址和 content key。解密由播放器根据 options.decryptionKey
 * 处理，这里不下载、不解密、不转码。
 *
 * 依赖 openhongguo（不是 npm 包，需要从源码构建）：
 *   cd openhongguo/bindings/node
 *   npm install && npm run build && npm pack
 *   # 在本目录安装生成的 tgz：
 *   npm install /path/to/openhongguo-0.1.0.tgz
 *
 * 或者不安装，直接指定构建产物：
 *   OPENHONGGUO_MODULE=/path/to/openhongguo/bindings/node/index.js node relay.mjs
 *
 * 启动：
 *   node relay.mjs                 # 默认 127.0.0.1:8787
 *   RELAY_PORT=9000 node relay.mjs
 *   RELAY_TOKEN=secret node relay.mjs
 *
 * 接口：
 *   GET /health
 *   GET /resolve?vid=<episodeId>
 *   GET /resolve?series_id=<seriesId>&episode=<number>
 *
 * 返回：
 *   {
 *     "episodeId": "...",
 *     "seriesId": "...",
 *     "key": "<32 位 hex>",
 *     "keyVersion": "1",
 *     "duration": 130.45,
 *     "expiresAt": 1793868661,
 *     "protected": true,
 *     "streams": [{ "definition": "1080p", "url": "...", "size": 10868589, ... }]
 *   }
 */

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const HOST = process.env.RELAY_HOST || "127.0.0.1";
const PORT = Number(process.env.RELAY_PORT || 8787);
const TOKEN = String(process.env.RELAY_TOKEN || "");
const PROFILE = process.env.HONGGUO_PROFILE || fileURLToPath(new URL("./relay-data/anonymous.json", import.meta.url));
const MODULE = process.env.OPENHONGGUO_MODULE || "openhongguo";

let sdk;
try {
  sdk = await import(MODULE);
} catch (error) {
  console.error(`[relay] 无法加载 openhongguo（${MODULE}）：${error && error.message}`);
  console.error("[relay] 先构建并安装 SDK，或设置 OPENHONGGUO_MODULE=/path/to/openhongguo/bindings/node/index.js");
  process.exit(1);
}

const { createClient, fileProfileStore } = sdk;
const client = await createClient({
  profile: fileProfileStore(PROFILE),
  retryAttempts: 2,
});

// SDK 的播放接口大约每台匿名设备只返回一次模型；串行处理避免并发 reset 互相踩踏。
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function episodeIdFor(seriesId, episodeNumber) {
  const page = await client.listEpisodes(seriesId);
  const items = page && Array.isArray(page.items) ? page.items : [];
  if (items.length === 0) return "";
  const direct = items.find((item) => Number(item.number) === episodeNumber);
  const fallback = items[Math.max(0, episodeNumber - 1)];
  const hit = direct || fallback;
  return hit && hit.id ? String(hit.id) : "";
}

/** 拿到某一集的播放模型；遇到匿名设备限额就换设备重试。 */
async function resolveModel(episodeId) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await client.resolvePlayback(episodeId);
      const streams = result && result.playback && Array.isArray(result.playback.streams) ? result.playback.streams : [];
      if (streams.some((stream) => stream && stream.url)) return result;
      lastError = new Error("播放模型为空");
    } catch (error) {
      lastError = error;
      const code = error && error.code;
      if (code && code !== "ANONYMOUS_LIMITED" && code !== "RATE_LIMITED" && code !== "TRANSPORT") throw error;
    }
    try {
      await client.resetDevice();
    } catch (error) {
      // reset 失败时继续下一次尝试；最终错误由 lastError 决定。
    }
  }
  throw lastError || new Error("没有拿到播放模型");
}

function streamRows(playback) {
  const streams = playback && Array.isArray(playback.streams) ? playback.streams : [];
  return streams
    .filter((stream) => stream && stream.url)
    .map((stream) => ({
      definition: safeString(stream.definition) || "auto",
      url: stream.url,
      size: Number(stream.size) || 0,
      codec: safeString(stream.codec),
      width: Number(stream.width) || 0,
      height: Number(stream.height) || 0,
      protected: stream.protected === true,
      encryption: safeString(stream.encryption),
      hls: stream.hls === true,
      dash: stream.dash === true,
    }))
    .sort((a, b) => b.width * b.height - a.width * a.height);
}

function payload(episodeId, seriesId, result) {
  const playback = result.playback || {};
  const contentKey = result.contentKey || {};
  return {
    episodeId,
    seriesId: safeString(seriesId) || safeString(playback.series_id),
    key: safeString(contentKey.key),
    keyVersion: safeString(contentKey.version),
    duration: Number(playback.duration_seconds) || 0,
    expiresAt: Number(playback.expires_at) || 0,
    protected: playback.protected === true,
    streams: streamRows(playback),
  };
}

function send(response, status, body, headers) {
  const payloadText = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "x-relay-token, content-type");
  response.setHeader("access-control-allow-methods", "GET, OPTIONS");
  if (headers) for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(payloadText);
}

function authorized(request, url) {
  if (!TOKEN) return true;
  const header = safeString(request.headers["x-relay-token"]);
  const query = safeString(url.searchParams.get("token"));
  return header === TOKEN || query === TOKEN;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || HOST}`);
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "x-relay-token, content-type");
    response.setHeader("access-control-allow-methods", "GET, OPTIONS");
    return response.end();
  }
  if (!authorized(request, url)) {
    return send(response, 401, { error: { code: "UNAUTHORIZED", message: "缺少或错误的 relay token" } });
  }

  if (url.pathname === "/health") {
    return send(response, 200, { ok: true, host: HOST, port: PORT, profile: PROFILE });
  }

  if (url.pathname !== "/resolve") {
    return send(response, 404, { error: { code: "NOT_FOUND", message: "unknown route" } });
  }

  let vid = safeString(url.searchParams.get("vid")) || safeString(url.searchParams.get("episode_id"));
  const seriesId = safeString(url.searchParams.get("series_id"));
  const episode = Number(url.searchParams.get("episode")) || 0;
  if (!vid && (!seriesId || episode <= 0)) {
    return send(response, 400, { error: { code: "INVALID", message: "需要 vid，或 series_id + episode" } });
  }

  try {
    const resolved = await enqueue(async () => {
      if (!vid) vid = await episodeIdFor(seriesId, episode);
      if (!vid) throw Object.assign(new Error("没有找到这一集"), { code: "NOT_FOUND" });
      const result = await resolveModel(vid);
      return payload(vid, seriesId, result);
    });
    if (!resolved.key && resolved.protected) {
      // 没有 key 的加密流在播放器里也解不了，早点告知扩展。
      return send(response, 502, { error: { code: "NO_CONTENT_KEY", message: "播放模型没有 content key" } });
    }
    return send(response, 200, resolved);
  } catch (error) {
    const code = error && error.code ? String(error.code) : "RESOLVE_FAILED";
    const status = code === "ANONYMOUS_LIMITED" || code === "RATE_LIMITED" ? 503 : 502;
    console.error(`[relay] resolve ${vid || `${seriesId}#${episode}`} 失败：${code} ${error && error.message}`);
    return send(response, status, { error: { code, message: String((error && error.message) || error) } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[relay] 红果增强线路 relay: http://${HOST}:${PORT}`);
  console.log(`[relay] profile: ${PROFILE}`);
  if (TOKEN) console.log("[relay] 已启用 RELAY_TOKEN");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
