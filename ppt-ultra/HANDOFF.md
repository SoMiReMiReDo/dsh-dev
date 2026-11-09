# PPT Ultra 开发交接

更新：2026-11-09（Asia/Shanghai）。先读 `MEMORY.md`、`DESIGN.md`、`README.md`。

## 当前停点

**入口/退出与右侧面板均已按用户确认改版，并已在桌面端真实 Host 上验证。**

- 入口从「Agent 预设自动打开全屏覆盖层」改为：**左侧栏常驻「PPT 工作台」→ DSH 主区域页面**。
  - `client.js` 注册 `sidebar.panellist`（label「PPT 工作台」，order 10）→ 点击由 `ctx.layout.selectPanel('ppt-ultra')` 选中。
  - `client.js` 注册 `main` keyed 面板 `ppt-ultra`，组件 `WorkbenchPage` 用 `retainedBy.mainView` 反查当前会话后渲染 `Workbench`。
  - `client.js` 注册 `shell.overlay` 的 `EntryWatcher`：工作台未打开时每 3 秒轮询 `/api/ppt-ultra.list`，Agent 用 `ppt_ultra_open` 打开新文稿后自动切到工作台（首次轮询只建基线）。
  - 已删除：`conversation.session.header.actions` 的临时按钮、`conversation.input.dock` 的 portal 挂载、`autoOpen` 预设逻辑、`puUI` 全局开关、`createPortal`。
- 右上角改为方案 1：`[⬇ 导出 PPTX（主/灰态 + 原因 tooltip）] │ [← 退出 PPT]`；去掉裸文本「关闭」。退出调用 `ctx.layout.selectPanel(null)`，文稿与未应用修改保留。
- `cordis.patch.yml` 只保留 Host 行；`ppt-edit` 预设与 `profile/` 目录删除；`package.json` 的 `files` 去掉 `profile`；`~/.dsh/profiles/ppt-ultra` 已删除。desktop Profile 只剩普通会话，`agentPresets/list` 返回 standard/ptc/minimal/cordis。
- 页面级布局：`.pu` 从 `position:fixed` 改为 flex 页面，容器查询 `@container` 自适应（不再用视口 media query）；`padding-top:var(--dsh-frame-top-clearance)` 让出 macOS 48px 顶部条；窄宽度下右侧编辑面板改为页面内 absolute 抽屉。
- `scripts/dev-server.mjs` 改为渲染 `Workbench({onExit})`，并用 flex 容器模拟页面高度。

### 右侧面板（文件选择 / 对话）

- 右侧只有两个 tab：`文件选择`（DSH 工作区仓库下拉 + 面包屑目录浏览，只列目录和 .pptx，可勾选「打开时新建对话」）与 `对话`（绑定 DSH Session 的消息/流式回复/运行态，输入框发送，可停止；可「新建对话」）。
- Agent 的 propose 结果以对话上方「待应用修改」卡片展示：操作条数/影响页/检查摘要 + 「已核对」勾选 + 应用/取消；已应用后显示「已应用 N 轮修改 / 撤销最近一轮」。
- `WorkbenchPage` 管理 chat session：默认取 `retainedBy.mainView` 的会话；最近选择写 localStorage；`ctx.sessions.retain({source:'ppt-ultra'})` 后渲染；「新建对话」= `ctx.sessions.create({workspaceId|cwd})` + retain + 切换；切换时用 `state.sourcePath` 在新 Session 里 `openPath` 重开当前文稿。
- Host `index.js` 新增 4 个受认证 POST 路由：`workspaces`、`browse`、`openPath`、`conversation`；browse/openPath 只接受已注册工作区内真实路径，openPath ≤50MiB；conversation 用 `sessions.get().deriveMessages()` + 全局 `agent/assistant-stream` 累积回复；`agent/error` 进 value.error。`lib/store.mjs` 的 `view()` 增加 `sourcePath`。

已验证（桌面端真实 Host + 已登录 cookie 的 headless Chrome）：

