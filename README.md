# pi-subagents-nico-lean

> **Token benchmark: Lean 238, upstream `pi-subagents@0.84.0` 1,322 — 82.0% fewer.**
> Works with the [codexhost Pi fork](https://github.com/kunkun9527/codex-host/tree/pi-local-0.16.0) to show subagent cards and live transcripts in Codex Desktop.

[简体中文](https://github.com/kunkun9527/pi-subagents-nico-lean/blob/master/README_zh-CN.md)

A lightweight Pi wrapper for [`pi-subagents`](https://github.com/nicobailon/pi-subagents) (nicobailon). It keeps the upstream runtime, the codexhost status data (`PI_SUBAGENT_ASYNC_JSON:`), and every tool's `execute` unchanged, and folds the parent-session tools into one compact `subagent` tool. No patches are applied to upstream.

## Context Footprint Benchmark

With only this extension enabled, its recurring model-facing initialization contribution is:

| Variant | Tools | Total |
| --- | --- | ---: |
| Lean `pi-subagents-nico-lean@0.84.0` | `subagent` | **238** |
| Upstream `pi-subagents@0.84.0` | `subagent` + `bg_wait` + `subagent_supervisor` + `contact_supervisor` | **1,322** |

This saves **1,084 tokens (82.0%)**.
Measured with Pi 1.4.0 in an isolated environment. Tokens are a fixed character-proxy estimate using `ceil(characters / 4)`, not provider tokenizer billing.

## Core Features

* Full upstream runtime: agent discovery, single/chain/parallel runs, background execution, status, steering, and supervisor replies all go through upstream unchanged.
* Unified tool interface: `subagent`, `bg_wait`, and `subagent_supervisor` are routed through one `subagent` tool.
* Same validation as upstream: each call is checked against the target tool's own schema before it is forwarded.
* Forgiving arguments: common model mistakes are repaired before validation (see [Usage](#usage)).

## Installation

```bash
pi install git:github.com/kunkun9527/pi-subagents-nico-lean@v0.84.0
```

Pi clones the repository and runs `npm install --omit=dev --legacy-peer-deps`, which installs only `pi-subagents@0.84.0` and no second copy of Pi. This package already contains the upstream runtime, so do not also load `npm:pi-subagents` or another `pi-subagents` wrapper. Run `/reload` or start a new session afterwards.

To uninstall:

```bash
pi remove git:github.com/kunkun9527/pi-subagents-nico-lean
```

This package is distributed through GitHub only and is not published to npm.

## Usage

The model sees a single tool:

```text
subagent
```

Parameters: `agent`, `task`, `action`, `id`, `message`, `async`, and `options` (other upstream fields such as `workflow`, `args`, `model`, `cwd`, `timeoutMs`).

| Call | Forwarded to upstream |
| --- | --- |
| `{agent, task}`, `{action, id?, ...}` | `subagent`; `workflow`, `args`, `model`, `cwd`, `worktree`, and `output` inside `options` are moved to the top level (upstream accepts them only there; conflicting values are rejected) |
| `{action: "wait", id?, options?}` | `bg_wait` (options: `all`, `nonBlocking`, `timeoutMs`, `stopOnAttention`) |
| `{action: "supervisor.pending\|reply\|status\|list", id?, message?}` | `subagent_supervisor`, with `id` used as `replyTo` |

```json
{
  "agent": "scout",
  "task": "Find the implementation of the cache key.",
  "async": true
}
```

* `options` passed as a JSON string is parsed into an object.
* Claude Code Task-style fields are mapped: `prompt` → `task`, `subagent_type` → `agent`, `run_in_background` → `async` (an existing different value is never overwritten). The accompanying `description` is a UI label with no upstream equivalent and is dropped. `action` is never inferred.
* Where upstream results mention `bg_wait` or `subagent_supervisor`, the tool description points to `action: "wait"` and `action: "supervisor.*"`.
* The on-demand loader `subagents_enable` is not registered; `subagent` is always available. Sessions that only declared the loader get `subagent` re-activated on `session_start`/`session_tree`.
* `contact_supervisor` only errors in the parent session (upstream `TOP_LEVEL_SUPERVISOR_REFUSAL`), so it is not registered. Subagents run in upstream's own processes and sessions without this package; agent files should list `extensions` explicitly so children do not load it.
* Upstream's `exposure: "model-only"` is kept, so `subagent` cannot be called from `codemode`.

## Important: Review Your Agent Definitions

Upstream discovers built-in agents (`scout`, `worker`, `reviewer`, `researcher`, `oracle`, `delegate`, and others) plus custom agents from your Pi directories. This repository does not package any private agents, sessions, or memory.

After installation:

1. Make sure each agent's `model` points to a model available in your environment.
2. Remove or disable agent types you do not need (for example `subagents.disableBuiltins` in `~/.pi/agent/settings.json`).
3. Adjust prompts, tools, and extension allowlists to match your workflow.

See the [pi-subagents docs](https://github.com/nicobailon/pi-subagents) for agent file locations and settings.

## Known Upstream Issues

Up to 0.79.1 this package patched upstream in `postinstall`. Since 0.82.1 upstream runs from `bundle/`, and the patches were removed:

* A running single task writes `sessionFile` only to `steps[0]`; the root `sessionFile` is written at the end (upstream `docs/observability.md`), so a root query to `/subagents-inspect-rpc` returns no transcript. The codexhost Pi fork handles this: when the root query is empty and the launch result is `mode: "single"`, it retries with `step:0`.
* Tool calls in codexhost and `status` transcripts showed only `[tool: bash]` without arguments, because upstream read `args` while Pi session logs store `arguments`. Fixed upstream in 0.83.0 (#3053).

## Versions

Upstream runtime is pinned to `pi-subagents@0.84.0`, which requires Pi 1.2.0 or newer. Tested with Pi 1.4.0.

## Development

```bash
npm ci
npm run check   # tsc + node --test
```

For local development, put the repository in `~/.pi/agent/local-packages/` and list `"local-packages\\pi-subagents-nico-lean"` under `packages` in `~/.pi/agent/settings.json`.

## License

MIT. This project wraps the MIT-licensed [`pi-subagents`](https://github.com/nicobailon/pi-subagents).
