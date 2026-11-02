# side-chat 交接文档（v0.2）

> 插件包名 `dsh-side-chat`，版本 `0.2.0`，位于 `/Users/seal/Desktop/myNote/dsh-dev/side-chat`。
> v0.2 是一次架构重写：侧聊**不再是 fork 出来的持久 session**，而是「点击创建、关闭即销毁、重启即消失」的内存态会话，上下文**每次请求实时读取主会话日志**构建。
> v0.1.1 的 fork 方案与本文附录 §11 对照。

---

## 1. 这是什么

给 DSH 的**同一个主会话**配一个右侧栏的「只读旁路」：

- 点会话头部分支图标 → Host 创建一个**全新的子 Agent**（不是 fork，不复制主会话历史）；
- 子会话上下文 = 主会话**当前**的模型可见消息（每次请求实时读、差量注入）+ 侧聊自己的问答；
- 侧聊界面只显示它自己的对话，主会话内容以隐藏的 context 注入，不占界面；
- 侧聊默认只读（read-only sandbox + 工具限制），需要写操作时走审批升级；
- 关闭标签页 = 销毁子 Agent；页面刷新不销毁（Host 还活着，tab 重新挂接）；应用重启后 Host 内存表清空，子会话没有 `header.cwd` → 不出现在会话列表/搜索里、普通 API 也无法 resume，恢复的 tab 会自查并自动关闭。

---

## 2. 当前状态

| 项 | 值 |
|---|---|
| 版本 | 0.2.0（与 0.1.x 语义不兼容：侧聊不可恢复、不再是 fork） |
| 安装方式 | desktop profile 的 `link:` 依赖 |
| 激活状态 | Host 改动需要重启应用后生效；Client 改动刷新页面 |
| 测试 | `node --test side-chat/test/*.test.mjs`（21 条假 ctx / 假 Client 用例） |
| 生效规则 | `client.js` 刷新页面；`index.js` / patch 重启应用 |

---

## 3. 架构

```
浏览器 (client.js)                              Host (index.js)
┌───────────────────────────┐                 ┌────────────────────────────────────┐
│ 头部按钮（主会话才显示）   │  POST /api/     │ sidechat.open                      │
│  └ openSideChat ──────────┼─sidechat.──────▶│  1. 主会话必须 live                │
│                           │  open           │  2. agents.create()：全新子 Agent  │
│ sidebarRight.openResource │                 │     · meta.parentSession=主会话     │
│  └ dsh-resource://sidechat/session/<child>  │     · 无 cwd / 无 seed             │
│                           │                 │     · setup: 纪律段 + 只读限制      │
│ tab type (kind=sidechat)  │                 │              + 实时上下文注入器     │
│  └ SessionProvider        │                 │  3. 进程内 Map 记录，可复用        │
│     └ conversation.content│                 │                                    │
│        (原生 Chat)        │                 │ 每次子 Agent pre-step：            │
│                           │                 │   读主会话 Session.deriveMessages() │
│                           │                 │   → 差量渲染成 sourced user message │
│                           │                 │   → 注入本次请求（UI 隐藏）         │
│                           │  POST /api/     │                                    │
│ 关闭 tab ─────────────────┼─sidechat.close─▶│ handle.dispose() → 子会话冷掉       │
│ 重启后 stale tab 自查 ────┼─sidechat.list──▶│ 只返回仍然 live 的侧聊              │
└───────────────────────────┘                 └────────────────────────────────────┘
```

关键决策：
- **不 fork**：`sessionController.fork` 复制的是静态 seed，无法满足「实时上下文」；改用 `ctx.agents.create` 建空会话。
- **无 `header.cwd`**：DSH 的 `session/list` 与 `session/search` 都会过滤掉 cold 且无 cwd 的会话（见 `dsh-api-session-controller`），这是实现「重启即消失」的关键，不需要删除 API（DSH 没有）。
- **注入走 `agent/pre-step`**：与官方 `dsh-time-context` 同一机制；注入消息是 `source.kind='side-chat-context'` 的 sourced user message，Chat 对非 `user` source 的 context 节点默认隐藏。
- **纪律段走 agent 作用域**：`agentCtx.systemPrompt.section(...)`，随 Agent 生命周期存在，不再需要「标题前缀」持久标记，也不会泄漏到主会话。
- **只读**：子会话追加 `sandbox/mode=read-only`（而主会话的 mode 不复制），并 `tools.restrict` 拒绝写类与跨会话控制类工具。

