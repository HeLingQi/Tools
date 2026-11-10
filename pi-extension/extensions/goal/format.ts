import type { GoalEvent, GoalState } from "./state";

const MAX_GOAL_CHARS = 96;
const MAX_NEXT_CHARS = 80;

export function truncate(text: string | undefined, max = 80): string {
	if (!text) return "—";
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function formatDuration(durationMs: number | undefined): string {
	if (durationMs === undefined) return "不可用";
	const totalSeconds = Math.floor(durationMs / 1000);
	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor(totalSeconds % 86400 / 3600);
	const minutes = Math.floor(totalSeconds % 3600 / 60);
	const seconds = totalSeconds % 60;
	const parts = [];
	if (days > 0) parts.push(`${days}天`);
	if (hours > 0) parts.push(`${hours}小时`);
	if (minutes > 0) parts.push(`${minutes}分`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);
	return parts.join(" ");
}

export function formatGoalCompletion(state: GoalState): string | undefined {
	if (!state.completion) return undefined;
	return `总耗时: ${formatDuration(state.completion.durationMs)} · 总 Token: ${state.completion.totalTokens ?? "不可用"}`;
}

export function formatGoalLines(state: GoalState | undefined, historyLength = 0): string[] {
	if (!state) return ["No goal set. Use /goal <text> to create one."];
	const lines = [
		`🎯 Goal: ${truncate(state.text, MAX_GOAL_CHARS)}`,
		`status: ${state.status} · mode: ${state.mode}`,
	];
	if (state.status === "paused" && state.lastContinuationReason) lines.push(`paused: ${state.lastContinuationReason}`);
	if (state.summary) lines.push(`progress: ${truncate(state.summary, MAX_GOAL_CHARS)}`);
	if (state.nextAction) lines.push(`next: ${truncate(state.nextAction, MAX_NEXT_CHARS)}`);
	if (state.blockers.length > 0) lines.push(`blockers: ${truncate(state.blockers.join("; "), MAX_GOAL_CHARS)}`);
	const completion = formatGoalCompletion(state);
	if (completion) lines.push(completion);
	lines.push(`updated: ${state.updatedAt}${historyLength > 0 ? ` · events: ${historyLength}` : ""}`);
	return lines;
}

export function formatGoalMarkdown(state: GoalState | undefined, history?: GoalEvent[]): string {
	if (!state) return "No goal set. Use `/goal <text>` or `create_goal` to create one.";
	const lines = [
		`Goal: ${state.text}`,
		`Status: ${state.status}`,
		`Mode: ${state.mode}`,
		`Created: ${state.createdAt}`,
		`Updated: ${state.updatedAt}`,
	];
	if (state.status === "paused" && state.lastContinuationReason) lines.push(`Paused: ${state.lastContinuationReason}`);
	if (state.summary) lines.push(`Progress: ${state.summary}`);
	if (state.nextAction) lines.push(`Next action: ${state.nextAction}`);
	if (state.blockers.length > 0) lines.push(`Blockers: ${state.blockers.join("; ")}`);
	const completion = formatGoalCompletion(state);
	if (completion) lines.push(completion);
	if (state.plan && state.plan.length > 0) {
		lines.push("", "Plan");
		for (const step of state.plan) lines.push(`[${step.status === "done" ? "x" : " "}] ${step.id}: ${step.text} (${step.status})`);
	}
	if (history && history.length > 0) {
		lines.push("", "Recent events");
		for (const event of history.slice(-12)) lines.push(`${event.at}: ${event.kind}`);
	}
	return lines.join("\n");
}
