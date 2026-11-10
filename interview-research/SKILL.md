---
name: interview-research
description: 调研某公司/岗位的面经（小红书采集 + 网络检索），整理成结构化内容，并生成单文件离线 HTML 面试准备手册与 Markdown 摘要。适用于「调研面经」「整理面试问题」「做面试准备手册/网页」「生成面试复习页」等请求。
---

# 面经调研 → 面试准备页

把散落在小红书笔记（以及牛客/知乎/CSDN/官网等公开来源）里的面经，整理成一份**结构化、可背、可搜索、离线可读**的面试准备手册。固定流水线：**多关键词检索 → 逐篇采集 → 聚合 → 结构化抽取 → 生成单页 HTML → 验收迭代**。

本 skill 自带全部脚本（仅 Python 3.9+ 标准库，无第三方依赖）和一套浅色优先的单文件 HTML 模板。数据采集依赖 `dsh-xhs-check` 插件（仓库同级安装，含 `dsh-inner-chrome` 依赖）。

## 何时使用

- 用户要调研某公司/部门/岗位的面经、面试题、面试流程、薪资口径、offer 时间线
- 用户要一份「面试准备手册 / 复习页 / 面经汇总网页」
- 用户已有零散采集数据（xhs-check data）需要整理成结构化报告
- 不适用：只回答一两个面试问题、不需要采集和成页的轻量咨询

## 开始前确认（只问必要问题，能推断就别问）

1. **目标**：公司/部门、岗位方向、城市（同公司不同厂区/岗位差异很大，城市常决定选岗与薪资口径）
2. **届别/时间范围**：如 27 届秋招、近一年；影响时间线与"是否已截止"判断
3. **数据源**：默认「小红书采集为主 + `web_search`/`web_fetch` 补充」；若用户未登录小红书或明确要求网页检索，走 web-only 路径
4. **交付位置**：默认当前工作区 `<workspace>/<slug>/`；确认是否要英文面试练习页
5. **边界**：只采集公开笔记；不采集私信、不保存他人账号资料；不把未证实的数字写成确定结论

## 前置检查

```text
1. xhs_status                     # 插件可用？内置浏览器连着？已登录？（web-only 可跳过）
2. python3 --version              # 需要 >= 3.9
3. 确认本 skill 目录：<skill> = 本 SKILL.md 所在绝对路径
```

- 未登录：调用 `xhs_login` 让**用户自己扫码**，不要代扫；登录后 `xhs_status` 复核。
- 采集浏览器默认是 DSH 内置浏览器右侧栏；不要复用用户正在看的标签页（`xhs_collect` 自建 tab）。
- `xhs_status` 返回的 `dataDir` 记下来，第 3 阶段传给 `build_dataset.py --xhs-data`。

## 流水线

### 阶段 0 · 立项

```bash
python3 "<skill>/scripts/init_project.py" --dir "<workspace>/<slug>" \
  --company "SK海力士" --city "大连" --role "工艺/设备/整合" --topic "海力士 大连 面经"
```

生成 `project.json`（公司/城市/关键词/主题色/标签规则）、`content.json` 骨架（唯一内容源）、`data/`、`README.md`。

### 阶段 1 · 多关键词检索（保证覆盖，不宣称穷举）

- 先读 `references/xhs-collection.md` 的**关键词矩阵**，按「核心词 / 轮次 / 岗位 / 结果状态 / 英文 / 站点 / 年份」组合出 **12-30 组**关键词（历史实战 16-27 组）。
- 每组用 `xhs_collect(mode="search", keyword=..., sort="default|latest|popular", limit=40)`；`latest` 用于抓新帖，`popular` 补高赞帖。搜索结果的 JSON 落盘在 xhs-check 的 `data/searches/`。
- 搜索只用于发现：**去重、记录 noteId + xsec_token**。同一笔记可能命中多组关键词，后续按 noteId 去重。
- 把实际执行的完整关键词表写回 `project.json` 的 `keywords.core/expanded`，并在最终页面「方法」区展示（用户要看数据怎么来的）。
- 单关键词通常只返回 20-40 条；多组关键词后仍要坦白「不等于全站穷举」。

