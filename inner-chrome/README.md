# 内置浏览器

`dsh-inner-chrome` 在 DeepSeek Harness 的右侧栏提供浏览器标签页。你可以直接打开聊天里的链接，也可以让 Agent 打开页面、读取正文、点击元素和截图。

## 安装

在 DeepSeek Harness Desktop 中调用下面的工具。将 `target` 替换为本地插件目录的绝对路径。

```text
plugin_manager install_bundle target=/path/to/dsh-dev/inner-chrome
```

安装后，从右侧栏打开「内置浏览器」，或让 Agent 调用 `inner_chrome_open`。首次启用会将聊天链接的打开方式设为侧边栏，之后可以在设置中改回系统浏览器。

## Agent 工具

| 工具 | 用途 |
| --- | --- |
| `inner_chrome_open` | 打开 HTTP(S) 地址，可新建标签页 |
| `inner_chrome_read` | 读取页面标题、地址和正文 |
| `inner_chrome_click` | 按 CSS 选择器或精确文本点击 |
| `inner_chrome_screenshot` | 将当前可见标签页的截图保存到 `~/.dsh/inner-chrome/screenshots/` |
| `inner_chrome_tabs` | 列出打开的浏览器标签页 |
| `inner_chrome_navigate` | 后退、前进、刷新或跳转 |

桌面端使用 Electron webview。Web 端使用 iframe，能否嵌入由站点决定，跨域页面的正文读取和交互受浏览器限制。

## 插件集成

同一 profile 中的其他插件可以注入 `ctx.innerChrome`。[小红书采集](../xhs-check/README.md) 默认使用该服务。Host 和 Client 的接口、命令格式与错误码见 [接口契约](CONTRACT.md)。

在插件目录运行 `npm test` 可验证命令桥、工具注册和客户端行为。
