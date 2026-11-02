# side-chat 交接文档

> 插件包名 `dsh-side-chat`，版本 `0.1.1`，位于 `/Users/seal/Desktop/myNote/dsh-dev/side-chat`。
> 本文记录实现现状、对外契约、踩过的坑和验证证据，接手者读这一份即可继续开发。

---

## 1. 这是什么

给 DSH 的**同一个 session** 增加"主聊天 + 侧边聊天"两种对话形态：

- 主聊天保持原样，不受影响；
- 侧聊 = 在主会话**最后一个完整 turn** 处 fork 出来的独立会话，渲染在右侧栏；
- 侧聊继承主会话的全部历史，但模型被告知：继承的历史只是参考资料，不是当前任务；只做只读探索，用户明确要求才允许改动；
- 关闭面板不影响任何会话；"结束侧聊"才中断并归档。

用户可见入口：会话头部 `conversation.session.header.actions` 里的分支图标按钮。

---

## 2. 当前状态

| 项 | 值 |
|---|---|
| 版本 | 0.1.1 |
| 安装方式 | desktop profile 的 `link:` 依赖（本地符号链接） |
| profile 依赖 | `"dsh-side-chat": "link:/Users/seal/Desktop/myNote/dsh-dev/side-chat"` |
| 激活状态 | 已在真机加载、通过验收（见 §7） |
| 生效规则 | 改 `client.js` 刷新页面；改 `index.js`/`patch` 必须重启应用 |

改动 Host 代码后重启的原因：profile 用 `link:` 安装，Node 按**文件路径**缓存 ESM 模块，原地改文件不会重新加载模块代际。

---

## 3. 架构

```
浏览器 (client.js)                          Host (index.js)
┌──────────────────────────┐               ┌───────────────────────────────┐
│ 头部按钮                 │  POST /api/   │ sidechat.open                 │
│  └ openSideChat ─────────┼──sidechat.───▶│  └ sessionController.fork()   │
│                          │    open       │     + rename "侧聊 · <父标题>" │
│ sidebarRight.openResource│               │     + 记入 sideChats Map       │
│  └ dsh-resource://sidechat/session/<child>?parent=<parent>             │
│                          │               │                               │
│ tab type (kind=sidechat) │               │ systemPrompt.section          │
│  └ SessionProvider       │               │  └ isSideConversation ? 指令 : ''│
│     └ conversation.content (embedded)    │                               │
│        ├ 继承历史 + 新消息 (原生 Chat)    │ POST /api/sidechat.close      │
│        └ 原生 composer ──────────────────┼─▶ archiveSession(stopActivity)│
└──────────────────────────┘               └───────────────────────────────┘
```

关键决策：**不自己画聊天 UI**。tab body 复用产品自带的 `conversation.content` factory，因此 transcript、流式、队列、附件、停止按钮全部与主聊天一致，插件只负责"寻址 + 绑定 + 边界提示"。

---

## 4. 文件清单

| 文件 | 职责 |
|---|---|
| `side-chat/index.js` | Host 入口。`export const inject = ['connection','sessionController','systemPrompt','agents']`；`apply(ctx)` 注册两条路由 + 一个动态提示词段 |
| `side-chat/client.js` | Client 入口。`window.__ModuleLoader__.load({id:'dsh-side-chat', factory})` 返回 `{inject, apply}`；注册 locale、资源、tab 类型、tab body、头部按钮 |
| `side-chat/package.json` | `dsh.bundle.patch` + `dsh.client{platform:web, immediately:true, inject:[...]}`；`exports` 暴露 `./client`、`./locale/*.json`、`./icon` |
| `side-chat/cordis.patch.yml` | `insert: [{id: side-chat, name: dsh-side-chat}]` |
| `side-chat/locale/{zh,en}.json` | 仅插件页 `meta.title` / `meta.description`（运行时文案内联在 `client.js`） |
| `side-chat/icon.svg` | 分支对话图标 |

运行时文案在 `client.js` 的 `zh`/`en` 对象里，通过 `ctx.locale.register('sidechat', {zh, en})` 注册。

