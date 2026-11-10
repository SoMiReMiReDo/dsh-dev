# 全流程操作手册（pipeline）

本文件把「调研面经 → 生成单页面试手册」拆成可执行阶段。命令中的 `<skill>` 指本 SKILL.md 所在目录的绝对路径，`<workdir>` 指项目目录（默认当前工作区下的 `<slug>/`）。

## 0. 两条路线

| 路线 | 何时用 | 采集 | 后续 |
| --- | --- | --- | --- |
| A · 小红书（主力） | 用户已登录小红书、要真实亲历面经/评论区的流程与结果信息 | `xhs_collect` 多关键词检索 + 逐篇详情 | `build_dataset.py` 聚合 → 抽取 → 生成 |
| B · 公网 | 无小红书登录、或要补充官网/JD/薪资/公开题单 | `web_search` + `web_fetch`（反爬时 `https://r.jina.ai/<url>` 兜底），必要时 `inner_chrome_*` 打开页面读取 | 手工整理成 `data/notes.json` 等价结构（见 §5），再走抽取 → 生成 |

两条都走阶段 0/4/5/6/7。不要为了"有数据"硬爬、绕过登录墙或验证码；抓不到的写进 `missing`/`appendix` 并在页面口径里说明。

## 1. 阶段 0：立项（3 分钟）

```bash
python3 "<skill>/scripts/init_project.py" --dir "<workdir>" \
  --company "<公司>" --city "<城市>" --role "<岗位/方向>" --topic "<课题，如 海力士 大连 面经>"
```

产出 `project.json`（公司/城市/关键词/主题色/标签规则）、`content.json` 骨架、`data/`、`README.md`。

先确认（能推断就别问，缺关键信息才用 `ask_user_question`）：
- 目标公司 + 岗位方向 + 城市（同公司不同厂区差异很大）
- 届别/时间范围（决定时间线口径与是否已截止）
- 数据源（小红书为主 or 公网为主）
- 交付要求：只要 report.html，还是也要 面试摘要.md / 英文练习页

## 2. 阶段 1：检索（发现候选笔记）

```text
xhs_status  → 拿到 dataDir、确认已登录
xhs_collect({mode:"search", keyword:"<核心词>", limit:40, maxScrolls:4})
xhs_collect({mode:"search", keyword:"<轮次/岗位/批次词>", sort:"latest", limit:40, maxScrolls:4})
```

- 关键词矩阵见 `xhs-collection.md`；首轮 ≥12 组（覆盖 公司 × 城市 × 主题 × 批次 × 岗位），增量轮用 `latest` 补新帖。
- 每次搜索都自动落盘到 `<dataDir>/searches/*.json`；记下每组的命中数，最终写进 `meta.json`。
- 搜索只负责"发现"，不追求完整内容；候选量大时去重后按相关性排序。

## 3. 阶段 2：详情采集

```text
# 推荐：优先 noteId（插件会复用缓存里带 xsec_token 的 URL）
xhs_collect({mode:"note", noteId:"<24位id>", maxComments:30})
# 只有缓存 URL 失效时才用完整 URL（必须带 xsec_token）
xhs_collect({mode:"note", url:"https://www.xiaohongshu.com/explore/<id>?xsec_token=...", maxComments:30})
```

- 做"评论区取证"（流程/结果/薪资常藏评论）时 `maxComments:60`。
- 逐条串行，失败重试 ≤1 次；点开评论 0 条且出现 `redcaptcha` 判据 → 停，记录到 missing，提示用户手动过验证码后补采。
- 超过 60 篇时拆 1 个采集子代理（清单文件 + 序号区间 + 只读约束），prompt 模板见 `xhs-collection.md`；主 agent 继续处理其他阶段。
- 纯图帖（title/desc 为空）：保留，抽取阶段标注"见配图"；疑似卖题库引流帖不当作亲历面经。

## 4. 阶段 3：聚合 + 图片本地化

