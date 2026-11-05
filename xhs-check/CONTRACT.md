# dsh-xhs-check 内部接口契约（实现已完成，维护者参考）

插件包位于仓库的 `xhs-check/` 目录（profile 里以 link 方式安装，Host 半区跑在 DSH Electron 主进程，Node 24.21，有全局 `WebSocket`/`fetch`，无第三方依赖）。

## 0. 硬约束

- **零第三方 npm 依赖**。只用 Node 内置模块（`node:*`）和全局 `WebSocket`/`fetch`。
- Host 半区（`index.js`、`lib/*.mjs`）是纯 ESM，`node --test test/*.test.mjs` 必须直接跑通。
- 不写 profile 的 `package.json` / `cordis.patch.yml`，不用 pnpm。安装走 `plugin_manager install_bundle`。
- 不在代码里硬编码 cookie/token。登录态来自采集浏览器自身的持久分区：默认是 DSH 内置浏览器（按 Session 隔离的 Electron partition），`backend=cdp` 时才用独立 Chrome user-data-dir。
- 采集是**低频单账号**：默认请求间隔 ≥ 1500ms，串行。
- 数据只写 `dataDir`；`data/` 产物是交付物，图片**只存远程链接**，不下载。

## 1. 目录与 ownership

| 文件 | owner | 说明 |
|---|---|---|
| `package.json` `cordis.patch.yml` `locale/*.json` `icon.svg` `README.md` `CONTRACT.md` | Lead | 清单、显示元数据、文档 |
| `index.js` | Lead | Host 插件入口：工具、路由、任务队列、采集浏览器生命周期 |
| `lib/inner-driver.mjs` + `test/inner-driver.test.mjs` | Lead | 内置浏览器后端：把 `ctx.innerChrome` 服务适配成采集器的 page API |
| `lib/cdp.mjs` + `test/cdp.test.mjs` | cdp-engine | CDP 客户端与 Chrome 启动器 |
| `lib/normalize.mjs` `lib/store.mjs` + `test/normalize.test.mjs` `test/store.test.mjs` `test/fixtures/**` | xhs-normalizer | 响应归一化、落盘 |
| `client.js` | panel-ui | 设置页面板 |
| `lib/collect.mjs` `lib/recorder.mjs` | Lead | 采集编排、页面内 recorder 源码 |

## 2. `lib/cdp.mjs`（owner: cdp-engine）

```js
/** 启动或复用 Chrome，返回 Browser 句柄。 */
export async function launchChrome(options) => Promise<Browser>
/** options: {
 *   chromePath?: string,     // 默认 '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
 *   port?: number,           // 默认 9333
 *   userDataDir: string,     // 必填，独立 profile 目录
 *   headless?: boolean,      // 默认 false（小红书检测 headless）
 *   startUrl?: string,       // 默认 'about:blank'
 *   launchTimeoutMs?: number // 默认 20000
 * } */
/** 连接一个已在 port 上监听的 Chrome（不负责启动）。 */
export async function connectChrome(port) => Promise<Browser>
/** 端口是否已有可用的 CDP 端点。 */
export async function isChromeListening(port) => Promise<boolean>

Browser: {
  port: number,
  wsUrl: string,
  pid?: number,                     // 由 launchChrome 启动时给出
  launched: boolean,                // 是否由本模块拉起
  async newPage(url?) => Promise<Page>,
  async pages() => Promise<Array<{ targetId, url, title }>>,
  async closePage(targetId) => Promise<void>,
  async close() => Promise<void>,   // 断开 WS；launched 时同时结束进程
}

Page: {
  targetId: string,
  sessionId: string,
  async goto(url, { waitUntil = 'load', timeoutMs = 30000 } = {}) => Promise<void>,
  /** 在页面主世界执行；expression 可为字符串或函数源码；functionSource 用 `(${fn})` 包装约定由调用方负责。 */
  async evaluate(expression, { awaitPromise = true, returnByValue = true, timeoutMs = 30000 } = {}) => Promise<unknown>,
  /** 每次新文档创建时执行（Page.addScriptToEvaluateOnNewDocument），用于 recorder。 */
  async addInitScript(source) => Promise<void>,
  /** 轮询 expression 直到真值；超时抛错。 */
  async waitFor(expression, { timeoutMs = 15000, intervalMs = 250 } = {}) => Promise<void>,
  /** 渐进滚动到底部，返回实际滚动次数；供信息流/评论列表用。 */
  async scrollToLoadMore({ times = 3, distance = 1200, delayMs = 1200 } = {}) => Promise<number>,
  async waitForIdle({ quietMs = 800, timeoutMs = 15000 } = {}) => Promise<void>,
  async on(event, listener) => () => void,   // 'load' | 'dialog' | 'close'
  async close() => Promise<void>,
}
```

