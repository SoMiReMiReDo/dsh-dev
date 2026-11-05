# dsh-inner-chrome 内部契约（实现前必读）

插件包：`inner-chrome/`（profile 以 link 方式安装，Node 24 / DSH 0.2.1-rc.5 Desktop）。

## 0. 目标与边界

**产品目标**：给 DSH Desktop 提供一个“内置浏览器”，跑在右侧栏（`ctx.sidebarRight`）里，并成为
网页类操作的优先出口：

1. 右侧栏出现浏览器标签页，地址栏/前进/后退/刷新/外部打开，默认进入空白起始页。
2. 聊天里的 HTTP(S) 链接走内置浏览器（接管 `kind: "browser"` 的内置实现 + 一次性把 `ui-chat`
   的 `linkOpening` 偏好迁到 `sidebar`）。
3. Agent 工具：`inner_chrome_open` / `inner_chrome_read` / `inner_chrome_click` /
   `inner_chrome_screenshot` / `inner_chrome_tabs` / `inner_chrome_navigate`。
4. 其他 Client 插件可 `ctx.innerChrome.open(url)` 把网页交给内置浏览器。
5. Desktop 用官方 `globalThis.dshDesktop.browser` 租约 + Electron `<webview>`；Web 端降级 iframe
   （页面可看，跨域时 `read/click/screenshot` 明确报不可用）。

**不做**：不改 `web_fetch`/`web_search` 链路；不做 CDP 驱动；不碰 xhs-check 的外部 Chrome。

## 1. 硬约束

- **零第三方 npm 依赖**。Host 只用 `node:*`；Client 用 `window.__ModuleLoader__.load({ factory(require) })`，
  可 `require('react')`、`require('@deepseek-ai/dsh-client-ui-primitives')`（同 side-chat）。
- `client.js` 是**单文件**（module loader 不解析相对 ESM import）；Host 侧可拆 `lib/*.mjs` 并被 `index.js` 正常 import。
- 不写 profile 的 `package.json` / `cordis.patch.yml`，不跑 pnpm；安装走 `plugin_manager install_bundle`。
- 不硬编码 token/cookie。数据只写 `~/.dsh/inner-chrome/`（截图）。
- **不覆盖用户设置之外的状态**：只做一次 `ui-chat.linkOpening: sidebar` 迁移，用 localStorage 标记，
  用户改回 `new-tab` 后不再抢。
- 所有面向模型的工具描述用中文，明确“优先使用内置浏览器”。

## 2. 目录与 ownership

| 文件 | owner | 说明 |
|---|---|---|
| `package.json` `cordis.patch.yml` `locale/*.json` `icon.svg` `CONTRACT.md` `README.md` | Lead | 清单、显示元数据、文档 |
| `index.js` `lib/broker.mjs` `lib/url.mjs` `test/host*.test.mjs` | **browser-host** | Host 插件入口：工具、命令队列、截图落盘 |
| `client.js` `test/client*.test.mjs` | **browser-client** | Client 插件：标签类型、webview 载体、工具栏、命令执行、`ctx.innerChrome` 服务 |
| 集成、安装、真机验证 | Lead | — |

两个 owner 之间**只通过本契约的 HTTP 协议与命令/结果 JSON 交互**，不互相 import。

## 3. Host 半区（index.js + lib）

### 3.1 入口

```js
export const name = 'inner-chrome'
export const inject = ['connection', 'tools']
export function apply(ctx) { ... }
```

- Host 跑在 DSH Electron 主进程（Node 24，全局 `fetch`/`WebSocket`，无 Electron API 权限）；
  **不要 `require('electron')`**。
- 命令队列纯内存；插件卸载/重载即清空。客户端会重连。
- 状态目录：`join(homedir(), '.dsh', 'inner-chrome')`，截图目录 `.../screenshots`，懒创建。

### 3.2 HTTP 路由（全部 `POST`，`ctx.connection.fetch.register`）

照抄 xhs-check 的注册形态：

```js
ctx.effect(() => ctx.connection.fetch.register({
  path, methods: ['POST'], requestBody: 'buffered',
  fetch: async (request) => Response.json(await handler(await readBody(request))),
}), `inner-chrome: route ${path}`)
```

