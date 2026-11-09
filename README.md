# DeepSeek Harness 插件集

个人对 DeepSeek Harness（DSH）的开发微调仓库。四个插件分别提供右侧栏浏览器、小红书数据采集、侧聊和 PPTX 精准编辑工作台，均自带 `cordis.patch.yml`，可以装进同一个 profile 组合使用；另有一个「面经调研 → 面试准备页」Skill（`interview-research`），一条命令即可连同所需插件安装到其他 DSH。

分支：`dev/ppt-ultra`（插件主开发）、`dev/interview-research`（面试调研 Skill）。

## 插件

| 插件 | 包名 / 版本 | 功能 | 文档 |
| --- | --- | --- | --- |
| PPT Ultra | `dsh-ppt-ultra` 0.1.0 | PPTX 微调工作台：左侧栏进入，右侧「文件选择」从 DSH 工作区选 PPTX，「对话」驱动 Agent 生成修改，预览确认后应用、撤销和导出；保留原稿和字体 | [README](ppt-ultra/README.md) |
| 内置浏览器 | `dsh-inner-chrome` 0.2.0 | 右侧栏浏览器标签页，Agent 可打开页面、读取正文、点击元素和截图 | [README](inner-chrome/README.md) |
| 小红书采集 | `dsh-xhs-check` 0.2.0 | 使用已登录的浏览器采集笔记、评论、搜索结果、主页、通知和私信会话，保存为本地 JSON | [README](xhs-check/README.md) |
| 侧聊 | `dsh-side-chat` 0.2.0 | 右侧栏只读旁路会话，每次请求实时注入主会话上下文，关闭即销毁、不落盘 | [交接文档](side-chat/HANDOFF.md) |

侧聊的桌面端真机交互仍在验收，状态见 [PROGRESS.md](side-chat/PROGRESS.md)。

## 面试调研 Skill

`interview-research/` 是一个 DSH Skill：调研某公司/岗位的面经（小红书采集 + 网络检索），整理成结构化内容，生成单文件离线 HTML 面试准备手册 + Markdown 摘要。自带 Python 脚本（仅标准库）、通用 HTML 模板与端到端测试。

一条命令安装 skill + 依赖插件（`dsh-inner-chrome`、`dsh-xhs-check`）：

```sh
curl -fsSL https://raw.githubusercontent.com/SoMiReMiReDo/dsh-dev/dev/interview-research/install.sh | bash
```

本地仓库内：`bash install.sh`（`--check` 只检查、`--dry-run` 只打印、`--uninstall` 卸载 skill）。装完重启 DSH，新开会话即可用；详见 [README](interview-research/README.md) 与 [SKILL.md](interview-research/SKILL.md)。

## PPT Ultra 已知问题（UI / Session）

> PPT Ultra 刚完成工作台入口和右侧面板改版，UI 与 session 逻辑仍在迭代。以下问题尚未修复，当前状态不代表最终交付质量；工作记录见 [MEMORY.md](ppt-ultra/MEMORY.md) 与 [HANDOFF.md](ppt-ultra/HANDOFF.md)。

### UI

- 右侧面板只有「文件选择 / 对话」两个 tab，但「对话 → Agent 提案 → 待应用修改卡片 → 应用 → 导出」整条链路还没有用真实模型跑通；卡片、流式回复、错误/空态都是初步实现。
- 手动参数编辑面板已移除，现阶段只能通过对话修改；画布对象选择只作为对话上下文，不能直接改文字、对齐或尺寸。
- 对话记录是纯文本：不渲染 Markdown，不展示工具调用和中间步骤；超长用户消息做了截断显示，和真实 Session 记录不完全一致。
- 窄屏抽屉、大目录文件浏览、仓库切换、无文稿/无会话空态、导出禁用提示等缺少回归测试。
- 文案与部分控件是中文硬编码，未接入 DSH locale；视觉只做了部分 DSH 原生风格对齐。
- 文件选择只支持逐层浏览 DSH 已注册工作区，没有搜索、最近文件、多选或把仓库文件拖进右侧面板；本地文件上传与仓库文件是两套入口。

### Session 逻辑

