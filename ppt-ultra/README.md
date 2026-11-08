# PPT Ultra

DSH Desktop / Web 的 PPTX 微调工作台。保留原稿和字体，修改目标对象后先渲染预览，再由用户应用整批修改。

## 使用

安装到已有 Desktop Profile：

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-dev/ppt-ultra
```

刷新客户端；若 Host 未热加载，重启 DSH。新建会话时选择「PPT 编辑」（`ppt-edit`）预设后，工作台会自动作为该会话界面打开；其他会话仍可从顶栏「打开 PPT Ultra」手动进入。选择 PPTX，或让 Agent 用 `ppt_ultra_open` 打开会话附件路径。自然语言指令会进入当前 DSH 会话，由工具生成待应用清单。目标不明确时显示候选对象。

选择对象后可添加文字、PNG/JPEG 换图、对齐、等距、尺寸操作。参数修改会自动更新预览，也可手动重试。检查上下对照与字体提醒，勾选确认后应用。应用成功才能导出 PPTX 和 JSON 变更清单。「变更记录」支持撤销最近一轮。

新建独立 Profile 时，先用 `dsh --profile ppt-ultra --from-default-profile web --dump-config` 初始化，再执行 `dsh plugin --profile ppt-ultra add <本目录>`。将 `profile/cordis.patch.yml` 的覆盖项加入该 Profile 的 `cordis.patch.yml`，`ppt-edit` 就会成为新会话默认预设；启动命令为 `dsh --profile ppt-ultra`（默认启动 Web 界面）。不要对已有自定义 Profile 使用 `--from-default-profile`，它会重置配置。独立 Profile 与 Desktop 共用 `~/.dsh` 数据；需要隔离会话数据时另设 `DSH_HOME`。

## 实现与限制

- Client 通过 DSH 会话入口挂载全屏工作台；Host 使用受认证的 `connection.fetch` 和 Agent 工具。
- `ppt-edit` 会话自动打开工作台（会话创建或选中该预设时，仅每个会话自动打开一次）；`conversation.input.dock` 承载会话级入口，`conversation.session.header.actions` 的「打开 PPT Ultra」按钮保留为手动开关。其他预设的会话不自动打开。
- 精准修改 OOXML；未修改的 ZIP 部件保留原始字节，目标页内的非目标对象和动画结构做规范化对比。混排文本按原有 run 分配新内容，保留各 run 的字体设置。
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

`npm run dev` 仅绑定 `127.0.0.1:4177`，复用本机 macOS DSH 客户端运行时，仅用于界面与参数编辑验证；自然语言完整验证须在 DSH 中进行。开发服务对当前安装版本的前端构建有适配，DSH 更新后可能需要调整。

已验证：5 份本地参考文稿、混排格式保留、共享图片独立替换、对齐/等距/尺寸、两轮应用后撤销、导出一致性、外部冲突、渲染失败回退、重启恢复及宽窄屏浏览器交互。参考原稿有动画，非目标动画结构保持不变；另用生成样稿检查原生图表与备注保留。

2026-11-08 补充：Node 状态测试 6 项、Python 编辑/保真测试 7 项重跑通过；desktop Profile 的 `ppt-edit` 预设修复后 `agentPresets/list` 与 `agentPresets/read` 正常；用 headless Chrome 驱动独立 `ppt-ultra` Profile 的 Web 界面，确认空白会话从「标准模式」切到「PPT 编辑」后工作台自动打开、切回标准不打开且无 JS 报错。

PowerPoint 原生重开和 SmartArt 实样保真仍需人工验收。本机未安装 PowerPoint，参考文件不含 SmartArt。OfficeCLI 未作为写入后端；按已确认的方案使用精准 XML 编辑。

参考文件副本位于 `test/fixtures`，默认不纳入 Git 或插件包。用户原文件不会被改写。
