# pi-subagents-nico-lean

把 [pi-subagents](https://github.com/nicobailon/pi-subagents)（nicobailon）在主会话注册的工具收成一个精简的 `subagent` 工具，减少模型初始化上下文。上游运行时、codexhost 状态面板数据（`PI_SUBAGENT_ASYNC_JSON:`）和各工具的 execute 都不改，也不给上游打补丁。配合 [kunkun9527/codex-host](https://github.com/kunkun9527/codex-host) 的 `pi-local-0.16.0` 分支使用时，codexhost 里能看到子代理卡片和实时记录。

## 效果

| | 工具 | 初始 token（`ceil(字符/4)`，Pi 1.4.0 隔离环境实测） |
|---|---|---|
| 上游 `pi-subagents@0.82.1` | `subagent`、`bg_wait`、`subagent_supervisor`、`contact_supervisor` | 1,322 |
| 本包 | `subagent` | 238 |

## 用法

参数：`agent`、`task`、`action`、`id`、`message`、`async`、`options`（其余上游字段，如 workflow、args、model、cwd、timeoutMs）。

| 调用 | 转给上游 |
|---|---|
| `{agent, task}`、`{action, id?, ...}` | `subagent`；`options` 里的 workflow、args、model、cwd、worktree、output 提到顶层（上游只接受顶层，两处值不同时报错） |
| `{action: "wait", id?, options?}` | `bg_wait`（options：all、nonBlocking、timeoutMs、stopOnAttention） |
| `{action: "supervisor.pending\|reply\|status\|list", id?, message?}` | `subagent_supervisor`，`id` 作为 `replyTo` |

- 转发前按目标工具自己的 schema 校验并转换参数，和直接调用上游一致。
- 模型常见的传参错误会在校验前自动修正：`options` 传成 JSON 字符串时解析为对象；Claude Code Task 写法 `prompt`→`task`、`subagent_type`→`agent`、`run_in_background`→`async`（目标字段已有不同值时不覆盖），随之带的 `description`（仅 UI 标签，上游无对应字段）丢弃。`action` 不会被推断。
- 上游结果里提到的 `bg_wait`、`subagent_supervisor`，在工具说明里指明对应 `action: "wait"`、`action: "supervisor.*"`。
- `subagents_enable`（按需加载器）不注册，`subagent` 始终可用；旧会话只声明过加载器时，`session_start`/`session_tree` 会补激活 `subagent`。
- 主会话的 `contact_supervisor` 只会报错（上游 `TOP_LEVEL_SUPERVISOR_REFUSAL`），不注册。子代理在上游自己的进程/会话里运行，不经过本包；agent 文件应显式列出 `extensions`，不要让子代理加载本包。
- 保留上游 `exposure: "model-only"`，所以 codemode 里调不到 `subagent`。

## 上游已知问题

0.79.1 及以前本包用 `postinstall` 给上游打过两个补丁；0.82.1 起上游运行 `bundle/`，补丁已删除：

- 运行中的 single 任务只在 `steps[0]` 写 `sessionFile`，根 `sessionFile` 结束时才写（上游 `docs/observability.md` 的约定），按根查询 `/subagents-inspect-rpc` 拿不到记录。改由 codexhost 兼容：根查询没有消息、且父会话的启动结果是 `mode: "single"` 时，改按 `step:0` 再查一次（`codex-host-pi-local` 的 `pi-adapter.ts`）。
- Pi 会话记录把工具参数存在 `arguments`，上游 transcript 解析只读 `args`，所以 codexhost 面板和 `status` transcript 里工具调用只显示 `[tool: bash]`，不带参数（0.82.1 仍在，`bundle/chunk-FXUXCX2K.js` 的 `sessionMessageParts`）。暂未处理；工具结果照常显示。

## 安装与回滚

```bash
pi install git:github.com/kunkun9527/pi-subagents-nico-lean@v0.82.1
```

Pi 会克隆仓库并执行 `npm install --omit=dev --legacy-peer-deps`，只装 `pi-subagents@0.82.1`，不会再装一份 Pi。本包已包含上游运行时，不要再同时加载 `npm:pi-subagents`。装好后 `/reload` 或新开会话。

回滚：`pi remove git:github.com/kunkun9527/pi-subagents-nico-lean`。

本地开发时也可以把仓库放进 `~/.pi/agent/local-packages/`，在 `~/.pi/agent/settings.json` 的 `packages` 里写 `"local-packages\\pi-subagents-nico-lean"`。

## 开发

```bash
npm install
npm run check   # tsc + node --test
```