```bash
python3 "<skill>/scripts/build_dataset.py" --dir "<workdir>" --xhs-data "<dataDir>"
```

产出：
- `data/notes.json`：合并 searches/notes/comments，按 noteId 去重，保留旧序号、新笔记追加，补 `tags2`（标签规则）、`offtopic`（是否偏题）、`publishedShort`；
- `data/meta.json`：关键词命中表、笔记/评论/图片计数、missing 清单、日期范围、标签计数、noteIndex；诊断字段 `searchFiltered`（被 `keywords.searchMatch` 过滤的搜索文件）、`retainedMissingFromData`（本次数据里不存在、为稳定序号保留的旧笔记）；
- `data/digest-01.md…`：分块文本（默认每块 ≤60k 字符），供抽取阅读；
- `data/images/`：配图本地化（并发 8、Referer、重试 3 次、>800B 校验；失败不阻断）。

要点：
- **图片采集后尽快跑这一步**：小红书 CDN 带时间签名，过期 403 无法补下。
- 序号即契约：`content.json` 的 `source:[n]` 是 `notes.json` 下标。脚本保证旧序不变、新笔记追加；本次数据里不存在的旧笔记会保留占位（`droppedFromData`）以稳定序号。手工改 `notes.json` 顺序前先想清楚所有引用。

`--max-images N` 用于控制图片下载量上限（调试/离线快速验证）：`meta.imageTotal = min(计划下载数, N)`，超出预算的笔记 `images` 置空；已有本地图片会复用，不会被清空。

## 5. 阶段 3B（仅路线 B）：公网数据手工落盘

没有 xhs 数据时，按 `build_dataset.py` 的输出契约手工准备 `<workdir>/data/notes.json` 与 `meta.json`（可写一个一次性的转换脚本）：

```json
notes.json: [{"id":"web-001","title":"…","author":"…","publishedAt":"2025-10-01","ip":"",
  "url":"https://…","stats":{"liked":0,"comments":0,"collected":0},"desc":"正文…",
  "tags":["面经"],"images":[],"comments":[{"author":"…","content":"…","like":0,"reply":false}],
  "queries":["来源关键词"],"localImages":[],"tags2":["流程"],"offtopic":false,"publishedShort":"2025-10-01"}]
meta.json: {"topic":"…","source":"web 检索","builtAt":"…","queries":[{"query":"…","count":3}],
  "queryCount":1,"noteCount":1,"commentCount":0,"imageCount":0,"totalLikes":0,"missing":[],
  "dateRange":"2025.10","noteTags":["流程"],"noteIndex":[…]}
```

`render_report.py` 会补派生字段（`tags2`/`offtopic`/`publishedShort`），所以最小字段只需 `id/title/desc/comments/publishedAt/stats/url`。

## 6. 阶段 4：结构化抽取（核心阶段）

1. 逐块阅读 `data/digest-*.md`（一次一块，不要把所有大文件塞进一个上下文）。
2. 按 `content-extraction.md` 的 schema 写入 `content.json`：
   `overview / process / questions / positions / timeline / salary / tips / pitfalls / takeaways / checklist / appendix / salaryNote / filteredNotes / emptyNotes`
3. 数量多时拆抽取子代理（每个子代理一块 digest → 一个片段文件），主 agent 合并；不要让单个模型一次"憋"出几百条大 JSON。
4. 校验：

```bash
python3 "<skill>/scripts/validate_content.py" --dir "<workdir>"          # 允许 warning，检查 error
python3 "<skill>/scripts/validate_content.py" --dir "<workdir>" --strict # 追求高质量交付时
```

## 7. 阶段 5：生成交付物

```bash
python3 "<skill>/scripts/digest.py" --dir "<workdir>"        # 面试摘要.md
python3 "<skill>/scripts/render_report.py" --dir "<workdir>" # report.html（主交付物）
```