- 左侧栏出现「PPT 工作台」，点击后页面铺满 DSH 主面板（1440 窗口、侧栏展开时 `x=280,w=1160,h=900`）。
- 页面打开时恢复该会话最近文稿；「退出 PPT」返回对话；再次点侧栏入口恢复上一份文稿。
- 用 `/api/ppt-ultra.open` 模拟 Agent 打开 2 页样例后，≤4.5 秒自动切到工作台并加载布局。
- 侧栏收起后页面全宽（`x=0,w=1440`）；`html[data-platform=darwin]` 下顶栏 `y=48`。
- 无 JS 报错；`agentPresets/list` 已无 `ppt-edit`。
- 右侧面板：工作区下拉 10 个仓库；`dsh-dev` 根目录与 `ppt-ultra/test/fixtures` 浏览；打开 18 页样稿后 18 张缩略图 + 主画布预览加载；「新建对话」创建新 Session，输入区可用；退出再进入恢复文稿与会话；控制台无报错。

**仍未验证**：真实模型完整跑 `ppt_ultra_open/propose` 的自动进入与工作台更新、目标澄清实际交互、完整应用/导出流程（本轮只验证了入口/退出/自动进入和页面渲染）、PowerPoint 原生重开、SmartArt 实样。

## 路径与权限

- 仓库：`/Users/seal/Desktop/myNote/dsh-dev`
- 本项目：`/Users/seal/Desktop/myNote/dsh-dev/ppt-ultra`
- 当前聊天 cwd：`/Users/seal/Desktop/myNote/dsh-dev`（仓库根）；未修改 side-chat 业务代码。
- 会话文件权限为 danger-full-access，写权限覆盖整个仓库；交接时以实际权限为准。
- 原素材：`/Users/seal/Desktop/myNote/Qian`；测试副本：本项目 `test/fixtures/`，共 5 份 PPTX。
- 实际 DSH Profile：`/Users/seal/.dsh/profiles/desktop/package.json`。
- 已确认该文件 dependencies 含 `dsh-ppt-ultra: link:/Users/seal/Desktop/myNote/dsh-dev/ppt-ultra`，且 `dsh.profile.bundles` 已含 `dsh-ppt-ultra`。
- Git：`ppt-ultra/` 已在提交 `aba06c3` 中；本文件所在的改动仍为工作区未提交状态（`git status` 复核）。

## 代码导航

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 插件、JSON 路由（含 workspaces/browse/openPath/conversation）、预览图片路由、4 个 Agent 工具 |
| `client.js` | React 工作台；左侧栏「PPT 工作台」入口 + `main` keyed 页面 + `shell.overlay` 文稿监听器；右侧「文件选择 / 对话」两 tab；对话绑定并切换 DSH Session；导出/退出顶栏 |
| `lib/store.mjs` | 文稿状态、单文稿互斥、预览/应用/撤销/导出、持久化恢复、源文件冲突检查 |
| `lib/runtime.mjs` | Python 与 LibreOffice Kit 定位、子进程限制、渲染串行队列 |
| `python/pptx_engine.py` | ZIP/OOXML 精准编辑、指纹与部件校验、重开检查、渲染图片基础检查 |
| `cordis.patch.yml` | 只加载 Host（`ppt-ultra` 行）；不再声明预设 |
| `scripts/dev-server.mjs` | 本机 UI/文稿渲染验证服务，用 flex 容器模拟 DSH 主面板；workspaces/browse 用 fake registry，不含真实模型调用 |
| `test/store.test.mjs` | 状态机与故障回退测试（6 项） |
| `test/host-routes.test.mjs` | Host 路由回归：预览资源路由必须 `requestBody:'buffered'`；新 4 路由注册；browse 越界/穿越 400（3 项） |
| `test/client-wiring.test.mjs` | Client 入口回归：必须注册侧栏/主面板、不得回到会话顶栏或预设自动打开（1 项） |
| `test/engine_test.py` | 编辑与保真测试（7 项，其中一项遍历本地参考文件） |