### 阶段 2 · 逐篇采集详情与评论

- 对去重后的每一篇：`xhs_collect(mode="note", url="https://www.xiaohongshu.com/explore/<id>?xsec_token=<token>")`。**必须带 `xsec_token`**，否则可能拿不到详情。
- `maxComments` 默认用 30（够拿正文 + 关键评论）；评论里常补出「几面、多久出结果、问了什么」这类正文没有的信息，需要评论区取证时用 60（软上限计父+子评论）。
- 量级大（>60 篇）时用子代理分批并发（每批 30-40 篇、串行调用、不要同时开太多浏览器任务），每个子代理只负责采集与落盘，不写其他文件；最后汇总失败清单。
- 失败处理：同一篇重试 1 次；仍失败（常见「未捕获笔记接口响应」、订阅 token 失效）记入 missing 清单，不要无限重试。
- 触发风控（`/api/redcaptcha/...`）时：停止重试，提示用户在内置浏览器里手动过一次验证码，再补采缺失评论/笔记——**不要试图绕过验证码**。
- 纯图片帖（title/desc 为空）不是失败：保留图片，正文显示为空；报告里标注「纯图帖」。

### 阶段 3 · 聚合与图片本地化

```bash
python3 "<skill>/scripts/build_dataset.py" --dir "<workdir>" --xhs-data "<dataDir>"
```

产出 `data/notes.json`（合并评论、去重、贴标签、标记偏题）、`data/meta.json`（关键词命中/统计/缺失清单/日期范围）、`data/digest-01.md…`（分块文本，供抽取）、`data/images/`。

- **图片采集后尽快本地化**：小红书 CDN 链接带时间签名，过期 403、无法补下。先跑本脚本再慢慢分析。
- **序号稳定性**：`content.json` 的 `source: [n]` 指向 `notes.json` 下标。脚本保证旧笔记序号不变、新笔记追加末尾；本次采集里已不存在的旧笔记也保留占位（标记 `droppedFromData`），避免换 `dataDir`/少采一篇导致后续序号前移。不要手工重排 `notes.json`。
- 失败图片不阻断流程，`meta.imageTotal` 与 `imageCount` 会给出缺口。

### 阶段 4 · 结构化抽取（本 skill 的核心）

按 `data/digest-*.md` 分块阅读（一次一块，不要把所有大文件塞进一个上下文），按 `references/content-extraction.md` 的 schema 与质量门槛，把内容写进 `content.json`。产出区段：

`overview / process / questions / positions / timeline / salary / tips / pitfalls / takeaways / checklist / appendix / salaryNote / filteredNotes / emptyNotes`

硬要求：
- 每条结论尽量带 `source`（笔记序号数组，≤6 个；页面默认展示前 5 个，超出显示 +N）；日期/数字标「（存疑）」；只写原帖说过的，不脑补通用面经。
- 问题按类别归并、去重（同一问题只保留一条，来源合并）；过滤无关帖、空帖、广告/题库引流帖，记录到 `filteredNotes`/`emptyNotes`。
- 抽取完必须校验：

```bash
python3 "<skill>/scripts/validate_content.py" --dir "<workdir>" --strict
```

### 阶段 5 · 生成交付物

```bash
python3 "<skill>/scripts/digest.py" --dir "<workdir>"          # 面试摘要.md
python3 "<skill>/scripts/render_report.py" --dir "<workdir>"   # report.html（主交付物）
```

- 主交付物 `report.html`：单文件离线，图片走本地 `data/images/`，无外部 CDN，默认浅色主题 + 可选夜间，打印走浅色。
- 视觉/交互规范与模板数据契约见 `references/html-report.md`；先改模板再重新生成，不要手改生成物。
- 可选英文面试练习页（中英对照 + 本地题源），纯数据驱动，见 `references/html-report.md` 末尾。

### 阶段 6 · 验收（不能只看"生成了"）