`readBody` 自己实现：最多 16 MiB，JSON.parse；错误返回 `{ ok:false, error:{ code, message } }`（HTTP 200）。

| 路由 | 请求 | 响应 |
|---|---|---|
| `/api/inner-chrome.hello` | `{ clientId, protocol:1, platform:'desktop'\|'web', capabilities:string[], version }` | `{ ok:true, protocol:1, version, screenshotsDir }` |
| `/api/inner-chrome.poll` | `{ clientId, waitMs?:number }` | `{ ok:true, command: Command \| null, serverTime }` |
| `/api/inner-chrome.result` | `{ clientId, id, ok:boolean, value?:any, error?:{code,message} }` | `{ ok:true }` |
| `/api/inner-chrome.status` | `{}` | 见下 |

`waitMs` 默认 15000，夹在 1000..25000。长轮询：无命令时挂起至多 `waitMs` 再返回 `command:null`。
连接断开/超时都要正常 resolve，绝不 500（客户端据此重连）。

`status` 响应：

```json
{ "ok": true,
  "client": { "connected": true, "clientId": "...", "platform": "desktop",
               "capabilities": ["open","read","click","screenshot","tabs","navigate"],
               "lastSeenAgoMs": 320 },
  "pendingCommands": 0,
  "protocol": 1,
  "version": "0.2.0",
  "screenshotsDir": "/path/to/home/.dsh/inner-chrome/screenshots" }
```

`connected` 判定：最近一次 poll/hello 在 30s 内；超过即清理该 client 并 reject 其挂起命令（错误码 `CLIENT_GONE`）。

### 3.3 Command / Result 协议

```ts
interface Command {
  id: string                 // uuid
  kind: 'open'|'read'|'click'|'screenshot'|'tabs'|'navigate'
  args: Record<string, unknown>
  sessionId?: string         // exec.agent?.session.id，客户端据此选/建标签页
  tabId?: string             // 明确指定标签页时
  createdAt: number
}
```

Result（客户端 POST 回 `/result`）：

- `ok:true` + `value`：见下表；`ok:false` + `error:{code,message}`。
- Host 侧错误码统一前缀：`NO_CLIENT` / `TIMEOUT` / `CLIENT_GONE` / `BAD_ARGS` / `INTERNAL`；
  客户端错误码：`NO_TAB` / `NO_WEBVIEW` / `READ_UNSUPPORTED` / `SCREENSHOT_FAILED` / `NAV_FAILED` / `CLICK_NOT_FOUND` / `UNSUPPORTED_URL`。

命令 `value`：

| kind | args | value |
|---|---|---|
| `open` | `{ url:string, newTab?:boolean }` | `{ tabId, sessionId, url, title, loading }` |
| `read` | `{ maxChars?:number }` | `{ tabId, url, title, text, chars, truncated }` |
| `click` | `{ selector?:string, text?:string }` | `{ tabId, url, title, found:boolean, tag?:string }` |
| `screenshot` | `{ maxWidth?:number }` | `{ tabId, url, title, mime:'image/jpeg', base64, width, height }` |
| `tabs` | `{}` | `{ tabs:[{ tabId, sessionId, url, title, active }] }` |
| `navigate` | `{ action:'back'\|'forward'\|'reload'\|'goto', url?:string }` | `{ tabId, url, title }` |

Host 对 `open`/`navigate` 的 `url` 做一次 `assertHttpUrl`（见 `lib/url.mjs` 语义）；非法立即 `BAD_ARGS`。
Host 等待结果的超时：工具级 25s；超时返回 `TIMEOUT` 文案，提示“内置浏览器没有响应：请确认 DSH Desktop
窗口开着，且右侧栏浏览器标签页可打开”。

### 3.4 工具（`ctx.tools.register`，照抄 xhs-check 形态：`parameters` JSON Schema + `output.schema` + `output.render`）

统一 `execute(args, exec)`，用 `exec.agent?.session.id` 当 `sessionId`，`exec.signal` 传入等待。

1. `inner_chrome_open` — 参数 `{ url:string, newTab?:boolean }`。
   描述必须写明：浏览网页请**优先**用本工具，不要用 `web_fetch` 代替“需要用户看到/需要交互”的页面。
   render：`已在内置浏览器打开：<title>\n<url>`。
