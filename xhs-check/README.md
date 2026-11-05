# 小红书采集

`dsh-xhs-check` 是 DeepSeek Harness 的本地采集插件。它使用你在浏览器中登录的小红书账号读取网页数据，将笔记、评论、搜索结果、主页数据、通知和私信会话列表保存为 JSON。可通过 Agent 工具发起采集，在设置面板查看任务和结果。

## 安装和使用

1. 在 DeepSeek Harness Desktop 的当前 profile 中安装并启用 [内置浏览器](../inner-chrome/README.md)。
2. 调用下面的安装工具，将 `target` 换成本地 `xhs-check` 目录的绝对路径。
3. 打开「设置 → 小红书采集」，点击「打开浏览器并登录」。在右侧栏扫码登录后，可以让 Agent 搜索关键词，或采集一条笔记链接。

```text
plugin_manager install_bundle target=/path/to/dsh-dev/xhs-check
```

## Agent 工具

| 工具 | 用途 |
| --- | --- |
| `xhs_login` | 打开登录页面，等待扫码 |
| `xhs_status` | 查看浏览器连接、登录状态、数据目录和最近任务 |
| `xhs_collect` | 按 `note`、`search`、`profile`、`notifications` 或 `chat` 模式采集 |
| `xhs_library` | 按类型或关键词查找本地采集结果 |
| `xhs_probe` | 排查采集问题时录制页面 API 响应并保存原始数据 |
| `xhs_close` | 关闭插件打开的浏览器标签页或 Chrome 进程 |

采集笔记详情时，请使用搜索结果里包含 `xsec_token` 的完整链接。评论通常只覆盖首屏和已展开的回复，私信模式目前支持会话列表，消息正文的读取尚未验证通过。

## 后端与数据

默认使用 DSH Desktop 的内置浏览器。需要使用独立 Chrome 时，可在插件目录创建本地 `settings.json`，设置 `"backend": "cdp"`。如果 Chrome 位于非默认位置，可同时设置 `chromePath` 或环境变量 `XHS_CHECK_CHROME_PATH`。

结果默认保存在 `xhs-check/data/`，图片和视频以链接形式保存。原始响应可能包含账号资料、通知或会话信息。默认数据目录和 `settings.json` 已被 Git 忽略。自定义 `dataDir` 或 Chrome `profileDir` 时，请将目录放到仓库外，或添加对应的忽略规则。只采集你有权访问和保存的内容。

在插件目录运行 `npm test` 可验证采集编排、数据解析和存储。开发接口见 [接口契约](CONTRACT.md)。