---

## 4. 文件清单

| 文件 | 职责 |
|---|---|
| `side-chat/index.js` | Host：三条路由、进程内生命周期、子 Agent 创建、实时上下文注入器、只读限制、旧版本清理 |
| `side-chat/client.js` | Client：tab 类型/正文、banner、头部按钮、stale tab 自愈、行隐藏、关闭即销毁 |
| `side-chat/test/host.test.mjs` | 假 Host ctx：open/reuse/并发/close/父会话销毁/上下文注入/压缩重同步/旧版清理 |
| `side-chat/test/client.test.mjs` | 假 Client ctx：注册、open 流程、stale、关闭销毁、结束按钮 |
| `side-chat/package.json` | `dsh.bundle.patch` + `dsh.client`；`exports` 暴露 `./client`、`./locale/*.json`、`./icon`；`test` 脚本 |
| `side-chat/cordis.patch.yml` | `insert: [{id: side-chat, name: dsh-side-chat}]` |
| `side-chat/locale/{zh,en}.json` | 插件页 `meta.title` / `meta.description` |
| `side-chat/icon.svg` | 分支对话图标 |

---

## 5. 对外契约（Host）

### 5.1 `POST /api/sidechat.open`

请求：`{"sessionId": "session-..."}`（主会话 id）

成功 200：`{"sessionId": "session-child", "parentSessionId": "session-parent"}`；重复点击复用同一 child 时附 `"reused": true`。

失败：

| HTTP | code | 触发 |
|---|---|---|
| 400 | `sidechat/bad-request` | body 不是 JSON、缺 `sessionId`、body 超过 8 KiB |
| 400 | `sidechat/nested` | 对一个侧聊会话再开侧聊 |
| 409 | `sidechat/parent-not-active` | 主会话不是 live Agent（冷历史会话需先在主会话发一条消息） |
| 500 | `sidechat/model-unavailable` | 主会话没有可复制的模型路由 |
| 500 | `sidechat/create-failed` | 其他创建失败 |

### 5.2 `POST /api/sidechat.close`

请求：`{"sessionId": "session-child"}`；返回 `{"ok": true, "disposed": <bool>}`。幂等：未知/已销毁返回 `disposed:false`。

行为：`handle.dispose()`（中断 + 卸载 Agent）。不 archive——子会话冷掉后因为无 cwd 自然不可见、不可 resume。

### 5.3 `POST /api/sidechat.list`

返回 `{"items": [{"sessionId": "...", "parentSessionId": "..."}]}`，只含当前进程内仍 live 的侧聊。Client 用它做三件事：隐藏命令面板里的会话行、判断恢复的 tab 是否还有效、头部分支按钮在侧聊会话里隐藏。

### 5.4 实时上下文注入

子 Agent 每次 `agent/pre-step`（waterfall 的最外层）在决定进入 step 后：

1. `ctx.sessions.get(parentId).deriveMessages()` 取主会话当前模型可见消息；
2. 用主会话 `surface.contentGeneration` 判断是否发生 compaction/rewrite：
   - 未变 → 只取 `messages.slice(rendered)` 增量；
   - 变了 → 重新注入完整快照（带 refreshed 说明）；
3. 过滤掉 system/developer 消息与非人类来源的 user 消息（runtime-context、目录提示等）；
4. 渲染成 `[user] ...` / `[assistant] ...` / `[tool] ...` 转录，按字符预算尾部截断（首屏 60k、增量 30k、单条 4k）；
5. 生成 `{role:'user', source:{kind:'side-chat-context', form:'snapshot', sections:[...]}}` 消息，放在用户问题**之前**返回。

注入消息会作为 sourced user message 写进子会话日志（DSH 的 pre-step 注入语义），但 Chat 隐藏该节点；子会话本身不可见，所以没有副作用。

---

## 6. 生命周期语义