2. `inner_chrome_read` — `{ maxChars?:number }`。返回当前内置浏览器标签页正文纯文本。
   render：`标题: ...\nURL: ...\n\n<text>`（超长截断提示）。
3. `inner_chrome_click` — `{ selector?:string, text?:string }`（二者至少一个）。
   render：`已点击 <tag>「<text>」。当前页面：<title> <url>`；未找到给 `CLICK_NOT_FOUND` 提示。
4. `inner_chrome_screenshot` — `{ maxWidth?:number }`。Host 落盘
   `screenshotsDir/<timestamp>-<rand>.jpg`，返回 `{ path, bytes, width, height, url, title }`。
   render：`截图已保存: <path>（<w>x<h>，<bytes>B）`。
5. `inner_chrome_tabs` — `{}`。render 列出每个标签页 `[active] <title> — <url>`。
6. `inner_chrome_navigate` — `{ action:'back'|'forward'|'reload'|'goto', url?:string }`（`goto` 必须带 url）。

不要注册 `run_code`；不要注册与官方同名工具。

### 3.5 Host 单测（`node --test test/host*.test.mjs`，零依赖，假 ctx）

必须覆盖：
- URL 校验：裸域名补 `https://`、拒绝 `javascript:`/`file:`/`data:`/带账号密码的 URL、拒绝应用自身 origin 之外的？
  （应用 origin 只有 Host 知道，Host 不做这项，交给 Client）。
- broker：hello 后 poll 拿到入队命令；无命令时 `waitMs` 到时返回 null；result 唤醒等待者并 resolve；
  重复 result 幂等；client 超时清理导致挂起命令 `CLIENT_GONE`。
- 路由：假 `connection.fetch.register` 捕获 handler，直接构造 `Request` 断言 JSON。
- 工具注册：假 `ctx.tools.register` 捕获 6 个工具，断言名字/参数 schema；用假 broker 跑通 `inner_chrome_open` 的成功与超时分支。
- 截图落盘：给假 result 的 base64，断言文件存在且字节数相符（写临时目录）。

## 4. Client 半区（client.js）

### 4.1 模块形态（照抄 side-chat）

```js
window.__ModuleLoader__.load({
  id: 'dsh-inner-chrome',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    ...
    return { inject, apply }
  },
})
```

`inject`（模块级，数组）：`['slots','locale','sidebarRight','sidebarRightTabs']`。
`ctx.sessions` / `ctx.configForms` 用运行时可选注入：`ctx.inject(['configForms'], child => ...)`，缺失不致命。

### 4.2 标签类型：接管 `kind: "browser"`

```js
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: 'dsh-inner-chrome',        // 也是 body 的 slot key
  kind: 'browser',
  multiple: true,
  priority: 'extension',         // 覆盖官方 builtin（未注册也能单独工作）
  title: () => t('type.label'),  // "内置浏览器"
  guide: [{ id: 'new', order: 30, title: () => t('guide.title'),
            description: () => t('guide.description'), icon: InnerChromeGuideIcon }],
}), 'inner-chrome: tab type')
```

权威参考：`/tmp/dshpkg/dsh-client-ui-sidebar-browser/lib/client.js`（浏览器实现，1600 行，含 CSS）
与 `/tmp/dshpkg/dsh-client-ui-sidebar-right/lib/client.js`（注册校验）。只借鉴结构，不整段复制官方代码。

body 注册：

```js
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: 'dsh-inner-chrome',
  locale: NS,
  inject: () => ({ /* 传给组件的 props */ }),
}, BrowserBody))
```

body 组件里用 `useTabInfo()` 拿 `{ tab, visible, navigation }`；`tab.id` 是标签页 id，
`navigation.params.url` 是 `openTab('browser', { params:{ url } })` 传进来的初始地址。

### 4.3 载体（carrier）

**Desktop**（`globalThis.dshDesktop?.protocolVersion === 1`，`globalThis.dshDesktop.browser` 有
`acquire(workspaceKey) -> {lease, partition}` / `release(lease)` / `onOpenRequested(lease, cb)`）：

