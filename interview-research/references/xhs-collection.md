# 小红书采集：参数、关键词、风控

采集依赖 `dsh-xhs-check` 插件（默认用 DSH 内置浏览器右侧栏的已登录会话）。插件接口契约见仓库 `xhs-check/CONTRACT.md`，工具说明见 `xhs-check/README.md`。本文件只写"面经调研"场景的实操参数与坑。

## 0. 前置检查

```text
xhs_status
```

返回 `dataDir`（采集数据目录，后面 `build_dataset.py --xhs-data` 要用）、`login.loggedIn`、`browser.connected`、`counts`、最近任务。

- 未登录 → `xhs_login` 打开登录页，让**用户自己扫码**；登录后再 `xhs_status` 复核。
- 采集浏览器默认是 DSH 内置浏览器（按 Session 隔离的持久分区）；`settings.json` 里 `backend: cdp` 才用独立 Chrome，一般不要切。
- 插件单账号低频：请求间隔默认 ≥1500ms、串行；不要试图并发多浏览器抓取。

## 1. 工具与参数（源码为准）

| 参数 | 类型/默认 | 说明 | 面经场景建议 |
| --- | --- | --- | --- |
| `mode` | 必填：`note/search/profile/chat/notifications` | 采集模式 | 只用 `search` + `note` |
| `keyword` | search 必填 | 搜索词 | 中文长尾词，见 §2 |
| `sort` | `default` / `popular` / `latest` | default 覆盖面广；latest 抓新帖 | 首轮全 default；增量轮 latest |
| `limit` | 默认 40（clamp 1-200） | 结果条数上限 | 40 |
| `maxScrolls` | 插件 settings 默认 8（clamp 1-40） | 滚动次数 | 4（个别核心词 5） |
| `maxComments` | 插件 settings 默认 50 | note 模式评论软上限（父+子合计） | 30（正文+关键评论）；评论取证用 60 |
| `noteId` | 24 位 note id | note 模式；插件会复用 store 里缓存的带 token URL | **优先用 noteId** |
| `url` | 笔记链接 | note 模式；必须来自搜索结果、带 `xsec_token` | 缓存 URL 失效时才用 |
| `userId`+`tab` | profile 模式 | 采某人主页/收藏/赞过 | 面经场景基本不用 |

调用示例：

```text
xhs_collect({mode:"search", keyword:"海力士 大连 面经", limit:40, maxScrolls:4})
xhs_collect({mode:"search", keyword:"海力士 大连 二面", sort:"latest", limit:40, maxScrolls:4})
xhs_collect({mode:"note", noteId:"65fea779000000001203d140", maxComments:30})
```

什么时候失败（插件返回/日志关键字）：
- 「未捕获到笔记接口响应」→ 页面被风控或未登录；
- 「未捕获到目标笔记 … 的详情：订阅 token 可能已失效 / xsec_source 不匹配」→ 用最新搜索结果里的 URL 或 noteId 重采；
- 「链接缺少 xsec_token…」→ 手拼 `explore/<id>` 会被降级 H5，必须用搜索卡片 URL。

## 2. 关键词矩阵（覆盖 ≠ 穷举）

单关键词通常只返回 20-40 条；用「核心词 × 维度」组合出 **12-30 组**。默认模板：

```text
{公司} {城市} 面经                     # 核心
{公司} {城市} 面试 / 面试问题 / 面试流程
{公司} 面经                            # 去城市，捞同厂其他城市
{公司全称} {城市} 面经                  # 品牌全称
{英文名} {城市} 面试 / {英文名} {城市}    # 英文名（如 hynix）
{公司} {城市} 校招 / 秋招 / 春招 / 暑期实习 / 社招
{公司} {城市} 宣讲会 / 笔试
{公司} {城市} 一面 / 二面 / 三面 / HR面 / 终面 / 线下面试
{公司} {城市} 结果 / offer / 薪资 / 待遇
{公司} {城市} {岗位词…}                 # PIE/PE/YE/EE/设备/工艺/良率/技术员/质量/可靠性
{城市} 半导体 面经 / {行业} 面经         # 行业泛化
```

- 首轮 ≥12 组（覆盖 公司/城市/主题/批次/岗位 五维），核心词同时跑一次 `sort:"latest"` 抓时间增量。
- 实际执行过的完整表要回填进 `project.json` 的 `keywords.core/expanded`，最终页面「方法」区会展示；用户会问"怎么保证没遗漏"。
- 口径写进报告：**多组关键词扩展 ≠ 全站穷举**；`meta.missing` 单列没取到详情的。

## 3. 去重与相关性筛选（三道）

1. **noteId 去重**（脚本化）：合并 `data/searches/*.json`，按笔记 id 去重，记录每条被哪些 query 命中（`build_dataset.py` 已实现，并写入 `notes[].queries`）。
2. **标题相关性**（可复核）：标题命中 `面经|面试|凉经|选岗|一面|二面|终面|初面|约面|进面|offer|求职|攒人品|流程|分享|记录|高频题` 的优先；无标题的也要采（可能是纯图帖）。
3. **语义相关性**（抽取阶段）：无关公司/岗位的帖子不写进 `content.json`，记 `filteredNotes`；空帖/仅话题/一句话帖记 `emptyNotes`；广告/内推/入职日记/卖题库引流帖不当作亲历面经。不要为凑数硬塞。

