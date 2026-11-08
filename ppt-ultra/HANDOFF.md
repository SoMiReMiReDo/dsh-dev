# PPT Ultra 开发交接

更新：2026-11-08（Asia/Shanghai，下午）。先读 `MEMORY.md`、`DESIGN.md`、`README.md`。本轮已接手并修复 desktop Profile 的预设故障，profile 配置完成；剩余为实机端到端与保真验收。

## 当前停点

**已安装到现有已登录 DSH 的 `desktop` Profile，配置完整并通过验证；首版代码可运行，测试全绿。**

此前“新会话预设菜单只有标准、PTC、极简、创造模式”的原因已确认：`preset-ppt-edit` 把 `@deepseek-ai/dsh-compaction-basic` 直接作为 preset plugin 挂载，注册表审计报 `Preset services require isolate realms: compaction`，定义 broken；Web 端 `presetOptions()` 过滤 `broken` 预设，所以菜单里看不到。

修复已落在 `cordis.patch.yml`：用 `cordis:group` + `isolate.compaction: true` 包住 `compaction-basic`（与官方 `minimal` 预设写法一致），并用 `plugin_manager set_bundle` 先禁用再启用 `dsh-ppt-ultra` 完成即时重载。

重载后的验证结果：

- `agentPresets.list` 返回 5 个预设，`ppt-edit`（PPT 编辑，order 5）不再带 `broken`。
- `agentPresets.read ppt-edit` 返回完整 composition：persona + 隔离的 compaction group。
- `plugin_manager list_plugins`：`include:ppt-ultra`、`include:preset-ppt-edit` 均 enabled / fiberPhase active。
- 活动 Client 的 `conversation.session.header.actions` 含 `ppt-ultra`（order 65），即“打开 PPT Ultra”入口已注册。

profile 定义文件、链接依赖、bundle 列表保持原状；未改默认预设（仍为 standard）。

### 本轮新增（Profile 级入口）

- `client.js`：工作台改为会话级入口。注册 `conversation.input.dock` 的 `ppt-ultra-workspace` 行；会话预设为 `ppt-edit` 时自动打开工作台（每会话一次，内存去重），`conversation.session.header.actions` 的按钮改为手动开关，不再只能靠点击插件按钮进入。空白会话（hero 界面）也由 dock 入口覆盖。
- 独立 Profile：`~/.dsh/profiles/ppt-ultra` 已创建，bundle 清单含 `dsh-ppt-ultra`，profile 的 `cordis.patch.yml` 设置 `agent-preset-registry.default: ppt-edit`。启动命令 `dsh --profile ppt-ultra`（Web 界面；与 Desktop 共用 `~/.dsh` 数据，需隔离时另设 `DSH_HOME`）。
- 验证：headless Chrome（Playwright + 已登录 cookie）驱动独立 profile 的 Web UI，空白会话从「标准模式」切到「PPT 编辑」后 `agentPresets/select` 200、工作台自动打开、无 JS 报错；切回标准并刷新后不自动打开。独立 profile 启动后 roster 中 `ppt-edit` 为 default。
- 临时验证目录 `/tmp/ppt-ultra-profile-verify-home`（含凭证副本）与相关 cookie 已删除；验证用的独立实例已停止。
- Desktop 端要让新 Client 代码生效，需刷新页面（Cmd+R）；Host 侧无需重启。

## 路径与权限

- 仓库：`/Users/seal/Desktop/myNote/dsh-dev`
- 本项目：`/Users/seal/Desktop/myNote/dsh-dev/ppt-ultra`
- 当前聊天 cwd：`/Users/seal/Desktop/myNote/dsh-dev`（仓库根）；未修改 side-chat 业务代码。
- 会话文件权限为 danger-full-access，写权限覆盖整个仓库；交接时以实际权限为准。
- 原素材：`/Users/seal/Desktop/myNote/Qian`；测试副本：本项目 `test/fixtures/`，共 5 份 PPTX。
- 实际 DSH Profile：`/Users/seal/.dsh/profiles/desktop/package.json`。
- 已确认该文件 dependencies 含 `dsh-ppt-ultra: link:/Users/seal/Desktop/myNote/dsh-dev/ppt-ultra`，且 `dsh.profile.bundles` 已含 `dsh-ppt-ultra`。
- 最近 Git 状态为 `?? ppt-ultra/`，没有创建提交。