1. 挂载容器后 `const { lease, partition } = await bridge.acquire('session:' + sessionId)`
2. `document.createElement('webview')`，设置 `name=lease`、`partition`、`allowpopups`、
   `src = 'about:blank#' + lease`、`data-inner-chrome-frame = 'webview'`，append 到容器
3. 监听 `dom-ready` 后 `element.loadURL(url)`
4. 监听 `did-navigate` / `did-navigate-in-page` / `did-start-loading` / `did-stop-loading` /
   `page-title-updated` / `did-fail-load`（`isMainFrame && errorCode !== -3`）/ `destroyed` / `render-process-gone`
5. 能力：
   - 读页面：`element.executeJavaScript(READ_JS, true)`（`READ_JS` 返回 `{title,url,text}`）
   - 点击：`element.executeJavaScript(CLICK_JS, true)`（按 selector 或精确文本找 `a/button/[role=button]`，返回 `{found,tag,text}`）
   - 截图：`await element.capturePage()` → `.resize({ width: maxWidth })` → `.toJPEG(80)` → base64
   - 导航：`canGoBack/canGoForward/goBack/goForward/reload/loadURL`
6. 卸载：`element.remove()` + `bridge.release(lease)`；异常时也要 release。

**Web 降级**（无 `dshDesktop`）：`<iframe sandbox="allow-scripts allow-forms allow-same-origin allow-popups">`，
自管历史栈；`load/back/forward/reload` 可用；`read/click/screenshot` 返回错误码：
`READ_UNSUPPORTED`（文案：Web 端无法读取跨域页面，请用 DSH Desktop 的内置浏览器）。

**关键：任何一步失败都不能抛到 React 渲染**；捕获后展示可重试的失败态。

### 4.4 命令执行与回传

- `clientId = crypto.randomUUID()`，`protocol: 1`。
- 启动即 `POST /api/inner-chrome.hello`，随后循环：
  `POST /api/inner-chrome.poll {clientId, waitMs: 20000}`（`fetch` + `AbortController` 35s 超时）→
  拿 `command` → 执行 → `POST /api/inner-chrome.result` → 继续。
- 网络失败：退避 1s→2s→5s→10s 重连；插件卸载（`ctx.effect` disposer）停止循环。
- 路由解析：优先 `command.tabId`；其次 `command.sessionId` 下**最近活跃**的标签页；再退到全局活跃标签页。
  `open` 例外：目标 session 没有标签页（或 `newTab:true`）时调用
  `ctx.sidebarRight.openTab('browser', { params: { url } })`，等 body 注册 controller（≤5s）后返回。
- 回报前把 error 映射成契约错误码；未知错误给 `INTERNAL`。
- `read` 的 `maxChars` 默认 20000，夹在 1000..100000，`truncated` 标记。

### 4.5 `ctx.innerChrome` Client 服务

`ctx.reflect.provide('innerChrome', api)`（照 `sidebar-right` 的 provide + effect 释放写法）：

```ts
interface InnerChromeApi {
  isAvailable(): boolean                 // desktop 或 web 均为 true（web 功能降级）
  isDesktop(): boolean
  open(url: string, options?: { newTab?: boolean }): Promise<{ ok: true }>  // 优先进内置浏览器
  current(): { tabId: string, url: string, title: string } | undefined
}
```

`open` 只做 URL 校验 + `ctx.sidebarRight.openTab('browser', { params:{ url } })`。
其他插件用法：`ctx.inject(['innerChrome'], (scope) => scope.innerChrome.open(url))`。

### 4.6 聊天链接偏好迁移（一次）

```js
ctx.inject(['configForms'], (scope) => {
  const MARK = 'dsh-inner-chrome.link-opening-migrated'
  try {
    if (localStorage.getItem(MARK) === '1') return
    const form = scope.configForms.get('ui-chat')
    if (form?.getSnapshot()?.value?.linkOpening === 'new-tab') {
      void form.set('linkOpening', 'sidebar').catch(() => {})
    }
    localStorage.setItem(MARK, '1')
  } catch {}
})
```

### 4.7 首次自动出现在右侧栏 + 头部按钮

