# Bangumi 番组计划

Conflux 扩展包，包 ID：`conflux.bangumi`。

数据来自 [Bangumi](https://bgm.tv) 官方公开 API（`https://api.bgm.tv`），只提供番剧元数据，不提供播放线路。

协议与开发文档见 [docs.conflux.one](https://docs.conflux.one)。

## 安装

任选其一：

- **订阅目录**：在 App 中添加订阅，地址为本目录的 [`catalog.json`](./catalog.json) 原始地址：
  `https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/bangumi/catalog.json`
- **从 URL 安装**：直接安装脚本
  `https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/bangumi/bangumi.js`

安装后不会自动出现在首页，需要手动把 widget 加到桌面。

## 能力

| 类型 | ID | 说明 |
| --- | --- | --- |
| widget | `daily` | 每日放送（可按星期、在看人数 / 评分排序） |
| widget | `season` | 季度新番（年份、季度、排名 / 开播日期） |
| widget | `ranking` | 番剧排行榜（可按年份筛选） |
| search | `main` | 番剧搜索（匹配度 / 热度 / 排名 / 评分） |
| list | `posters` | widget 标题点击后的全屏海报列表，导航栏可直接搜索番剧 |
| detail | `main` | 简介、标签、制作人员、角色、分集、关联条目 |

## 包级设置

- **标题语言**：中文名优先（默认）或原名优先
- **封面清晰度**：原图（默认）或压缩图

## 本地验证

需要能访问 `https://api.bgm.tv`：

```bash
node bangumi/test/harness.js
```

测试会注入 `definePackage` / `ExtensionError` / `ctx.http` 等运行时替身，并对真实 Bangumi API 调用 widget、search、list、detail。
