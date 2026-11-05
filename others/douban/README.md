# 豆瓣

Conflux 扩展包，包 ID：`conflux.douban`。

用豆瓣的电影 / 剧集榜单做首页小组件，并提供豆瓣搜索与详情。数据来自豆瓣移动端的 rexxar JSON 接口（`https://m.douban.com/rexxar/api/v2/...`）；搜索走 `/rexxar/api/v2/search/subjects`，被限流时回退到 `movie.douban.com/j/subject_suggest` 标题联想。只提供元数据，**不提供播放线路**。

协议与开发文档见 [docs.conflux.one](https://docs.conflux.one)。

## 安装

任选其一：

- **订阅目录**：在 App 中添加订阅，地址为本目录的 [`catalog.json`](./catalog.json) 原始地址：
  `https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/others/douban/catalog.json`
- **从 URL 安装**：直接安装脚本
  `https://raw.githubusercontent.com/ConfluxOne/ExtensionSamples/main/others/douban/douban.js`

安装后不会自动出现在首页，需要手动把 widget 加到桌面。

## 能力

| 类型 | ID | 说明 |
| --- | --- | --- |
| widget | `showing` | 正在热映 |
| widget | `top250` | 豆瓣电影 Top250 |
| widget | `weekly` | 一周口碑榜（正好 10 条，带名次） |
| widget | `hot` | 热门电影 |
| widget | `tv` | 热门剧集 |
| widget | `tvRanked` | 剧集口碑榜（可切换华语 / 全球） |
| search | `search` | 豆瓣搜索（电影 + 剧集，支持分页；限流时回退标题联想） |
| list | `collection` | 其余 widget 标题点击后的全屏海报墙，按 `collection:<id>` 分页，导航栏可直接搜索电影与剧集 |
| list | `top250` | Top250 标题点击后的 `list` 样式列表，行副标题带名次、行内显示榜单短评作为简介，同样支持搜索 |
| detail | `main` | 豆瓣详情：简介、类型、演职员、评分 |

## 小组件与模板的选择理由

六个 widget 的 `header` 都是 `"list"`，标题栏可以点开对应榜单的全屏列表。除 Top250 外的 `ref` 都是 `{ source: "douban", id: "collection:<榜单>", mediaType: "movie" | "tv" }`，进入 `grid` 海报墙；Top250 的 `ref` 用 `{ source: "custom", id: "collection:top250", mediaType: "movie" }` 单独指向 `list` 样式的 `top250` 扩展。

| widget | 数据源 | 模板 | 为什么是这个模板 |
| --- | --- | --- | --- |
| `showing` 正在热映 | `movie_showing` | `poster-grid` | 正在热映只有海报、没有名次，且数量多（约 40+），适合铺成海报墙逐张浏览；标题栏点击进入同一份榜单的 `grid` 列表。 |
| `top250` 豆瓣电影 Top250 | `movie_top250` | `poster-ranked` | 接口按 `rank`（1 起）稳定排序返回；`poster-ranked` 把前三张海报做扇形叠放（第一名居中、第二/第三名分列左右），正好突出 Top250 的名次感；标题栏点击进入同一份榜单的 `list` 样式列表，行副标题带名次，行内显示榜单短评作为简介。 |
| `weekly` 一周口碑榜 | `movie_weekly_best` | `ranked-list` | 该榜单固定 10 条并带 `rank`，正好等于 `ranked-list` 的容量上限（每列三行、最多 10 条），每行左侧显示名次，海报 + 标题 + 副标题的信息密度最高。 |
| `hot` 热门电影 | `movie_hot_gaia` | `poster-pager` | 热门电影数量多（300+），`poster-pager` 是 `extraLarge` 大图翻页，中间一张完整卡片、两侧露出相邻卡片，适合用大图横向翻看热门片。 |
| `tv` 热门剧集 | `tv_hot` | `poster-rail` | 热门剧集没有名次、条目多，`poster-rail` 是无排名的横向海报轨，背后还有随海报变色的环境光，适合浏览热播剧。 |
| `tvRanked` 剧集口碑榜 | `tv_chinese_best_weekly` / `tv_global_best_weekly` | `ranked-rail` | 口碑榜带 `rank`，`ranked-rail` 在海报左下角叠加名次；`params.board` 可在华语（默认）与全球两个榜单间切换。 |

## 搜索与详情

- **搜索**：`search` 扩展调用豆瓣的 rexxar 搜索接口 `GET https://m.douban.com/rexxar/api/v2/search/subjects?q=<关键词>&start=&count=20`，只保留 `target_type` 为 `movie` / `tv` 的条目（`chart` 榜单等会被过滤），用 `types` 里影视合并的 `total` 翻页，每页 20 条、通过 `next` 继续加载。结果显示中文标题、年份、类型、评分和封面；封面是 `qnmob3-sign.doubanio.com` 的签名 URL，不需要额外请求头；实现会把 URL 里的 `imageView2` 尺寸改成 600×900，避免默认 120×180 的缩略图太糊。搜索被软限流（HTTP 403 `need_login` / 400）或第一页没有结果时，会回退到 `movie.douban.com/j/subject_suggest` 标题联想（条数少、无分页，用 `episode` 是否为正整数区分剧集）；两者都失败才抛 `rate_limited` / `unavailable`。
- **详情**：`detail` 扩展接受 `source: "douban"` 的 `movie` / `tv` 条目，返回标题、原名、简介、`genres`、`people`（导演与演员，来自 `/movie|tv/<id>/celebrities`）和 `rating`。详情按 `ref.mediaType` 请求 `/movie/<id>` 或 `/tv/<id>`；豆瓣对剧集 id 的 `/movie/<id>` 会 301 到 `/tv/<id>`，实现再按返回的 `type` / `is_tv` 判定电影还是剧集。
- **列表**：两份 `list`。`collection`（`grid`）的 `accepts.sources` 为 `["douban"]`，其余 widget 标题的 `ref.id` 形如 `collection:<榜单>` 时打开对应榜单的全屏海报墙；`top250`（`list`）的 `accepts.sources` 为 `["custom"]`，只接受 Top250 widget 的 header ref，行副标题前缀 `No.<名次>`，翻页后名次连续。`list` 样式会把 `overview` 显示在副标题下：这里直接使用榜单接口自带的短评（Top250 的 `description` 是一句话短评；一周口碑榜、热门剧集的 `description`/`comment` 更长），不额外请求详情。完整剧情简介在详情页。两份列表都把上一页的 `next` 原样作为下一页的 `page`，并声明了 `search: { id: "search" }`，导航栏因此出现搜索框；检索复用同一个 search 扩展，只取第一页，清空关键词后回到列表。

## 本地验证

测试全部使用内联 fixture（真实响应的精简版）和路由表 mock，**不联网**：

```bash
# 仓库根目录
node Packages/ExtensionSamples/others/douban/test/harness.js
```

测试会注入 `definePackage` / `ExtensionError` / `ctx.http` 等运行时替身，覆盖：包元数据与权限、六个 widget 的 `load` 与分页、`tvRanked` 的 board 切换、搜索（rexxar 主路径、过滤 chart、签名封面、分页，以及 403/5xx 回退标题联想与 `rate_limited` / `unavailable`）、列表分页、Top250 `list` 样式的名次与榜单短评 overview（不额外请求详情）、电影/剧集详情，以及 400 / 404 / 429 / 500 的错误码映射。

## 已知限制

- 使用的是豆瓣非官方接口（rexxar JSON / 标题联想），豆瓣随时可能改结构、加验证或收紧风控，失败时表现为 `unavailable` / `rate_limited`。
- 只提供元数据，**没有播放线路**，详情页的播放按钮不会出现；条目仅用于浏览和查看详情。
- 豆瓣没有公开可用的剧集分集接口，因此详情不提供 `episodes`，无法从详情或小组件直接定位季/集。
- 榜单接口不含完整剧情简介，`list` 样式的 `overview` 只能使用榜单自带的短评（Top250 为一句话）；需要完整简介请进入详情页。
- 搜索接口对未登录 / 高频请求很敏感，可能返回 403 `need_login` 或 400 `subject_ip_rate_limit`（软限流）；此时只会退回条数较少的标题联想，等一段时间再搜更稳。
- 豆瓣图床 `img*.doubanio.com` 不带 `Referer` 会返回 HTTP 418。包上的 `requestRules` 让 App 在加载这些图片时带上 `Referer: https://m.douban.com/`。搜索结果的 `qnmob3-sign` 签名 URL 不在这条规则里，本身也不需要这个头。
- 电影 / 剧集评分可能缺失（新片、冷门条目 `rating` 为空），此时条目不显示评分，属于正常情况。