- `ctx.sidebarRight.mounted` 是 observable（`getSnapshot()`/`subscribe()`）：本轮进程内**首次**
  变成有效 Session 时，如果没有 `browser` 标签页，就 `ctx.sidebarRight.openTab('browser')` 一次，
  之后不再自动开（用户关掉不打扰）。放在 `ctx.effect` 里，dispose 时退订。
- `conversation.session.header.actions` 注册一个地球图标按钮（`primitives.IconGlobeOutlineRegular`，
  若不存在就用内联 SVG），点击 `openTab('browser')`。

### 4.8 UI 要求

- 工具栏：后退 / 前进 / 刷新 / 地址输入（回车导航，裸域名补 https）/ 打开 / 在系统浏览器打开 / 关闭标签页。
- 起始页：居中提示“输入网址，或让 Agent 调用 inner_chrome_open”。
- 失败态：错误摘要 + 重试按钮。
- 配色只用主题变量（`var(--dsw-alias-bg-base)`、`--dsw-alias-label-primary`、`--dsw-alias-label-secondary`、
  `--dsw-alias-border-l3`、`--dsw-alias-interactive-bg-hover`、`--dsw-radius-sm` 等，参考官方浏览器 CSS）；
  不硬编码颜色。深色/浅色都要可读。
- 容器高度 100%，webview 撑满剩余空间。

### 4.9 Client 单测（`node --test test/client*.test.mjs`）

- 假 `window.__ModuleLoader__` + 假 `require('react')`（最小 `createElement`）抓 `factory` 返回值，
  断言 `inject` 含必需服务；用假 `ctx`（effect/locale/slots/sidebarRight/sidebarRightTabs/reflect/inject）
  跑 `apply`，断言：注册了 kind `browser` 的 extension 类型、body key、header action、provide 了 `innerChrome`。
- 纯函数（URL 解析、命令路由选择、base64 分块）抽出来导出或在 `factory` 内部可测；至少测 URL 规整。

## 5. 验收标准

1. `node --check index.js client.js` 通过；`node --test test/*.test.mjs` 全绿。
2. `plugin_manager install_bundle` → `application: applied`；`cordis_inspect_query(Config)` 能看到
   `inner-chrome` 行；刷新页面后右侧栏指南里是“内置浏览器”，点开有地址栏；聊天里的 HTTP(S) 链接
   在右侧栏打开（而不是外部浏览器）。
3. Agent 侧工具可见：`inner_chrome_open` 打开网页后 `inner_chrome_tabs` 能列出同一标签页，
   `inner_chrome_read` 能拿到正文，`inner_chrome_screenshot` 落盘一张 JPEG。
4. 关闭标签页/刷新页面/切换会话不崩；Web 端（非 Electron）打开页面可用，读取时报“请用 Desktop”。

## 6. 参考文件（全部只读）

- 官方浏览器实现：`/tmp/dshpkg/dsh-client-ui-sidebar-browser/lib/client.js`
- 右侧栏注册契约：`/tmp/dshpkg/dsh-client-ui-sidebar-right/lib/client.js` + `README.md`
- 同 profile 可运行的插件样例：`../xhs-check/{index.js,client.js,test/}`
- 侧边栏 tab 注册样例：`../side-chat/client.js`
- 主题 token 现场查询：`cordis_inspect_query` client `Theme.listTokens`
- Electron 主进程租约策略：`/tmp/applib/main.js` 的 `DesktopBrowserGuests` 与 `DESKTOP_IPC`（只读，别改）

## 7. 实现记录（首版落地后的差异，以代码为准）

以下偏差均为真机验证中暴露并修掉的，契约正文按此理解：

1. **空闲标签页也能被 Agent 使用**：自动打开的空白标签页没有载体（未导航过），
   `open` 命令若命中它，会先调用 body 注册的 `navigate(url)` 钩子启动载体，再等载体就绪（≤8s）
   才 `load`。`carrier.isReady()` 由载体实现提供（Desktop = `dom-ready` 后，Web = iframe 已创建）。
2. **截图不用 `NativeImage.toJPEG()`**：Electron 渲染端没有 Node `Buffer`，`toJPEG()` 会抛
   `Buffer is not available for the current Context`。改为 `capturePage() → toDataURL() → Blob →
   createImageBitmap → canvas` 缩放并编码 JPEG(0.82)，全程浏览器 API；返回 `mime: 'image/jpeg'`。