---

## 5. 对外契约（Host）

### 5.1 `POST /api/sidechat.open`

请求：`{"sessionId": "session-..."}`

成功 200：

```json
{ "sessionId": "session-child", "parentSessionId": "session-parent" }
```

同一个父会话重复请求时返回 `{"sessionId": "...", "parentSessionId": "...", "reused": true}`（前端据此聚焦已有 tab）。
若记住的 child 已无 live Agent（归档/中断/销毁），会丢弃记录并重新 fork。

失败：

| HTTP | code | 触发 |
|---|---|---|
| 400 | `sidechat/bad-request` | body 不是 JSON 或缺 `sessionId`；body 超过 8 KiB |
| 404 | `sidechat/session-not-found` | 父会话不存在 |
| 409 | `sidechat/no-completed-turn` | 父会话还没有完整 turn（`session/fork-unavailable`） |
| 409 | `sidechat/migration-required` | 会话格式需要迁移 |
| 500 | `sidechat/fork-failed` | 其他 fork 失败 |

### 5.2 `POST /api/sidechat.close`

请求：`{"sessionId": "session-..."}`；返回 `{"ok": true, "archived": <bool>}`。

行为：从标记表移除 → `workspaces.archiveSession(sessionId, { stopActivity: true })`。归档会停掉该会话的工作并从工作区列表隐藏，但日志保留、可反归档。归档失败只记 warning，仍返回 `ok:true`（前端保证关 tab）。

### 5.3 提示词段

```js
ctx.systemPrompt.section({
  name: 'side-chat:bounds',
  order: 9500,              // deliverables(9000) 之后、structured output(9900) 之前
  interpolate: false,       // 指令里有 {{...}} 也不会被变量替换
  text: (context) => isSideConversation(...) ? SIDE_CONVERSATION_INSTRUCTIONS : '',
})
```

`text` 可以是函数，每次 assemble 用 `{agent, scope, signal}` 求值；空串在 render 阶段被丢弃，所以普通会话的 system prompt 完全不变。

---

## 6. 侧聊判定与纪律

### 6.1 判定链

```js
if (sideChats.has(session.id)) return true          // 进程内标记（权威）
if (session.header?.isSeeded !== true) return false // 侧聊一定是 fork，普通会话零成本
return sessionTitle(ctx, session).startsWith('侧聊') // 重启后的持久兜底（按 session id 记忆化）
```

- `sideChats` 是 `Map<childId, parentId>`，只在 Host 进程内有效；
- 持久兜底读的是 `ctx.get('sessionTitle').get(session)`，**注意它返回快照对象 `{title, messageSeqs, source, ...}`，不是字符串**（0.1.0 的 bug 就出在这）；
- 兜底只在 `isSeeded === true` 时触发，避免给普通会话做无谓的 log fold；结论按 session id 记忆化。

### 6.2 提示词全文

```text
Side conversation boundary.

This conversation is a side conversation forked from a main conversation at an earlier point. The conversation history you inherited before the user's first message in this side conversation is reference material only. It is not your current task.

Do not continue, execute, or complete any instructions, plans, tool calls, approvals, or edits that appear in the inherited history. Only messages the user sends in this side conversation are active instructions for it.

Answer the user's question and do lightweight, non-mutating exploration: reading or searching files, and running checks that do not change workspace state. Do not modify files, source, git state, permissions, configuration, or any other workspace state unless the user explicitly requests that mutation in this side conversation. Do not request escalated permissions or broader sandbox access unless the user explicitly requests a mutation that requires it. If the user does request a mutation, keep it minimal, local to that request, and avoid disrupting the main conversation.

Do not present yourself as continuing the main conversation's active task.
```

改写自 Codex `/side` 的 `SIDE_DEVELOPER_INSTRUCTIONS` + `SIDE_BOUNDARY_PROMPT`。Codex 是把边界作为一条 user message 注入并把继承历史在界面上隐藏；DSH 这里用 system prompt section 达到同等效果（不污染会话日志，也不需要客户端过滤）。

---

