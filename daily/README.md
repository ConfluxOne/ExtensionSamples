# 每日推荐

Conflux 扩展包，包 ID：`conflux.daily`。

数据来自 [TMDB](https://www.themoviedb.org) 与 [Trakt](https://trakt.tv)，通过 Conflux 的公开代理（`/pubapi/tmdb/3`、`/pubapi/trakt`）访问，只提供元数据与榜单，不提供播放线路。

协议与开发文档见 [docs.conflux.one](https://docs.conflux.one)。

## 安装

任选其一：

- **订阅目录**：在 App 中添加订阅，地址为本目录的 [`catalog.json`](./catalog.json) 原始地址：
  `https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/daily/catalog.json`
- **从 URL 安装**：直接安装脚本
  `https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/daily/daily.js`

安装后不会自动出现在首页，需要手动把 widget 加到桌面。

## 能力

| 类型 | ID | 说明 |
| --- | --- | --- |
| widget | `now-playing` | 正在热映（海报网格） |
| widget | `popular` | 热门电影（带评分的海报排行） |
| widget | `hero` | 今日推荐（大图轮播） |
| widget | `top-rated` | 高分电影（榜单，副标题为评分） |
| widget | `schedule` | 今日播出（按播出时间排列的剧集） |
| widget | `upcoming` | 即将上映（海报分页） |
| widget | `week` | 本周热门（横向海报条） |
| widget | `movies-anticipated` | 最期待电影（Trakt 片单数） |
| widget | `shows-anticipated` | 最期待剧集（Trakt 片单数） |
| widget | `box-office` | 票房榜（Trakt 票房） |
| widget | `movies-watched` | 本周电影观看（Trakt 观看人数） |
| widget | `shows-watched` | 本周剧集观看（Trakt 观看人数） |
| search | `movie` | 电影搜索（分页） |
| detail | `movie` | 影视详情：简介、类型、演职员、剧照与预告片（接受 `tmdb` 来源，电影与剧集） |

所有 widget 都带 `placeholderData`，加载前先用占位内容渲染。

## 包级设置

- **API 地址**（`apiOrigin`）：默认 `https://test.conflux.one`；调试时可改成 `http://127.0.0.1:8080` 或 `http://localhost:8080`，留空则使用默认地址。修改后需要完全退出 App 再打开，不用重装。

## 本地验证

不需要网络：测试会注入 `definePackage` / `ExtensionError` / `ctx.http` 等运行时替身，并把 TMDB 与 Trakt 的响应替换为固定数据，因此不会请求真实接口。

```bash
node daily/test/harness.js
```
