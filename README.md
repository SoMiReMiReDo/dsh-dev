# DeepSeek Harness 插件集

个人对 DeepSeek Harness（DSH）的开发微调仓库。四个插件分别提供右侧栏浏览器、小红书数据采集、侧聊和 PPTX 精准编辑工作台，均自带 `cordis.patch.yml`，可以装进同一个 profile 组合使用。

当前分支 `dev/ppt-ultra`。

## 插件

| 插件 | 包名 / 版本 | 功能 | 文档 |
| --- | --- | --- | --- |
| PPT Ultra | `dsh-ppt-ultra` 0.1.0 | PPTX 微调工作台：选中对象后手动或自然语言编辑，先渲染预览再整批应用，支持撤销与导出；保留原稿和字体 | [README](ppt-ultra/README.md) |
| 内置浏览器 | `dsh-inner-chrome` 0.2.0 | 右侧栏浏览器标签页，Agent 可打开页面、读取正文、点击元素和截图 | [README](inner-chrome/README.md) |
| 小红书采集 | `dsh-xhs-check` 0.2.0 | 使用已登录的浏览器采集笔记、评论、搜索结果、主页、通知和私信会话，保存为本地 JSON | [README](xhs-check/README.md) |
| 侧聊 | `dsh-side-chat` 0.2.0 | 右侧栏只读旁路会话，每次请求实时注入主会话上下文，关闭即销毁、不落盘 | [交接文档](side-chat/HANDOFF.md) |

侧聊的桌面端真机交互仍在验收，状态见 [PROGRESS.md](side-chat/PROGRESS.md)。

## 安装

环境要求：Node >= 22.19.0，DSH >= 0.2.1-rc.5 < 0.3.0（各插件 `engines.dsh` 已声明）。

```sh
git clone --branch dev/ppt-ultra https://github.com/SoMiReMiReDo/dsh-dev.git
```

在 DSH Desktop 中调用 `plugin_manager install_bundle`，`target` 传仓库内插件目录的绝对路径。四个插件装进同一个 profile，按以下顺序安装：

1. `inner-chrome/` —— 先装。小红书采集通过 `ctx.innerChrome` 复用它的浏览器。
2. `xhs-check/`
3. `side-chat/`
4. `ppt-ultra/` —— 依赖 DSH Python（`lxml`、`python-pptx`、Pillow）与 LibreOffice Kit，缺失时会报错提示。

安装后刷新客户端；`index.js`、`cordis.patch.yml` 的改动需要重启 DSH。各插件入口：

| 插件 | 入口 |
| --- | --- |
| PPT Ultra | 顶栏「打开 PPT Ultra」；新建会话选「PPT 编辑」（`ppt-edit`）预设后自动打开。预设的 profile 补丁见其 README |
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
npm run dev                                            # 127.0.0.1:4177，仅用于界面与参数验证
```

改动生效方式：`client.js` 刷新页面；`index.js`、`cordis.patch.yml`、`package.json` 重启 DSH（profile 以 `link:` 安装，Node 按路径缓存 ESM）。

## 数据与隐私

| 插件 | 本地数据 |
| --- | --- |
| 小红书采集 | `xhs-check/data/`（Git 忽略）与 `settings.json`；图片、视频只存链接 |
| 内置浏览器 | 截图保存在 `~/.dsh/inner-chrome/screenshots/` |
| PPT Ultra | 原稿、历史和预览保存在 `~/.dsh/ppt-ultra/`；`ppt-ultra/test/fixtures/*.pptx` 默认不入库 |
| 侧聊 | 内存态，关闭标签页即销毁 |

自定义数据目录时放到仓库外，或补充对应的 Git 忽略规则。采集内容仅限你有权访问和保存的范围；原始响应可能包含账号资料、通知或会话信息。

## 分支

| 分支 | 内容 |
| --- | --- |
| `main` | 早期 side-chat 单插件线 |
| `dev/xhs-innerChrome` | 侧聊 + 内置浏览器 + 小红书采集 |
| `dev/ppt-ultra`（当前） | 在上一分支基础上新增 PPT Ultra |
