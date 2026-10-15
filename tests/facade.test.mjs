import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { createSubagentsFacade, default: realFacade } = await jiti.import("../index.ts");

function createMockPi() {
  const tools = new Map();
  const noop = () => undefined;
  const pi = new Proxy(
    {
      registered: [],
      registerTool(tool) { tools.set(tool.name, tool); this.registered.push(tool.name); },
      getAllTools: () => [...tools.values()].map((t) => ({ name: t.name })),
      getActiveTools: () => [...tools.keys()],
      setActiveTools: noop,
      events: { on: noop, emit: noop },
    },
    { get: (target, property) => (property in target ? target[property] : noop) },
  );
  return { pi, tools };
}

function fakeTool(name, calls) {
  return {
    name,
    exposure: "model-only",
    description: `${name} long upstream description`,
    parameters: { type: "object", properties: { huge: { type: "string", description: "x".repeat(500) } } },
    async execute(_id, params) {
      calls.push({ name, params });
      return { content: [{ type: "text", text: `${name} ok` }], details: {} };
    },
  };
}

function setup() {
  const calls = [];
  const { pi, tools } = createMockPi();
  let api;
  const upstream = (proxied) => {
    api = proxied;
    api.registerTool(fakeTool("subagent", calls));
    api.registerTool(fakeTool("bg_wait", calls));
    api.registerTool(fakeTool("contact_supervisor", calls));
    api.registerTool(fakeTool("subagents_enable", calls));
    api.registerTool(fakeTool("other_tool", calls));
  };
  createSubagentsFacade(upstream)(pi);
  const run = (params) => tools.get("subagent").execute("call", params, new AbortController().signal, () => {}, {});
  // `api` is the wrapper's proxy, i.e. what upstream registers through later.
  return { api, tools, calls, run };
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

  api.registerTool(fakeTool("subagent_supervisor", calls));
  await run({ action: "supervisor.reply", id: "req1", message: "yes", options: { to: "child" } });
  assert.deepEqual(calls.at(-1), { name: "subagent_supervisor", params: { to: "child", action: "reply", replyTo: "req1", message: "yes" } });
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
