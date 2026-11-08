# PPT Ultra 项目记忆

更新：2026-11-08（Asia/Shanghai，下午）。状态：desktop Profile 的 `ppt-edit` 预设故障已修复；Profile 级入口（选中预设自动打开工作台）已实现；独立 `ppt-ultra` Profile 已创建；测试全绿。PowerPoint 原生保真与真实模型端到端仍未验收。

## 用户确认的范围与决策

- 按 `DESIGN.md` 和 `profile-mockup.svg` 直接实现首版，不止做界面原型。有影响范围或方案的问题，先向用户确认。
- 参考素材从 `/Users/seal/Desktop/myNote/Qian` 复制 PPTX。5 份副本已放在本项目 `test/fixtures/`，不得修改 Qian 原文件。
- 用户已接受精准修改 PPTX 内部 XML：官方 `python-pptx` 负责读取、重开核验，官方 LibreOffice Kit 负责渲染。原因是对参考样稿进行无内容修改的 python-pptx 重存，也会改写 109–129 个包内部件；这不是损坏结论，但不适合严格的未涉及部件字节保持要求。
- 保留原字体设置。缺失字体显示提醒，允许用户看预览并确认后应用、导出；不自动替换文件中的字体名或安装字体。
- 用户明确选择使用现有已登录 DSH 安装验证。已安装到 `desktop` Profile；授权无需重复询问。
- 用户偏好中文、取舍细节并总结；追问后再展开。
- 交付形态：用户要求是 Profile 级体验——在新会话/新工作区里选择模式，而不是从顶栏插件按钮点击进入。已确认方案：(1) desktop Profile 内选中「PPT 编辑」预设后工作台自动作为会话界面打开，顶栏按钮仅作手动开关；(2) 同时交付独立 `ppt-ultra` Profile（默认预设 `ppt-edit`）。新建工作区只需在其中的新会话选择预设，不改造工作区创建 UI。
- 项目文档应放在 `ppt-ultra`。当前会话 cwd 为仓库根 `/Users/seal/Desktop/myNote/dsh-dev`，写权限覆盖整个仓库；不要把项目产物写入相邻的 side-chat。

## 产品与实现约定

- 首版支持 text、image、align、distribute、resize 五类操作。
- 工作台是 Profile/Preset 级入口：新建会话选择「PPT 编辑」后自动打开工作台（每会话一次），顶栏按钮仅作手动开关；独立 `ppt-ultra` Profile 默认预设即 `ppt-edit`。
- 工作台包含页面导航、同倍率上下前后对照、对象多选、可编辑操作清单、变更记录和检查页签；窄屏默认单页切换。
- Agent 仅打开、读取、提出操作或要求澄清。应用与导出由用户在工作台触发。
- 采用稳定页面 ID + 对象 ID、文稿 SHA-256、对象 fingerprint 拒绝过时提交。
- 每轮写临时副本，检查非目标部件与对象、重开并渲染后才发布草稿。原稿与历史快照保留；撤销回到上一轮草稿。
- 普通且有明确位置的未旋转文本/形状和图片可编辑。组合、继承布局、图表、SmartArt 等复杂对象目前只读保留。
- 混排文本尽量沿用原有 run 格式；图片替换创建独立素材关系，防止修改共享图片的其他实例。替换保留原裁切设置。
- 程序检查结构、对象边界和渲染缺页/空白。文字溢出、遮挡、裁切仍由用户对照预览确认；不能声称渲染成功就等于视觉合格。

## 状态与结论边界

首版代码与本地流程已实现，尚未完成最终保真验收。

desktop Profile 已配置完成：bundle 已安装并启用，`ppt-ultra`、`preset-ppt-edit` 两个 Loader 行为 active，4 个 Agent 工具当前可见，工作台顶栏入口已在活动 Client 中注册（`conversation.session.header.actions` 的 `ppt-ultra`）。

新会话预设菜单缺少 `ppt-edit` 的原因已确认并修复：预设把 `@deepseek-ai/dsh-compaction-basic` 直接作为 preset plugin 挂载，注册表审计报 `Preset services require isolate realms: compaction`，定义进入 broken 状态；Web 端 `presetOptions()` 只展示 `broken === undefined` 的预设，因此菜单只剩 4 项。修复方式是在 `cordis.patch.yml` 中用 `cordis:group` + `isolate.compaction: true` 包住 `compaction-basic`，与官方 `minimal` 预设一致；通过 `plugin_manager set_bundle` 关闭再启用即时重载后，`agentPresets.list` 不再返回 broken，`agentPresets.read ppt-edit` 返回完整 composition。

当前测试：Node 状态测试 6 项、Python 编辑/保真测试 7 项（2026-11-08 重跑）全部通过。

Profile 级入口已实现：`client.js` 把工作台注册为会话级 `conversation.input.dock` 入口，并在会话预设为 `ppt-edit` 时自动打开（每个会话一次）；`conversation.session.header.actions` 的按钮改为手动开关。headless Chrome 已验证独立 Profile 的空白会话从「标准模式」切到「PPT 编辑」后工作台自动打开、无 JS 报错。

独立 Profile 已创建于 `~/.dsh/profiles/ppt-ultra`：bundle 清单含 `dsh-ppt-ultra`，`cordis.patch.yml` 把 `agent-preset-registry.default` 设为 `ppt-edit`；启动命令 `dsh --profile ppt-ultra`（Web 界面）。

5 份用户参考文稿均已做精准编辑结构测试；原版含 13 个带 timing 的幻灯片 XML，参考文稿不含原生图表和 SmartArt。另用生成样稿测试原生图表、备注及共享图片保留。

本机没有 Microsoft PowerPoint，未完成 PowerPoint 原生重开验收；未有 SmartArt 实样保真结论。OfficeCLI 未评估为正式后端，采用用户已确认的 XML 路线。

源码尚未提交 Git。测试素材已被本项目 `.gitignore` 排除，不在插件打包 files 中。后续不得把参考 PPTX、个人草稿、访问令牌或用户配置误提交。