要求：
- 内部一个浏览器级 WebSocket，`Target.createTarget` + `Target.attachToTarget({flatten:true})` 建立 page session，命令带 `sessionId`。
- 命令超时、WS 断开要把 pending promise 全部 reject，错误带 `code`（`CdpError`）。
- `launchChrome` 参数：`--remote-debugging-port`、`--user-data-dir`、`--no-first-run`、`--no-default-browser-check`、`--window-size=1440,900`、`--disable-background-timer-throttling`；**不要**加 `--enable-automation`（避免 `navigator.webdriver`）。
- Chrome 136+ 禁止默认 user-data-dir + remote debugging，本实现始终用独立目录，所以没问题；目录不存在时先 `mkdir -p`。
- 端口轮询 `http://127.0.0.1:<port>/json/version`，取 `webSocketDebuggerUrl`。
- 单测用假 WebSocket/假 fetch 覆盖：消息分发、超时、断开 reject、`launchChrome` 复用已有端点、参数拼装。

## 3. `lib/normalize.mjs`（owner: xhs-normalizer）

输入是一条 recorder 捕获：

```ts
interface Capture {
  url: string
  method: string
  status: number
  capturedAt: string      // ISO
  body: unknown           // 已 JSON.parse 的响应体（非 JSON 时为 string）
  reqBody?: unknown
}
```

```js
/** 路径 → 采集类型。未知返回 'unknown'。 */
export function classify(url: string): CaptureKind
// CaptureKind = 'note' | 'comments' | 'subcomments' | 'search' | 'user_notes'
//             | 'note_detail_by_id' | 'user_me' | 'chat_conversations' | 'chat_messages'
//             | 'notifications' | 'unknown'
/** 把一条捕获转成结构化记录。无法识别时返回 { kind:'unknown', records: [], raw: body } 不抛错。 */
export function normalizeCapture(capture: Capture): { kind: CaptureKind, records: XhsRecord[], raw: unknown, sourceUrl: string }
/** 由 note_card（信息流/搜索/主页共用）生成 note 记录。 */
export function noteFromCard(card: any, source?: { url?: string, kind?: string }): XhsRecord | undefined
/** 评论（含楼中楼 sub_comments）→ comment 记录数组。 */
export function commentsFromPage(body: any, noteId?: string): XhsRecord[]
/** 私信消息启发式：任意 JSON 中找出「有 sender+content/type+timestamps」的消息数组。 */
export function messagesFromAny(body: any, conversationId?: string): XhsRecord[]
/** 合并同一笔记的多次采集（保留更完整字段、评论数取 max、raw 叠加）。 */
export function mergeRecord(existing: any, incoming: any): any
/** 给模型看的单行/多行摘要。 */
export function summarizeRecords(records: XhsRecord[], maxChars?: number): string
```

`XhsRecord` 统一带 `type`、`id`、`collectedAt`、`sourceUrl`、`raw`：

```ts
note:       { type:'note', id, url, title, desc, author:{id,nickname,avatarUrl}, images:[{url,width,height}],
              video:{url,coverUrl,duration}|null, tags:[string], stats:{liked,collected,comments,shared},
              publishedAt, ipLocation, noteType, collectedAt, sourceUrl, raw }
comment:    { type:'comment', id, noteId, parentId:null, content, author:{id,nickname,avatarUrl},
              likeCount, createdAt, ipLocation, subCommentCount, subComments:[comment], collectedAt, sourceUrl, raw }
chat_message:{ type:'chat_message', id, conversationId, seq, from:{id,nickname,avatarUrl}, text,
              images:[string], messageType, createdAt, collectedAt, sourceUrl, raw }
conversation:{ type:'chat_conversation', id, peer:{id,nickname,avatarUrl}, lastMessage, unreadCount,
              updatedAt, collectedAt, sourceUrl, raw }
notification:{ type:'notification', id, category, title, content, actor:{id,nickname}, noteId, createdAt,
              collectedAt, sourceUrl, raw }
```

