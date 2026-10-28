import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringEnum, Type, type Usage } from "@earendil-works/pi-ai";
import { getAgentDir, truncateHead, type ExtensionAPI, type ExtensionContext, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

// 子代理模型映射（可按需配置为自己的 provider/model）
const MODELS = {
  "pi-std": process.env.PI_DELEGATE_STD_MODEL || "787880/gemini-3.8-flash",
  "pi-sol": process.env.PI_DELEGATE_SOL_MODEL || "787880/gpt-5.6-sol",
};
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const HARD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export default function (pi: ExtensionAPI) {
  // 子代理即使切换到 Astra，也不能再次注册委派工具。
  if (process.env.PI_DELEGATE_CHILD) return;
  let active: AbortController | undefined;
  const syncTools = (_event: unknown, ctx: ExtensionContext) => {
    const enabled = ctx.model?.id === "gpt-6-astra";
    const tools = pi.getActiveTools();
    if (tools.includes("delegate") !== enabled) {
      pi.setActiveTools([...tools.filter((name) => name !== "delegate"), ...(enabled ? ["delegate"] : [])]);
    }
  };
  pi.on("session_start", syncTools);
  pi.on("model_select", syncTools);
  pi.on("session_shutdown", () => active?.abort());

  pi.registerTool({
    name: "delegate",
    label: "Pi 委派",
    description: "把任务交给独立 Pi 子进程。开发修改必须使用 pi-sol；pi-std 仅用于只读分析等非开发任务。子代理能修改当前项目文件，不继承主会话历史。",
    promptSnippet: "Astra 的开发修改必须委派给 pi-sol；主会话负责拆任务、只读审查和实际验证。",
    promptGuidelines: [
      "当主会话模型为 gpt-6-astra 时，所有开发修改必须通过 delegate(agent: 'pi-sol') 完成，包括简单修改、小修、脚本、测试、配置和审查后的修正，不得因改动小而直接实现，也不得改派 pi-std。只有用户明确要求主会话亲自修改且不委派时才可例外；普通的开发请求、‘帮我修改’或‘继续’不构成例外。",
      "主会话负责需求澄清、任务拆分、只读代码审查、环境探测及运行测试和构建；不得使用 edit、write、bash、MCP 或其他工具直接或间接修改开发文件，格式化和自动修复也须委派。运行测试、构建产生的正常产物不受此限制，但不得借此修改源码。",
      "子代理失败、超时或验证未通过时，主会话应检查现有改动和错误，把剩余实现或修正继续委派给 pi-sol，不得自行接管编写；若委派不可用，报告阻塞并等待用户决定，不得静默降级为主会话实现。",
      "委派 task 必须完整包含必要上下文、文件范围、验收标准；保留用户给定的行数预算、函数签名和参照文件，不得删减。复杂任务先明确接口，不让子代理擅自决定关键设计。",
      "子代理共享工作目录；不要安排会修改同一文件的并行任务。子代理结果不是验证依据，主会话仍需检查实际改动。",
    ],
    defaultActive: false,
    executionMode: "sequential",
    parameters: Type.Object({
      agent: StringEnum(["pi-std", "pi-sol"] as const),
      task: Type.String({ minLength: 1, description: "完整任务、上下文、约束和验收标准" }),
    }),
    async execute(_id, { agent, task }, signal, onUpdate, ctx) {
      if (ctx.model?.id !== "gpt-6-astra") throw new Error("delegate 仅供 gpt-6-astra 主会话使用。");
      if (!Object.hasOwn(MODELS, agent)) throw new Error("未知代理。");
      if (!task.trim()) throw new Error("任务 task 不能为空。");
      const lean = join(getAgentDir(), "lean.md");
      await access(lean);
      const controller = new AbortController();
      active = controller;
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const model = MODELS[agent];
      const details: { agent: string; model: string; exitCode?: number; fullOutputPath?: string } = { agent, model };
      const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      let output = "", stderr = "", failure = "", modelError = "", stopReason = "", settled = false;
      const update = (text: string) => onUpdate?.({ content: [{ type: "text", text: `${agent}：${text}` }], details });
      try {
        if (combined.aborted) throw new Error("委派已取消。");
        update(`正在启动 ${model}`);
        details.exitCode = await new Promise<number>((resolve) => {
          const child = spawn("pi", [
            "--mode", "json", "--print", "--no-session", "--model", model,
            "--append-system-prompt", lean,
            "--append-system-prompt", "你是执行子代理，直接完成收到的任务，不要再启动或委派给其他 Pi。",
          ], {
            cwd: ctx.cwd,
            env: { ...process.env, PI_DELEGATE_CHILD: "1" },
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
          let buffer = "";
          let forceKill: ReturnType<typeof setTimeout> | undefined;
          let fallback: ReturnType<typeof setTimeout> | undefined;
          let idle: ReturnType<typeof setTimeout> | undefined;
          const runningTools = new Set<string>();
          // WSL/Linux：独立进程组避免取消子任务时误杀主 Pi。
          const kill = (kind: NodeJS.Signals) => {
            if (!child.pid) return;
            try { process.kill(-child.pid, kind); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure += `\n终止进程失败：${String(error)}`;
            }
          };
          const stop = (reason: string) => {
            if (failure) return;
            failure = reason;
            kill("SIGTERM");
            forceKill = setTimeout(() => {
              kill("SIGKILL");
              // 进程组可能残留（孙进程、卡住的管道），close 等不到时强制返回，避免主会话无限挂住。
              fallback = setTimeout(() => resolve(-1), 20000);
            }, 5000);
          };
          const cancel = () => stop("委派已取消或主会话已关闭。");
          // 判据是“没有进展”而非总耗时：子进程任何一行输出都说明它还活着。
          const touch = () => {
            if (failure) return;
            clearTimeout(idle);
            idle = setTimeout(() => {
              // 长工具（构建、测试、docker）执行期间没有事件输出是正常的，工具未结束就不算卡死。
              if (runningTools.size) { touch(); return; }
              stop(`委派超时（${IDLE_TIMEOUT_MS / 60000} 分钟无进展），已终止子进程。`);
            }, IDLE_TIMEOUT_MS);
          };
          const hardLimit = setTimeout(() => stop("委派超时（2 小时上限），已终止子进程。"), HARD_TIMEOUT_MS);
          touch();
          combined.addEventListener("abort", cancel, { once: true });
          if (combined.aborted) cancel();
          // 超时/取消后仍继续解析，保留子代理最后的进展与用量。
          const consume = (line: string) => {
            if (!line.trim()) return;
            if (Buffer.byteLength(line) > MAX_EVENT_BYTES) { stop("子代理单条事件超过 8 MiB，已停止。"); return; }
            try {
              const event = JSON.parse(line) as JsonAgentSessionEvent;
              if (event.type === "tool_execution_start") { runningTools.add(event.toolCallId); update(`执行 ${event.toolName}`); }
              if (event.type === "tool_execution_end") runningTools.delete(event.toolCallId);
              if (event.type === "agent_settled") {
                settled = !event.aborted;
                if (event.aborted) stop("子代理已取消。");
              }
              if (event.type !== "message_end") return;
              const msg = event.message;
              if ((msg.role === "assistant" || msg.role === "toolResult") && msg.usage) {
                for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "reasoning", "cacheWrite1h"] as const) {
                  if (msg.usage[key] !== undefined) usage[key] = (usage[key] ?? 0) + msg.usage[key]!;
                }
                for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += msg.usage.cost[key];
              }
              if (msg.role === "assistant") {
                output = msg.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
                stopReason = msg.stopReason;
                modelError = msg.errorMessage ?? "";
              }
            } catch (error) { stop(`子代理事件解析失败：${String(error)}`); }
          };
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            touch();
            buffer += chunk;
            let end: number;
            while ((end = buffer.indexOf("\n")) !== -1) {
              consume(buffer.slice(0, end));
              buffer = buffer.slice(end + 1);
            }
            if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES) { buffer = ""; stop("子代理单条事件超过 8 MiB，已停止。"); }
          });
          child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
          child.on("error", (error) => { failure = `无法启动 Pi：${error.message}`; });
          child.stdin.on("error", (error: NodeJS.ErrnoException) => {
            if (error.code !== "EPIPE") stop(`任务传输失败：${error.message}`);
          });
          child.on("close", (code) => {
            if (buffer.trim()) consume(buffer);
            clearTimeout(idle);
            clearTimeout(hardLimit);
            clearTimeout(forceKill);
            clearTimeout(fallback);
            combined.removeEventListener("abort", cancel);
            if (failure) kill("SIGKILL");
            resolve(code ?? -1);
          });
          // stdin 保留任务原文，避免 shell 注入、@文件展开及命令行长度限制。
          child.stdin.end(task);
        });
        if (!failure && (details.exitCode !== 0 || !settled || stopReason !== "stop")) {
          failure = modelError || `子代理未正常完成（exit=${details.exitCode}，stop=${stopReason || "无结果"}）。`;
        }
        let report = `${agent} / ${model}\n${failure ? `失败：${failure}` : "完成"}\n\n${output || "（无文本输出）"}`;
        if (failure && stderr.trim()) report += `\n\nstderr（末尾最多 8192 字符）：\n${stderr.trim()}`;
        // 只同步已有索引；子任务失败也可能留下代码改动。
        if (!combined.aborted && !failure) {
          let root = ctx.cwd;
          while (!existsSync(join(root, ".codegraph", "codegraph.db")) && dirname(root) !== root) root = dirname(root);
          if (existsSync(join(root, ".codegraph", "codegraph.db"))) {
            update("同步 CodeGraph 索引");
            try {
              const sync = await pi.exec("codegraph", ["sync", "-q", root], { cwd: root, timeout: 300000, signal: combined });
              if (sync.code !== 0 || sync.killed) report += `\n\n警告：CodeGraph 同步失败或被取消。${sync.stderr.slice(-2000)}`;
            } catch (error) { report += `\n\n警告：CodeGraph 同步失败：${String(error)}`; }
          }
        }
        const truncated = truncateHead(report);
        if (truncated.truncated) {
          const dir = await mkdtemp(join(tmpdir(), "pi-delegate-"));
          details.fullOutputPath = join(dir, "result.txt");
          await writeFile(details.fullOutputPath, report, { mode: 0o600 });
        }
        return {
          content: [{ type: "text", text: truncated.content + (details.fullOutputPath ? `\n\n[输出已截断；完整报告：${details.fullOutputPath}]` : "") }],
          details,
          usage,
          isError: Boolean(failure),
        };
      } finally { active = undefined; }
    },
  });
}
