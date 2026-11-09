# HTML 报告：设计规范、模板契约、主题与验收

主交付物是 `report.html`：**单文件、离线、浅色优先**的面试准备手册。由 `assets/report.template.html` + `render_report.py` 生成，改生成物无效——**先改模板/脚本，再重新生成**。

## 1. 固定结构（8 个板块 + 首屏）

| # | 板块 | 内容 | 关键交互 |
| --- | --- | --- | --- |
| 首屏 | hero | 标题、lede、5 个统计卡、3-6 条 `takeaways` 卡片 | — |
| 01 | `#overview` 先看结论 | `overview` 长文 | — |
| 02 | `#process` 流程与节奏 | 流程卡片（编号水印）+ 时间线表 | 来源编号跳转 |
| 03 | `#questions` 高频问题库 | 分类问题 + hint + 来源 | 分类 chips 筛选、关键词搜索（含类别名） |
| 04 | `#positions` 岗位差异 | 岗位卡片 | 来源编号 |
| 05 | `#salary` 薪资与结果 | 薪资条目 + 口径说明 | 来源编号 |
| 06 | `#tips` 经验与坑 | 建议/踩坑双列 + 可勾选准备清单 | `localStorage` 保存勾选 |
| 07 | `#notes` 面经原文 | 全量笔记：正文/评论/配图/原帖链接 | 标签 chips、搜索、排序、分页 24、lightbox、来源跳转高亮 |
| 08 | `#method` 数据说明 | 检索关键词表 + 统计 + 口径与局限 + 附录 | — |

导航吸顶，锚点平滑滚动；来源编号可跨区块跳到原文卡片并高亮。

## 2. 视觉与主题（默认浅色）

- **默认浅色**，`color-scheme: light`，CSS 变量控制：`--bg/--panel/--text/--muted/--line/--accent/--accent-soft/--accent-line/--blue/--ok/--warn/--shadow/--radius`。
- 强调色由 `project.json` 的 `accent/accentSoft/accentLine` 注入；夜间可选 `accentDark: {accent, soft, line}`，未提供时用主色 + 自动 alpha 派生。
- 夜间是**可选切换**（不是默认）：head 内联脚本先读 `localStorage['<themeKey>']` 落 `data-theme` 防闪白；深色变量包在 `@media not print{}` 内。
- **打印永远浅色**：`@media print` 隐藏 nav / 回到顶部 / lightbox / 筛选栏 / 图片区，去阴影，正文白底。
- 可访问性：主题按钮 `aria-pressed` + `aria-label` + focus-visible；图片 `alt` + `loading="lazy"`；Esc 关 lightbox；`localStorage` 读写全部 try/catch。
- 关键操作（夜间切换）在窄视口必须常显：≤760px 收紧间距、≤480px 只留图标；**DSH 右侧栏约 575px 是必测宽度**。
- 响应式断点：980px（两列）、720px（单列）、480px（图标按钮）。

## 3. 模板契约

`render_report.py` 做四类替换（替换失败会报错退出）：

| 占位符 | 来源 | 说明 |
| --- | --- | --- |
| `__PAGE_TITLE__` | `project.pageTitle` | `<title>` 内容 |
| `__THEME_KEY__` | `project.themeKey` | localStorage 夜间主题 key |
| `__STORAGE_KEY__` | `project.storageKey` | 清单勾选等本地状态 key 前缀 |
| `/*__DATA__*/` | `const DATA = {project, meta, content, notes};` | 唯一数据注入点 |

`DATA` 结构：

```text
project   ← project.json（品牌/公司/城市/标题/主题色/文案/标签规则）
meta      ← data/meta.json（queries/noteCount/commentCount/imageCount/missing/dateRange/noteTags…）
content   ← content.json（8 区段 + takeaways/checklist/appendix/salaryNote/filteredNotes/emptyNotes）
notes     ← data/notes.json（正文/评论/本地图片/标签/是否偏题/来源命中词…）
```

`notes[]` 渲染依赖的派生字段（`build_dataset.py` 生成，`render_report.py` 会兜底补）：

