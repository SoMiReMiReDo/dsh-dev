# PPT Ultra 项目记忆

更新：2026-11-09（Asia/Shanghai）。状态：入口/退出与右侧面板均已按用户确认改版。工作台为 DSH 左侧栏入口 + 主区域页面；右侧只有「文件选择 / 对话」两个 tab，支持仓库浏览、按路径打开 PPTX、对话式修改与新建对话；`ppt-edit` 预设与独立 Profile 已移除。真实 Host 上的入口、文件选择、打开 18 页样稿、新建对话与退出恢复已用 headless Chrome 验证。PowerPoint 原生保真与真实模型完整端到端仍未验收。

## 用户确认的范围与决策

- 按 `DESIGN.md` 和 `profile-mockup.svg` 直接实现首版，不止做界面原型。有影响范围或方案的问题，先向用户确认。
- 参考素材从 `/Users/seal/Desktop/myNote/Qian` 复制 PPTX。5 份副本已放在本项目 `test/fixtures/`，不得修改 Qian 原文件。
- 用户已接受精准修改 PPTX 内部 XML：官方 `python-pptx` 负责读取、重开核验，官方 LibreOffice Kit 负责渲染。原因是对参考样稿进行无内容修改的 python-pptx 重存，也会改写 109–129 个包内部件；这不是损坏结论，但不适合严格的未涉及部件字节保持要求。
- 保留原字体设置。缺失字体显示提醒，允许用户看预览并确认后应用、导出；不自动替换文件中的字体名或安装字体。
- 用户明确选择使用现有已登录 DSH 安装验证。已安装到 `desktop` Profile；授权无需重复询问。
- 用户偏好中文、取舍细节并总结；追问后再展开。
- 交付形态（2026-11-09 用户重新确认）：放弃「预设/Profile 级入口」与全屏覆盖层。工作台改为 DSH 左侧栏常驻「PPT 工作台」页面（`sidebar.panellist` + `main` keyed 面板），点一次进入；Agent 打开文稿或用户打开/拖入 PPTX 时自动进入；右上角「导出 PPTX」+ 分隔线 +「← 退出 PPT」返回对话。预设 `ppt-edit` 与独立 `ppt-ultra` Profile 都移除，回归普通会话。
- 项目文档应放在 `ppt-ultra`。当前会话 cwd 为仓库根 `/Users/seal/Desktop/myNote/dsh-dev`，写权限覆盖整个仓库；不要把项目产物写入相邻的 side-chat。

## 产品与实现约定

- 首版支持 text、image、align、distribute、resize 五类操作。
- 工作台是根级页面入口：左侧栏「PPT 工作台」一行 + `main` keyed 面板；不再由 Agent 预设或会话顶栏按钮触发。退出通过右上角「退出 PPT」调用 `layout.selectPanel(null)` 返回对话。
- 工作台包含页面导航、同倍率上下前后对照、画布对象点选、右侧「文件选择 / 对话」两个 tab；窄屏默认单页切换，右侧面板作为页面内抽屉。
- 右侧「文件选择」：DSH 工作区仓库下拉 + 面包屑目录浏览，只列目录与 .pptx；打开时可选「打开时新建对话」。
- 右侧「对话」：绑定一个 DSH Session，轮询 Host `conversation` 路由显示消息/流式回复/运行态；「新建对话」用 `sessions.create` 新建 Session 并切换；切换时用文稿 `sourcePath` 在新会话重开。Agent 的 propose 结果以「待应用修改」卡片展示，由用户勾选后应用/取消，已应用可撤销。
- Host 新增受认证 POST 路由：`workspaces`、`browse`、`openPath`、`conversation`；browse/openPath 只接受已注册工作区内的真实路径，openPath ≤50MiB。
- Agent 仅打开、读取、提出操作或要求澄清。应用与导出由用户在工作台触发。
- 采用稳定页面 ID + 对象 ID、文稿 SHA-256、对象 fingerprint 拒绝过时提交。
- 每轮写临时副本，检查非目标部件与对象、重开并渲染后才发布草稿。原稿与历史快照保留；撤销回到上一轮草稿。
- 普通且有明确位置的未旋转文本/形状和图片可编辑。组合、继承布局、图表、SmartArt 等复杂对象目前只读保留。
- 混排文本尽量沿用原有 run 格式；图片替换创建独立素材关系，防止修改共享图片的其他实例。替换保留原裁切设置。
- 程序检查结构、对象边界和渲染缺页/空白。文字溢出、遮挡、裁切仍由用户对照预览确认；不能声称渲染成功就等于视觉合格。

