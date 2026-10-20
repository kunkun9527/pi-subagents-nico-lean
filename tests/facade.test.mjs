import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// These tests model the parent session. Run inside a subagent child, upstream would decide at import
// time to skip registration; node --test runs each file in its own process, so this stays local.
delete process.env.PI_SUBAGENT_CHILD;

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { createSubagentsFacade, routeFacadeCall, default: realFacade } = await jiti.import("../index.ts");
// Upstream's own lowering of a model call's `options`; not a public export, so import by path.
const { flattenSubagentToolOptions } = await import("../node_modules/pi-subagents/src/extension/subagent-options.js");
const { createSubagentParamsSchema } = await import("../node_modules/pi-subagents/src/extension/schemas.js");
const { validateToolArguments } = await import("@earendil-works/pi-ai");

function createMockPi() {
  const tools = new Map();
  const handlers = new Map();
  let active;
  const noop = () => undefined;
  const pi = new Proxy(
    {
      registered: [],
      registerTool(tool) { tools.set(tool.name, tool); this.registered.push(tool.name); },
      getAllTools: () => [...tools.values()].map((t) => ({ name: t.name })),
      getActiveTools: () => active ?? [...tools.keys()],
      setActiveTools: (names) => { active = [...names]; },
      on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      events: { on: noop, emit: noop },
    },
    { get: (target, property) => (property in target ? target[property] : noop) },
  );
  const emit = (event, ctx) => { for (const handler of handlers.get(event) ?? []) handler({ type: event }, ctx); };
  return { pi, tools, emit };
}

function fakeTool(name, calls, properties = {}) {
  return {
    name,
    exposure: "model-only",
    description: `${name} long upstream description`,
    parameters: { type: "object", properties: { huge: { type: "string", description: "x".repeat(500) }, ...properties } },
    async execute(_id, params) {
      calls.push({ name, params });
      return { content: [{ type: "text", text: `${name} ok` }], details: {} };
    },
  };
}

function setup() {
  const calls = [];
  const { pi, tools, emit } = createMockPi();
  let api;
  const upstream = (proxied) => {
    api = proxied;
    api.registerTool(fakeTool("subagent", calls));
    api.registerTool(fakeTool("bg_wait", calls, { all: { type: "boolean" } }));
    api.registerTool(fakeTool("contact_supervisor", calls));
    api.registerTool(fakeTool("subagents_enable", calls));
    api.registerTool(fakeTool("other_tool", calls));
  };
  createSubagentsFacade(upstream)(pi);
  const run = (params) => tools.get("subagent").execute("call", params, new AbortController().signal, () => {}, {});
  // `api` is the wrapper's proxy, i.e. what upstream registers through later.
  return { api, pi, tools, calls, run, emit };
}

test("folds upstream parent tools into one compact subagent tool", () => {
  const { tools } = setup();
  assert.deepEqual([...tools.keys()].sort(), ["other_tool", "subagent"]);
  const facade = tools.get("subagent");
  assert.equal(facade.exposure, "model-only", "keeps upstream exposure");
  assert.deepEqual(Object.keys(facade.parameters.properties), ["agent", "task", "action", "id", "message", "async", "options"]);
  assert.ok(!JSON.stringify(facade.parameters).includes("description"), "no per-field descriptions");
});

test("passes launches and management straight to upstream subagent", async () => {
  const { run, calls } = setup();
  const launch = { agent: "General", task: "do it", async: false, options: { timeoutMs: 1000 } };
  await run(launch);
  await run({ action: "status", id: "abc" });
  assert.deepEqual(calls, [
    { name: "subagent", params: launch },
    { name: "subagent", params: { action: "status", id: "abc" } },
  ]);
});

test("routes wait and supervisor actions to the folded tools", async () => {
  const { api, run, calls } = setup();
  await run({ action: "wait", id: "run1", options: { timeoutMs: 5 } });
  assert.deepEqual(calls.at(-1), { name: "bg_wait", params: { timeoutMs: 5, id: "run1" } });

  const missing = await run({ action: "supervisor.pending" });
  assert.equal(missing.isError, true, "supervisor is reported unavailable until upstream registers it");

  api.registerTool(fakeTool("subagent_supervisor", calls, { to: { type: "string" } }));
  await run({ action: "supervisor.reply", id: "req1", message: "yes", options: { to: "child" } });
  assert.deepEqual(calls.at(-1), { name: "subagent_supervisor", params: { to: "child", action: "reply", replyTo: "req1", message: "yes" } });
});