| 字段 | 说明 |
| --- | --- |
| `publishedShort` | 发布日 `YYYY-MM-DD` |
| `tags2` | 标签数组（来自 `project.tagRules` 的正则匹配） |
| `offtopic` | 是否偏题（未命中 `project.topicPattern`），偏题卡片显示 `offtopicLabel` |
| `localImages` | 本地图片相对路径（`data/images/...`，报告在 `<workdir>` 根目录打开） |
| `queries` | 命中该笔记的检索词（卡片展示前 3 个） |
| `stats` | `{liked, collected, comments}` |
| `comments` | `[{author, content, like, createdAt, ip, reply}]`，`reply=true` 表示楼中楼 |

模板内可配置项（缺省都有合理默认）：

```text
project.company / city / role / brand / titleMain / titleThin / pageTitle
project.sourceLabel          # "小红书" / "公开网页"
project.dateRange            # 覆盖时间，如 "2025.09—2026.11"
project.timelineTitle        # 时间线小标题
project.checklistTitle       # 清单标题
project.questionSearchPlaceholder
project.processDesc / methodDesc / sourceNote / offtopicLabel
project.accent / accentSoft / accentLine / accentDark{accent,soft,line}
project.englishPage          # 可选英文练习页相对路径；空则隐藏入口
project.limits               # 自定义「口径与局限」bullet 数组；空则用动态默认
project.sourceMax / questionSourceMax   # 来源编号显示上限（默认 5/4，超出显示 +N）
```

## 4. 生成流程

```bash
python3 "<skill>/scripts/render_report.py" --dir "<workdir>"                 # 用 skill 自带模板
python3 "<skill>/scripts/render_report.py" --dir "<workdir>" --template "<自有模板>"
python3 "<skill>/scripts/digest.py" --dir "<workdir>"                        # 面试摘要.md
```

- 数据 / 模板分离：`project.json` + `data/*.json` + `content.json` 是输入；`report.html`/`面试摘要.md` 是生成物。
- 改配色/结构/文案：改模板（或复制模板到项目里改），重新生成；如果用户在页面上直接改了 HTML，要在交付前合并回模板，否则下次重生成会丢。
- 图片必须本地：`data/images/`，由 `build_dataset.py` 下载；报告不引用外链图片（`hasExternal` 检查）。

## 5. 自定义英文面试练习页（可选）

历史项目另做了 `english-interview.html`：49 题、4-5 组、每题中文标题 + 英文问法 + 中英参考答案 + hint + 面经来源；另有左侧目录、搜索、按组折叠、编辑模式（localStorage 持久化 + 导入导出）。

- 面经报告主体不依赖它；用户明确要"英文面试练习"或"英文真题页"时才做。
- 建议直接生成静态单文件（可复用本模板的 CSS 变量与主题切换），题源用 `content.json` 的英文类问题或独立 `english.json`，不要复用个人简历等隐私数据。
- 不要把它打包进 skill 分发（历史文件含真实姓名/学校信息）。

## 6. 验收（渲染层）

启动本地服务（`python3 -m http.server`）后用 headless Chrome / CDP 做断言，至少覆盖：

1. **无 JS 错误**：监听 `Runtime.exceptionThrown` / `console.error`。
2. **数据渲染**：标题/品牌/hero/统计卡/流程卡/问题数/笔记卡数与数据一致；`document.title === project.pageTitle`。
3. **搜索与筛选**：问题搜索（如"英文"）能命中类别名；分类 chips 切换后条数正确；笔记搜索/排序/分页可用。
4. **来源跳转**：点首个 `[data-jump]` 不报错，目标卡片进入视口。
5. **夜间切换**：点击后 `data-theme=dark`、`aria-pressed=true`；刷新后保持；console 无报错。
6. **打印**：`Emulation.setEmulatedMedia({media:'print'})` 下 nav/top 为 `display:none`、body 背景纯白。
7. **断点**：390/480/575/760/980/1440 宽度下 `document.documentElement.scrollWidth === innerWidth`（无横向溢出），主题按钮可见可点。
8. **离线**：断网/`file://` 打开时页面可读、图片来自本地路径（`img.src` 全部以本地相对路径开头）。
9. **图片**：`localImages` 引用文件存在；懒加载图片在截图前可换 `eager`（或提高 `--virtual-time-budget`）。

截图建议：浅色整页 + 暗色整页 + 窄屏（575/390）；失败时回退 Chrome headless（内置浏览器截图可能超时）。
