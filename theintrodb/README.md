# TheIntroDB

Conflux 扩展包，包 ID：`conflux.theintrodb`。

数据来自 [TheIntroDB](https://theintrodb.org) 的公开 API（`https://api.theintrodb.org`），只提供片头、回顾、片尾和预告的时间段，用于在播放器上显示时间轴标记。不需要 API Key。

协议与开发文档见 [docs.conflux.one](https://docs.conflux.one)。

## 安装

任选其一：

- **订阅目录**：在 App 中添加订阅，地址为本目录的 [`catalog.json`](./catalog.json) 原始地址：
  `https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/theintrodb/catalog.json`
- **从 URL 安装**：直接安装脚本
  `https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/theintrodb/theintrodb.js`

安装后需要到 App 的 Extensions 里启用。

## 能力

| 类型 | ID | 说明 |
| --- | --- | --- |
| timeline | `main` | 按 TMDB / IMDb / TVDB 编号查询片头（intro）、回顾（recap）、片尾（credits）和预告（preview） |

行为说明：

- 优先用 `ids.tmdb`；没有时用 `ids.imdb`（纯数字会补成 `tt...`）；再没有时用 `ids.tvdb`。
- 剧集（`mediaType: "tv"`）必须同时提供 `season` 与 `episode`；电影带上这两项也会一并提交。
- 传入 `duration`（秒）时会附带 `duration_ms`，接口没给结束时间时用播放时长兜底。
- 没有可识别的编号、接口返回 404 或时间段不合法时返回空数组；400 为 `invalid_params`，429 为 `rate_limited`。

## 网络权限

只申请了 `https://api.theintrodb.org`。

## 本地验证

默认不需要网络：测试会注入 `definePackage` / `ExtensionError` / `ctx.http` 等运行时替身，用固定响应校验查询参数、时间轴转换与错误映射。

```bash
node theintrodb/test/harness.js
```

加上 `CONFLUX_LIVE=1` 会额外对 `api.theintrodb.org` 跑一次真实查询（需要网络）：

```bash
CONFLUX_LIVE=1 node theintrodb/test/harness.js
```