test("hoists upstream top-level fields out of options so upstream accepts them", async () => {
  const params = { agent: "General", task: "t", options: { model: "a/b", cwd: "C:/x", workflow: "w", timeoutMs: 5 } };
  assert.throws(() => flattenSubagentToolOptions(params), /top-level field/, "upstream rejects them inside options");
  const { args } = routeFacadeCall(params);
  assert.deepEqual(args, { agent: "General", task: "t", model: "a/b", cwd: "C:/x", workflow: "w", options: { timeoutMs: 5 } });
  assert.deepEqual(flattenSubagentToolOptions(args), { agent: "General", task: "t", model: "a/b", cwd: "C:/x", workflow: "w", timeoutMs: 5 });
  const upstreamTool = { name: "subagent", parameters: createSubagentParamsSchema() };
  assert.deepEqual(validateToolArguments(upstreamTool, { type: "toolCall", id: "c", name: "subagent", arguments: args }), args, "passes upstream's schema");
  assert.deepEqual(routeFacadeCall({ agent: "A", task: "t", options: { model: "m" } }).args, { agent: "A", task: "t", model: "m" }, "empty options dropped");
  assert.deepEqual(routeFacadeCall({ agent: "A", task: "t", model: "m", options: { model: "m" } }).args, { agent: "A", task: "t", model: "m" }, "equal duplicate is fine");
  assert.throws(() => routeFacadeCall({ agent: "A", task: "t", model: "m", options: { model: "other" } }), /given both/);
});

test("routed arguments are checked against the target tool's own schema", async () => {
  const { api, run, calls } = setup();
  await run({ action: "wait", options: { all: "true" } });
  assert.deepEqual(calls.at(-1), { name: "bg_wait", params: { all: true } }, "coerced like a direct call");
  api.registerTool(fakeTool("subagent_supervisor", calls, { to: { type: "string" } }));
  const before = calls.length;
  await assert.rejects(run({ action: "supervisor.reply", id: "r", message: "m", options: { to: {} } }), /Validation failed/);
  assert.equal(calls.length, before, "invalid arguments never reach upstream");
});

test("prepareArguments decodes a JSON-string options and maps only equivalent Task aliases", async () => {
  const { tools, calls, run } = setup();
  const facade = tools.get("subagent");
  const upstreamTool = { name: "subagent", parameters: createSubagentParamsSchema() };
  const check = (tool, args) => validateToolArguments(tool, { type: "toolCall", id: "c", name: tool.name, arguments: args });
  const same = (raw) => { const prepared = facade.prepareArguments(raw); assert.equal(prepared.constructor, Object); return prepared; };

  // options as a JSON string: invalid for the facade shell before, valid and hoistable after.
  const stringOptions = { agent: "General", task: "t", options: '{"timeoutMs":5,"model":"a/b"}' };
  assert.throws(() => check(facade, stringOptions), /Validation failed/);
  const decoded = facade.prepareArguments(stringOptions);
  assert.equal(typeof stringOptions.options, "string", "input is not mutated");
  assert.deepEqual(decoded, { agent: "General", task: "t", options: { timeoutMs: 5, model: "a/b" } });
  assert.deepEqual(facade.prepareArguments(decoded), decoded, "idempotent");
  const { args } = routeFacadeCall(check(facade, decoded));
  assert.deepEqual(args, { agent: "General", task: "t", model: "a/b", options: { timeoutMs: 5 } });
  check(upstreamTool, args);
  for (const bad of ["not json", "[1]", "5", '"x"', ""]) {
    const kept = { agent: "A", task: "t", options: bad };
    assert.deepEqual(same(kept), kept, "undecodable options stay for validation");
    assert.throws(() => check(facade, same(kept)), /Validation failed/);
  }

  // Task-tool aliases map onto upstream's own fields and then run through upstream's schema.
  const task = { prompt: "do it", subagent_type: "General", description: "short label", run_in_background: false };
  const mapped = facade.prepareArguments(task);
  assert.deepEqual(mapped, { task: "do it", agent: "General", async: false });
  assert.deepEqual(task, { prompt: "do it", subagent_type: "General", description: "short label", run_in_background: false });
  assert.deepEqual(check(upstreamTool, routeFacadeCall(check(facade, mapped)).args), mapped);
  await run(mapped);
  assert.deepEqual(calls.at(-1), { name: "subagent", params: { task: "do it", agent: "General", async: false } });
  assert.deepEqual(facade.prepareArguments({ prompt: "x", agent: "G", run_in_background: true }), { task: "x", agent: "G", async: true });
  assert.deepEqual(facade.prepareArguments(mapped), mapped, "idempotent");
  assert.deepEqual(facade.prepareArguments({ prompt: "t", task: "t" }), { task: "t" }, "equal duplicate collapses");

  // A different value already in the target is never overwritten; the alias stays and nothing is guessed.
  const conflict = { agent: "A", task: "real", prompt: "other", subagent_type: "B", async: true, run_in_background: false };
  assert.deepEqual(facade.prepareArguments(conflict), conflict);

  // description alone is not a Task call and is left untouched; action is never inferred.
  for (const raw of [{ description: "label" }, { id: "abc" }, { message: "hi", id: "abc" }, { prompt: "only" }]) {
    assert.equal("action" in facade.prepareArguments(raw), false);
  }
  assert.deepEqual(facade.prepareArguments({ agent: "A", task: "t", description: "label" }), { agent: "A", task: "t", description: "label" });
  const explicit = { action: "stop", id: "abc", prompt: "p" };
  assert.deepEqual(facade.prepareArguments(explicit), { action: "stop", id: "abc", task: "p" });
  for (const odd of [null, undefined, "x", [1]]) assert.equal(facade.prepareArguments(odd), odd);
});