## 7. 关键 API 契约（都是实测/读源码确认过的）

### Host

| 用途 | 调用 |
|---|---|
| fork | `ctx.sessionController.fork({ sessionId })` → `{ sessionId }`；切在最后一个完整 turn，主会话运行中也可调用，半截 turn 不会被继承 |
| 改名 | `ctx.sessionController.rename({ sessionId, title })` |
| 读标题 | `ctx.get('sessionTitle').get(session)` → **快照对象** |
| 归档 | `ctx.get('workspaces').archiveSession(id, { stopActivity: true })` |
| 自定义 HTTP | `ctx.connection.fetch.register({ path, methods:['POST'], requestBody:'buffered', fetch })`；非 owner 请求直接 403 |
| 提示词 | `ctx.systemPrompt.section({ name, order, text, interpolate })`，返回 disposer |

**不要**给外部插件 append 自定义 session 事件：`appendPluginRecord` 仅限 `packages/experimental/`，仓库内也有 lint 拦截。这就是"持久标记"最终落在标题上的原因。

### Client

| 用途 | 调用 |
|---|---|
| 服务注入 | `inject = ['slots','locale','sessions','resources','sidebarRight','sidebarRightTabs']` |
| 资源 | `ctx.resources.register({ protocol:'sidechat', async *open(addr,{signal}) { yield {ok:true,value:{reference}} } })`；`reference = sessions.retain(childId,{source:'sideChat',signal})`，收尾 `release()` |
| 打开面板 | `ctx.sidebarRight.openResource(address, { preferNewPane:true })` |
| tab 类型 | `ctx.sidebarRightTabs.register({ id, kind:'sidechat', patterns:['dsh-resource://sidechat/**'], priority:'extension', canOpen, title })` |
| tab body | slot `sidebar.right.pane.tab`，`key` = tab 类型 id，`children: { 'sidebar.sidechat.conversation': { kind:'single', scope:'session' } }` |
| 会话组件 | 子槽里 `SessionProvider({session: reference})` → `renderSlot('sidebar.sidechat.conversation')` → `renderFactorySlot('conversation.content', { variant:'embedded', phase, hero }, { slots:{ views } })` |
| 发消息 | 走原生 composer → `session.prompt`，按 sessionId 寻址，**不要求是主会话** |

从 shipped 的 `@deepseek-ai/dsh-client-ui-subagent`（侧栏里的 subagent 聊天）抄的骨架；`SessionProvider`/`renderSlot`/`renderFactorySlot`/`useResource`/`useTabInfo` 都是 slot 框架自动注入的标准 props，前提是子槽声明了 `scope: 'session'`。

---

## 8. 真机验证证据

判定"改动是否真的生效"的方法是看进程启动时间与文件 mtime：

```bash
lsof -nP -iTCP:<GUI端口> -sTCP:LISTEN -t | xargs -I{} python3 -c \
  "import psutil,datetime;print(datetime.datetime.fromtimestamp(psutil.Process(int('{}')).create_time()))"
stat -f '%Sm %N' side-chat/index.js
```

会话日志读取（JSONL + zstd）：

```bash
S=~/.dsh/sessions/--Users-seal-Documents-deepseek-harness-default-workspace--
zstd -dc "$S/<session-id>/session.v4.jsonl.zstd" | python3 -c '
import sys,json
for l in sys.stdin:
    e=json.loads(l)
    if e.get("type")=="system/message":
        t=e["data"]["message"]["content"][0]["text"]
        print(e["seq"], "boundary:", "Side conversation boundary." in t)
'
```

已验证：

| 检查 | 证据 |
|---|---|
| fork 切在完整 turn | 子会话 `session/end-seed {"inherited":true}`，父 seq 为 `turn/end` |
| 改名 | `session/title` source=`user`，标题 `侧聊 · <父标题>` |
| 纪律进了模型请求 | 侧聊 `system/message` 6763 字符，含 `Side conversation boundary.` |
| 主会话无泄漏 | 主会话全部 `system/message` 中该段出现 0 次 |
| 主会话运行中可开侧聊 | fork 时父会话正跑当前 turn，边界仍落在上一个 `turn/end` |
| 侧聊行为正常 | 零工具调用即可直接回复，`turn/end` completed |