1. `python3 -m unittest discover -s "<skill>/test" -v`（skill 自测，确认脚本没被改坏）
2. `validate_content.py --strict` 通过
3. 起本地静态服务（`python3 -m http.server 8877 --bind 127.0.0.1 --directory "<workdir>"`）后用 `inner_chrome_open` 打开 `http://127.0.0.1:8877/report.html`，或直接用 headless Chrome 截图；检查：浅色对比度、导航、题目搜索/筛选、来源跳转、图片、575px/390px 窄屏、打印样式。**内置浏览器只接受 http(s)，不要用 file://**
4. 统计核对：页面数字 = `meta.json` 数字；抽查 3-5 条 `source` 跳转是否命中对应原帖；问题数 = 各分类之和
5. 汇报时给：笔记/评论/图片数、缺失清单、问题总数、3-5 条核心发现、页面路径

### 阶段 7 · 迭代

- 增量补采：重新跑 阶段 1-2，再 `build_dataset.py`（自动合并、追加序号、重算 meta），只重写受影响的 `content.json` 区段，然后重新生成。
- 用户反馈页面问题时改模板/生成脚本，再重新生成；不要让用户手改 `report.html`。

## 输出契约

```text
<workdir>/
  project.json        课题配置
  content.json        唯一内容源（抽取产物）
  data/notes.json     合并后的笔记（正文/评论/图片/标签/是否偏题）
  data/meta.json      统计与关键词命中、缺失清单
  data/digest-*.md    分块抽取输入
  data/images/        本地化配图
  report.html         主交付物：单文件离线面试准备手册
  面试摘要.md          纯文本摘要（生成物）
  README.md           文件说明与重新生成命令
```

## 硬规则（历史踩坑，逐条都是真教训）

1. **多关键词矩阵**，单关键词约 20-40 条；不宣称穷举，页面写明口径。
2. 详情链接必须带 `xsec_token`；失败重试 1 次，风控不硬刚。
3. **图片采集后立即本地化**，避免 CDN 签名过期 403。
4. `content.json` 是唯一内容源；`面试摘要.md`、`report.html` 永远重新生成。
5. `source` 用 `notes.json` 下标，≤6 个；序号稳定（旧序保持、新笔记追加、丢失笔记保留占位），不要手工重排。
6. 只写原帖说过的；推断/二手数字标「（存疑）」；无关/空帖/引流帖过滤并留痕。
7. 默认**浅色主题**，夜间为可选；打印/导出只走浅色。用户明确要深色才改默认。
8. 单文件离线：不引外部字体/脚本/图片；图片本地、题目可搜索筛选、来源可跳转。
9. 每阶段产物落盘，不把中间数据只留在对话里；缺失与失败要写进 `meta.json` 并在页面「口径与局限」展示。
10. 交付前跑自测与验收，报告统计口径，不夸大覆盖。

## 安装与自检

- 一条命令安装 skill + 依赖插件（xhs-check + inner-chrome）：在仓库根目录 `bash install.sh --profile desktop`，或 `curl -fsSL https://raw.githubusercontent.com/SoMiReMiReDo/dsh-dev/dev/interview-research/install.sh | bash`；装完重启 DSH 并**新开会话**。
- skill 自检：`python3 -m unittest discover -s "<skill>/test" -v`
- 依赖缺失（无 `xhs_*` 工具）时：先装插件，不要用 CDP/自研脚本硬爬。
- web-only 场景：跳过阶段 1-2 的 xhs 采集，用 `web_search`/`web_fetch`/`inner_chrome_*` 收集公开面经 → 手工整理成等价的 `data/notes.json`（可用 `build_dataset.py --xhs-data` 的目录约定仿写）后继续 阶段 4-7。

## 参考文件

- `references/pipeline.md` — 全流程操作手册（含并行/子代理分工、验收清单）
- `references/xhs-collection.md` — 关键词矩阵、xhs 工具参数、风控与失败处理
- `references/content-extraction.md` — content.json schema、抽取 prompt、质量门槛
- `references/html-report.md` — 页面设计规范、模板数据契约、主题/打印/可访问性
- `references/troubleshooting.md` — 常见报错与排查
