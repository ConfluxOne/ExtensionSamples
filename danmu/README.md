# 弹幕

Conflux 扩展包，包 ID：`conflux.danmu`。

兼容标准弹幕 API 的弹幕源：接口地址由使用者自己填写，扩展只负责调用 `match`、`search`、`episodes`、`comment` 等接口，并把弹幕转换成 App 的 cue。仓库里不附带任何具体的弹幕服务。

协议与开发文档见 [docs.conflux.one](https://docs.conflux.one)。

## 安装

任选其一：

- **订阅目录**：在 App 中添加订阅，地址为本目录的 [`catalog.json`](./catalog.json) 原始地址：
  `https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/danmu/catalog.json`
- **从 URL 安装**：直接安装脚本
  `https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/danmu/danmu.js`

安装后需要到 App 的 Extensions 里启用，并在扩展包设置里填写 API 地址，否则 `match` 会直接报「请先填写弹幕 API 地址」。

## 能力

| 类型 | ID | 说明 |
| --- | --- | --- |
| danmu | `main` | 弹幕：按文件名匹配（`match`）、按关键词搜索（`search`）、剧集列表（`episodes`）、按剧集拉取弹幕（`comments`） |

接口约定：

- 基础地址会自动补上 `/api/v2`；填到 `/api/v2` 结尾也不会重复拼接。
- 填了 AppId / AppSecret 时，请求会带 `X-AppId` / `X-AppSecret` 头。
- `comments` 支持分段过滤（`input.segment`）与 `episode.id` 里的 `@shift` 时间偏移。
- 接口返回 401 / 403 视为 AppId 配置问题（`invalid_params`），429 为 `rate_limited`，404 为 `not_found`。

## 包级设置

- **API 地址**（`apiBase`，必填）：服务主机，例如 `https://example.com`。
- **AppId**（`appId`，可选）：服务要求时填写。
- **AppSecret**（`appSecret`，可选）：与 AppId 配对，放在 `X-AppSecret`。

因为地址由使用者提供，包申请了 `https://` 与 `http://` 两种网络权限。

## 本地验证

不需要网络：测试会注入 `definePackage` / `ExtensionError` / `ctx.http` 等运行时替身，用固定的接口响应跑一遍 `match` / `search` / `episodes` / `comments` 与错误映射。

```bash
node danmu/test/harness.js
```