要求：
- 字段全部用 `undefined`/`null` 兜底，禁止抛错；对小红书 `note_card`、`items[].note_card`、`notes[]`、`comments[]`、`sub_comments[]`、`user_info`/`user`、`interact_info`、`image_list[].url_default|url_pre|info_list[].url`、`video.media.stream.h264[].master_url` 等真实变体做容错。
- `classify` 覆盖：`/api/sns/web/v1/feed`、`/v1/note/…`、`/v2/comment/page`、`/v2/comment/sub/page`、`/v1/search/notes`、`/v1/user_posted`、`/v2/user/me`、`/v1/im/…`、`/v1/chat/…`、`/v1/notification/…`，同时留模糊规则（路径含 `comment`/`search`/`user_posted`/`im`/`chat`/`notification`）。
- 单测用 fixture（自己按小红书公开响应结构写），覆盖：正常卡片、缺字段、空 body、非 JSON、私信未知骨架。

## 4. `lib/store.mjs`（owner: xhs-normalizer）

```js
export class Store {
  constructor(rootDir: string)        // 即 dataDir
  async init(): Promise<void>
  /** 写/合并一条记录；返回落盘相对路径。 */
  async save(record: XhsRecord): Promise<string>
  /** 批量保存，返回 { saved, paths }。 */
  async saveMany(records: XhsRecord[]): Promise<{ saved: number, paths: string[] }>
  async get(type: string, id: string): Promise<any | undefined>
  /** 目录式查询：type + 关键词（标题/正文/昵称）+ limit/offset；返回精简行。 */
  async list({ type, query, limit = 30, offset = 0 } = {}): Promise<{ items: any[], total: number }>
  async counts(): Promise<Record<string, number>>
  /** 原始捕获落盘（probe 用），返回相对路径。 */
  async saveRaw(name: string, value: unknown): Promise<string>
  /** 批量保存评论：按 noteId 合并去重。 */
  async saveComments(noteId: string, comments: XhsRecord[]): Promise<{ saved: number, path: string }>
  async saveSearch(query: string, records: XhsRecord[], meta?: object): Promise<string>
  async saveChat(conversationId: string, records: XhsRecord[], meta?: object): Promise<string>
}
```

落盘布局（`dataDir` 下）：

```
data/
  notes/<noteId>.json
  comments/<noteId>.json            # { noteId, comments:[...], collectedAt, sourceUrl }
  searches/<slug>-<ts>.json         # { query, notes:[...], collectedAt, sourceUrl }
  profiles/<userId>.json            # { userId, tab, notes:[...], collectedAt }
  chats/<conversationId>.json       # { conversationId, peer, messages:[...], collectedAt }
  notifications/<ts>.json           # { items:[...], collectedAt }
  raw/<ts>-<slug>.json              # probe 原始捕获
  index.json                        # { updatedAt, entries:[{type,id,title,count,path,collectedAt}] }
```
- `index.json` 缺失/损坏可重建；并发写用「读-改-写」+ 简单串行化即可（单进程）。
- 原子写（临时文件 + rename）。
- `list()` 只读 index，不扫全量目录。

## 5. Host 路由（owner: Lead，panel-ui 按此消费）

全部 `POST`，JSON body，同源，走 `ctx.connection.fetch.register({ path, methods:['POST'], requestBody:'buffered', fetch })`。