| 动作 | 结果 |
|---|---|
| 点头部按钮 | 创建子 Agent；同一主会话重复点是复用；并发点击只创建一次 |
| 页面刷新 | **保留**。Host 内存表还在，tab 恢复后经 `/api/sidechat.list` 校验通过并重新挂接 |
| 关闭 tab（X / 结束时） | **销毁**。Client 在 resource 的 finally 里 POST close（页面卸载时不发）；Host `handle.dispose()` |
| 点「结束侧聊」 | POST close + 关 tab |
| 切换主会话 / 收起右栏 | 不销毁（tab 记录还在） |
| 主会话 Agent 被销毁 | Host 的 `agent/disposed` 监听会连带销毁其侧聊 |
| 应用重启 | Host 内存表清空；子会话 cold 且无 cwd → list/search 不返回、不能 resume；恢复的 tab 自查为 stale → 自动关闭 |
| 插件卸载 | Host effect 释放时销毁全部侧聊 |

---

## 7. 关键 API 契约（本机实测/源码确认）

### Host

| 用途 | 调用 |
|---|---|
| 创建子 Agent | `ctx.agents.create({sessionId, meta:{parentSession, isSeeded:false}, agentOptions, setup})`；`setup(agentCtx, agent)` 在发布前执行 |
| 工具限制 | `agentCtx.get('tools').restrict({deny:[...]})`（必须 agent 作用域，名字必须是可见全局工具） |
| 纪律段 | `agentCtx.systemPrompt.section({name, order, interpolate:false, text})` |
| 实时注入 | `agentCtx.on('agent/pre-step', async (payload, next) => {...}, {prepend:true})` |
| 读主会话 | `ctx.sessions.get(parentId)` → `Session.deriveMessages()` / `surface.contentGeneration` |
| 读投影 | `ctx.sessionProjections.stateOf(session, 'modelSelection' / 'agentPreset')` |
| 改名 | `ctx.get('sessionController').rename({sessionId, title})` |
| 旧版归档 | `ctx.get('workspaceRegistry').archiveSession(id)`（注意：服务名是 `workspaceRegistry`，v0.1.1 写成 `workspaces` 导致归档从未生效） |
| 父 Agent 销毁事件 | `ctx.on('agent/disposed', ({agent}) => ...)` |

### Client

| 用途 | 调用 |
|---|---|
| 服务注入 | `inject = ['slots','locale','sessions','resources','sidebarRight','sidebarRightTabs']` |
| 资源 | `ctx.resources.register({protocol:'sidechat', async *open(addr,{signal}){...}})`；`sessions.retain(childId,{source:'sideChat',signal})`，结束 `release()` |
| tab 类型 | `ctx.sidebarRightTabs.register({id, kind:'sidechat', patterns:['dsh-resource://sidechat/**'], ...})` |
| tab body | slot `sidebar.right.pane.tab`，子槽 `sidebar.sidechat.conversation`（`scope:'session'`） |
| 会话组件 | `SessionProvider({session: reference})` → `renderFactorySlot('conversation.content', {variant:'embedded', phase:'active', hero:false}, {slots:{views}})` |
| 行隐藏 | 注入 `<style>[data-row-key="session:<childId>"]{display:none!important}</style>` |
| 页面卸载判定 | `pagehide` / `pageshow` 事件标志，决定 resource finally 是否发 close |

---

## 8. 验证

### 自动化（假 ctx）

```bash
cd /Users/seal/Desktop/myNote/dsh-dev
node --test side-chat/test/*.test.mjs
```

覆盖：无 fork seed、无 header cwd、setup 注入的配置事件、边界段/工具限制/pre-step 注册、复用、并发、父会话销毁、上下文首快照/增量/压缩重同步/过滤 system+context、旧版 fork 清理、Client 注册/打开/stale/关闭销毁/结束按钮。

### 真实服务栈冒烟（不重启应用）

用安装包里的真实 Host 包在 Electron-as-Node 里跑最小组合，验证 `agents.create(meta, 无 cwd)`、真实 turn 里的 pre-step 注入、边界段装配、dispose 后持久化 header 无 cwd：

```bash
cd /Users/seal/Desktop/myNote/dsh-dev
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  --expose-internals side-chat/test/smoke.real-stack.mjs
```

最近一次结果：`ALL CHECKS PASSED`（child header `cwd:null`、注入 1 条、边界段只进子会话、close 后 agent 消失、持久化 header 无 cwd）。

### 真机（需要一次应用重启）

