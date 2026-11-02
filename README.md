# dsh-dev

DeepSeek Harness 相关开发的仓库。

## 布局

- `side-chat/` — 侧边聊天插件
  - `index.js` Host：`POST /api/sidechat.open|close`，fork + 改名 + 侧聊纪律段
  - `client.js` Client：右侧栏 tab 类型、会话头部按钮、banner
  - `cordis.patch.yml` / `package.json` / `locale/` / `icon.svg`

## 开发循环

| 改动 | 生效方式 |
|---|---|
| `client.js` | 刷新页面 |
| `index.js` | 重启应用（profile 用 `link:` 安装，Node 按路径缓存 ESM） |
| `cordis.patch.yml` / `package.json` | 重启应用，必要时在插件页重新安装 |

验证：会话头部点分支图标 → 右侧栏出现 `侧聊 · <主会话标题>` → 在侧聊里发一条消息。

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

- 侧聊 = 主会话在最后一个完整 turn 处的 fork（`ctx.sessionController.fork`），主会话继续跑也不受影响
- 纪律段通过 `ctx.systemPrompt.section` 动态注入：仅对进程内标记过的会话，或 `isSeeded` 且标题以 `侧聊` 开头的会话生效
- 关闭 panel 不动会话；「结束侧聊」= 中断 + 归档（`workspaces.archiveSession`）
