import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatGoalCompletion, truncate } from "./format";
import type { GoalState } from "./state";

const STATUS_ID = "goal";
const WIDGET_ID = "goal";

export function refreshGoalUi(ctx: ExtensionContext, state: GoalState | undefined): void {
	if (!state) {
		ctx.ui.setStatus(STATUS_ID, undefined);
		ctx.ui.setWidget(WIDGET_ID, undefined);
		return;
	}

	if (state.status === "active") {
		ctx.ui.setStatus(STATUS_ID, state.mode === "auto" ? "🎯 auto" : "🎯 goal");
	} else if (state.status === "paused") {
		ctx.ui.setStatus(STATUS_ID, "🎯 paused");
	} else if (state.status === "blocked") {
		ctx.ui.setStatus(STATUS_ID, "🎯 blocked");
	} else if (state.status === "completed") {
		ctx.ui.setStatus(STATUS_ID, "🎯 done");
	} else {
		ctx.ui.setStatus(STATUS_ID, undefined);
	}

	if (state.status === "cancelled") {
		ctx.ui.setWidget(WIDGET_ID, undefined);
		return;
	}

	const lines = [
		`🎯 Goal: ${truncate(state.text, 90)}`,
		`mode: ${state.mode} · status: ${state.status}`,
	];
	const completion = formatGoalCompletion(state);
	if (completion) lines.push(completion);
	if (state.nextAction) lines.push(`next: ${truncate(state.nextAction, 82)}`);
	else if (state.summary) lines.push(`progress: ${truncate(state.summary, 82)}`);
	if (state.status === "paused" && state.lastContinuationReason) lines.push(`paused: ${truncate(state.lastContinuationReason, 82)}`);
	if (state.blockers.length > 0) lines.push(`blocked: ${truncate(state.blockers[state.blockers.length - 1], 82)}`);
	ctx.ui.setWidget(WIDGET_ID, lines.slice(0, 4));
}
