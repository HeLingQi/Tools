import { FooterComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Token Speed Monitor & Footer Beautifier Extension
 *
 * 功能：
 * 1. 监测模型输出速度 (tokens/s)、TTFT 首字延迟、总耗时
 * 2. 美化 Footer 第三行扩展状态栏：增加优雅的 "│" 分隔符，净化冗余图标和文字，让状态行规整清爽
 * 3. 提供 /speed 查看上一轮生成的完整指标
 */
export default function tokenSpeedExtension(pi: ExtensionAPI) {
  let startTime = 0;
  let firstTokenTime = 0;
  let lastCharCount = 0;
  let lastSpeedCheckTime = 0;
  let currentSpeed = 0;

  function countAssistantChars(content: unknown[]): number {
    if (!Array.isArray(content)) return 0;
    let chars = 0;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        chars += b.text.length;
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        chars += b.thinking.length;
      } else if (b.type === "toolCall") {
        const name = typeof b.name === "string" ? b.name : "";
        const argsStr = b.arguments ? JSON.stringify(b.arguments) : "{}";
        chars += name.length + argsStr.length;
      }
    }
    return chars;
  }

  let lastStats: {
    model?: string;
    output?: number;
    reasoning?: number;
    input?: number;
    cacheRead?: number;
    durationMs?: number;
    ttftMs?: number;
    genTps?: number;
    overallTps?: number;
  } | null = null;

  function setupBeautifiedFooter(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange?.(() => tui.requestRender());

      const sessionShim = {
        state: {
          get model() { return ctx.model; },
          get thinkingLevel() { return ctx.thinkingLevel; },
        },
        sessionManager: ctx.sessionManager,
        getContextUsage: () => ctx.getContextUsage(),
        modelRuntime: (ctx.modelRegistry as unknown as { runtime: unknown })?.runtime,
        autoCompactionEnabled: true,
      };

      const baseFooter = new FooterComponent(sessionShim, footerData);

      return {
        dispose: () => {
          unsub?.();
          baseFooter.dispose?.();
        },
        invalidate() {
          baseFooter.invalidate?.();
        },
        render(width: number): string[] {
          const lines = baseFooter.render(width);
          const map = footerData.getExtensionStatuses();
          if (map.size > 0 && lines.length >= 3) {
            const entries = Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
            const items = entries.map(([key, text]) => {
              let clean = text.trim();
              if (key === "mcp") {
                // 精简 mcp 结尾的尾点和多余文字
                clean = clean.replace(/\s*●\s*$/, "").replace(/servers enabled/, "servers");
              } else if (key === "ponytail") {
                // 移除重复的闪电符号，避免和速度图标撞车
                clean = clean.replace(/⚡\s*/, "");
              }
              return clean;
            });

            const separator = ` ${theme.fg("dim", "│")} `;
            const statusLine = items.join(separator);
            lines[2] = truncateToWidth(statusLine, width, theme.fg("dim", "..."));
          }
          return lines;
        },
      };
    });
  }

  pi.on("session_start", (_event, ctx) => {
    setupBeautifiedFooter(ctx);
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    startTime = Date.now();
    firstTokenTime = 0;
    lastCharCount = 0;
    lastSpeedCheckTime = 0;
    currentSpeed = 0;
    if (ctx.hasUI) {
      ctx.ui.setStatus("token-speed", ctx.ui.theme.fg("accent", "⚡ -- tok/s"));
    }
  });

  pi.on("message_update", (event, ctx) => {
    if (event.message.role !== "assistant" || !startTime) return;
    const now = Date.now();
    if (!firstTokenTime) {
      firstTokenTime = now;
      lastSpeedCheckTime = now;
    }

    if (ctx.hasUI) {
      // 优先从 provider 上报的 usage 取 output tokens，若流式中未上报则按字符估算
      const usageOutput = event.message.usage?.output;
      let tokens = typeof usageOutput === "number" && usageOutput > 0 ? usageOutput : 0;
      if (!tokens) {
        const chars = countAssistantChars(event.message.content as unknown[]);
        // 中英文混合经验值：约 2~2.5 字符 / token，取 2.3 粗估
        tokens = Math.round(chars / 2.3);
      }

      const elapsedSec = (now - firstTokenTime) / 1000;
      if (elapsedSec > 0.2 && tokens > 0) {
        // 滑动窗口平滑速度，类似于网速波动刷新
        if (!lastSpeedCheckTime || now - lastSpeedCheckTime >= 300) {
          const instantSpeed = tokens / elapsedSec;
          currentSpeed = currentSpeed === 0 ? instantSpeed : currentSpeed * 0.4 + instantSpeed * 0.6;
          lastSpeedCheckTime = now;
        }
        const speedDisplay = currentSpeed >= 10 ? currentSpeed.toFixed(0) : currentSpeed.toFixed(1);
        ctx.ui.setStatus("token-speed", ctx.ui.theme.fg("accent", `⚡ ${speedDisplay} tok/s`));
      } else {
        ctx.ui.setStatus("token-speed", ctx.ui.theme.fg("accent", "⚡ ... tok/s"));
      }
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const msg = event.message;
    const outputTokens = msg.usage?.output ?? 0;
    const durationMs = msg.durationMs ?? (startTime ? Date.now() - startTime : 0);
    const ttftMs = firstTokenTime && startTime ? firstTokenTime - startTime : 0;
    // 纯生成耗时（排除首字等待），反映真实吐字速度
    const genDurationMs = Math.max(durationMs - ttftMs, 50);

    if (outputTokens > 0 && durationMs > 0) {
      const genTps = Number((outputTokens / (genDurationMs / 1000)).toFixed(1));
      const overallTps = Number((outputTokens / (durationMs / 1000)).toFixed(1));

      lastStats = {
        model: msg.model,
        output: outputTokens,
        reasoning: msg.usage?.reasoning,
        input: msg.usage?.input,
        cacheRead: msg.usage?.cacheRead,
        durationMs,
        ttftMs,
        genTps,
        overallTps,
      };

      if (ctx.hasUI) {
        const theme = ctx.ui.theme;
        // 默认直接突出展示速度指标，类似网速状态
        ctx.ui.setStatus("token-speed", theme.fg("accent", `⚡ ${genTps} tok/s`));
      }
    } else if (ctx.hasUI) {
      ctx.ui.setStatus("token-speed", undefined);
    }

    startTime = 0;
    firstTokenTime = 0;
    lastCharCount = 0;
    lastSpeedCheckTime = 0;
    currentSpeed = 0;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("token-speed", undefined);
    }
  });

  pi.registerCommand("speed", {
    description: "查看上一次模型生成的完整 Token 速度与性能详情",
    handler: async (_args, ctx) => {
      if (!lastStats) {
        if (ctx.hasUI) ctx.ui.notify("暂无上一轮请求的速度数据", "warning");
        else console.log("暂无上一轮请求的速度数据");
        return;
      }
      const s = lastStats;
      const lines = [
        `模型: ${s.model ?? "未知"}`,
        `纯吐字速度: ${s.genTps} tokens/s`,
        `端到端速度: ${s.overallTps} tokens/s`,
        `输出 Tokens: ${s.output}${s.reasoning ? ` (包含思考: ${s.reasoning})` : ""}`,
        `输入 Tokens: ${s.input ?? 0}${s.cacheRead ? ` (缓存读取: ${s.cacheRead})` : ""}`,
        `首字延迟 (TTFT): ${s.ttftMs ? (s.ttftMs / 1000).toFixed(2) + "s" : "N/A"}`,
        `总耗时: ${(s.durationMs! / 1000).toFixed(2)}s`,
      ];
      const summary = lines.join("\n");
      if (ctx.hasUI) {
        ctx.ui.notify(`⚡ Token 性能详情:\n${summary}`, "info");
      } else {
        console.log(summary);
      }
    },
  });
}
