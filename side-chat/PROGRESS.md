# dsh-side-chat v0.2 进展交接（给接手的 agent）

> **后续排查（2026-11-02，尚未完成真机验收）**：用户已确认「打开侧聊后空白、没有输入框」，画面可见 banner 与结束按钮。**根因已定位：原生日志读取接口不支持无 cwd 会话。**
> 新增错误提示后，真机显示 `侧聊加载失败：session "session-54d62add-f066-4f44-a47f-7f716f3dc143" not found`。真实 asar 中 `dsh-api-session-controller` 的日志读取 `sourceFor()` 在 `observeSession()` 之后无条件检查 `observation.header.cwd`，缺失即拒绝；该规则也作用于 live 会话。因此 §4 的 Host 建会话/Agent 冒烟通过不能证明 Client 可读，这也否定了原方案直接复用 `conversation.content` 的可行性。
> 原生 DevTools（F12）的 Console 捕获到 `Identifier 'PAGE_UNLOAD' has already been declared`；已移除 `client.js` 顶层未使用常量，并增加同 realm 连续加载两次的回归测试。
> 用户已确认改用插件聊天面板：现已移除子 Session retain 和原生 conversation.content 接入，新增 read/send/cancel 接口、输入框、流式文本、停止与错误提示；生命周期保持不变。**28 条单测通过**，真实服务栈通过插件接口验证发送/回复、最新主会话日志注入与隐藏上下文过滤；真机已确认输入框、主会话连接状态与用户消息送达；模型测试回合被关闭面板中断，完整回答/页面刷新/关闭重开仍待真机验收。UI 已按主页面主题改造并复用原生 MarkdownText。
> 安装版的 Cmd+R 不可靠：桌面源码仅在 development 模式提供 reload 菜单。可从原生 DevTools Console 执行 `location.reload()`。内置 NodeJS 诊断面板的 Client ingest WebSocket 当前连接失败，不能据该面板「无错误」排除 Client 问题。

## 以下为 18:25 原始交接记录（当前状态以上述更新为准）

> 更新时间：2026-11-02 18:25（Asia/Shanghai）
> 分支：`feat/side-chat-lifecycle-context`，最后代码提交：`de4f0b7`（本地，**未 push**）
> 一句话结论：**Host 侧已实现并在真机验证通过；Client 侧在真机上未达到预期，用户反馈「功能没有实现」，根因尚未定位。**
> 阅读顺序建议：本文档 §5（当前故障）→ §6（调试工具箱）→ §10（下一步）；实现细节见 [HANDOFF.md](HANDOFF.md)。

---

## 1. 用户需求（原话 + 解读）

### 1.1 原始需求（v0.1.1 → v0.2 的方向性变更）

用户原话：

> 1. 【侧聊】只是一个能在侧边存在的 fork session，这并非我的本意，他的生命周期应该是通过点击生成，然后在关闭或者重启等清理内存的时候消失
> 2. 【侧聊】的上下文构建应该是实时阅读 session log 而不是直接通过 fork 的格式继承，一个是动态一个是静态的

### 1.2 用户拍板（18:14 前）

- 只读策略 OK（侧聊只负责讲解/非 fork 工作）
- 页面刷新**不**销毁（用户明确说 Codex 侧聊「刷新就没了」是缺点）
- 旧 v0.1.x fork 侧聊自动归档
- 按方案 A（无 cwd 的 fresh session + pre-step 实时注入）开发

### 1.3 最新反馈（18:14 与 18:2x，含歧义，接手需先确认）

- 18:14：`第一次打开设置对话框，从session log读取信息，不一定要在主对话结束之后才能问答`
- 18:2x：`而且现在功能也没有实现啊`

解读（未确认，按可能性排序）：

1. **「设置对话框」大概率是「侧聊对话框」的语音/输入误差**。含义：首次打开侧聊就应基于 session log 立即可问答，不需要等主对话回合结束。
2. 也可能指：从**冷的历史会话**打开侧聊时不该要求主会话先激活（当前实现会返回 `409 sidechat/parent-not-active`，见 HANDOFF §5.1）。
3. 「功能没有实现」= 打开侧聊面板后看不到/无法使用对话（见 §5 现象证据）。

**接手第一步：向用户要一张侧聊面板截图，并确认这句话的真实含义。**

---

## 2. 需求 → 实现对照

