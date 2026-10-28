import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Safe Copy — 让长命令在终端里框选复制后仍然可执行
 *
 * 背景：pi 的 TUI 在应用层按终端宽度折行（wrapTextWithAnsi），框选复制时
 * 每一条渲染行用 "\n" 拼接（pi-tui/tui-alt-screen.js: getActiveSelectionText），
 * 于是软折行变成硬换行，粘贴到 shell 就断了。
 *
 * 做法：注册 MarkdownTransformer，在渲染前知道 availableWidth，
 * 把代码块里超过宽度的行，在「引号外 / 双引号内」的空白处折成 `\` 续行。
 * 这样：
 *   - 渲染后每行都不超宽 → pi 不会再折行 → 复制出来的换行就是我们自己写的
 *   - 每行以 `\` 结尾 → bash/sh/zsh 把它们当同一行，命令照常执行
 *   - 不进入单引号字符串、heredoc、已有 `\` 续行符的逻辑不变，避免破坏语义
 *
 * 关闭方式：设置环境变量 PI_SAFE_COPY=0（或在 /reload 前删除本文件）。
 */

const SHELL_LANGS = new Set([
  "bash",
  "sh",
  "shell",
  "shell-session",
  "zsh",
  "fish",
  "ksh",
  "dash",
  "console",
  "console-bash",
  "bat",
  "cmd",
  "ps1",
  "powershell",
  "pwsh",
  "",
]);

const MIN_BUDGET = 24;

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function visualWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x1b) continue; // 不该出现，保险起见跳过 esc
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

interface ScanState {
  inSingle: boolean;
  inDouble: boolean;
}

/**
 * 扫描一行，返回可以安全折行的空白位置（下标），以及行尾的引号状态。
 * 只在引号外或双引号内返回位置：`\<newline>` 在这两处会被 shell 完全删掉；
 * 单引号内不会被删，会污染字符串，所以排除。
 */
export function scanBreaks(line: string, startState: ScanState): { breaks: number[]; end: ScanState } {
  const breaks: number[] = [];
  let { inSingle, inDouble } = startState;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      else if (ch === " " || ch === "\t") breaks.push(i);
      i += 1;
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === " " || ch === "\t") {
      breaks.push(i);
    }
    i += 1;
  }
  return { breaks, end: { inSingle, inDouble } };
}

/** 在一行里检测 heredoc 起始，返回结束标记（可能是 null）。 */
export function detectHeredoc(line: string): string | null {
  // 只在未被引号包住的区域里找 <<WORD / <<-WORD / <<'WORD'
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i += 1;
      continue;
    }
    if (ch === "<" && line[i + 1] === "<") {
      const match = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line.slice(i));
      if (match) return match[2];
      return null;
    }
    i += 1;
  }
  return null;
}

/**
 * 把一行超宽命令折成若干行，行尾用 ` \` 连接。
 * 折完后在 shell 里 `\` + 换行会被删除，语义等价于原始单行。
 * 找不到安全折点（例如整行都在单引号里）时原样返回。
 */
export function wrapShellLine(line: string, budget: number, startState: ScanState = { inSingle: false, inDouble: false }): { text: string; end: ScanState } {
  const { breaks, end } = scanBreaks(line, startState);
  if (visualWidth(line) <= budget) return { text: line, end };

  const segments: string[] = [];
  let start = 0;
  let guard = 0;
  // 续行段还要额外承载 " \\" 两个字符，所以折点上限要比总宽度小 2
  const limit = budget - 2;
  while (visualWidth(line.slice(start)) > budget) {
    if (guard++ > 500) return { text: line, end };
    let chosen = -1;
    for (const b of breaks) {
      if (b <= start) continue;
      if (visualWidth(line.slice(start, b)) > limit) break;
      chosen = b;
    }
    if (chosen <= start) return { text: line, end }; // 没有安全折点
    segments.push(line.slice(start, chosen));
    start = chosen + 1;
    while (start < line.length && (line[start] === " " || line[start] === "\t")) start += 1;
  }
  segments.push(line.slice(start));
  return { text: segments.join(" \\\n"), end };
}

/** 处理整段 markdown 中的所有 shell 代码块。 */
export function transformMarkdown(markdown: string, availableWidth: number): string {
  const budget = availableWidth - 4; // 代码块缩进(2) + 1 格安全余量
  if (budget < MIN_BUDGET) return markdown;

  const lines = markdown.split("\n");
  const out: string[] = [];
  let fenceLang: string | null = null;
  let heredoc: string | null = null;
  let state: ScanState = { inSingle: false, inDouble: false };

  for (const line of lines) {
    if (fenceLang === null) {
      const open = /^\s*```+\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
      if (open) {
        fenceLang = open[1].toLowerCase();
        state = { inSingle: false, inDouble: false };
        heredoc = null;
      }
      out.push(line);
      continue;
    }

    // 代码块内
    if (/^\s*```+\s*$/.test(line) && heredoc === null) {
      fenceLang = null;
      out.push(line);
      continue;
    }

    if (heredoc !== null) {
      if (line.replace(/^\t+/, "").trim() === heredoc) heredoc = null;
      out.push(line);
      continue;
    }

    if (!SHELL_LANGS.has(fenceLang)) {
      out.push(line);
      continue;
    }

    const found = detectHeredoc(line);
    const result = wrapShellLine(line, budget, state);
    state = result.end;
    out.push(result.text);
    if (found) heredoc = found;
  }

  return out.join("\n");
}

export default function safeCopyExtension(pi: ExtensionAPI) {
  if (process.env.PI_SAFE_COPY === "0") return;

  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType === "assistant-thinking") return markdown;
    try {
      return transformMarkdown(markdown, context.availableWidth);
    } catch {
      return markdown;
    }
  });
}
