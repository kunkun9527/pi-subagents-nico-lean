// pi-subagents-nico-lean: fold pi-subagents' parent-session tools into one compact `subagent` facade.
// The upstream runtime, widgets (codexhost status snapshots) and execute paths stay untouched;
// only what the model sees is replaced.
import { isDeepStrictEqual } from "node:util";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import subagents from "pi-subagents";

const COLLAPSED_DISPLAY_SERVICE = Symbol.for("@local/pi-collapsed-tools.display-service.v1");

type CollapsedDisplayTool = { name: string };
type CollapsedDisplayService = { readonly version: 1; decorate<T extends CollapsedDisplayTool>(tool: T): T };

function decorateWithCollapsedDisplay<T extends CollapsedDisplayTool>(tool: T): T {
	const candidate = (globalThis as unknown as Record<PropertyKey, unknown>)[COLLAPSED_DISPLAY_SERVICE];
	if (!candidate || typeof candidate !== "object") return tool;
	const service = candidate as Partial<CollapsedDisplayService>;
	return service.version === 1 && typeof service.decorate === "function" ? service.decorate(tool) : tool;
}

type CapturedTool = ToolDefinition<any, any, any> & { exposure?: string };
type UpstreamExtension = (pi: ExtensionAPI) => unknown;
type FacadeParams = {
	agent?: string;
	task?: string;
	action?: string;
	id?: string;
	message?: string;
	async?: boolean;
	options?: Record<string, unknown>;
};

const MAIN = "subagent";
const WAIT = "bg_wait";
const SUPERVISOR = "subagent_supervisor";
// Folded into the facade; never registered with Pi directly.
const FOLDED = new Set([MAIN, WAIT, SUPERVISOR]);
// Top-level only: the loader is replaced by an always-active facade, and contact_supervisor
// only refuses outside a child (children run upstream without this wrapper).
const LOADER = "subagents_enable";
const DROPPED = new Set([LOADER, "contact_supervisor"]);
// Upstream accepts these only at the top level; the facade keeps them in `options` to stay small.
const TOP_LEVEL_ONLY = ["workflow", "args", "model", "cwd", "worktree", "output"];

const PARAMETERS = Type.Object({
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	action: Type.Optional(Type.String()),
	id: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
	async: Type.Optional(Type.Boolean()),
	options: Type.Optional(Type.Object({}, { additionalProperties: true })),
});

const DESCRIPTION = [
	"Delegate to child agents and manage runs. Launch {agent,task}; async defaults true and completion wakes you (never sleep or poll); async:false blocks.",
	"Other fields go in options (workflow, args, model, cwd, worktree, output, context, timeoutMs...). Management {action,id?,message?}: status, steer, stop, resume, list, guide.",
	"action wait = wait for detached work without native wake (options all/nonBlocking/timeoutMs). action supervisor.pending|reply|status answers child requests (reply: id, message).",
	"Results naming bg_wait or subagent_supervisor mean these actions.",
	"Delegate only when the user or instructions authorize it; one writer per cwd; on launch failure stop and report.",
].join(" ");

/** Map one facade call to the upstream tool and the arguments that tool's own schema expects. */
export function routeFacadeCall(params: FacadeParams): { name: string; args: Record<string, unknown> } {
	const { action, options, id, message } = params;
	if (action === "wait") return { name: WAIT, args: { ...options, ...(id ? { id } : {}) } };
	if (action?.startsWith("supervisor.")) {
		return {
			name: SUPERVISOR,
			args: { ...options, action: action.slice("supervisor.".length), ...(id ? { replyTo: id } : {}), ...(message !== undefined ? { message } : {}) },
		};
	}
	if (!options || typeof options !== "object" || Array.isArray(options)) return { name: MAIN, args: params as Record<string, unknown> };
	const args: Record<string, unknown> = { ...params };
	const rest: Record<string, unknown> = { ...options };
	for (const key of TOP_LEVEL_ONLY) {
		if (!(key in rest)) continue;
		if (args[key] !== undefined && !isDeepStrictEqual(args[key], rest[key])) {
			throw new Error(`subagent: '${key}' given both at the top level and in options with different values; give it once.`);
		}
		args[key] = rest[key];
		delete rest[key];
	}
	if (Object.keys(rest).length > 0) args.options = rest;
	else delete args.options;
	return { name: MAIN, args };
}