| 需求 | Host 状态 | Client 状态 | 证据 / 说明 |
|---|---|---|---|
| 点击创建、进程内内存态、非 fork | ✅ | ❓ | `ctx.agents.create`（无 seed、无 cwd）+ 进程内 Map；真机 HTTP 验证 create/reuse |
| 关闭即销毁 | ✅ | ❓ | `handle.dispose()`；真机 close → list 为空 |
| 应用重启后消失、列表/搜索不可见、不可 resume | ✅ | ❓ | `header.cwd` 缺失 → Host `list()`/`search()` 过滤 cold 行；真实栈持久化 header 已验证 |
| 页面刷新保留 | ✅ | ❓ | resource 重新挂接 + stale 自愈（未真机验证） |
| 上下文实时读 session log | ✅ | — | `agent/pre-step` 读主会话 `deriveMessages()` 差量注入；真实 agent-loop 冒烟通过 |
| 首次打开即可问答、主对话运行中也可 | ✅ 设计支持 | ❓ | open 只要求 parent live；注入只含 **durable** 日志，流式中未落盘内容看不到 |
| 只读 | ✅ | — | `sandbox/mode=read-only` + `tools.restrict` |
| 旧 v0.1.x fork 侧聊自动归档 | ✅ 真机验证 | — | 两个旧 fork 已进 `archivedSessionIds` |
| **Client 侧整体可用** | — | ❌ | 用户反馈「功能没有实现」，见 §5 |

---

## 3. 已提交内容（commit `de4f0b7`）

| 文件 | 内容 |
|---|---|
| `side-chat/index.js` | Host 重写（801 行）：`/api/sidechat.open|close|list`、`agents.create` 建全新子 Agent、进程内 registry、并发去重、父会话销毁联动、`agent/pre-step` 实时上下文注入、只读限制、旧版 fork 归档 |
| `side-chat/client.js` | Client 改造（527 行）：tab 类型/正文、banner、头部按钮、stale tab 自愈、live 行隐藏、关闭即销毁 |
| `side-chat/test/host.test.mjs` | 假 Host ctx 单测（14 条） |
| `side-chat/test/client.test.mjs` | 假 Client ctx 单测（8 条） |
| `side-chat/test/smoke.real-stack.mjs` | 真实 DSH 包组合冒烟（Electron-as-Node） |
| `side-chat/HANDOFF.md` | v0.2 设计/契约/验证/限制（已重写） |
| `side-chat/package.json` | 版本 0.2.0，`test` 脚本 |
| `side-chat/locale/*.json` | 文案 |
| `README.md` | 布局/开发循环/验证 |

阶段进度：P0（feasibility）→ P3（Client 代码）已完成；P4（真机验收 + push）**未完成**。

本次交接新增（随文档一起提交）：`side-chat/test/host-api.mjs`（真机 Host 路由探测脚本）、本文件 `side-chat/PROGRESS.md`。

---

## 4. 验证证据（Host 侧已充分验证）

### 4.1 自动化测试

```bash
cd /Users/seal/Desktop/myNote/dsh-dev
node --test side-chat/test/*.test.mjs     # 22 pass, 0 fail
```

覆盖：无 fork seed / 无 header cwd / setup 注入的配置事件 / 边界段 + 工具限制 + pre-step 注册 / 复用 / 并发 / 父会话销毁 / 上下文首快照 + 增量 + compaction 重同步 / system 与 runtime-context 过滤 / 旧 fork 清理 / Client 注册、open、stale、关闭销毁、结束按钮。

### 4.2 真实服务栈冒烟（不重启应用）

```bash
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  --expose-internals side-chat/test/smoke.real-stack.mjs
```

最近输出（全部通过）：

```text
[side-chat smoke] child header: {"cwd":null,"parentSession":"session-parent","isSeeded":false}
[side-chat smoke] live-context injections: 1
[side-chat smoke] stored child header: {"cwd":null,"parentSession":"session-parent"}
[side-chat smoke] ALL CHECKS PASSED
```

验证内容：真实 `agents.create` 接收 `meta.parentSession` / `isSeeded:false` / 无 cwd；真实 turn 的 pre-step 注入恰好 1 条并含主会话内容；边界段只进子会话、不泄漏主会话；close 后 agent 消失；持久化 header 无 cwd。

### 4.3 真机 Host 实测（应用 18:11 重启后，GUI 端口 58125）

