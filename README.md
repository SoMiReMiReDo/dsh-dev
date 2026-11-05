# DeepSeek Harness 插件

这个仓库包含三个 DeepSeek Harness 插件。本分支新增内置浏览器和小红书采集插件。

| 插件 | 功能 |
| --- | --- |
| [内置浏览器](inner-chrome/README.md) | 在右侧栏打开网页，支持 Agent 读取、点击和截图。 |
| [小红书采集](xhs-check/README.md) | 使用已登录的浏览器采集笔记、评论、搜索结果等，并保存为本地 JSON。 |
| [侧聊](side-chat/HANDOFF.md) | 在右侧栏发起临时讨论，侧聊可读取当前主会话上下文。桌面端完整流程仍待验收。 |

## 安装

克隆本分支，然后在 DeepSeek Harness Desktop 的同一个 profile 中按顺序安装两个插件。

```sh
git clone --branch dev/xhs-innerChrome https://github.com/SoMiReMiReDo/dsh-dev.git
```

在 DSH 中调用 `plugin_manager install_bundle`，分别使用本地 `inner-chrome/` 和 `xhs-check/` 的绝对路径作为 `target`。先安装并启用 `inner-chrome`，再安装 `xhs-check`。打开「设置 → 小红书采集」即可查看连接状态和登录入口。

## 本地开发

在仓库根目录运行单测。修改 Host 入口后重启 DSH，修改 Client 入口后刷新界面。

```sh
node --test inner-chrome/test/*.test.mjs xhs-check/test/*.test.mjs side-chat/test/*.test.mjs
```

采集结果和登录状态保留在本机。自定义数据目录或 Chrome 用户目录时，请放在仓库外，或添加对应的 Git 忽略规则。