## 代码导航

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 插件、JSON 路由、预览图片路由、4 个 Agent 工具 |
| `client.js` | React 工作台；会话级入口（ppt-edit 自动打开 + 顶栏开关）；自然语言提交到当前 DSH 会话 |
| `lib/store.mjs` | 文稿状态、单文稿互斥、预览/应用/撤销/导出、持久化恢复、源文件冲突检查 |
| `lib/runtime.mjs` | Python 与 LibreOffice Kit 定位、子进程限制、渲染串行队列 |
| `python/pptx_engine.py` | ZIP/OOXML 精准编辑、指纹与部件校验、重开检查、渲染图片基础检查 |
| `cordis.patch.yml` | 加载 Host 并声明 `ppt-edit` 预设 |
| `profile/` | 独立 Profile 清单与默认预设覆盖示例 |
| `scripts/dev-server.mjs` | 本机参数编辑/UI 验证服务，不含真实模型调用 |
| `test/store.test.mjs` | 状态机与故障回退测试（6 项） |
| `test/engine_test.py` | 编辑与保真测试（7 项，其中一项遍历本地参考文件） |

工具名：`ppt_ultra_open`、`ppt_ultra_read`、`ppt_ultra_propose`、`ppt_ultra_clarify`。没有 Agent 应用/导出工具。

默认数据目录 `~/.dsh/ppt-ultra`；每份文稿保存 original、候选副本、渲染图片和原子替换的 state.json。历史暂不自动清理。

## 已做验证：勿扩大结论

- Node 状态测试 6 项重跑通过（2026-11-08）。
- Python 编辑/保真测试 7 项重跑通过（2026-11-08，含 5 份参考 PPTX）。此前“最后一次改动后未回收完整输出”的状态已消除。
- 对参考文稿修改一个文本对象，变更列表只有对应 slide XML；非目标部件逐字节一致。
- 本地 Chrome UI 已跑通：原版 18 页 PPT 导入 → 文字编辑/真实预览 → 应用 → 第二轮编辑/应用 → 撤销 → 下载 PPTX 和清单 → 刷新恢复 → 窄屏单页。
- 下载的 PPTX 已用 python-pptx 重开，18 页，撤销后标题是第一轮的“海底电缆安全治理的管辖边界”。
- 生成样稿的五类操作已通过真实 LibreOffice Kit 预览、应用和导出；含共享图片、原生图表和备注。
- 已检查宽屏工作台截图。窄屏初始单页行为通过；动态断点切换和参数自动预览是后续新增，还应补回归。
- 已用已安装 DSH 的真实 schema 校验器验证 4 个工具的参数与输出 schema。
- desktop Profile 已完成配置验证（预设 roster、composition、Loader 行状态、Client 入口见“当前停点”）。诊断路径：读取 Desktop 的 `dsh-auth` cookie 后直接调用 `POST /api/agentPresets/list`（body `{type:"client-request",rpcId,method:"agentPresets/list",payload:{args:{}}}`），可无 UI 验证预设 roster。
- Profile 级入口已用 headless Chrome + Playwright 验证（独立 profile 实例）：空白会话从「标准模式」切换到「PPT 编辑」后 `agentPresets/select` 返回 200、工作台 `.pu` 自动出现；切回标准并刷新后不自动打开；控制台无 JS 报错。
- 独立 Profile 已创建并验证：`--dump-config` 中 `default: ppt-edit` 且含 `dsh-ppt-ultra` bundle；以隔离 `DSH_HOME` 启动成功，登录后 roster 显示 `ppt-edit` 为 default。
- 旧临时实例与开发服务器（4178/4177）可能仍在后台运行，PID/端口需重新确认；本轮验证用的 4191 实例已停止、临时目录已删除。

**仍未验证**：真实模型完整生成操作、目标澄清实际交互、Desktop 实机中刷新后新建会话选「PPT 编辑」自动打开工作台（本机 Electron 窗口内的人工确认）、完整工作台流程（导入 → 预览 → 应用 → 导出）、PowerPoint 原生重开、SmartArt 实样。

## 下一步