用 `node side-chat/test/host-api.mjs 58125 session-0984c82a-4301-4200-be80-1769aa1d3e01` 实测（脚本自动从 Electron Cookies sqlite 找 dsh-auth cookie）：

```text
list before: {"items":[]}
open #1: {"sessionId":"session-97febbc4-...","parentSessionId":"session-0984c82a-..."}
open #2 (expect reused:true): {"sessionId":"session-97febbc4-...","reused":true}
list during: {"items":[{"sessionId":"session-97febbc4-...","parentSessionId":"session-0984c82a-..."}]}
close: {"ok":true,"disposed":true}
list after: {"items":[]}
HOST API OK
```

结论：**Host 路由、registry、复用、销毁在真机上全部正常。**

### 4.4 旧 v0.1.x 侧聊归档（真机验证）

v0.1.1 的 fork 侧聊在 v0.2 启动时被归档（`~/.dsh/storages/workspace.json` 的 `archivedSessionIds`）：

- `session-188a9827-7727-4a8d-8c12-9819f36096e0`（标题 `侧聊 · Codex 侧边聊天插件开发计划`）
- `session-fdcf3f65-f4bd-487f-9eee-2e410adaec3b`（标题 `侧聊 ·`）

顺带确认 v0.1.1 的隐藏 bug：旧代码 `ctx.get('workspaces')` 取到的服务是 `undefined`（正确服务名是 `workspaceRegistry`），所以 v0.1.1 的「结束侧聊 → 归档」从未生效。

### 4.5 侧聊子会话日志（说明 Host 建会话正常、但用户从未成功发过消息）

所有侧聊子会话在 `~/.dsh/sessions/_no-cwd/<child-id>/session.v4.jsonl.zstd`，header 形如：

```json
{"type":"session","version":4,"cwd":null,"parentSession":"session-...","isSeeded":false,...}
```

事件只有 5 条（+header）：`permission/preset`、`approval/policy`、`working-directory/change`、`sandbox/mode`、`session/title`。
**没有任何 `turn/start` / `user/message` / `assistant/message`。** 即用户点击后创建了侧聊，但从未有 prompt 被送进侧聊 Agent。

### 4.6 时间线（用户真机操作 vs Host 记录）

| 时间 | 事件 |
|---|---|
| 18:11 | 应用重启（端口 64373 → 58125），加载 v0.2 |
| 18:12:38 | 从主会话 `session-af4421d7`（当时 turn 2 运行中）点击侧聊 → 创建 `_no-cwd/session-86d8cd6d` |
| 18:12:54 | 从主会话 `session-0984c82a` 点击侧聊 → 创建 `_no-cwd/session-4f43d451` |
| 18:14:53 | 用户发出反馈消息（本文档 §1.3） |
| 18:17:15 | 再次从 `session-af4421d7` 点击 → 创建 `session-42971ee7` |
| 18:18:33 | 再次从 `session-0984c82a` 点击 → 创建 `session-f9cf4b01` |
| ~18:19 | 我（诊断）通过 HTTP 创建 `session-24094363`，随后 close 清理 |

每个子会话都在下一次点击前被销毁（说明 close 路径被触发：用户点「结束侧聊」或关 tab），最终 `/api/sidechat.list` 为空。

### 4.7 localStorage 证据（tab 曾创建并被关闭）

`~/Library/Application Support/@deepseek-ai/dsh-desktop/Local Storage/leveldb/000013.log` 中：

```json
dsh.sidebar-right.v1.session-0984c82a-... = {"bySession":{... "layout":{...,"tabs":{}...},"minted":5}}
dsh.sidebar-right.v1.session-af4421d7-... = {"bySession":{... "layout":{...,"tabs":{}...},"minted":1}}
```

`minted` 非零 = 创建过 tab；最终 `tabs:{}` = tab 被关闭。结合 4.5/4.6 可推断：**side tab 确实打开过，但又关闭了；用户始终没有发出侧聊消息。**

---

## 5. 当前故障（未定位）：Client 侧

### 5.1 现象

- 用户多次点击头部按钮；Host 每次创建子会话；tab 记录出现后又消失。
- 所有子会话都没有任何 turn / 用户消息。
- 用户结论：「功能没有实现」。

### 5.2 已排除

- Host `open/list/close` 路由、registry、复用、销毁 —— 真机 curl 验证通过（§4.3）。
- Host 建会话参数（无 cwd、parentSession、isSeeded、policy 事件）—— 真实栈 + 真机日志验证。
- 上下文注入链路 —— 真实 agent-loop 冒烟通过。
- 旧 fork 归档 —— 真机验证。
- 主会话必须有完整 turn —— 已不存在该限制（只要求 live agent）。

