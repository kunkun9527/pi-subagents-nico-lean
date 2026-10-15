// Guards patches/pi-subagents-inspect-single-root.patch: root inspection of a running
// single-mode run must read the sole step's live transcript (codexhost clicks the root).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Not in the package exports map, so import by path.
const inspectRpc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/pi-subagents/src/runs/background/inspect-rpc.js");
const { handleInspectRpcArgs } = await import(pathToFileURL(inspectRpc).href);

const PARENT = "parent-session";

function fixture({ mode = "single", steps = 1, context = "fresh", rootSessionFile = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nico-lean-inspect-"));
  const runId = `run-${mode}-${steps}-${context}-${rootSessionFile}`;
  const asyncDirRoot = path.join(tmp, "async");
  const resultsDir = path.join(tmp, "results");
  const sessions = path.join(tmp, "sessions");
  fs.mkdirSync(path.join(asyncDirRoot, runId), { recursive: true });
  fs.mkdirSync(resultsDir);
  fs.mkdirSync(sessions);
  const sessionFile = (index) => {
    const file = path.join(sessions, `step-${index}.jsonl`);
    fs.writeFileSync(file, [
      { type: "session", version: 3, id: `s${index}` },
      { type: "message", id: "u", message: { role: "user", content: [{ type: "text", text: `TASK-${index}` }] } },
      { type: "message", id: "a", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", args: { command: "sleep 90" } }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return file;
  };
  const now = Date.now();
  const status = {
    lifecycleArtifactVersion: 3, runId, sessionId: PARENT, mode, state: "running",
    startedAt: now, lastUpdate: now, lastActivityAt: now, pid: process.pid, cwd: tmp,
    currentStep: 0, chainStepCount: steps,
    steps: Array.from({ length: steps }, (_, index) => ({ agent: "General", context, status: "running", sessionFile: sessionFile(index), startedAt: now })),
    ...(rootSessionFile ? { sessionFile: sessionFile(0) } : {}),
  };
  fs.writeFileSync(path.join(asyncDirRoot, runId, "status.json"), JSON.stringify(status));
  const state = {
    currentSessionId: PARENT, trustedSessionRoots: [sessions],
    asyncJobs: new Map(), fleetJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(),
  };
  const inspect = (childId) => handleInspectRpcArgs(`req ${runId}${childId ? ` ${childId}` : ""} --lines 50`, { asyncDirRoot, resultsDir, state });
  return { runId, inspect, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test("running single run: root inspection reads the sole step's live transcript, identity unchanged", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const reply = f.inspect();
  assert.equal(reply.error, undefined);
  assert.equal(reply.status, "running");
  assert.equal(reply.asyncId, f.runId);
  assert.ok(!Object.hasOwn(reply, "childId"), "root reply must not gain a childId (codexhost identity check)");
  assert.equal(reply.messages?.length, 2);
  assert.equal(reply.task, "TASK-0");
  assert.deepEqual(f.inspect("step:0").messages, reply.messages);
});

test("running forked single run: transcript shown but inherited first user message is not the task", (t) => {
  const f = fixture({ context: "fork" });
  t.after(f.cleanup);
  const reply = f.inspect();
  assert.equal(reply.messages?.length, 2);
  assert.equal(reply.task, undefined);
});

test("root sessionFile, when published, still wins", (t) => {
  const f = fixture({ rootSessionFile: true });
  t.after(f.cleanup);
  assert.equal(f.inspect().messages?.length, 2);
});

test("chain runs keep run-level semantics (no step fallback)", (t) => {
  const f = fixture({ mode: "chain", steps: 2 });
  t.after(f.cleanup);
  const reply = f.inspect();
  assert.equal(reply.error, undefined);
  assert.equal(reply.messages, undefined);
  assert.equal(f.inspect("step:1").task, "TASK-1");
});