## 状态与结论边界

首版代码与本地流程已实现，尚未完成最终保真验收。

desktop Profile 已配置完成：bundle 已安装并启用，`ppt-ultra` Loader 行 active，4 个 Agent 工具当前可见；Client 入口是 `sidebar.panellist` 的「PPT 工作台」与 `main` keyed 面板，`conversation.session.header.actions` 的临时按钮已删除。

2026-11-09 已按用户决定移除 `ppt-edit` 预设（连同独立 `ppt-ultra` Profile）。`cordis.patch.yml` 只保留 `ppt-ultra` Host 行；desktop Profile 重载后 `agentPresets/list` 只剩 standard/ptc/minimal/cordis。此前预设 `broken` 问题的修复记录只作为历史；不要再把预设加回入口链路。

当前测试：Node 测试 10 项（2026-11-09：状态 6 + 预览路由 1 + Client 入口 1 + 新 Host 路由 1 + browse 越界 1）、Python 编辑/保真测试 7 项（2026-11-08 重跑）全部通过。

2026-11-08 晚修复预览裂图：`/api/ppt-ultra.asset` 是精确 GET 路由，未声明 `requestBody: 'buffered'` 时 DSH connection bridge 按 streaming 处理，`new Request(GET, {body})` 抛错后被 web 服务器统一回 400，所有 `<img>` 预览裂图。已修复并新增 `test/host-routes.test.mjs` 防回归；在真实 Host 上验证 18/18 资源请求 200。工作台 UI 同轮改版：加载态居中显示、预览图加载/失败占位与重试、对象可读名称、滚动条与整体视觉（2026-11-09 起改为页面级布局，顶栏不再模拟 macOS 红绿灯）。

右侧面板（文件选择 / 对话）已实现并实测：Host 新增 `workspaces`、`browse`、`openPath`、`conversation` 4 个受认证 POST 路由；Client 右侧只保留两个 tab，对话绑定 DSH Session、可新建对话，Agent 提案以「待应用修改」卡片展示（应用/取消/撤销）。headless Chrome（桌面端真实 Host）验证：10 个工作区可选、目录浏览到 `ppt-ultra/test/fixtures`、打开 18 页样稿（18 缩略图 + 主画布预览）、新建对话、退出再进入恢复文稿与会话、无 JS 报错。

页面级入口已实现并实测：`client.js` 注册 `sidebar.panellist`（label「PPT 工作台」）+ `main` keyed 面板 + `shell.overlay` 文稿监听器。headless Chrome（桌面端真实 Host、已登录 cookie）验证：侧栏入口出现并选中、页面铺满主面板（1440 窗口侧栏展开时 1160×900）、退出回对话、再次进入恢复文稿、`/api/ppt-ultra.open` 后 3 秒内自动切换、侧栏收起后页面全宽、顶栏避开 macOS 48px 顶部条、无 JS 报错。

独立 Profile 已按用户决定移除：仓库内 `profile/` 目录、`~/.dsh/profiles/ppt-ultra` 和 `cordis.patch.yml` 的预设声明均删除；只用现有 desktop Profile。

5 份用户参考文稿均已做精准编辑结构测试；原版含 13 个带 timing 的幻灯片 XML，参考文稿不含原生图表和 SmartArt。另用生成样稿测试原生图表、备注及共享图片保留。

本机没有 Microsoft PowerPoint，未完成 PowerPoint 原生重开验收；未有 SmartArt 实样保真结论。OfficeCLI 未评估为正式后端，采用用户已确认的 XML 路线。

源码尚未提交 Git。测试素材已被本项目 `.gitignore` 排除，不在插件打包 files 中。后续不得把参考 PPTX、个人草稿、访问令牌或用户配置误提交。