### 5.3 可推断

子会话能被 close 销毁，只有两种来源：**Client 的「结束侧聊」按钮**（需要 resource value 里有有效 sessionId）或 **resource 的 finally**（tab 被移除且 resource 已 retain 成功）。二者都说明 **side tab body 曾拿到有效 resource**，因此问题更可能出在：

- conversation 正文/输入区渲染不正常（面板空白、没有 composer、或错误态），用户看到「没实现」后关闭；或
- 用户 UX 预期差异：面板本来就是空聊天（主会话上下文是隐藏注入），用户以为没实现。

### 5.4 怀疑点（按优先级）

1. **H1**：`conversation.content` factory 对 **blank + 无 cwd** 的 session 不渲染 composer / 内容（v0.1.1 的侧聊有继承历史 → 非 blank；v0.2 是全新 blank session，这是最大的环境差异）。
2. **H2**：`sessions.retain(childId)` 与 client session 目录竞态：Host 侧 live 行存在，但 client `sessions.refresh()` 尚未完成，binding 空白/异常。
3. **H3**：我们的 `SideChatConversation` 强制 `phase:'active', hero:false`，对 blank session 的 shell 分支不成立（View 未激活 / composer 不显示 / 抛错）。
4. **H4**：tab body React 异常 → 面板空白或 error 态（需要 Client console）。
5. **H5**：resource open 在 `liveIds()` / `retain` 处异常 → 一直显示「正在创建侧聊…」。
6. **H6**：UX 预期差异（见 §5.3 第二条）——需要产品上显式提示「已读取主会话上下文 / 可以直接提问」，或展示折叠的主会话上下文预览。

### 5.5 最快诊断路径（建议按顺序）

1. **打开 DSH 内置 inspector 面板（Ctrl/Cmd+Shift+.）→ Client Console**，点一次侧聊按钮，抓 console error / React 报错。这是最快路径（inspector 已随 profile 启用）。
2. 若 console 无错误，直接在 Client realm 查 DOM：
   - `document.querySelectorAll('[data-side-chat]').length`（tab body 是否挂载）
   - `document.querySelectorAll('[data-composer-seat]').length`、`[data-conversation-content]`（composer/内容区是否渲染）
   - `fetch('/api/sidechat.list',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.text())`（页面凭据下验证 Host）
   - 连接方式见 §6.3。
3. **A/B 对比**：`git show c25f365:side-chat/client.js` 是 v0.1.1 能正常显示侧聊的版本。先临时恢复它的 `SideChatConversation`（phase/hero 计算 + `useSessions`）看是否恢复渲染，快速定位是「blank session」还是「我们的改动」。
4. 若确认 `conversation.content` 无法用于 blank cwd-less session，二选一：
   - a) 让 side session 先有首条事件（例如在 setup 里 append 一条隐藏的 source 非 `user` 的 context/user 消息，使 session 非 blank；注意 UI 不可见且不要污染模型意图）；
   - b) 放弃 `conversation.content`，实现一个最小自定义聊天面板（消息列表 + streaming + composer），或改成「侧聊只在主会话有内容后才显示」。
5. 修复后走 §7 验收清单。

---

## 6. 调试工具箱

### 6.1 环境事实

| 项 | 值 |
|---|---|
| GUI 端口 | runtime context 里 `http://127.0.0.1:<port>`；**每次重启变化**（本次：58125） |
| 进程 | `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`（本次 PID 15926；`ps` 可能被沙箱禁止） |
| profile | `~/.dsh/profiles/desktop`（`dsh-side-chat` 用 `link:` 指向本仓库） |
| 生效规则 | 改 `index.js` → **重启应用**；改 `client.js` → 刷新页面 |
| 运行栈 | dsh 0.2.1-rc.5，Electron 44，Chrome 152，Node 24.21（Host 是 ELECTRON_RUN_AS_NODE 子进程） |
| 工作区 | `/Users/seal/Desktop/myNote/dsh-dev`（DSH 沙箱根=工作区，`~/.dsh` 只读）、本会话 profile=desktop |

### 6.2 Host HTTP API 探测（已脚本化，推荐）

