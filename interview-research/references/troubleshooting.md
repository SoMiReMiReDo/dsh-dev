# 常见问题与排查

## 安装 / 环境

**新会话里看不到 `interview-research` skill**
- 确认 skill 安装在文件系统 skill 根目录：`~/.dsh/skills/interview-research/SKILL.md`（或项目 `.dsh/skills/`、`~/.agents/skills/`）。
- skill 目录必须有 `SKILL.md` 且 frontmatter 含 `name`、`description`。
- skill 列表在会话开始时注入；装完要**新开一个会话**（或重启 DSH）。
- 校验：`bash install.sh --check`。

**没有 `xhs_*` 工具**
- `dsh-xhs-check` 插件没装或没启用。用仓库 `install.sh` 安装（会先装 `dsh-inner-chrome` 依赖），重启 DSH。
- 插件版本闸门：`xhs-check/package.json` 声明 `engines.dsh`，DSH 版本不匹配时插件管理器会拒绝；按提示 `dsh plugin --profile <p> allow-version ...`，或升级/降级 DSH。**不建议在生产 profile 放宽版本限制**。

**`install.sh` 报 dsh CLI 找不到**
- macOS 默认：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`
- 覆盖：`DSH_CLI=/path/to/dsh bash install.sh`；`DSH_HOME` 也可覆盖（默认 `~/.dsh`）。

**`install.sh` 报 profile 未初始化 / 安装失败**
- 先打开一次 DSH Desktop 初始化 profile；插件安装时最好完全退出 DSH 再跑（避免 profile 文件锁）。
- 失败日志在 `<profile>/.plugin-manager/logs/`。

**装完插件没生效**
- `index.js` / `cordis.patch.yml` 改动要重启 DSH；`client.js` 改动刷新页面即可。
- 插件以 `link:` 安装，仓库缓存目录（默认 `~/.dsh/plugins/dsh-dev`）不要删。

## 采集

**`xhs_collect` 全部失败 / 拿不到详情**
- 先 `xhs_status`：未登录 → `xhs_login` 让用户扫码；浏览器未连接 → 重新打开内置浏览器。
- 详情 URL 必须是搜索结果里的带 `xsec_token` 链接；手拼 `explore/<id>` 会被降级 H5。优先传 `noteId` 让插件复用缓存 URL。
- 失败重试 1 次即可；仍失败记 `missing`，不要无限重试。

**评论全是 0**
- 判据：接口出现 `/api/redcaptcha/...`，comments JSON 为空数组。
- 处理：停止重试；提示用户在内置浏览器手动过一次验证码，再补采；报告口径里说明评论缺口。

**采集中途被登出**
- `xhs_status` 检查 → `ask_user_question` 请用户扫码（「已扫码」/「先用手头数据继续」）→ 已采数据先跑聚合与抽取。

**`data/searches/` 里没有数据 / build 报找不到**
- `xhs_status` 的 `dataDir` 才是权威路径；`build_dataset.py --xhs-data <dataDir>` 显式传，或用 `XHS_DATA` 环境变量。
- 插件的 `data/` 默认在插件安装目录下（`<repo>/xhs-check/data`），插件以 link 安装时不要移动该目录。

## 聚合（build_dataset.py）

**图片大量 403 / 缺图**
- CDN 链接带时间签名，采集后要立刻本地化；过期不可补。报告「口径与局限」里如实写缺口（`meta.imageCount` vs `imageTotal`）。
- 提高成功率：确认 `Referer`（脚本已带）、降低并发（脚本默认 8）、失败重试 3 次。

**笔记数比搜索命中少**
- 只有搜索卡片、没有详情 JSON 的笔记记为 `meta.missing`；报告「数据说明」会展示。
- `publishedAt` 为空的详情报文也会被跳过（视为不完整）；如确认可接受，补采或手工修复该 JSON 后重跑。

**序号漂移 / content.json 的 source 指错**
- 不要手工重排 `data/notes.json`。脚本规则：已有 notes.json 时旧笔记保持原顺序，新笔记追加末尾。
- 如果已经破坏了顺序：从 git/备份恢复 notes.json 重跑；或按旧 content.json 里引用的标题重新核对（成本高，尽量避免）。

## 抽取 / 校验

**`validate_content.py` 报 source 越界**
- 序号是 `notes.json` 下标，不是笔记 id；确认抽取时用的是 digest 里的 `[n]`。
- 增删/重排笔记后必须重新构建再校验。

**问题重复 warning 很多**
- 同一问题换措辞出现：合并来源，保留最贴近原文的一条；`hint` 里放追问/提醒。
- 校验器只做归一化去重（去标点/空白/大小写），语义去重仍需人工/模型判断。

**条数不够（questions < 60）**
- 关键词/详情覆盖不足，或过滤过严。先看 `meta.missing`、`filteredNotes`、`emptyNotes`；补充关键词（轮次/岗位/批次词）和 `latest` 增量重采。
- 面经本身稀少时如实告知用户，不要用通用模板题硬凑。

## 生成 / 渲染

**`render_report.py` 报「模板替换失败：__XXX__ 仍存在」**
- 模板被改坏或换了不兼容模板；恢复 `assets/report.template.html`，或用 `--template` 指向正确模板。

**`report.html` 打开空白 / 只显示骨架**
- 先看浏览器 console：常见是数据注入后 JS 报错（字段缺失/非法字符）。`render_report.py` 会做 `</` 转义；自定义模板要注意。
- 用 `grep -c "const DATA = " report.html` 确认注入存在；用 `python3 -c "json.loads(...)"` 从 HTML 里抽 `const DATA` 校验 JSON。

**来源编号点了没反应**
- 目标笔记被当前筛选/分页隐藏时，模板会重置筛选并展开后跳转；若仍失效，检查 `content.json` 的 source 是否越界（越界编号不会渲染按钮）。

**图片不显示**
- `localImages` 路径相对 `report.html` 所在目录；本 skill 约定图片在 `<workdir>/data/images/`，`localImages` 应为 `data/images/...`。旧数据如果是 `images/...`，`render_report.py` 会自动尝试加 `data/` 前缀。
- `file://` 打开时 localStorage 可能受限（Chrome 可用），主题/勾选在换路径后可能丢，属于预期。

**内置浏览器截图超时 / `UnknownVizError`**
- 回退 headless Chrome：`--headless=new --screenshot=... --virtual-time-budget=6000`。
- 截整页前把 `loading="lazy"` 换成 `eager`，或加大 virtual-time-budget，避免图片空白。

**夜间模式颜色错位**
- 深色主题下 `--accent` 由 `project.accentDark` 或自动派生；如果只传了 `accentSoft/accentLine`，检查是否与深色背景对比度不足。
- 验收断点要包含 **575px（DSH 右侧栏）**：历史上窄视口隐藏过主题按钮。

**打印不是浅色 / 打印被截断**
- 深色样式应在 `@media not print{}` 内（模板已实现）；`@media print` 隐藏 nav/搜索/图片区。
- 被截断时检查是否有 `height:100vh` / `overflow:hidden` 的自定义样式。

## 交付

**`present` 后用户看不到文件**
- 确认路径在会话工作区内且文件已生成；`present` 只声明已存在的文件，不复制内容。
- 交付前重启静态服务占用端口要清理（`kill` 后台 job / `ps aux | grep http.server`）。

**用户说"我改了 report.html 但重新生成后没了"**
- 生成物与模板分离：把用户改动合并进模板/脚本再重新生成；不要直接手改生成物。
