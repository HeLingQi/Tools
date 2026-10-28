import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatGoalLines, formatGoalMarkdown } from "./format";
import { buildGoalContinuationPrompt, buildGoalSteeringPrompt } from "./prompts";
import {
	applyGoalEvent,
	createGoalEvent,
	GOAL_CONTINUATION_CONTEXT,
	GOAL_EVENT,
	GOAL_STEERING_CONTEXT,
	isTerminalStatus,
	isSteeringActive,
	nowIso,
	reconstructGoal,
	type GoalEvent,
	type GoalMode,
	type GoalState,
	type GoalStatus,
	type SessionEntryLike,
} from "./state";
import { refreshGoalUi } from "./ui";

const MODE_SCHEMA = Type.Union([Type.Literal("manual"), Type.Literal("assist"), Type.Literal("auto")]);
const STATUS_SCHEMA = Type.Union([
	Type.Literal("active"),
	Type.Literal("paused"),
	Type.Literal("blocked"),
	Type.Literal("completed"),
	Type.Literal("cancelled"),
]);
const STEP_STATUS_SCHEMA = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("done"),
	Type.Literal("blocked"),
]);

const MAX_HISTORY_EVENTS = 40;
const MAX_NO_PROGRESS_CONTINUATIONS = 2;
const QUESTION_RE = /[?？]\s*$|(?:^|\n)\s*(?:please confirm|need your approval|waiting for you|which option|what would you like|please share|请(?:确认|提供|选择)|需要(?:你|您)(?:的)?(?:确认|授权|批准))/i;

function getBranch(ctx: ExtensionContext): SessionEntryLike[] {
	return ctx.sessionManager.getBranch() as SessionEntryLike[];
}

function readGoal(ctx: ExtensionContext): ReturnType<typeof reconstructGoal> {
	return reconstructGoal(getBranch(ctx));
}

function appendGoalEvent(pi: ExtensionAPI, ctx: ExtensionContext, event: GoalEvent): GoalState | undefined {
	const base = readGoal(ctx).state;
	pi.appendEntry(GOAL_EVENT, event);
	const current = applyGoalEvent(base, event);
	refreshGoalUi(ctx, current);
	return current;
}

function statusEvent(goalId: string, status: GoalStatus, reason?: string): GoalEvent {
	return { kind: "status", goalId, status, reason, at: nowIso() };
}

function startGoal(pi: ExtensionAPI, ctx: ExtensionContext, state: GoalState | undefined): void {
	if (!state || state.status !== "active" || state.mode !== "auto" || !ctx.isIdle() || ctx.hasPendingMessages()) return;
	pi.sendMessage({
		customType: GOAL_CONTINUATION_CONTEXT,
		content: buildGoalContinuationPrompt(state),
		display: false,
		details: { goalId: state.goalId },
	}, { triggerTurn: true });
}

function assertMode(value: string | undefined): GoalMode | undefined {
	if (value === "manual" || value === "assist" || value === "auto") return value;
	return undefined;
}

function getErrorResult(message: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: message }], isError: true, details: { ok: false, ...details } };
}

function getGoalResult(state: GoalState | undefined, history: GoalEvent[] = []) {
	return {
		content: [{ type: "text" as const, text: formatGoalMarkdown(state, history) }],
		details: { ok: true, goal: state, history: history.slice(-MAX_HISTORY_EVENTS) },
	};
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: string; text?: string };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function commandUsage(): string {
	return `Usage: /goal [show|create|edit|update|done|block|pause|resume|clear|auto|mode]\n\nExamples:\n  /goal migrate TargetTracking to features\n  /goal show\n  /goal pause\n  /goal resume\n  /goal edit new goal text\n  /goal auto on\n  /goal done implemented and tested`;
}

