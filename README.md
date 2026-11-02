# dsh-dev

DeepSeek Harness 相关开发的仓库。

## 当前状态（2026-11-02）

- v0.2 Host 侧已实现并验证（22 条假 ctx 单测 + 真实服务栈冒烟 + 真机 HTTP 路由实测）；
- Client 侧真机未达预期（用户反馈「功能没有实现」），根因未定位，代码**未 push**；
- 接手请先读 [`side-chat/PROGRESS.md`](side-chat/PROGRESS.md)（进展、证据、调试手段、下一步）。

## 布局

- `side-chat/` — 侧边聊天插件（v0.2，内存态只读旁路 + 实时上下文）
  - `index.js` Host：`POST /api/sidechat.open|close|list`，`agents.create` 建全新子 Agent、`agent/pre-step` 实时注入主会话上下文、只读工具限制
  - `client.js` Client：右侧栏 tab 类型、会话头部按钮、banner、stale tab 自愈、关闭即销毁
  - `test/` 假 ctx / 假 Client 单测
  - `cordis.patch.yml` / `package.json` / `locale/` / `icon.svg`
  - `HANDOFF.md` 交接文档（架构、契约、验证、限制）

## 开发循环

| 改动 | 生效方式 |
|---|---|
| `client.js` | 刷新页面 |
| `index.js` | 重启应用（profile 用 `link:` 安装，Node 按路径缓存 ESM） |
| `cordis.patch.yml` / `package.json` | 重启应用，必要时在插件页重新安装 |

测试：

```bash
node --test side-chat/test/*.test.mjs          # 假 ctx / 假 Client
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  --expose-internals side-chat/test/smoke.real-stack.mjs   # 真实 Host 包冒烟
```

验证：主会话发一条消息 → 会话头部点分支图标 → 右侧栏出现侧聊 tab → 提问（侧聊会实时看到主会话内容）→ 关闭 tab 即结束；页面刷新保留，应用重启后侧聊消失。

## 安装 / 重新 link

profile 里已注册为本地 link 依赖，目标就是这个目录：

```
~/.dsh/profiles/desktop/package.json
  "dependencies": { "dsh-side-chat": "link:/Users/seal/Desktop/myNote/dsh-dev/side-chat" }
```

目录再移动后，在 profile 目录重跑一次：

```
cd ~/.dsh/profiles/desktop
node ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs install --offline
```

## 设计要点

- 侧聊 = `ctx.agents.create` 创建的全新子 Agent（`meta.parentSession` 指主会话，无 seed、无 `header.cwd`），不是 fork
- 上下文实时：每次侧聊请求前读主会话 `Session.deriveMessages()`，差量注入为 `side-chat-context` sourced user message（Chat 隐藏）
- 纪律段通过 `agentCtx.systemPrompt.section` 注入，仅对侧聊 Agent 生效，不再依赖标题前缀
- 只读：子会话 `sandbox/mode=read-only` + `tools.restrict` 拒绝写类/跨会话控制类工具
- 生命周期：进程内 Map；关闭 tab → `handle.dispose()`；无 cwd 的冷会话不进列表/搜索、不可 resume，所以重启后自然消失
- v0.1.1 的 fork 侧聊会在插件启动时一次性归档（见 HANDOFF §11）
