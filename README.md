# ExtensionSamples

[Conflux](https://conflux.one) 扩展包示例仓库。扩展负责拉取并映射数据，界面由 App 原生渲染。

协议、开发者指南和用户说明见 **[docs.conflux.one](https://docs.conflux.one)**。

## 示例

| 包 ID | 说明 | 订阅目录 |
| --- | --- | --- |
| [`conflux.bangumi`](./bangumi/) | Bangumi 番组计划：每日放送、季度新番、排行榜、搜索与详情（仅元数据） | [`bangumi/catalog.json`](./bangumi/catalog.json) |
| [`conflux.daily`](./daily/) | TMDB 与 Trakt 每日推荐：热映、热门、今日推荐、高分、即将上映、本周热门、今日播出，以及三个 Trakt 榜单、电影搜索与影视详情 | [`daily/catalog.json`](./daily/catalog.json) |
| [`conflux.danmu`](./danmu/) | 兼容标准弹幕 API 的弹幕源：需在扩展包设置里填写自己的 API 地址 | [`danmu/catalog.json`](./danmu/catalog.json) |
| [`conflux.theintrodb`](./theintrodb/) | TheIntroDB：片头、回顾、片尾与预告时间轴 | [`theintrodb/catalog.json`](./theintrodb/catalog.json) |

在 App 中通过「添加订阅」填入目录的原始 URL，或用「从 URL 安装」直接安装对应的 `.js`。

想一次订阅全部四个扩展，用根目录的 [`subscribe.json`](./subscribe.json)：

`https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/subscribe.json`

## 本地测试

```bash
node bangumi/test/harness.js
node daily/test/harness.js
node danmu/test/harness.js
node theintrodb/test/harness.js
```

`bangumi` 的测试会访问真实 Bangumi API；其余三个默认注入 `ctx.http` 替身，不需要网络（`theintrodb` 加 `CONFLUX_LIVE=1` 可额外跑一次真实接口查询）。
