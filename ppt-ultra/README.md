# PPT Ultra

DSH Desktop / Web 的 PPTX 微调工作台。保留原稿和字体，修改目标对象后先渲染预览，再由用户应用整批修改。

## 使用

安装到已有 Desktop Profile：

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-dev/ppt-ultra
```

刷新客户端（Cmd+R）；若 Host 未热加载，重启 DSH。左侧栏出现「PPT 工作台」入口，点一次即进入工作台页面；不需要选择 Agent 预设，也不需要先新建会话。

进入方式：

- 左侧栏点「PPT 工作台」→ 右侧「文件选择」里选 DSH 仓库、浏览目录、打开 .pptx（只显示目录和 .pptx）。
- 也可以从本地选择/拖入 .pptx，或让 Agent 用 `ppt_ultra_open` 打开文稿；界面会自动切到工作台。
- 打开时勾选「打开时新建对话」会先新建一个 DSH 会话，再在该会话里打开文稿。
- 右上角「退出 PPT」返回对话；文稿、预览和未应用修改都会保留。

右侧面板只有两个 tab：

- **文件选择**：选择仓库和文件，显示当前目录、目录和 .pptx 列表；打开文稿后可切到「对话」。
- **对话**：直接和绑定到当前 DSH 会话的 Agent 对话来修改 PPT。每个对话有自己的上下文；点「新建对话」会创建一个新的 DSH 会话并切换到它（已打开的文稿会在新对话里重新打开）。Agent 的修改会先渲染成「待应用修改」卡片，勾选核对后点「应用修改」，也可取消或撤销最近一轮。

右上角「导出 PPTX」在有可导出的草稿时为主按钮，否则灰显并给出原因。画布上仍可点选对象，当前选中对象会带进对话指令。

## 实现与限制

- Client 把工作台注册为 DSH 根级 `main` keyed 面板（`sidebar.panellist` 的「PPT 工作台」行是入口），不再使用会话级全屏覆盖层或 Agent 预设触发；Host 使用受认证的 `connection.fetch` 和 Agent 工具。
- 页面宽度按 DSH 主面板计算，布局使用容器查询（`@container`）自适应，不依赖视口宽度。macOS 上页面通过 `--dsh-frame-top-clearance` 让出窗口顶部条。
- 工作台关闭（`shell.overlay` 中的轻量监听器）时每 3 秒轮询一次当前会话文稿列表；Agent 用 `ppt_ultra_open` 产生新文稿后自动切到工作台。首次轮询只建基线，不会把已有文稿当成新文稿反复弹出。
- Host 新增 4 个受认证 POST 路由：`workspaces`（已注册工作区）、`browse`（工作区目录浏览，只返回目录和 .pptx）、`openPath`（从工作区路径直接读取 .pptx 打开）、`conversation`（读取绑定会话的人类消息、流式回复与运行态）。`openPath`/`browse` 只接受已注册工作区内的真实路径。
- 对话绑定 DSH Session 并保留引用；「新建对话」用 `sessions.create` 创建会话、`sessions.retain` 打开后切换，最近选择记在 localStorage。切换对话时若已有文稿，用 `sourcePath` 在新会话里重新打开。
- 已移除 `ppt-edit` 预设与独立 `ppt-ultra` Profile：插件在任意 profile 安装后即可用，不再改变 Agent 预设菜单或新会话默认值。
- 精准修改 OOXML；未修改的 ZIP 部件保留原始字节，目标页内的非目标对象和动画结构做规范化对比。混排文本按原有 run 分配新内容，保留各 run 的字体设置。
- 预览图通过受认证的精确 GET 路由 `/api/ppt-ultra.asset` 提供。该路由必须声明 `requestBody: 'buffered'`：缺省会被 connection bridge 当作 streaming，给 GET 请求附加 body 后抛错，web 服务器统一回 400，页面所有预览变成裂图。`test/host-routes.test.mjs` 固定此约束。
- 整轮操作携带文稿摘要、稳定页面/对象 ID 和对象 fingerprint。临时副本校验、重开、渲染完成后，通过原子替换状态文件发布草稿。外部修改会拒绝提交，失败不替换上一份草稿。
- 默认使用 DSH Python（`lxml`、`python-pptx`、Pillow）与官方 LibreOffice Kit。可用插件配置 `python`、`node`、`renderCli`、`dataDir` 或环境变量 `PPT_ULTRA_PYTHON`、`PPT_ULTRA_NODE`、`PPT_ULTRA_RENDER_CLI` 指定路径。
- 缺字体仅提醒，保留原字体名。文字溢出、遮挡与裁切仍需用户看预览确认；程序检查文件结构、对象边界、渲染缺页/空白，不把渲染成功标为视觉合格。
- 首版编辑独立、未旋转且有明确位置的普通文本/形状和图片；组合、继承布局、图表、SmartArt 等复杂对象保留为只读。图片替换保留原裁切；PNG/JPEG 最大 20 MiB，PPTX 最大 50 MiB。
- 原稿、历史和预览存于 `~/.dsh/ppt-ultra`，重启可恢复。历史暂不自动清理。自然语言编辑需要已登录的 DSH 模型。

## 验证

```sh
npm test
# 使用带 python-pptx、lxml、Pillow 的 Python
/path/to/dsh/python3 -B -m unittest discover -s test -p '*_test.py'
npm run dev
```

`npm run dev` 仅绑定 `127.0.0.1:4177`，复用本机 macOS DSH 客户端运行时，仅用于界面与文稿渲染验证（dev-server 不提供真实对话模型）；完整对话验证须在 DSH 中进行。开发服务对当前安装版本的前端构建有适配，DSH 更新后可能需要调整。

已验证：5 份本地参考文稿、混排格式保留、共享图片独立替换、对齐/等距/尺寸、两轮应用后撤销、导出一致性、外部冲突、渲染失败回退、重启恢复及宽窄屏浏览器交互。参考原稿有动画，非目标动画结构保持不变；另用生成样稿检查原生图表与备注保留。

2026-11-09 右栏改版：右侧「编辑/变更记录/检查」替换为「文件选择 / 对话」两个 tab；新增工作区仓库浏览、按路径打开 PPTX、对话记录与流式回复、待应用修改卡片（应用/取消/撤销）以及「新建对话」（新 DSH 会话）。用桌面端真实 Host + headless Chrome 验证：仓库列表与目录浏览、打开 18 页样稿（18 张缩略图、主画布预览加载）、对话 tab 新建对话、文件 tab「打开时新建对话」复选框可切换、退出再进入恢复文稿与会话；无 JS 报错；Node 测试 10 项、Python 7 项全绿。
2026-11-09 入口/退出改版：工作台从会话级全屏覆盖层改为 DSH 根级页面，左侧栏「PPT 工作台」一键进入，「退出 PPT」返回对话；导出改为「导出 PPTX」主/灰态 + 分隔线 + 「退出 PPT」。已移除 `ppt-edit` 预设与独立 `ppt-ultra` Profile（`agentPresets/list` 只剩标准/PTC/极简/创造）。用桌面端真实 Host + 已登录 cookie 的 headless Chrome 验证：侧栏入口出现并选中、页面铺满主面板（1440 宽侧栏展开时 1160×900）、退出后回到对话、再次进入恢复上一份文稿、`ppt_ultra_open` 后 3 秒内自动切换、侧栏收起后页面全宽且顶栏避开 macOS 48px 顶部条、无 JS 报错。
2026-11-08 晚补充：修复预览裂图的根因（GET 资源路由缺少 `requestBody: 'buffered'`，bridge 对 GET 附加 body 抛错后统一 400）。Node 测试为 10 项（4 个新 Host 路由 + browse 越界校验 + 原有路由/状态测试）。
2026-11-08 补充：Node 状态测试 6 项、Python 编辑/保真测试 7 项重跑通过；5 份参考文稿编辑与保真测试通过。

PowerPoint 原生重开和 SmartArt 实样保真仍需人工验收。本机未安装 PowerPoint，参考文件不含 SmartArt。OfficeCLI 未作为写入后端；按已确认的方案使用精准 XML 编辑。

参考文件副本位于 `test/fixtures`，默认不纳入 Git 或插件包。用户原文件不会被改写。