## 4. 评论采集的真实行为

- note 模式流程：滚动加载 → 展开楼中楼 → `maxComments` 达到软上限即停；软上限计的是**评论记录总数（父+子）**。
- `maxComments:30` 实测常拿到一级评论 3-10 条 + 楼中楼若干；要更多一级评论用 60。
- 评论里常有「几面/多久出结果/问了什么/薪资」等正文没有的信息，报告原文区要展示评论，抽取时要读评论。

## 5. 风控 / 验证码 / 登录态（踩坑集中区）

| 现象 | 判据 | 处理 |
| --- | --- | --- |
| 评论全 0 | 请求接口出现 `/api/redcaptcha/v2/...`；comments 文件空数组 | 重试 1-2 次即停；记录清单；提示用户在内置浏览器手动过验证码后补采。**不要绕过验证码** |
| 单篇详情失败 | 「未捕获到笔记接口响应」 | 重试 1 次；仍失败记 `missing`，别无限重试 |
| 订阅 token 失效 | 「订阅 token 可能已失效 / xsec_source 不匹配」 | 用最新搜索 → noteId 重采；插件不会落盘错误笔记（避免污染 library） |
| URL 缺 token | 页面被降级 `/h5/` | 只用搜索/信息流里的带 token URL |
| 采集中被登出 | `xhs_status` 未登录 / 右侧栏停在登录页 | `ask_user_question` 请用户扫码（「已扫码登录好了」/「先用手头数据继续」），已采数据先处理 |
| 大量 0 评论/风控累积 | 搜索页/评论区频繁 redcaptcha | 降速：`settings.json` 调 `requestDelayMs=3000-4000`、`innerSettleMs=800-1000`、`maxScrolls=6`、`maxComments=30` |

## 6. 纯图帖 / 引流帖

- 纯图帖：`title`/`desc` 为空、内容在图片里。标题回退为「（无标题 · 纯图帖）」，抽取时标注"见配图，需人工"，必要时 `read_image` 看 1-2 张。
- 引流帖：图片是"中文 45 题/英文 20 题"资料页、正文只有标签/联系方式——不是亲历面经，不进 `questions`，可在 `appendix` 注明。
- 报告里对偏题笔记标「非主题 · 同业对比」（`offtopic` 自动生成），保留可追溯性。

## 7. 图片本地化

插件只存图片链接，不下载；`build_dataset.py` 会本地化到 `data/images/`：
- 并发 8、带 `Referer: https://www.xiaohongshu.com/`、超时 25s、每条重试 3 次、>800B 才算成功；
- 小红书图片 CDN 链接带时间签名，**采集后不尽快下载就会过期 403**；老帖补不回来，报告「口径与局限」要说明；
- 失败不阻断，`meta.imageTotal` 与 `imageCount` 给出缺口。

## 8. 采集子代理 prompt 模板（>60 篇时）

```text
你的任务：用小红书采集工具把一批笔记详情抓下来（只读采集，不要写/改任何项目文件）。

工作目录：<workdir>
清单文件：<清单路径>，每行格式「序号<TAB>noteId<TAB>完整URL」。
只处理序号 <a> 到 <b>（含），共 <N> 条。每条调用：
xhs_collect({mode:"note", noteId:"<noteId>", maxComments:<30|60>})
（优先 noteId；若插件提示缓存 URL 失效，再用该行完整 URL，URL 里的 %3D 原样传入不要解码。）

要求：
- 逐条串行，不并发；某条失败跳过并记录，重试不超过 1-2 次。
- 允许重复抓取（插件会合并）。
- 不要调用 xhs_login、不要搜索、不要改 data 目录以外的文件；除采集工具外不要做破坏性 bash 操作。
- redcaptcha 判据（评论 0 条且接口出现 /api/redcaptcha/）出现时停止该批并汇报，不要硬刚。

完成后 send_message 向 lead 汇报：成功/失败条数、失败清单（序号+noteId+原因）、评论缺失清单、纯图帖清单。
```

## 9. 参数速查（默认值）

| 参数 | 值 |
| --- | --- |
| 关键词组数 | 首轮 ≥12（实战 16-27） |
| search limit / maxScrolls | 40 / 4 |
| sort | 首轮 default，增量 latest |
| 详情 maxComments | 30（正文+关键评论）/ 60（评论取证） |
| 请求间隔 / settle | settings 保守档 3000-4000ms / 800-1000ms |
| 失败重试 | 详情 1-2 次；redcaptcha 立即停 |
| 图片并发 / 重试 | 8 / 3 次（>800B 校验） |
| 并发执行体 | 主 agent + 最多 1 个只读采集子代理（清单不重叠） |