test("rendering uses the same repaired arguments", () => {
  const calls = [];
  const { pi, tools } = createMockPi();
  createSubagentsFacade((api) => api.registerTool({
    ...fakeTool("subagent", calls),
    renderCall: (args, _theme, context) => ({ args, contextArgs: context.args }),
    renderResult: (_result, _options, _theme, context) => ({ args: context.args }),
  }))(pi);
  const facade = tools.get("subagent");
  const raw = { prompt: "do it", subagent_type: "General", options: '{"timeoutMs":5,"model":"a/b"}' };
  const expected = { task: "do it", agent: "General", model: "a/b", options: { timeoutMs: 5 } };
  const call = facade.renderCall(raw, { fg: (_c, text) => text }, { args: raw });
  assert.deepEqual(call.args, expected);
  assert.deepEqual(call.contextArgs, expected);
  assert.deepEqual(facade.renderResult({ content: [] }, {}, { fg: (_c, text) => text }, { args: raw }).args, expected);
});

test("a resumed transcript that declared only upstream's loader gets subagent back", () => {
  const ctx = (toolsAdded) => ({ sessionManager: { buildSessionContext: () => ({ messages: [{ role: "system", content: "", toolsAdded }] }) } });
  const legacy = setup();
  legacy.pi.setActiveTools(["read", "other_tool"]);
  legacy.emit("session_start", ctx([{ name: "read" }, { name: "subagents_enable" }]));
  assert.deepEqual(legacy.pi.getActiveTools(), ["read", "other_tool", "subagent"]);

  const plain = setup();
  plain.pi.setActiveTools(["read"]);
  plain.emit("session_start", ctx([{ name: "read" }]));
  assert.deepEqual(plain.pi.getActiveTools(), ["read"], "a transcript without the loader keeps its loadout");
});

test("re-registration by upstream keeps one stable facade", () => {
  const { api, tools, calls } = setup();
  const first = tools.get("subagent");
  api.registerTool(fakeTool("subagent", calls));
  assert.equal(tools.get("subagent"), first);
});

test("real pi-subagents registers only the facade in the parent", async () => {
  const { pi, tools } = createMockPi();
  await realFacade(pi);
  assert.deepEqual([...tools.keys()], ["subagent"]);
  const chars = JSON.stringify({ d: tools.get("subagent").description, p: tools.get("subagent").parameters }).length;
  assert.ok(chars / 4 <= 300, `facade footprint ~${Math.ceil(chars / 4)} tokens`);
});
