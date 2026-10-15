# pi-subagents-nico-lean

本地测试包：把 [pi-subagents](https://github.com/nicobailon/pi-subagents)（nicobailon）在主会话注册的工具收成一个精简的 `subagent` 工具，减少模型初始化上下文。上游运行时、codexhost 状态面板数据（`PI_SUBAGENT_ASYNC_JSON:`）和各工具的 execute 都不改。暂不发布。

## 效果

| | 工具 | 初始 token（`ceil(字符/4)`，隔离环境实测） |
|---|---|---|
| 上游 `pi-subagents@0.78.0` | `subagent`、`bg_wait`、`subagent_supervisor`、`contact_supervisor` | 1,317 |
| 本包 | `subagent` | 222 |

## 用法

参数：`agent`、`task`、`action`、`id`、`message`、`async`、`options`（其余上游字段，如 workflow、args、model、cwd、timeoutMs）。

| 调用 | 转给上游 |
|---|---|
| `{agent, task}`、`{action, id?, ...}` | `subagent`，参数原样 |
| `{action: "wait", id?, options?}` | `bg_wait`（options：all、nonBlocking、timeoutMs、stopOnAttention） |
| `{action: "supervisor.pending\|reply\|status\|list", id?, message?}` | `subagent_supervisor`，`id` 作为 `replyTo` |

- `subagents_enable`（按需加载器）不注册，`subagent` 始终可用。
- 主会话的 `contact_supervisor` 只会报错（上游 `TOP_LEVEL_SUPERVISOR_REFUSAL`），不注册。子代理在上游自己的进程/会话里运行，不经过本包；agent 文件应显式列出 `extensions`，不要让子代理加载本包。
- 保留上游 `exposure: "model-only"`，所以 codemode 里调不到 `subagent`。

## 安装与回滚

`~/.pi/agent/settings.json` 的 `packages` 用 `"local-packages\\pi-subagents-nico-lean"` 替换 `"npm:pi-subagents"`，然后 `/reload` 或新开会话。回滚时换回去即可。

## 开发

```bash
npm install
npm run check   # tsc + node --test
```