```
POST /api/xhs.status   {} →
{ ok:true, backend:'inner-chrome'|'cdp',
  dataDir, browser:{ backend, available, connected, platform, capabilities, version,
                     tabId, url, title, tabIds[], hint?   // 内置浏览器
                     /* cdp: running, launched, port, userDataDir, pid */ },
  login:{ loggedIn, nickname?, userId?, checkedAt? },
  counts:{ note, comment, chat_conversation, chat_message, notification, search, profile },
  jobs:[{ id, mode, target, phase, startedAt, finishedAt, ok, error, progress:{done,total} }],
  settings:{ requestDelayMs, maxComments, maxScrolls } }

POST /api/xhs.login    { wait?:boolean } → { ok, login:{...}, browser:{...} }
POST /api/xhs.chrome   { action:'open'|'close'|'focus' } → { ok, browser:{...} }
                        # close 关闭本插件打开的内置浏览器标签页 / cdp Chrome
POST /api/xhs.library  { type?, query?, limit?, offset? } → { ok, items:[{type,id,title,count,collectedAt,path}], total }
POST /api/xhs.reveal   {} → { ok }                       # Finder 打开 dataDir
POST /api/xhs.jobs     {} → { ok, jobs:[...] }           # 面板轮询用（比 status 轻）
```
错误统一 `{ error: { code, message } }` + 非 2xx。

## 6. `client.js`（owner: panel-ui）