3. **URL 持久化**：`localStorage['dsh-inner-chrome.url.<tabId>']` 记录每个标签页最后提交的地址；
   页面刷新 / 客户端热重载后 body 用 `navigation.params.url ?? 存储值` 初始化，关闭标签页时清除。
   这是官方 browser 的 checkpoint 行为的轻量替代（官方存在 tab store 里，本插件不依赖其内部 store）。
4. **ERR_ABORTED 不算失败**：`loadURL` 的拒绝若为 `ERR_ABORTED` / `(-3)` 直接忽略——用户或另一个
   命令接管了导航，不弹失败态、不报工具错误。
5. **`tabs` 结果里的标题**过滤掉 `about:blank#<lease>` 引导文档标题（内部租约 id 不外泄给模型）。
6. **聊天链接偏好**：`ui-chat.linkOpening` 迁移成功后落在 profile 的 `cordis.patch.yml`
   （`ui-chat.config.linkOpening: sidebar`），用户可在 设置 → 通用 → “聊天链接打开方式” 改回。
7. **自动开一个标签页**：进程内首次 `sidebarRight.mounted` 有效时打开一次（若该会话还没有
   `kind === 'browser'` 的标签页），之后不再自动打开。

## 8. 页面脚本执行 / 关闭标签页 / 注入脚本（v0.2 扩展，同进程 Host 插件复用）

**目的**：让同一 Host 进程里的其他插件（首个消费者：`xhs-check`）把内置浏览器当作页面自动化载体，
不再启动自带的外部 Chrome。本扩展只增加“执行页面脚本 / 关闭标签页 / 导航时注入脚本”三件事，
不改变既有 6 个 Agent 工具的行为。

### 8.1 命令协议新增

`COMMAND_KINDS` 增加 `eval`、`close`；`open` 增加两个可选参数。

| kind | args | value |
|---|---|---|
| `eval` | `{ expression: string, timeoutMs?: number }` | `{ tabId, url, title, value }` |
| `close` | `{ tabId: string }` | `{ tabId, closed: true }` |
| `open` | 既有 `{ url, newTab? }` + `{ injectScript?: string, waitForLoad?: boolean }` | 既有 + `{ injected?: boolean }` |

- `eval.expression`：1..262144 字符；`eval.timeoutMs`：100..60000，默认 15000。
- `eval` 在标签页**主世界**执行（`webview.executeJavaScript(expression, true)`），返回值必须可结构化克隆；
  Host 收到后按现有 `jsonValue` 归一化（`undefined` → `null`）。
- 新增错误码：`EVAL_FAILED`（页面抛错，message 带摘要）、`EVAL_TIMEOUT`（超时）。
  客户端执行超时后**必须立即回 result**，然后继续轮询，不能卡住命令桥。
- `close`：Client 调 `ctx.sidebarRight.close(tabId)`；找不到标签页 → `NO_TAB`；成功 `{ tabId, closed: true }`。
- `open.injectScript`：本次导航的 `dom-ready` 之后、命令返回之前，对目标文档执行一次该脚本
  （best-effort：脚本抛错不使命令失败，结果里 `injected:false`）。它**不能**早于目标文档自身的脚本，
  因此适合“导航后就绪即安装录制器”的场景，不适合拦截首包请求。
- `open.waitForLoad === false`：只发起加载就返回（`loading:true`），不等 `did-stop-loading`；默认 `true`。

### 8.2 Host 服务 `ctx.innerChrome`（其他 Host 插件使用）

`inner-chrome/index.js` 在 `apply` 内 `ctx.provide('innerChrome', api)`（插件卸载由 Cordis 自动回收）。