- 生成物永远从 `content.json` + `data/*.json` + `project.json` 重新生成；**不要手改 report.html**。
- 需要改视觉/结构：改 `assets/report.template.html`（或项目内复制的模板，用 `--template` 指定）后重新生成。
- 可选英文面试练习页：见 `html-report.md` 最后一节，v1 不默认打包。

## 8. 阶段 6：验收

数据层：

```bash
python3 "<skill>/scripts/validate_content.py" --dir "<workdir>" --strict
python3 -m unittest discover -s "<skill>/test" -v   # skill 自测（脚本没被改坏）
```

渲染层（有 `node` + Chrome 时最稳）：

```bash
# 起本地服务后，用 headless Chrome 截整页（file:// 也可，但相对图片用 http 更稳）
python3 -m http.server 8877 --bind 127.0.0.1 --directory "<workdir>"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --hide-scrollbars --window-size=1440,4000 --virtual-time-budget=6000 \
  --screenshot=/tmp/report.png "http://127.0.0.1:8877/report.html"
```

- 用 `inner_chrome_open` + `inner_chrome_read` 检查标题/板块文本；截图失败（超时/`UnknownVizError`）回退 headless Chrome。
- 断点验收：1440 / 1280 / 1100 / 960 / 760 / 575（DSH 右侧栏宽）/ 480 / 390，确认无横向溢出、关键按钮不被遮挡。
- 打印验收：`Emulation.setEmulatedMedia({media:'print'})` 下 `.nav/.top` 应隐藏、背景纯白（模板已内置）。
- 交互验收：题目搜索/分类筛选、来源编号跳转、夜间切换（`aria-pressed`、刷新保持）、清单勾选持久化、图片 lightbox、Esc 关闭。
- 数据核对：页面显示数 = `meta.json`；抽查 3-5 个 `source` 是否命中对应笔记；`content.json` 的 source 全部在 `[0, noteCount)`。

交付层：
- `present` 主交付物（report.html + 面试摘要.md）；如项目在 git 仓库内，`git status` 确认只改了预期文件。
- README/说明里写清统计、口径、缺失清单、重新生成命令。
- 清理临时静态服务与预览副本。

## 9. 阶段 7：增量更新（面经是动态语料）

1. 用 `latest` 重跑关键词矩阵（只需核心/批次/轮次词），并重试旧 `meta.missing`。
2. 采集新笔记 + 补采失败笔记；`build_dataset.py` 自动合并（旧序保持、新笔记追加）。
3. 把新笔记导出为 `new_notes_batchN.md`（含 24 位 note id），交给增量分析子代理，产出 `delta_batchN.md`，固定分节：
   `## process / ## questions / ## positions / ## timeline / ## salary / ## tips / ## pitfalls / ## english / ## overview_update / ## irrelevant / ## duplicate`
4. 合并 delta 到 `content.json`：冲突点显式写出（**不要静默覆盖旧结论**），保留"（存疑）"标注与修正记录；重新 validate/digest/render。
5. 更新 README 统计与「更新记录」（数据量、结构性修正、仍存疑项）。

增量 prompt 模板见 `content-extraction.md`。

## 10. 规模与时间基线（历史实测）

| 项 | Gen1（91 篇） | Gen2（192 篇，含增量） |
| --- | --- | --- |
| 关键词组数 | 16 | 27 |
| 评论 | 834 | 2,055 |
| 图片本地化 | 231 | 611 / 期望 886（老图 CDN 过期） |
| 问题库 | 91 题 / 7 类 | 129 题 / 7 类 + 英文 49 题独立页 |
| 报告 | 332KB 单文件 | 更大 + 双主题 + 英文页 |
| 采集耗时 | 搜索 8 分钟 + 详情约 2.5 小时（2 个执行体） | 增量约 2.5 小时（133 次调用） |
| build 全量 | 分钟级 | 47s（含图片下载，限并发修复后） |

低于这个量级（<20 篇、<30 题）的报告通常不足以支撑面试准备，可如实告诉用户并建议扩充关键词/补采。