工具名：`ppt_ultra_open`、`ppt_ultra_read`、`ppt_ultra_propose`、`ppt_ultra_clarify`。没有 Agent 应用/导出工具。

默认数据目录 `~/.dsh/ppt-ultra`；每份文稿保存 original、候选副本、渲染图片和原子替换的 state.json。历史暂不自动清理。

## 已做验证：勿扩大结论

Node 测试 10 项（2026-11-09：状态 6 + 预览路由 1 + client wiring 1 + 新 Host 路由 1 + browse 越界 1）与 Python 编辑/保真测试 7 项在 2026-11-08/09 通过。

- 对参考文稿修改一个文本对象，变更列表只有对应 slide XML；非目标部件逐字节一致。
- 2026-11-08 本地流程已跑通：原版 18 页 PPT 导入 → 文字编辑/真实预览 → 应用 → 第二轮编辑/应用 → 撤销 → 下载 PPTX 和清单 → 刷新恢复 → 窄屏单页；下载文件用 python-pptx 重开核对。
- 生成样稿的五类操作已通过真实 LibreOffice Kit 预览、应用和导出；含共享图片、原生图表和备注。
- 已用已安装 DSH 的真实 schema 校验器验证 4 个工具的参数与输出 schema。
- **2026-11-09 页面级入口验证**（desktop Profile 真实 Host，headless Chrome + 已登录 cookie，见 `/tmp/live-verify.cjs`、`/tmp/live-verify2.cjs`）：
  - `agentPresets/list` 返回 4 个预设（standard/ptc/minimal/cordis），无 `ppt-edit`。
  - 侧栏出现「PPT 工作台」；点击后 `.pu` 页面主面板 `x=280,w=1160,h=900`（1440 窗口、侧栏展开）。
  - 页面打开恢复会话最近文稿；「退出 PPT」后 `.pu` 消失、会话内容恢复；再次点侧栏入口恢复文稿。
  - `/api/ppt-ultra.open` 后 ≤4.5 秒 `EntryWatcher` 自动选中工作台，文件名/页数/布局正确。
  - 侧栏收起后页面 `x=0,w=1440`；模拟 `data-platform=darwin` 时顶栏 `y=48`（`--dsh-frame-top-clearance`）。
  - 页面滚动/容器查询断点（页面宽 1160 → `158px 1fr 326px`；900 → 单栏 + absolute 右侧面板）正常；控制台无 JS 报错。
- **2026-11-09 右侧面板验证**（`/tmp/live-panel.cjs`）：10 个工作区可选；目录浏览到 `ppt-ultra/test/fixtures`；打开 18 页样稿（18 缩略图、主画布 2 张预览图加载）；「新建对话」后输入区启用；退出再进入恢复文稿与会话；无 JS 报错。

**仍未验证**：真实模型完整跑 `ppt_ultra_open → ppt_ultra_propose` 时的自动进入与工作台热更新、clarify 实际交互、完整应用/导出流程、PowerPoint 原生重开、SmartArt 实样。桌面 Electron 窗口需刷新（Cmd+R）后才能看到新 Client；本轮 headless 验证走的是同一 Host 的新页面。

## 下一步

1. Desktop 主窗口 Cmd+R 刷新后人工确认：左侧栏「PPT 工作台」→ 文件选择仓库/文稿 → 对话给出修改 → 待应用卡片 → 应用 → 导出；退出再进入能恢复；「新建对话」与「打开时新建对话」上下文隔离符合预期。
2. 在真实会话中让模型跑 `ppt_ultra_open` + `ppt_ultra_propose`，确认真实模型回复在对话 tab 流式显示、待应用卡片与 clarify 候选对象正确。
3. 补右侧面板回归：窄屏抽屉、文件浏览器大目录、切换仓库、对话切换时文稿重开、无 Session 时自动建会话、导出禁用 tooltip。
4. PowerPoint 原生重开与 SmartArt 实样仍需人工验收，不以 LibreOffice 渲染代替。
5. 清理 `__pycache__`、`.local`、fixtures 等未纳入 Git 的内容后再提交。