```bash
cd /Users/seal/Desktop/myNote/dsh-dev
node side-chat/test/host-api.mjs <gui-port> <live-main-session-id>
# 例：node side-chat/test/host-api.mjs 58125 session-0984c82a-4301-4200-be80-1769aa1d3e01
# 期望最后一行：HOST API OK
```

脚本做的事：从 `~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies`（sqlite）里按 cookie payload 的 `authority` 匹配端口找到 `dsh-auth-*` cookie，然后依次 list → open → open(reuse) → list → close → list 并断言。

手工 curl 取 cookie：

```bash
sqlite3 -separator '=' "$HOME/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies" \
  "select name,value from cookies where host_key='127.0.0.1';"
# 解 base64url 第二段，找 {"authority":"127.0.0.1:<port>"} 那一行
```

### 6.3 Client realm / inspector

- **最推荐：DSH 内置 inspector 面板**（Ctrl/Cmd+Shift+.）→ Console，里面能看到 Host + 当前页面 Client 的 console / 错误。
- raw CDP：`http://127.0.0.1:9230/json/list` 只有 Host realm（Electron-as-Node；`import('electron')` 不可用，`require('electron')` 也失败）。Host realm 可 `Runtime.evaluate`，可用来执行 Host 内代码。
- 认证 relay：`ws://127.0.0.1:<gui-port>/inspector/devtools/cdp`，带 `Cookie: dsh-auth-...` 头可 101 升级（已实测）。理论上 `Runtime.enable` 后会列出 Host + 所有已连接 Client 的 execution context（无 `clientSourceId` 参数 = 全部）；本次未完成 Client context 的实测。Node 全局 `WebSocket` 不支持自定义 Cookie 头，需要 `node:net` 手写握手：