async function handleGoalCommand(args: string, pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const trimmed = args.trim();
	const { state, history } = readGoal(ctx);

	if (!trimmed || ["show", "status", "view"].includes(trimmed)) {
		ctx.ui.notify(formatGoalLines(state, history.length).join("\n"), "info");
		refreshGoalUi(ctx, state);
		return;
	}

	if (trimmed === "help") {
		ctx.ui.notify(commandUsage(), "info");
		return;
	}

	const [subcommandRaw = "", ...rest] = trimmed.split(/\s+/);
	const subcommand = subcommandRaw.toLowerCase();
	const restText = rest.join(" ").trim();

	if (["create", "set"].includes(subcommand) || !isKnownSubcommand(subcommand)) {
		const text = ["create", "set"].includes(subcommand) ? restText : trimmed;
		if (!text) {
			ctx.ui.notify("Goal text is required.", "warning");
			return;
		}
		if (state && !isTerminalStatus(state.status)) {
			ctx.ui.notify("A non-terminal goal already exists. Use /goal edit <text>, /goal done, /goal pause/resume, or /goal clear first.", "warning");
			return;
		}
		const created = appendGoalEvent(pi, ctx, createGoalEvent(text, "assist"));
		ctx.ui.notify(`Goal created:\n${formatGoalLines(created).join("\n")}`, "info");
		return;
	}

	if (!state) {
		ctx.ui.notify("No goal set. Use /goal <text> to create one.", "warning");
		return;
	}

	switch (subcommand) {
		case "edit": {
			if (!restText) {
				ctx.ui.notify("Usage: /goal edit <new goal text>", "warning");
				return;
			}
			const updated = appendGoalEvent(pi, ctx, {
				kind: "updated",
				goalId: state.goalId,
				patch: { text: restText },
				note: "Goal text edited by user",
				at: nowIso(),
			});
			ctx.ui.notify(`Goal updated:\n${formatGoalLines(updated).join("\n")}`, "info");
			return;
		}
		case "update": {
			if (!restText) {
				ctx.ui.notify("Usage: /goal update <progress note>", "warning");
				return;
			}
			const updated = appendGoalEvent(pi, ctx, {
				kind: "updated",
				goalId: state.goalId,
				patch: { summary: restText },
				note: restText,
				at: nowIso(),
			});
			ctx.ui.notify(`Progress recorded:\n${formatGoalLines(updated).join("\n")}`, "info");
			return;
		}
		case "pause":
			ctx.ui.notify(`Goal paused. Resume with /goal resume.`, "info");
			appendGoalEvent(pi, ctx, statusEvent(state.goalId, "paused", restText || "paused by user"));
			ctx.abort();
			return;
		case "resume": {
			if (isTerminalStatus(state.status)) {
				ctx.ui.notify("A finished goal cannot be resumed. Create a new goal instead.", "warning");
				return;
			}
			const resumed = appendGoalEvent(pi, ctx, statusEvent(state.goalId, "active", restText || "resumed by user"));
			ctx.ui.notify(`Goal resumed in ${state.mode} mode.`, "info");
			startGoal(pi, ctx, resumed);
			return;
		}
		case "done":
		case "complete":
			appendGoalEvent(pi, ctx, statusEvent(state.goalId, "completed", restText || "completed by user"));
			ctx.ui.notify("Goal completed.", "info");
			return;
		case "block":
			appendGoalEvent(pi, ctx, statusEvent(state.goalId, "blocked", restText || "blocked by user"));
			ctx.ui.notify("Goal blocked.", "warning");
			return;
		case "cancel":
		case "clear":
			appendGoalEvent(pi, ctx, statusEvent(state.goalId, "cancelled", restText || (subcommand === "clear" ? "cleared by user" : "cancelled by user")));
			refreshGoalUi(ctx, undefined);
			ctx.ui.notify(subcommand === "clear" ? "Goal cleared." : "Goal cancelled.", "info");
			return;
		case "auto": {
			if (restText !== "on" && restText !== "off") {
				ctx.ui.notify("Usage: /goal auto on|off", "warning");
				return;
			}
			const mode: GoalMode = restText === "on" ? "auto" : "assist";
			const updated = appendGoalEvent(pi, ctx, {
				kind: "updated",
				goalId: state.goalId,
				patch: { mode },
				note: `auto ${restText}`,
				at: nowIso(),
			});
			ctx.ui.notify(`Goal mode set to ${updated?.mode ?? mode}.`, "info");
			startGoal(pi, ctx, updated);
			return;
		}
		case "mode": {
			const mode = assertMode(restText);
			if (!mode) {
				ctx.ui.notify("Usage: /goal mode manual|assist|auto", "warning");
				return;
			}
			const updated = appendGoalEvent(pi, ctx, {
				kind: "updated",
				goalId: state.goalId,
				patch: { mode },
				note: `mode ${mode}`,
				at: nowIso(),
			});
			ctx.ui.notify(`Goal mode set to ${mode}.`, "info");
			startGoal(pi, ctx, updated);
			return;
		}
		default:
			ctx.ui.notify(commandUsage(), "warning");
	}
}