未在真机覆盖：重启后仅靠标题兜底生效的那条路径（已用假 ctx 单测覆盖，无真机证据）。

---

## 9. 已知限制

1. **继承历史全量渲染** —— 侧聊 tab 从 fork 点开始展示整段历史，长会话里滚动量大。Codex 是直接不渲染；DSH 目前没有 transcript 过滤 seat，要做需要新 seat 或自定义 Chat View。
2. **会话列表污染** —— 侧聊以 `侧聊 · X` 出现在工作区会话列表，不折叠到父会话下。"结束侧聊"可以归档隐藏。
3. **每个父会话同时只有一个侧聊** —— 再次点击复用已有 child；换一个需要先结束。
4. **持久标记靠标题前缀** —— 若用户把侧聊改名到不以 `侧聊` 开头，重启后就会失去纪律段（当前进程内仍有效）。
5. **没有 `/side` 斜杠命令** —— `ctx.commandUi.register` 的 contribution 形状只能从源码反推，未在真机上验证前没有动已跑通的插件。
6. **关闭 ≠ 删除** —— 关 tab 只收面板；删内容要"结束侧聊"（归档）或手动清理。

---

## 10. 开发循环

```bash
cd /Users/seal/Desktop/myNote/dsh-dev
# 改 client.js  → 浏览器刷新
# 改 index.js   → 重启 DeepSeek Harness
# 改 package.json / cordis.patch.yml → 重启；必要时在插件页重新安装
```

重新 link（目录再次移动后）：

```bash
cd ~/.dsh/profiles/desktop
node ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs install --offline
```

注意：DSH 的**会话沙箱根 = 会话所属 workspace 的路径**。用本仓库开发时，先把该目录「打开文件夹」建成工作区，在新工作区里开会话；否则 shell 能读但写会被沙箱拒绝（`Operation not permitted`）。

---

## 11. 下一步候选

| 优先级 | 事项 | 思路 |
|---|---|---|
| 高 | 隐藏/折叠继承历史 | 找 transcript 过滤 seat；退路是包一层自定义 Chat View 只渲染 `seq > inheritedEventCount` |
| 中 | `/side` 命令 | `ctx.commandUi.register({ name, available, ui:{kind:'action', run(session)} })`，先用假 ctx 冒烟再上真机 |
| 中 | 会话列表折叠侧聊 | 需要 `sidebar.workspaces.session.*` 的过滤能力，或改成 subagent 型子会话（不在主列表） |
| 低 | 重启后自动补全标题 | 首次 assemble 时检测 `侧聊 ·` 并以父标题重命名 |
| 低 | 多侧聊并行 | tab 地址已带 parent，限制只在 Host 的"一父一侧聊"循环里 |

---

## 12. 参考：DSH 源码位置

本机 DSH 是打包分发（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`），源码在 asar 内 `dsh/node_modules/@deepseek-ai/*`，每包自带 `README.md` / `README.zh.md`，是最准确的 API 文档。本次开发主要参考：

| 包 | 用途 |
|---|---|
| `dsh-session` / `dsh-session-fork` | fork 种子、`inheritedEventCount`、事件类型 |
| `dsh-api-session-controller` | `session/fork`、`session/prompt`、会话列表与 history |
| `dsh-client-ui-sidebar-right` | 右侧栏、tab 类型注册、`openResource`、Tab domain |
| `dsh-client-ui-conversation` | `conversation.content` factory、composer、Session scope |
| `dsh-client-ui-subagent` | **侧栏内嵌完整会话的参考实现**（本次骨架来源） |
| `dsh-system-prompt` | `section()`、order 常量、scope 语义 |
| `dsh-client-connection` | `connection.fetch.register`、owner 鉴权 |
| `dsh-workspace` | `archiveSession(id,{stopActivity})` |
| `dsh-agent-preset/skills/cordis-plugin-development` | 插件 bundle 规范、slot/加载约定 |
