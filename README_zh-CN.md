# pi-subagents-nico-lean

> **Token 基准：Lean 238，上游 `pi-subagents@0.84.0` 1,322，减少 82.0%。**
> 配合 [codexhost Pi fork](https://github.com/kunkun9527/codex-host/tree/pi-local-0.16.0) 使用，可在 Codex Desktop 里看到子代理卡片和实时记录。

[English](README.md)

基于 [`pi-subagents`](https://github.com/nicobailon/pi-subagents)（nicobailon）的精简封装。上游运行时、codexhost 状态面板数据（`PI_SUBAGENT_ASYNC_JSON:`）和各工具的 `execute` 都不改，只把主会话注册的工具收成一个精简的 `subagent` 工具，也不给上游打补丁。

## 初始化上下文占用对比

单独启用本扩展时，模型可见的常驻初始化上下文如下：

| 版本 | 工具 | 合计 |
| --- | --- | ---: |
| Lean `pi-subagents-nico-lean@0.84.0` | `subagent` | **238** |
| 上游 `pi-subagents@0.84.0` | `subagent` + `bg_wait` + `subagent_supervisor` + `contact_supervisor` | **1,322** |

节省 **1,084 tokens（82.0%）**。
测量环境为 Pi 1.4.0 隔离环境。Token 是按 `ceil(字符数 / 4)` 计算的固定字符代理估算，并非模型 tokenizer 实际计费值。

## 核心特性

* 完整保留上游运行时：Agent 发现、single/chain/parallel 运行、后台任务、状态查询、Steering 和 supervisor 回复都照常走上游。
* 统一工具入口：`subagent`、`bg_wait`、`subagent_supervisor` 通过一个 `subagent` 工具转发。
* 校验与上游一致：转发前按目标工具自己的 schema 校验并转换参数。
* 容错传参：模型常见的传参错误会在校验前自动修正（见[使用方法](#使用方法)）。

## 安装

```bash
pi install git:github.com/kunkun9527/pi-subagents-nico-lean@v0.84.0
```

Pi 会克隆仓库并执行 `npm install --omit=dev --legacy-peer-deps`，只装 `pi-subagents@0.84.0`，不会再装一份 Pi。本包已包含上游运行时，不要再同时加载 `npm:pi-subagents` 或其它 `pi-subagents` 包装扩展。装好后 `/reload` 或新开会话。

卸载：

```bash
pi remove git:github.com/kunkun9527/pi-subagents-nico-lean
```

本包只通过 GitHub 分发，不发布到 npm。

## 使用方法

模型仅会看到一个工具：

```text
subagent
```

参数：`agent`、`task`、`action`、`id`、`message`、`async`、`options`（其余上游字段，如 `workflow`、`args`、`model`、`cwd`、`timeoutMs`）。

| 调用 | 转给上游 |
| --- | --- |
| `{agent, task}`、`{action, id?, ...}` | `subagent`；`options` 里的 `workflow`、`args`、`model`、`cwd`、`worktree`、`output` 提到顶层（上游只接受顶层，两处值不同时报错） |
| `{action: "wait", id?, options?}` | `bg_wait`（options：`all`、`nonBlocking`、`timeoutMs`、`stopOnAttention`） |
| `{action: "supervisor.pending\|reply\|status\|list", id?, message?}` | `subagent_supervisor`，`id` 作为 `replyTo` |

```json
{
  "agent": "scout",
  "task": "Find the implementation of the cache key.",
  "async": true
}
```

* `options` 传成 JSON 字符串时解析为对象。
* Claude Code Task 写法自动映射：`prompt` → `task`、`subagent_type` → `agent`、`run_in_background` → `async`（目标字段已有不同值时不覆盖）。随之带的 `description` 仅是 UI 标签，上游无对应字段，会被丢弃。`action` 不会被推断。
* 上游结果里提到的 `bg_wait`、`subagent_supervisor`，在工具说明里指明对应 `action: "wait"`、`action: "supervisor.*"`。
* 按需加载器 `subagents_enable` 不注册，`subagent` 始终可用；旧会话只声明过加载器时，`session_start`/`session_tree` 会补激活 `subagent`。
* 主会话的 `contact_supervisor` 只会报错（上游 `TOP_LEVEL_SUPERVISOR_REFUSAL`），不注册。子代理在上游自己的进程和会话里运行，不经过本包；agent 文件应显式列出 `extensions`，不要让子代理加载本包。
* 保留上游 `exposure: "model-only"`，所以 `codemode` 里调不到 `subagent`。

## 重要：检查你的 Agent 定义

上游会发现内置 Agent（`scout`、`worker`、`reviewer`、`researcher`、`oracle`、`delegate` 等）以及 Pi 目录里的自定义 Agent。本仓库不包含任何私有 Agent、会话或记忆。

安装后：

1. 确认每个 Agent 的 `model` 指向你环境中可用的模型。
2. 删除或禁用不需要的 Agent 类型（例如在 `~/.pi/agent/settings.json` 里设 `subagents.disableBuiltins`）。
3. 按自己的工作流调整 Prompt、工具和扩展白名单。

Agent 文件位置和设置见 [pi-subagents 文档](https://github.com/nicobailon/pi-subagents)。

## 上游已知问题

0.79.1 及以前本包用 `postinstall` 给上游打过两个补丁；0.82.1 起上游运行 `bundle/`，补丁已删除：

* 运行中的 single 任务只在 `steps[0]` 写 `sessionFile`，根 `sessionFile` 结束时才写（上游 `docs/observability.md` 的约定），按根查询 `/subagents-inspect-rpc` 拿不到记录。codexhost Pi fork 已兼容：根查询没有消息、且启动结果是 `mode: "single"` 时，改按 `step:0` 再查一次。
* codexhost 面板和 `status` transcript 里工具调用曾只显示 `[tool: bash]`、不带参数，因为上游只读 `args`，而 Pi 会话记录把参数存在 `arguments`。上游 0.83.0 已修复（#3053）。

## 版本

上游运行时固定为 `pi-subagents@0.84.0`，需要 Pi 1.2.0 或更新版本。已在 Pi 1.4.0 上测试。

## 开发

```bash
npm ci
npm run check   # tsc + node --test
```

本地开发时可以把仓库放进 `~/.pi/agent/local-packages/`，在 `~/.pi/agent/settings.json` 的 `packages` 里写 `"local-packages\\pi-subagents-nico-lean"`。

## 许可

MIT。本项目封装了 MIT 许可的 [`pi-subagents`](https://github.com/nicobailon/pi-subagents)。