```js
const socket = net.connect(guiPort, '127.0.0.1')
socket.write([
  'GET /inspector/devtools/cdp HTTP/1.1',
  `Host: 127.0.0.1:${guiPort}`,
  'Upgrade: websocket', 'Connection: Upgrade',
  `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
  'Sec-WebSocket-Version: 13',
  `Cookie: ${cookie}`,
  '', ''
].join('\r\n'))
// 读到 101 后：CDP JSON 用 mask=1 的 text 帧发送；服务端帧可能分片，需要按 FIN 组装。
// 然后 Runtime.enable → 收集 Runtime.executionContextCreated → 在 Client context 里 Runtime.evaluate。
```

### 6.4 会话日志读取

| 内容 | 路径/方法 |
|---|---|
| 主会话日志 | `~/.dsh/sessions/--Users-seal-Desktop-myNote-dsh-dev--/<session-id>/session.v4.jsonl.zstd` |
| 侧聊日志（无 cwd） | `~/.dsh/sessions/_no-cwd/<child-id>/session.v4.jsonl.zstd` |
| 解码 | `zstd -dc <file> \| python3 -c '...逐行 json.loads...'` |
| 第一行 | `{"type":"session",...}` **header 在顶层**（不是 `data.` 包裹），含 `cwd/parentSession/isSeeded` |
| 验证纪律段 | `system/message` 的 `data.message.content[0].text` 是否含 `Side conversation boundary.` |
| 验证实时注入 | `user/message` 且 `data.source.kind === 'side-chat-context'` |
| 验证是否 fork | header `isSeeded` 应为 `false`；`cwd` 应为缺失 |

### 6.5 测试命令

```bash
node --test side-chat/test/*.test.mjs      # 22 条
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  --expose-internals side-chat/test/smoke.real-stack.mjs
```

### 6.6 DSH 源码（读取方法）

app 是打包分发：`"/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"`。Node/Electron-as-Node 可直接 import asar 内路径：

```js
const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai'
const { Context } = await import(`file://${ASAR}/cordis/lib/index.js`)
```

本次已提取到 `/tmp/dshsrc/ai/dsh/node_modules/@deepseek-ai`（机器重启会丢，可重新解析 asar header 提取）。本次参考的关键包：

`dsh-session`、`dsh-session-projection`、`dsh-action`(无)、`dsh-agent`、`dsh-agent-loop`、`dsh-system-prompt`、`dsh-tools`、`dsh-api-session-controller`、`dsh-client-ui-conversation`、`dsh-client-ui-chat`、`dsh-client-ui-sidebar-right`、`dsh-experimental-inspector`。

---

## 7. 真机验收清单（修通 Client 后逐项过）

1. 主会话发一条消息 → 点头部分支图标 → 右侧出现侧聊 tab（面板非空白、有 composer）。
2. 主会话继续发消息 → 侧聊提问「刚才主会话说了什么」→ 回答包含新内容（实时上下文生效；UI 里看不到注入行）。
3. 关闭侧聊 tab → 侧聊结束（`/api/sidechat.list` 为空、侧边栏无残留行）；再点按钮 → 新 child id。
4. 页面刷新 → 侧聊 tab 保留、可继续提问。
5. 重启应用 → 侧聊消失、无残留行；恢复的 tab 自动关闭。
6. 侧聊里要求写文件 → 被只读 sandbox 拒绝（审批升级才可能放行）。
7. 主会话 `system/message` 零边界段泄漏；侧聊子会话有边界段。
8. 主会话运行中开侧聊可立即提问（用户最新关注点）。

---

## 8. 已知限制 / 踩过的坑

1. **无 Session 删除 API**：关闭的侧聊日志留在 `~/.dsh/sessions/_no-cwd/<id>/`，不可见、不可 resume，但占磁盘（HANDOFF §9）。
2. **header 无 cwd 是「重启后消失」的关键**：Host `session/list`/`search` 过滤 cold 且无 cwd 的行；代价是 sandbox workspaceRoot 走部署 fallback，所以侧聊强制 `sandbox/mode=read-only`，文件/搜索工具靠 `working-directory` projection 拿父 cwd。
3. **冷父会话**：open 要求 parent 是 live Agent，否则 `409 sidechat/parent-not-active`；用户「从 session log 读取」可能要求支持冷父会话（待确认，见 §1.3、§10）。
4. **只有 durable 日志**：主会话正在流式输出、尚未落盘的 assistant 内容不在注入快照里；若用户要求「主对话结束前就能问正在生成的内容」，需要另外消费 `agent/assistant-stream`。
5. **注入是 durable user/message**（source `side-chat-context`）：Chat 隐藏该节点，但会进侧聊日志；主会话 compaction/rewrite 后会做一次全量重同步（历史里可能保留旧快照）。
6. **v0.1.1 的 archive bug**：`ctx.get('workspaces')` 应为 `workspaceRegistry`，旧版从未真正归档；已在 v0.2 修正（legacy cleanup）。
7. **preset mount / 工具限制失败只 warn**：侧聊仍有全局组合与 read-only sandbox 兜底。
8. **页面刷新保留、应用重启销毁** 是刻意语义，不要「修掉」。
9. **tab 是否关闭** 只能从 localStorage `dsh.sidebar-right.v1.<sessionId>` 反推（`minted` / `tabs`）。

---

## 9. 仓库/环境状态

- 分支：`feat/side-chat-lifecycle-context`
- 提交：`de4f0b7 feat: dsh-side-chat v0.2 内存态只读侧聊 + 实时上下文`（**本地，未 push**）
- 上一版：`c25f365 feat: dsh-side-chat 侧聊插件 v0.1.1`
- 工作区：无未提交代码改动；本文件与 `host-api.mjs` 随文档提交（若下一位 agent 继续改代码，注意还会产生新提交）。
- 真机当前状态：`/api/sidechat.list` 为空（诊断创建的 side chat 均已 close 清理）；`_no-cwd/` 下有 5 个历史测试子会话日志（不可见，属预期残留）。

---

## 10. 建议的下一步（给接手的 agent）

1. **先对齐需求**：要截图 + 确认 §1.3 的真实含义（首次打开要看到什么？是否要求主对话未结束时就能问？是否要支持冷历史会话？）。
2. **定位 Client**：内置 inspector 面板看 Client console → 按 §5.5 的 A/B 快速定位 blank-session 假设。
3. **修通 UI**：优先让侧聊面板「打开即有可用聊天界面」；若 `conversation.content` 在 blank cwd-less session 上不可用，按 §5.5-4 的二选一处理。
4. **补用户点名的缺口**：
   - 冷父会话支持（读 persisted session log 做首快照，见 §1.3-2）；
   - 若需要，UI 上显式展示「已读取主会话上下文」的提示或折叠预览（解决 H6 预期差）；
   - 若需要，主对话流式中的实时内容（`agent/assistant-stream`）。
5. **走完 §7 验收 → 用户确认 → push**（用户之前要求验收后再 push）。
6. **不要做**：不要改 asar 内核；不要因为 Host 单测/冒烟通过就认为功能可用；不要在没有 Client console 证据前大改架构。
