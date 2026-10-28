# ExtensionSamples

[Conflux](https://conflux.one) 扩展包示例仓库。扩展负责拉取并映射数据，界面由 App 原生渲染。

协议、开发者指南和用户说明见 **[docs.conflux.one](https://docs.conflux.one)**。

## 示例

| 包 ID | 说明 | 订阅目录 |
| --- | --- | --- |
| [`conflux.bangumi`](./bangumi/) | Bangumi 番组计划：每日放送、季度新番、排行榜、搜索与详情（仅元数据） | [`bangumi/catalog.json`](./bangumi/catalog.json) |

在 App 中通过「添加订阅」填入目录的原始 URL，或用「从 URL 安装」直接安装对应的 `.js`。

## 本地测试

```bash
node bangumi/test/harness.js
```