```ts
interface InnerChromeHostService {
  readonly protocol: number
  readonly version: string
  status(): BrokerStatus            // 与 /api/inner-chrome.status 同构
  isConnected(): boolean
  capabilities(): string[]
  command(kind: string, args: object, options?: CommandOptions): Promise<any>
  open(url: string, options?: CommandOptions & {
    newTab?: boolean; tabId?: string; injectScript?: string; waitForLoad?: boolean }): Promise<OpenValue>
  read(args?: { maxChars?: number }, options?: CommandOptions): Promise<ReadValue>
  click(args: { selector?: string; text?: string }, options?: CommandOptions): Promise<ClickValue>
  screenshot(args?: { maxWidth?: number }, options?: CommandOptions): Promise<ScreenshotValue>
  tabs(options?: CommandOptions): Promise<{ tabs: TabInfo[] }>
  navigate(args: { action: string; url?: string }, options?: CommandOptions): Promise<NavValue>
  evaluate(expression: string, options?: CommandOptions):
    Promise<{ tabId: string; url: string; title: string; value: any }>
  close(tabId: string, options?: CommandOptions): Promise<{ tabId: string; closed: boolean }>
}
interface CommandOptions { sessionId?: string; tabId?: string; timeoutMs?: number; signal?: AbortSignal }
```

消费者形态（可选注入，不允许把 `innerChrome` 加进 `export const inject`）：

```js
ctx.inject(['innerChrome'], (scope) => {
  const innerChrome = scope.innerChrome
  // 使用 …
  return () => { /* 引用清理 */ }
})
```

- 未连接时任何方法都抛带 `code: 'NO_CLIENT'` 的错误；调用方负责给出“请打开右侧栏内置浏览器”的提示。
- `evaluate(expression, options)` 内部 `timeoutMs` 默认 15000（上限 60000），broker 等待取
  `timeoutMs + 5000`，保证客户端先回 `EVAL_TIMEOUT` 而不是宿主先 `TIMEOUT`。
- `command()` 是逃生口：新增协议命令无需再改服务接口。

### 8.3 Client 载体接口扩展

Desktop carrier 增加：

- `async eval(expression, { timeoutMs }) → unknown`（`Promise.race` 超时保护；`EVAL_TIMEOUT`）
- `load(url, { script? })`（`script` 在目标文档 `dom-ready` 后执行一次）
- 新标签页首次加载的 `script` 由 `openTab(KIND, { params: { url, script } })` 传入 body，
  body 通过 `createCarrier({ initialScript })` 交给载体。

Web carrier：`eval` 抛 `READ_UNSUPPORTED`；`load` 忽略 `script`；`close` 照常可用。

### 8.4 能力声明

`hello.capabilities`：Desktop 增加 `eval`、`close`、`inject`；Web 增加 `close`。
Host 服务 `capabilities()` 读到的是这份清单。

### 8.5 验收

- 单测：broker 接受并校验新命令（`eval` 表达式/超时边界、`close` 必填 tabId、`open` 新参数透传）；
  Host 服务方法转发、`NO_CLIENT` 错误码；Host 工具的 `injectScript` 透传；
  Client：`eval` 成功/超时/抛错、`close` 命中与 `NO_TAB`、`open` 的 `injectScript` 在 dom-ready 后执行、
  Web 载体 `eval` 拒绝。
- 真机：`ctx.innerChrome.evaluate('document.title')` 返回标题；`close(tabId)` 后 `inner_chrome_tabs` 不再列出；
  `open(url, { injectScript: 'window.__T__=1' })` → `evaluate('window.__T__')` 得到 `1`。

### 8.6 首版落地差异（实现记录，以代码为准）

1. `eval.timeoutMs` 越界是**夹取**到 100..60000（而非 BAD_ARGS）；`expression` 为空/超长仍 `BAD_ARGS`。
2. `open` 命令总是携带 `waitForLoad`（默认 `true`）；`injectScript` 只在提供时出现。
3. `injectScript` 的注入时机：`about:blank#<lease>` 引导文档的 `dom-ready` 只发起真实导航、**不消费**脚本；
   目标文档的 `dom-ready` 才执行一次（best-effort，失败只把 `injected` 记成 `false`）。
4. `waitForLoad:false` 立即返回 `{ loading:true, injected:false }`；脚本仍会在目标文档 `dom-ready` 后尽力执行。
5. `close` 成功后立刻把标签页从 hub 记录里移除（`tabs` 命令即时不再列出）；body 的后续 dispose 变成 no-op。
6. Host 服务 `evaluate()` 传给 broker 的等待 = 客户端执行超时 + 5000ms；`status()` 直接返回 `broker.status()`
   本体（没有 HTTP 路由那层 `ok:true`）。