- `window.__ModuleLoader__.load({ id: 'dsh-xhs-check', factory(require) { ... return { inject, apply } } })`，照抄 `side-chat/client.js` 的骨架。
- 面板挂在 **`settings.section`** 槽：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'xhs-check', order: 23, locale: NS, label: () => t('panel.title') }, Panel))`。
  （该槽 ownerProps 只有 `{ close }`；条目自带 `id`，不要复用 shipped id。）
- `NS = 'xhscheck'`，`ctx.locale.register(NS, { zh, en })`，字典写在 client.js 内部（同 side-chat）。
- 面板内容：状态卡（采集浏览器是否可用/已连接、当前页、登录昵称、数据目录、各类型计数）、按钮（打开浏览器并登录 / 刷新 / 关闭采集页面 / 打开数据目录）、任务列表（phase + 进度 + 错误）、最近采集列表（type/id/标题/条数/时间）。浏览器状态读 `status.browser`，后端由 `status.backend` 区分。
- 轮询 `/api/xhs.status`：任务进行中 1.5s，否则 5s；页面卸载即停。
- 用原生元素 + `var(--dsw-*)` 主题变量做样式（参考 side-chat 的 `style` 写法），必要时用 `primitives.Button`；**浅色主题优先、跟随宿主主题**，不要硬编码深色背景。所有可见文案走 `t()`。
- 不写全局副作用，资源都用 `ctx.effect` 注册并返回清理函数。

## 7. 采集器与浏览器后端（owner: Lead）

### 7.1 两个后端共用的 page API

`lib/collect.mjs` 只依赖这组 page 方法：

```ts
Page {
  addInitScript(source: string): void            // 下一次导航时安装 recorder
  goto(url, { waitUntil?: 'none', timeoutMs?: number }): Promise<unknown>
  evaluate(expression: string): Promise<unknown> // 页面主世界，返回值可 JSON 序列化
  scrollToLoadMore({ times, distance, delayMs }): Promise<number>
  getLocationHref(): Promise<string>
  close(): Promise<void>
}
Browser { newPage(): Promise<Page>, pages(): Promise<unknown>, close(): Promise<number|void>, kind? }
```

- `backend=cdp`（`lib/cdp.mjs`）：`Page.addInitScript` = `Page.addScriptToEvaluateOnNewDocument`，recorder 在文档创建前安装。
- `backend=inner-chrome`（`lib/inner-driver.mjs`，**默认**）：经 Host 服务 `ctx.innerChrome` 驱动右侧栏内置浏览器。
  - 每个采集任务用 `open(url,{newTab:true})` 建自己的 tab，之后所有命令带显式 `tabId`，不会劫持用户正在看的页面；收尾 `close(tabId)` 关掉。
  - `goto` → `open { url, tabId?, injectScript, waitForLoad }`；`injectScript` 在目标文档 `dom-ready` 后执行（recorder 由此安装）。
  - `evaluate` → `eval { expression, timeoutMs }`；`scrollToLoadMore` → `eval` + `window.scrollBy`；`getLocationHref` → `eval` + `location.href`。
  - 内置浏览器的 recorder 只能从 `dom-ready` 开始录制，**首屏响应可能早于它**；因此采集器额外从 `window.__INITIAL_STATE__` 读 SSR 兜底（搜索/通知/私信会话/主页 id）。

### 7.2 recorder 与采集编排

- recorder 源码（`lib/recorder.mjs` 导出字符串）注入：包 `window.fetch` 与 `XMLHttpRequest`，把 `{url,method,status,body}` 推到 `window.__XHS_NET__`（环形缓冲，上限 300 条/8MB），并提供 `window.__XHS_TAKE__()` 取走并清空。
- `lib/collect.mjs` 导出 `collectNote/collectSearch/collectProfile/collectChat/collectNotifications/probePage`，统一 `{ browser, store, settings, signal }` 依赖注入，返回紧凑摘要对象。
- 配置来自 `xhs-check/settings.json`（不存在则用默认值，运行期不写回）：
  `backend`（`inner-chrome`|`cdp`，默认 `inner-chrome`）、`dataDir`、`requestDelayMs`、`maxComments`、`maxScrolls`、
  内置浏览器专用 `innerSettleMs`（导航后静默窗口，默认 400ms）、`evalTimeoutMs`（页面脚本超时，默认 20000ms）；
  `cdp` 后端另有 `chromePath` / `chromePort` / `profileDir`。
- 环境变量覆盖：`XHS_CHECK_DATA_DIR`、`XHS_CHECK_CHROME_PATH`、`XHS_CHECK_BACKEND`。


## 8. 真机探测到的真实接口（2026-11-05，Chrome 156）

采集器的实现依据下面这些实测结果；小红书改版时先跑 `xhs_probe` 对照。

| 用途 | 接口 | 关键字段 |
|---|---|---|
| 登录态 | `GET /api/sns/web/v2/user/me` | `data.guest`（匿名 true）、`data.user_id` |
| 搜索 | `POST /api/sns/web/v2/search/notes` | `data.items[]{id, xsec_token, note_card{display_title,user,interact_info,cover,image_list,type}}`（`note_card` 里没有 `note_id`，id 在外层） |
| 笔记详情 | **页面 SSR** `window.__INITIAL_STATE__.note.noteDetailMap[noteId].note` | camelCase：`noteId/title/desc/user/imageList/tagList/interactInfo/time/ipLocation`；评论在 `.comments.list` |
| 评论 | `GET /api/sns/web/v2/comment/page?note_id=…&cursor=` | 一级评论 + `sub_comments` 楼中楼 |
| 主页笔记 | **页面 SSR** `window.__INITIAL_STATE__.user.notes`（Vue ref，需在页内 unwrap） | 网格卡片只有 `noteId/displayTitle/user/interactInfo/cover/xsecToken` |
| 收藏 / 赞过 | `GET /api/sns/web/v1/user_posted?tab=…` | `data.notes[]` |
| 通知 | `GET /api/sns/web/v1/you/mentions`、`/you/likes`、`/you/connections` | `data.message_list[]{title,time,user_info,item_info}` |
| 私信会话 | `GET /api/im/web/v3/chats?limit=100`、`/api/im/web/chats/group`、`/api/sns/v1/im/web/get_recent_chats` | `data.chats[]{chat_user_id | group_id, info{nickname|group_name,avatar}, last_msg_time, last_msg_content}`；`user_list[]` 为最近会话 |
| 私信消息 | 未获得 | 网页版 `/im` 面板本机返回 HTTP 504，点到会话才会发消息接口 |

两个易踩的坑：

1. 笔记链接的 `xsec_source` 必须与 token 来源一致：搜索来的 token 用 `pc_search`、信息流用 `pc_feed`、主页用 `pc_user`，否则服务端降级到 H5 页（`/api/sns/h5/v1/note_info`），拿不到详情。
2. 裸 `https://www.xiaohongshu.com/explore/<id>` 无 token 会进 H5；`xhs_collect mode=note` 会明确报错而不是落错数据。
