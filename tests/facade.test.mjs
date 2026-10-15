import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

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