1. Desktop 刷新（Cmd+R）后人工确认：新建会话选「PPT 编辑」→ 工作台自动打开；导入 `test/fixtures` 样稿验证导入/预览/应用/导出。首次自动打开后若手动关闭，顶栏按钮可重新打开。
2. 用复制的样稿在测试会话验证自然语言 → read/propose → 工作台预览 → 用户确认应用，及 clarify 候选对象流程。不要让模型用 shell 绕过受限编辑工具。
3. 实际启动独立 profile 验收：`'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' --profile ppt-ultra`，确认登录态、默认预设和 Web 入口。
4. 补最新自动预览、窄屏断点、故障提示和导出交互回归。
5. 明确记录 PowerPoint/SmartArt 未验收部分；不以 LibreOffice 渲染代替原生保真结论。整理实际验证结果再交付。
6. Git 仍为 `?? ppt-ultra/`，提交前清理 `__pycache__`、`.local`、fixtures 等排除项。

## 常用命令

```sh
cd /Users/seal/Desktop/myNote/dsh-dev/ppt-ultra
npm test
/Users/seal/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3 -B -m unittest discover -s test -p '*_test.py'
node --check client.js
node --check index.js
npm run dev
```

独立 `ppt-ultra` Profile（Web 界面，默认预设 ppt-edit）：

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' --profile ppt-ultra
```

本机官方 DSH CLI：

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' --profile desktop --dump-config
```

安装命令已经执行成功，不必无故重复：

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' plugin --profile desktop add /Users/seal/Desktop/myNote/dsh-dev/ppt-ultra
```

**不要**对现有 desktop Profile 执行 `--from-default-profile`，该选项会重置自定义配置。检查现有用户配置时避免输出凭据。

## 本机运行时与参考资料

- Python：`/Users/seal/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3`
- Node：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node`
- Renderer：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js`
- 官方 Office 技能：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/office-skills/`
- 已解出的 DSH 插件接口参考：`/tmp/ppt-ultra-dsh-reference/`。从本机 app.asar 读取，非完整源码仓库。
- `/Users/seal/Documents/deepseek-harness` 实际只有默认工作区，不能当成源码仓库。
- 架构来源：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- Office 来源：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-office/README.md>

DSH `tools.register` 接受原始 JSON Schema；`defineTool` 接受另一种属性映射式定义。之前误用 defineTool 做校验曾报错，已确认是校验方式问题，不要因此错误修改现有工具 schema。

## 临时服务与测试产物

旧临时服务未停止；本轮验证用的 4191 实例已停止、临时目录已删除：

| 端口 | 进程（写文档时） | 内容 |
| --- | --- | --- |
| `127.0.0.1:4177` | node，PID 4065 | 临时开发服务器，入口 `/tmp/ppt-ultra-build/scripts/dev-server.mjs` |
| `127.0.0.1:4178` | DeepSeek，PID 6454 | 独立 DSH 测试 Profile；DSH_HOME 为 `/tmp/ppt-ultra-dsh-home` |

PID 可能变化，操作前用 `lsof` 重新确认。4177 进程较早启动，可能仍持有旧 Host 模块；不能据其行为推断最新版状态。独立 DSH 的访问令牌不写入交接文档，需从自身启动信息获取。

其他临时路径：

- `/tmp/ppt-ultra-build`：开发中转目录。交接前核对主要源码/测试与项目内文件一致；以后以项目内文件为准。
- `/tmp/ppt-ultra-ui-flow.cjs`：浏览器端到端测试脚本，含本机路径和固定样稿，未纳入项目自动测试。
- `/tmp/ui-preset-flow.cjs`、`/tmp/ui-autopen-check.cjs`：本轮 Profile 级入口验证脚本，用 Playwright（`/Users/seal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`）+ 登录 cookie 驱动孤立 profile 实例；`/tmp/ppt-ultra-autopen.png`、`/tmp/ppt-ultra-preset-flow.png` 为对应截图。
- `/tmp/ppt-ultra-object-flow.mjs`：五操作真实渲染测试脚本；配套 `/tmp/ppt-ultra-objects.pptx` 和 `/tmp/ppt-ultra-blue.png`。
- `/tmp/ppt-ultra-schema-check.cjs`：已安装 DSH schema 校验脚本。
- `/tmp/ppt-ultra-workbench.png`、`/tmp/ppt-ultra-empty.png`、`/tmp/ppt-ultra-narrow.png`：此前本地 UI 截图，不代表当前实机状态。
- `/tmp/ppt-ultra-dev-data`、`/tmp/ppt-ultra-object-flow-data`、`/tmp/ppt-ultra-integration-data`：不同测试使用的数据目录。

这些文件可随系统清理消失。需要长期保留的回归脚本应整理进项目，不能把绝对临时路径当正式依赖。现有 `scripts/dev-server.mjs` 对已安装 DSH 前端构建有特定适配，升级后可能需要调整。