## 常用命令

```sh
cd /Users/seal/Desktop/myNote/dsh-dev/ppt-ultra
npm test
/Users/seal/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3 -B -m unittest discover -s test -p '*_test.py'
node --check client.js
node --check index.js
npm run dev
```

本机官方 DSH CLI：

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' --profile desktop --dump-config
```

安装命令已经执行成功，不必无故重复：

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' plugin --profile desktop add /Users/seal/Desktop/myNote/dsh-dev/ppt-ultra
```

改完 `cordis.patch.yml` / Host 侧代码后，用 plugin manager 的 bundle 关闭再启用可热重载（本轮用 `set_bundle dsh-ppt-ultra false/true`）；Client 侧仍需用户刷新页面。**不要**对现有 desktop Profile 执行 `--from-default-profile`，该选项会重置自定义配置。检查现有用户配置时避免输出凭据。

## 本机运行时与参考资料

- Python：`/Users/seal/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3`
- Node：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node`
- Renderer：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js`
- 官方 Office 技能：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/office-skills/`
- 已解出的 DSH 插件接口参考：`/tmp/ppt-ultra-dsh-reference/`。从本机 app.asar 读取，非完整源码仓库。本轮另用 `/tmp/dsh-asar/asar.py` 直接从 app.asar 解包客户端包做接口核对。
- `/Users/seal/Documents/deepseek-harness` 实际只有默认工作区，不能当成源码仓库。
- 架构来源：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- Office 来源：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-office/README.md>

DSH `tools.register` 接受原始 JSON Schema；`defineTool` 接受另一种属性映射式定义。之前误用 defineTool 做校验曾报错，已确认是校验方式问题，不要因此错误修改现有工具 schema。

## 临时服务与测试产物

本轮启动的本地验证服务（收尾时应停止）：

| 端口 | 内容 |
| --- | --- |
| `127.0.0.1:4177` | `npm run dev` 等价开发服务器（默认数据目录） |
| `127.0.0.1:4180` | 空数据目录 `PPT_ULTRA_DATA=/tmp/pu-empty-data2`，用于无文稿布局截图 |

旧临时实例（4178/4191 等）可能仍在后台运行，PID/端口需重新确认。

其他临时路径（可随系统清理消失，不作为正式依赖）：

- `/tmp/live-panel.cjs`：右侧面板真实 Host 验证脚本（仓库列表、目录浏览、打开 18 页样稿、新建对话、退出恢复）。
- `/tmp/live-checkbox.cjs`、`/tmp/smoke-panel.cjs`：文件 tab「打开时新建对话」复选框与回归烟雾脚本。
- `/tmp/panel-*.png`：右侧面板/文件选择/对话截图；已复制到项目 `.local/verify/2026-11-09-*.png`。
- `/tmp/live-verify.cjs`、`/tmp/live-verify2.cjs`：上一轮页面级入口真实 Host 验证脚本（读桌面 cookie、headless Chrome）。截图 `/tmp/live-*.png`。
- `/tmp/pu-auto-test.pptx`：两页自动进入样例。
- `/tmp/cookie-line.txt`：本轮从 Desktop cookie DB 解出的 `127.0.0.1:51836` 会话 token；含凭据，不要提交或写入文档。
- `/tmp/ppt-ultra-build`：旧开发中转目录，以后以项目内文件为准。
- `/tmp/ppt-ultra-ui-flow.cjs`、`/tmp/ui-preset-flow.cjs` 等旧脚本：对应旧的覆盖层/预设入口，已不代表当前实现。
- `/tmp/ppt-ultra-object-flow.mjs`、`/tmp/ppt-ultra-schema-check.cjs`：对象操作与 schema 验证脚本。
- `/tmp/ppt-ultra-dev-data`、`/tmp/pu-empty-data` 等：测试数据目录。

现有 `scripts/dev-server.mjs` 对已安装 DSH 前端构建有特定适配，升级后可能需要调整。