1. 重启应用，打开主会话，发一条消息（让主 Agent live）。
2. 点头部分支图标 → 右侧出现侧聊 tab；主会话日志中没有 sidechat 事件。
3. 主会话继续发消息，侧聊里提问 → 侧聊能引用主会话新内容；侧聊 transcript 只显示侧聊问答。
4. 关闭侧聊 tab → `/api/sidechat.list` 变空；工作区列表看不到新行。
5. 页面刷新 → 侧聊 tab 恢复且可继续提问（Host 未重启）。
6. 重启应用 → 无侧聊行；恢复的 tab 自动关闭；再点按钮 → 新的 child id。
7. 侧聊里让模型写文件 → 被只读 sandbox 拒绝；主会话 system prompt 中无边界段。

会话日志（验证注入/纪律段）：

```bash
# 侧聊子会话（无 cwd → _no-cwd）
zstd -dc ~/.dsh/sessions/_no-cwd/<child-id>/session.v4.jsonl.zstd | python3 -c '
import sys,json
for line in sys.stdin:
    e=json.loads(line); t=e.get("type")
    if t=="system/message":
        txt=e["data"]["message"]["content"][0]["text"]
        print(e["seq"], "boundary:", "Side conversation boundary." in txt)
    if t=="user/message" and e["data"]["source"]["kind"]=="side-chat-context":
        print(e["seq"], "live-context:", len(e["data"]["content"][0]["text"]))
'
```

---

## 9. 已知限制

1. **日志残留**：DSH 没有 session 删除 API，冷掉的无 cwd 子会话文件会留在持久化根目录 `_no-cwd/` 下，不可见、不可 resume，但占磁盘。可选后续：读 `ctx.sessionPersistence.root` 做 best-effort 清理（风险高，默认不做）。
2. **只读**：侧聊默认 read-only，写操作需审批升级；`bash`/terminal 允许但受 sandbox 约束。
3. **主会话必须 live**：冷历史会话点侧聊会返回 `sidechat/parent-not-active`，需先在主会话发消息激活。
4. **行隐藏是视觉层**：侧聊 live 期间会话列表里的行用 CSS 隐藏，键盘导航/统计仍可能感知该会话；搜索与归档不会出现（Host 已过滤）。
5. **注入重复**：主会话 compaction/rewrite 后一次全量重同步，历史里会保留旧注入快照（模型上下文里可能看到旧内容，属可接受冗余）。
6. **页面刷新保留、应用重启销毁** 是刻意语义：刷新属于同一 Host 进程，重启才是「清理内存」。
7. **旧 v0.1.x 侧聊**：插件启动时会把「父会话子项 + isSeeded + 标题以 `侧聊` 开头」的 fork 归档一次；用户自行改过标题的会漏掉。

---

## 10. 开发循环

```bash
cd /Users/seal/Desktop/myNote/dsh-dev
node --test side-chat/test/*.test.mjs   # Host/Client 逻辑
# 改 client.js  → 浏览器刷新
# 改 index.js   → 重启 DeepSeek Harness（profile 用 link: 安装，Node 按路径缓存 ESM）
```

重新 link（目录再次移动后）：

```bash
cd ~/.dsh/profiles/desktop
node ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs install --offline
```

注意：DSH 的会话沙箱根 = 会话 workspace 路径。用本仓库开发时，先把该目录打开为工作区，在新工作区里开会话。

---

## 11. v0.1.1（fork 方案）回顾与差异

| 维度 | v0.1.1 | v0.2 |
|---|---|---|
| 侧聊实体 | `sessionController.fork` 的持久 session | `agents.create` 的全新子 Agent，无 seed |
| 上下文 | fork 时复制主会话前缀（静态） | 每次 pre-step 实时读主会话、差量注入（动态） |
| 界面 | 全量显示继承历史（长会话滚动量大） | 只显示侧聊自己的对话，主会话上下文隐藏注入 |
| 关闭 | `workspaces` 服务名写错 → archive 从未生效 | `handle.dispose()`，子会话 cold 后不可见 |
| 重启 | 侧聊作为普通 fork 会留在列表里 | 无 cwd → 列表/搜索不返回、不可 resume、tab 自愈关闭 |
| 纪律段 | 全局 section + 标题前缀兜底 | agent 作用域 section，随 Agent 生命周期 |
| 只读 | 靠提示词 | read-only sandbox + 工具限制（提示词作为说明） |
