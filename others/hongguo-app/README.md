# 红果短剧 · App 线路

Conflux 扩展包，包 ID：`conflux.hongguo.app`。

它和 [`../hongguo.js`](../hongguo.js) 使用同一套官网数据（widget / 搜索 / 列表 / 详情），区别只在 **playback**：

- 优先通过本机 relay 用 [openhongguo](https://github.com/beilunyang/openhongguo) 解析红果 App 的播放模型和 content key；
- 把 `url` + `options.decryptionKey` 交给 Conflux CorePlayer，由内置 FFmpeg 直接解 **CENC（cenc-aes-ctr）**；
- 因此官网只公开前几集也没关系，relay 解析的是 App 接口，可以播全部分集；
- relay 不可用时回退官网公开线路（只有前若干集）。

relay 只负责**解析**，不下载、不解密、不转码。视频解密发生在 Conflux 的播放器进程里。

> 免责声明：仅供个人学习与研究。内容版权归权利人所有，请勿用于批量抓取或传播。

## 前提

- Conflux 已包含 `PlaybackSource.options.decryptionKey` 支持（`decryptionKey` 只对 CorePlayer 生效，Aether / mpv / `player: "system"` 不使用）。
- Node.js 20+。
- 能从源码构建 openhongguo（需要 Go 1.22+）。

## 1. 构建并安装 openhongguo

```sh
git clone https://github.com/beilunyang/openhongguo.git
cd openhongguo/bindings/node
npm install
npm run build
npm pack
# 生成 openhongguo-0.1.0.tgz
```

在本目录安装它：

```sh
cd Packages/ExtensionSamples/others/hongguo-app
npm install /path/to/openhongguo-0.1.0.tgz
```

不想安装到本目录时，也可以直接指向构建产物：

```sh
OPENHONGGUO_MODULE=/path/to/openhongguo/bindings/node/index.js node relay.mjs
```

## 2. 启动 relay

```sh
node relay.mjs
# 默认 http://127.0.0.1:8787
```

可用环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RELAY_HOST` | `127.0.0.1` | 监听地址；默认只允许本机访问 |
| `RELAY_PORT` | `8787` | 端口 |
| `RELAY_TOKEN` | 空 | 设置后，请求需带 `X-Relay-Token` 或 `?token=` |
| `HONGGUO_PROFILE` | `./relay-data/anonymous.json` | 匿名设备档案；删除即可换设备 |
| `OPENHONGGUO_MODULE` | `openhongguo` | SDK 模块路径 |

健康检查：

```sh
curl http://127.0.0.1:8787/health
```

解析某一集（`vid` 就是红果的分集 ID）：

```sh
curl 'http://127.0.0.1:8787/resolve?vid=7621226618727435288'
```

返回示例（`key` 已截断）：

```json
{
  "episodeId": "7621226618727435288",
  "key": "bf337390e5a0d1e4631eabbd888a171e",
  "protected": true,
  "streams": [
    { "definition": "1080p", "url": "https://v95-sz-reading-video.qznovelvod.com/...", "size": 10868589 },
    { "definition": "720p", "url": "https://v95-sz-reading-video.qznovelvod.com/...", "size": 6230780 }
  ]
}
```

也可以只传剧集和集号，relay 会自己查分集 ID：

```sh
curl 'http://127.0.0.1:8787/resolve?series_id=7621200213801176126&episode=20'
```

## 3. 安装扩展

App → Extensions → 从文件安装 [`hongguo-app.js`](./hongguo-app.js)，或放到 HTTPS 地址后从 URL 安装。

包设置：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 本地解析服务 | `http://127.0.0.1:8787` | relay 地址 |
| relay 访问令牌 | 空 | relay 设置 `RELAY_TOKEN` 时填写 |
| 优先 App 线路 | 开 | 关掉后只走官网公开线路 |

扩展的 `permissions.network` 声明了 `http://127.0.0.1` / `http://localhost` 前缀，因此 relay 可以换端口；如果 relay 不在本机，需要相应修改权限，且不建议这样做。

## 播放流程

```
Conflux 播放按钮
  → 扩展 playback.sources
  → GET http://127.0.0.1:8787/resolve?vid=...
  → relay: openhongguo 匿名设备 → App 播放模型 + content key
  → 扩展返回 PlaybackSource { url, options: { decryptionKey } }
  → Conflux CorePlayer / FFmpeg: -decryption_key，直接解 CENC
```

## 常见问题

- **relay 返回 503 / ANONYMOUS_LIMITED**：匿名设备额度用尽，relay 会自动 `resetDevice` 重试；仍失败时删除 `relay-data/anonymous.json` 再试。
- **能显示线路但播放失败**：确认 Conflux 的播放核心是 CorePlayer（默认），不要用 Aether / mpv；并确认 App 版本已包含 `options.decryptionKey`。
- **没有 App 线路，只有官网线路**：relay 没启动、地址/端口不对、token 不匹配，或包设置里关闭了「优先 App 线路」。
- **官网公开线路仍然只有前几集**：这是兜底路径，属于预期行为。