function isKnownSubcommand(value: string): boolean {
	return [
		"show",
		"status",
		"view",
		"help",
		"create",
		"set",
		"edit",
		"update",
		"pause",
		"resume",
		"done",
		"complete",
		"block",
		"cancel",
		"clear",
		"auto",
		"mode",
	].includes(value);
}

function shouldStopForAssistantQuestion(event: { messages?: unknown }): boolean {
	const messages = Array.isArray(event.messages) ? event.messages : [];
	const lastAssistant = [...messages]
		.reverse()
		.find((message): message is { role?: string; content?: unknown } => Boolean(message && typeof message === "object" && (message as { role?: string }).role === "assistant"));
	return QUESTION_RE.test(extractTextContent(lastAssistant?.content).trim());
}

export default function goalExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const { state } = readGoal(ctx);
		refreshGoalUi(ctx, state);
	});
	pi.on("session_tree", (_event, ctx) => refreshGoalUi(ctx, readGoal(ctx).state));

	pi.registerCommand("goal", {
		description: "Codex-style persistent session goal: /goal <text>, /goal show, /goal pause/resume/clear/edit, /goal auto on",
		getArgumentCompletions(prefix: string) {
			const options = ["show", "create ", "edit ", "update ", "pause", "resume", "done ", "block ", "clear", "auto on", "auto off", "mode manual", "mode assist", "mode auto"];
			return options.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => handleGoalCommand(args, pi, ctx),
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Inspect the current session goal and progress.",
		promptSnippet: "Inspect the active session goal and progress",
		promptGuidelines: ["Use get_goal before substantial work when a session goal is active and you need current structured progress."],
		parameters: Type.Object({ includeHistory: Type.Optional(Type.Boolean({ description: "Include recent goal event history." })) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { state, history } = readGoal(ctx);
			refreshGoalUi(ctx, state);
			return getGoalResult(state, params.includeHistory ? history.map((h) => h.event) : []);
		},
	});

	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description: "Create a persistent session goal. Auto mode continues unattended until completion or a stop condition.",
		promptSnippet: "Create or formalize the active session goal",
		promptGuidelines: [
			"Use create_goal only when the user asks to set a goal or no active goal exists and the request clearly defines one.",
			"Do not overwrite an active goal with create_goal unless replace is true or the current goal is terminal.",
		],
		parameters: Type.Object({
			goal: Type.String({ description: "Goal text." }),
			mode: Type.Optional(MODE_SCHEMA),
			replace: Type.Optional(Type.Boolean({ description: "Replace an existing active goal." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { state } = readGoal(ctx);
			if (!params.goal.trim()) return getErrorResult("Goal text is required.");
			if (state && !isTerminalStatus(state.status) && !params.replace) {
				return getErrorResult("A non-terminal goal already exists. Pass replace=true to replace it.", { goal: state });
			}
			if (state && params.replace && !isTerminalStatus(state.status)) {
				appendGoalEvent(pi, ctx, statusEvent(state.goalId, "cancelled", "replaced by create_goal"));
			}
			const created = appendGoalEvent(pi, ctx, createGoalEvent(params.goal, params.mode ?? "assist"));
			return getGoalResult(created);
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Update goal progress, next action, plan, blockers, mode, or status.",
		promptSnippet: "Update active session goal progress or status",
		promptGuidelines: [
			"Use update_goal after meaningful progress, when blocked, and when the session goal is complete.",
			"Use update_goal with status=blocked when user input, approval, or credentials are required.",
		],
		parameters: Type.Object({
			status: Type.Optional(STATUS_SCHEMA),
			summary: Type.Optional(Type.String()),
			progressNote: Type.Optional(Type.String()),
			nextAction: Type.Optional(Type.String()),
			blockers: Type.Optional(Type.Array(Type.String())),
			mode: Type.Optional(MODE_SCHEMA),
			plan: Type.Optional(
				Type.Array(
					Type.Object({ id: Type.String(), text: Type.String(), status: STEP_STATUS_SCHEMA }),
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { state } = readGoal(ctx);
			if (!state) return getErrorResult("No active goal. Use create_goal first.");

			if (params.status === "active" && isTerminalStatus(state.status)) {
				return getErrorResult("A finished goal cannot be resumed. Create a new goal instead.");
			}
			const patch = {
				summary: params.summary ?? params.progressNote,
				nextAction: params.nextAction,
				blockers: params.blockers,
				plan: params.plan,
				mode: params.mode,
			};
			const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));

			let updated = state;
			if (Object.keys(cleanPatch).length > 0 || params.progressNote) {
				updated = appendGoalEvent(pi, ctx, {
					kind: "updated",
					goalId: state.goalId,
					patch: cleanPatch,
					note: params.progressNote,
					at: nowIso(),
				}) ?? updated;
			}
			if (params.status) {
				updated = appendGoalEvent(pi, ctx, statusEvent(state.goalId, params.status, params.summary ?? params.progressNote)) ?? updated;
			}
			return getGoalResult(updated);
		},
	});

	pi.on("context", (event, ctx) => {
		const { state } = readGoal(ctx);
		// 只替换自有消息；源码和用户输入中的相同标记不能被误删。
		const messages = event.messages.filter((message) => message.role !== "custom"
			|| (message.customType !== GOAL_STEERING_CONTEXT && message.customType !== GOAL_CONTINUATION_CONTEXT));
		if (isSteeringActive(state)) {
			messages.push({
				role: "custom", customType: GOAL_STEERING_CONTEXT,
				content: buildGoalSteeringPrompt(state), display: false,
				details: { goalId: state.goalId }, timestamp: Date.now(),
			});
		}
		return { messages };
	});

	pi.on("agent_before_settle", (event, ctx) => {
		const { state } = readGoal(ctx);
		refreshGoalUi(ctx, state);
		if (!state || state.status !== "active" || state.mode !== "auto") return;
		if (event.outcome !== "completed") {
			appendGoalEvent(pi, ctx, statusEvent(state.goalId, "paused", `执行${event.outcome === "aborted" ? "已中止" : "失败"}，确认后用 /goal resume 恢复`));
			return;
		}
		if (event.continue || event.context.pendingMessages.length > 0 || ctx.hasPendingMessages()) return;
		if (shouldStopForAssistantQuestion({ messages: event.context.contextMessages })) {
			appendGoalEvent(pi, ctx, statusEvent(state.goalId, "blocked", "等待用户输入或确认"));
			return;
		}
		if (state.noProgressTurns >= MAX_NO_PROGRESS_CONTINUATIONS) {
			appendGoalEvent(pi, ctx, statusEvent(state.goalId, "paused", "连续两次自动续跑未更新实质进度，请检查后用 /goal resume 恢复"));
			return;
		}
		// 在最终边界请求一次续跑，不使用 agent_end 的队列回灌，避免取消后复活。
		return {
			continue: true,
			entries: [
				{ type: "custom", customType: GOAL_EVENT, data: {
					kind: "continuation", goalId: state.goalId, action: "queued", reason: "auto-continuation", at: nowIso(),
				} },
				// Pi 的续跑上下文不能以 assistant 结尾，必须附带新的输入消息。
				{ type: "custom_message", customType: GOAL_CONTINUATION_CONTEXT,
					content: buildGoalContinuationPrompt(state), display: false, details: { goalId: state.goalId } },
			],
		};
	});

	pi.on("session_shutdown", (_event, ctx) => refreshGoalUi(ctx, undefined));
}
