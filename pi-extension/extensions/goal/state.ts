export const GOAL_EVENT = "goal-event";
export const GOAL_STEERING_CONTEXT = "goal-steering-context";
export const GOAL_CONTINUATION_CONTEXT = "goal-continuation";

export type GoalStatus = "active" | "paused" | "blocked" | "completed" | "cancelled";
export type GoalMode = "manual" | "assist" | "auto";
export type GoalStepStatus = "pending" | "in_progress" | "done" | "blocked";

export interface GoalStep {
	id: string;
	text: string;
	status: GoalStepStatus;
}

export interface GoalState {
	goalId: string;
	text: string;
	status: GoalStatus;
	mode: GoalMode;
	createdAt: string;
	updatedAt: string;
	summary?: string;
	plan?: GoalStep[];
	nextAction?: string;
	blockers: string[];
	lastContinuationAt?: string;
	lastContinuationReason?: string;
	noProgressTurns: number;
	lastProgressAt?: string;
}

export type GoalEvent =
	| {
			kind: "created";
			goalId: string;
			text: string;
			mode: GoalMode;
			at: string;
	  }
	| {
			kind: "updated";
			goalId: string;
			patch: Partial<Pick<GoalState, "text" | "summary" | "plan" | "nextAction" | "blockers" | "mode">>;
			note?: string;
			at: string;
	  }
	| { kind: "status"; goalId: string; status: GoalStatus; reason?: string; at: string }
	| { kind: "continuation"; goalId: string; action: "queued" | "skipped" | "stopped"; reason: string; at: string };

export interface HistoryEntry {
	event: GoalEvent;
}

export interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function newGoalId(): string {
	return `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createGoalEvent(text: string, mode: GoalMode = "assist"): GoalEvent {
	const at = nowIso();
	return {
		kind: "created",
		goalId: newGoalId(),
		text: text.trim(),
		mode,
		at,
	};
}

export function applyGoalEvent(state: GoalState | undefined, event: GoalEvent): GoalState | undefined {
	if (event.kind === "created") {
		return {
			goalId: event.goalId,
			text: event.text,
			status: "active",
			mode: event.mode,
			createdAt: event.at,
			updatedAt: event.at,
			blockers: [],
			noProgressTurns: 0,
		};
	}

	if (!state || state.goalId !== event.goalId) return state;

	switch (event.kind) {
		case "updated": {
			// 旧会话的补丁可能含已移除字段，只恢复当前支持的目标数据。
			const patch = Object.fromEntries(Object.entries(event.patch).filter(([key, value]) =>
				["text", "summary", "plan", "nextAction", "blockers", "mode"].includes(key) && value !== undefined,
			)) as typeof event.patch;
			const progressChanged = (patch.summary !== undefined && patch.summary !== state.summary)
				|| (patch.plan !== undefined && JSON.stringify(patch.plan) !== JSON.stringify(state.plan));
			return {
				...state,
				...patch,
				updatedAt: event.at,
				noProgressTurns: progressChanged ? 0 : state.noProgressTurns,
				lastProgressAt: progressChanged ? event.at : state.lastProgressAt,
			};
		}
		case "status":
			return {
				...state,
				status: event.status,
				updatedAt: event.at,
				blockers: event.status === "active" ? [] : event.status === "blocked" && event.reason ? [...new Set([...state.blockers, event.reason])] : state.blockers,
				summary: event.status === "completed" && event.reason ? event.reason : state.summary,
				noProgressTurns: event.status === "active" && state.status !== "active" ? 0 : state.noProgressTurns,
				lastContinuationReason: event.reason,
			};
		case "continuation":
			return {
				...state,
				updatedAt: event.at,
				lastContinuationAt: event.action === "queued" ? event.at : state.lastContinuationAt,
				lastContinuationReason: event.reason,
				noProgressTurns: event.action === "queued" ? state.noProgressTurns + 1 : state.noProgressTurns,
			};
	}
}

export function isGoalEvent(value: unknown): value is GoalEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as { kind?: unknown; goalId?: unknown };
	return typeof event.kind === "string" && ["created", "updated", "status", "continuation"].includes(event.kind) && typeof event.goalId === "string";
}

export function extractGoalEvents(entries: SessionEntryLike[]): HistoryEntry[] {
	const history: HistoryEntry[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== GOAL_EVENT) continue;
		if (isGoalEvent(entry.data)) history.push({ event: entry.data });
	}
	return history;
}

export function reconstructGoal(entries: SessionEntryLike[]): { state?: GoalState; history: HistoryEntry[] } {
	const history = extractGoalEvents(entries);
	let state: GoalState | undefined;
	for (const { event } of history) {
		state = applyGoalEvent(state, event);
	}
	return { state, history };
}

export function isTerminalStatus(status: GoalStatus): boolean {
	return status === "completed" || status === "cancelled";
}

export function isSteeringActive(state: GoalState | undefined): state is GoalState {
	return Boolean(state && state.status === "active" && (state.mode === "assist" || state.mode === "auto"));
}
