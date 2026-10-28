import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

/**
 * Auto Compact @ 90%
 *
 * Install:
 *   mkdir -p ~/.pi/agent/extensions
 *   cp auto-compact.ts ~/.pi/agent/extensions/auto-compact.ts
 *
 * Then restart Pi, or run /reload in Pi.
 *
 * Behavior:
 * - Checks context usage after the agent fully settles.
 * - When usage crosses from <90% to >=90%, triggers Pi's native compaction.
 * - Does not repeatedly compact while already above 90%.
 * - After automatic compaction, resumes the preserved task in a fresh turn.
 * - After compaction drops usage below 90%, it is armed again.
 * - Adds /auto-compact-status for checking current usage.
 * - Adds /auto-compact-now for manual compaction.
 */

const THRESHOLD_PERCENT = 90;

export default function (pi: ExtensionAPI) {
  let wasAboveThreshold = false;
  let compacting = false;

  function notify(ctx: ExtensionContext, message: string, level: "info" | "success" | "warning" | "error" = "info") {
    if (ctx.hasUI) {
      ctx.ui.notify(message, level);
    }
  }

  function compact(ctx: ExtensionContext, continueTask = false) {
    if (compacting || !ctx.isIdle()) return;

    const usage = ctx.getContextUsage();
    if (!usage || usage.percent == null) return;

    compacting = true;

    notify(
      ctx,
      `Context ${usage.percent.toFixed(1)}% >= ${THRESHOLD_PERCENT}%, auto-compacting...`,
      "warning",
    );

    ctx.compact({
      customInstructions:
        "Preserve the exact original goal, current task state, important decisions, constraints, file paths, commands, code changes, errors, unresolved issues, and concrete next steps. Explicitly state whether the task is complete. Remove redundant discussion and obsolete details.",
      onComplete: () => {
        compacting = false;

        // Re-arm only after usage has actually dropped below the threshold.
        wasAboveThreshold = true;

        notify(ctx, "Auto-compaction completed.", "success");

        if (continueTask) {
          pi.sendMessage(
            {
              customType: "auto-compact-continue",
              content:
                "Continue the current task from the compaction summary. Follow the recorded next steps, verify the work, and only finish when the original task is complete.",
              display: false,
            },
            { triggerTurn: true },
          );
        }
      },
      onError: (error) => {
        compacting = false;

        // Avoid an immediate retry loop while context is still above 90%.
        wasAboveThreshold = true;

        notify(ctx, `Auto-compaction failed: ${error.message}`, "error");
      },
    });
  }

  // turn_end still runs inside the agent loop; manual compact() would abort that run.
  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted) return;

    const usage = ctx.getContextUsage();

    if (!usage || usage.percent == null) {
      return;
    }

    const isAboveThreshold = usage.percent >= THRESHOLD_PERCENT;

    // Trigger only when crossing the threshold.
    if (isAboveThreshold && !wasAboveThreshold && !compacting) {
      wasAboveThreshold = true;
      compact(ctx, true);
      return;
    }

    // Once usage is back below the threshold, arm the trigger again.
    if (!isAboveThreshold) {
      wasAboveThreshold = false;
    }
  });

  pi.registerCommand("auto-compact-status", {
    description: "Show current context usage and auto-compact threshold",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();

      if (!usage || usage.percent == null) {
        notify(ctx, `Context usage unavailable. Threshold: ${THRESHOLD_PERCENT}%`, "info");
        return;
      }

      const tokens =
        usage.tokens == null ? "unknown" : usage.tokens.toLocaleString();
      const window = usage.contextWindow.toLocaleString();

      notify(
        ctx,
        `Context: ${usage.percent.toFixed(1)}% (${tokens}/${window} tokens), auto-compact at ${THRESHOLD_PERCENT}%`,
        "info",
      );
    },
  });

  pi.registerCommand("auto-compact-now", {
    description: "Trigger context compaction immediately",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      compact(ctx);
    },
  });
}
