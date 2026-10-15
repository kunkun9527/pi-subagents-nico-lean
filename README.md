# pi-subagents-nico-lean

本地测试包：把 [pi-subagents](https://github.com/nicobailon/pi-subagents)（nicobailon）在主会话注册的工具收成一个精简的 `subagent` 工具，减少模型初始化上下文。上游运行时、codexhost 状态面板数据（`PI_SUBAGENT_ASYNC_JSON:`）和各工具的 execute 都不改，只对上游打了一个修复补丁（见下文）。暂不发布。

## 效果

| | 工具 | 初始 token（`ceil(字符/4)`，隔离环境实测） |
|---|---|---|
| 上游 `pi-subagents@0.78.0` | `subagent`、`bg_wait`、`subagent_supervisor`、`contact_supervisor` | 1,317 |
| 本包 | `subagent` | 238 |

## 用法

参数：`agent`、`task`、`action`、`id`、`message`、`async`、`options`（其余上游字段，如 workflow、args、model、cwd、timeoutMs）。

| 调用 | 转给上游 |
|---|---|
| `{agent, task}`、`{action, id?, ...}` | `subagent`；`options` 里的 workflow、args、model、cwd、worktree、output 提到顶层（上游只接受顶层，两处值不同时报错） |
| `{action: "wait", id?, options?}` | `bg_wait`（options：all、nonBlocking、timeoutMs、stopOnAttention） |
| `{action: "supervisor.pending\|reply\|status\|list", id?, message?}` | `subagent_supervisor`，`id` 作为 `replyTo` |

- 转发前按目标工具自己的 schema 校验并转换参数，和直接调用上游一致。
- 上游结果里提到的 `bg_wait`、`subagent_supervisor`，在工具说明里指明对应 `action: "wait"`、`action: "supervisor.*"`。
- `subagents_enable`（按需加载器）不注册，`subagent` 始终可用；旧会话只声明过加载器时，`session_start`/`session_tree` 会补激活 `subagent`。
- 主会话的 `contact_supervisor` 只会报错（上游 `TOP_LEVEL_SUPERVISOR_REFUSAL`），不注册。子代理在上游自己的进程/会话里运行，不经过本包；agent 文件应显式列出 `extensions`，不要让子代理加载本包。
- 保留上游 `exposure: "model-only"`，所以 codemode 里调不到 `subagent`。

## 对上游的补丁

本包当作上游的 fork，`npm install` 时由 `postinstall` 打上 `patches/` 里的补丁（已打过则跳过）：

- `pi-subagents-inspect-single-root.patch`：上游 0.78.0 中，运行中的 single 任务只在 `steps[0]` 写 `sessionFile`，根 `sessionFile` 要到结束才写；codexhost 点进子代理时按根查询（`/subagents-inspect-rpc`），于是运行中拿到 0 条消息、一直转圈。补丁让根查询在“single、只有一个 step”时回退读该 step 的记录，并沿用它的 `context` 判断 fork；回复身份不变，chain/parallel 不受影响。测试：`tests/inspect-single-root.test.mjs`（未打补丁时其中 2 项失败）。
- `pi-subagents-toolcall-arguments.patch`：Pi 会话记录把工具参数存在 `arguments`，上游 `fleet-view.js` 只读 `args`，所以 Codex 面板和 `status` transcript 里只显示 `[tool: bash]`。补丁改为 `args ?? arguments`。测试同上文件。

## 安装与回滚

`~/.pi/agent/settings.json` 的 `packages` 用 `"local-packages\\pi-subagents-nico-lean"` 替换 `"npm:pi-subagents"`，然后 `/reload` 或新开会话。回滚时换回去即可。

## 开发

```bash
npm install
npm run check   # tsc + node --test
```