- 工作台对话绑定一个 DSH Session，「最近用的对话」存在浏览器 localStorage；跨窗口/跨设备不一致，重新打开工作台可能沿用旧对话而不是当前主会话。
- 「新建对话」由 Client 直接调 `sessions.create`，没有走 `uiWorkspace.startSession` 的空白会话复用与导航流程：会在侧栏留下真实会话，不自动命名，也不会切换 DSH 主视图。
- 文稿记录按 `sessionId` 归属。切换对话时用 `sourcePath` 重新打开当前文稿，会产生新的文稿 ID 和新的状态记录；旧对话里的历史轮次与撤销记录没有入口找回。
- 没有对话列表或会话切换 UI，只能新建对话；关闭工作台后靠 localStorage 记住当前对话，换浏览器窗口会丢失。
- Host `conversation` 路由依赖 Session 处于激活状态；会话未激活时只返回 `available: false`，UI 仅提示「对话记录暂不可用」，没有自动恢复逻辑。
- 对话 Session 的 retain/release 由页面生命周期控制；退出工作台、刷新页面、Host 重启后的对话可读性尚未系统验证。
- `ppt_ultra_open` 自动切页的 watcher 只轮询当前主会话、单窗口生效；多窗口/多会话并发行为未定义。
- 对话 Session 与文稿所在仓库没有强绑定：可以在 A 仓库的会话里打开 B 仓库的文件，Agent 的 cwd 与文稿目录可能不一致。
- 从本地上传的文稿没有 `sourcePath`，切换或新建对话时不会跟随重开；只有从仓库打开的文件会。


## 安装

环境要求：Node >= 22.19.0，DSH >= 0.2.1-rc.5 < 0.3.0（各插件 `engines.dsh` 已声明）。

```sh
git clone --branch dev/ppt-ultra https://github.com/SoMiReMiReDo/dsh-dev.git
```

只装面经调研所需的 skill + 两个插件（`inner-chrome`、`xhs-check`），用仓库根目录的 `install.sh` 一条命令完成，见上文「面试调研 Skill」。

装全部插件时，在 DSH Desktop 中调用 `plugin_manager install_bundle`，`target` 传仓库内插件目录的绝对路径。四个插件装进同一个 profile，按以下顺序安装：

1. `inner-chrome/` —— 先装。小红书采集通过 `ctx.innerChrome` 复用它的浏览器。
2. `xhs-check/`
3. `side-chat/`
4. `ppt-ultra/` —— 依赖 DSH Python（`lxml`、`python-pptx`、Pillow）与 LibreOffice Kit，缺失时会报错提示。

安装后刷新客户端；`index.js`、`cordis.patch.yml` 的改动需要重启 DSH。各插件入口：

| 插件 | 入口 |
| --- | --- |
| PPT Ultra | 左侧栏「PPT 工作台」；右侧「文件选择」选仓库和 .pptx，「对话」里描述修改（可新建对话，不同会话上下文独立） |
| 内置浏览器 | 右侧栏「内置浏览器」，或让 Agent 调用 `inner_chrome_*` 工具 |
| 小红书采集 | 「设置 → 小红书采集」，或让 Agent 调用 `xhs_*` 工具 |
| 侧聊 | 会话头部的分支图标 |

## 开发

单测在各插件目录运行 `npm test`（即 `node --test test/*.test.mjs`）。从仓库根目录一次跑全部：

```sh
node --test inner-chrome/test/*.test.mjs xhs-check/test/*.test.mjs side-chat/test/*.test.mjs ppt-ultra/test/*.test.mjs
```

PPT Ultra 另有 Python 引擎测试和仅绑定本机的界面预览服务：

```sh
cd ppt-ultra
python3 -m unittest discover -s test -p '*_test.py'   # 需要 python-pptx / lxml / Pillow
npm run dev                                            # 127.0.0.1:4177，仅用于界面与文稿渲染验证（不含真实模型对话）
```

面试调研 skill 用 Python 自测（离线、仅标准库）：

```sh
python3 -m unittest discover -s interview-research/test -v
```

改动生效方式：`client.js` 刷新页面；`index.js`、`cordis.patch.yml`、`package.json` 重启 DSH（profile 以 `link:` 安装，Node 按路径缓存 ESM）。

## 数据与隐私

| 插件 | 本地数据 |
| --- | --- |
| 小红书采集 | `xhs-check/data/`（Git 忽略）与 `settings.json`；图片、视频只存链接 |
| 内置浏览器 | 截图保存在 `~/.dsh/inner-chrome/screenshots/` |
| PPT Ultra | 原稿、历史和预览保存在 `~/.dsh/ppt-ultra/`；`ppt-ultra/test/fixtures/*.pptx` 默认不入库 |
| 侧聊 | 内存态，关闭标签页即销毁 |
| 面试调研 skill | 采集数据与生成物在用户自选项目目录（`data/`、`content.json`、`report.html`），不随 skill 分发 |

自定义数据目录时放到仓库外，或补充对应的 Git 忽略规则。采集内容仅限你有权访问和保存的范围；原始响应可能包含账号资料、通知或会话信息。

## 分支

| 分支 | 内容 |
| --- | --- |
| `main` | 早期 side-chat 单插件线 |
| `dev/xhs-innerChrome` | 侧聊 + 内置浏览器 + 小红书采集 |
| `dev/ppt-ultra` | 在上一分支基础上新增 PPT Ultra |
| `dev/interview-research` | 在 `dev/ppt-ultra` 基础上新增面经调研 Skill 与 `install.sh` 一键安装 |