/** Tool names a transcript declares, replaying its system messages' tool changes. */
function recordedTools(messages: readonly { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }[]): Set<string> {
	const recorded = new Set<string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) recorded.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) recorded.add(tool.name);
	}
	return recorded;
}

export function createSubagentsFacade(upstream: UpstreamExtension = subagents as UpstreamExtension): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI): void => {
		const captured = new Map<string, CapturedTool>();
		let facade: CapturedTool | undefined;
		const route = routeFacadeCall;
		// Rendering must not throw on arguments execute would reject; fall back to the plain view.
		const routeForDisplay = (params: FacadeParams): { name: string; args: Record<string, unknown> } => {
			try {
				return route(params);
			} catch {
				return { name: "", args: params as Record<string, unknown> };
			}
		};

		const buildFacade = (main: CapturedTool): CapturedTool => decorateWithCollapsedDisplay({
			name: MAIN,
			label: main.label ?? "Subagent",
			...(main.exposure ? { exposure: main.exposure } : {}),
			description: DESCRIPTION,
			parameters: PARAMETERS,
			async execute(callId, params, signal, onUpdate, ctx) {
				const { name, args } = route(params as FacadeParams);
				const target = captured.get(name);
				if (!target) {
					const reason = name === SUPERVISOR ? "no child supervisor channel is active" : `${name} is not registered`;
					return { content: [{ type: "text", text: `subagent: ${reason}.` }], details: {}, isError: true };
				}
				// Pi validated only the facade shell; apply the target's own schema, as a direct call would.
				const validated = validateToolArguments(target as never, { type: "toolCall", id: callId, name, arguments: args } as never);
				return target.execute(callId, validated, signal, onUpdate, ctx);
			},
			renderCall(args, theme, context) {
				const { name, args: routed } = routeForDisplay(args as FacadeParams);
				const target = captured.get(name);
				if (target?.renderCall) return target.renderCall(routed, theme, { ...context, args: routed });
				return new Text(theme.fg("toolTitle", `subagent ${(args as FacadeParams).action ?? ""}`.trim()), 0, 0);
			},
			renderResult(result, options, theme, context) {
				const { name, args: routed } = routeForDisplay((context.args ?? {}) as FacadeParams);
				const target = captured.get(name);
				if (target?.renderResult) return target.renderResult(result, options, theme, { ...context, args: routed });
				const text = result.content
					.filter((entry: { type: string }): entry is { type: "text"; text: string } => entry.type === "text")
					.map((entry: { text: string }) => entry.text)
					.join("\n");
				return new Text(text, 0, 0);
			},
		} as CapturedTool);

		const proxy = new Proxy(pi, {
			get(target, property, receiver) {
				if (property === "registerTool") {
					return (tool: CapturedTool) => {
						if (DROPPED.has(tool.name)) return;
						if (!FOLDED.has(tool.name)) return target.registerTool(tool);
						captured.set(tool.name, tool);
						// Upstream re-registers `subagent` on session start (declaration pinning); keep one stable facade.
						if (tool.name === MAIN) {
							facade ??= buildFacade(tool);
							target.registerTool(facade as never);
						}
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		upstream(proxy);

		// A transcript that declared only upstream's loader would resume without any delegation tool:
		// Pi restores the recorded loadout, and upstream re-activates nothing once the loader is gone.
		const restoreLegacyLoader = (_event: unknown, ctx: { sessionManager: unknown }): void => {
			const manager = ctx.sessionManager as { buildSessionContext?: () => { messages: never[] } };
			const active = pi.getActiveTools();
			if (active.includes(MAIN) || typeof manager.buildSessionContext !== "function") return;
			if (!pi.getAllTools().some((tool) => tool.name === MAIN)) return;
			if (recordedTools(manager.buildSessionContext().messages).has(LOADER)) pi.setActiveTools([...active, MAIN]);
		};
		pi.on("session_start", restoreLegacyLoader);
		pi.on("session_tree", restoreLegacyLoader);
	};
}

export default createSubagentsFacade();
