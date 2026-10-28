import assert from "node:assert/strict";
import { wrapShellLine, transformMarkdown, visualWidth } from "../extensions/safe-copy.ts";

// 1) 基本：超宽命令被折成 \ 续行，且每段不超宽
const cmd =
  "docker run --rm -it -v \"$PWD\":/work -w /work -e NODE_ENV=production -e CI=true node:22-alpine sh -c 'npm ci && npm run build'";
const out = wrapShellLine(cmd, 40).text;
const segs = out.split("\n");
assert.ok(segs.length > 1, "应被折行");
for (const s of segs) assert.ok(visualWidth(s) <= 40, `段太宽: ${s} (${visualWidth(s)})`);
for (const s of segs.slice(0, -1)) assert.ok(s.endsWith(" \\"), `续行应以 \\ 结尾: ${s}`);

// 2) 不变量：去掉 "\\\n" 后与原文等价（空白归一后完全相同）
const joined = out.replace(/ \\\n/g, " ");
assert.equal(joined.replace(/[ \t]+/g, " "), cmd.replace(/[ \t]+/g, " "), "折行改变了命令语义");

// 3) 不超宽的行不动
assert.equal(wrapShellLine("echo hi", 40).text, "echo hi");

// 4) 单引号内的长字符串：一个安全折点都没有 → 原样保留（宁可折行破坏复制，也不破坏语义）
const single = "echo 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'";
assert.equal(wrapShellLine(single, 40).text, single);

// 5) 单引号开头 + 后面有安全折点：只在引号外折
const mixed = "printf '%s' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' --flag=value --other=value2 --third=value3";
const mixedOut = wrapShellLine(mixed, 40).text;
for (const s of mixedOut.split("\n")) assert.ok(visualWidth(s) <= 40, `段太宽: ${s}`);
assert.ok(
  mixedOut.replace(/ \\\n/g, " ").replace(/[ \t]+/g, " ") === mixed.replace(/[ \t]+/g, " "),
  "引号混合行折行后语义改变",
);

// 6) 双引号内允许折行（bash 会在双引号内删除 \ 换行）
const dq = 'echo "aaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccc ddddddddd"';
const dqOut = wrapShellLine(dq, 30).text;
assert.ok(dqOut.includes("\\\n"));
assert.equal(dqOut.replace(/ \\\n/g, " "), dq, "双引号内折行应可无损还原");

// 7) 续行状态：单引号未闭合时，下一行不得在引号内折
const st1 = "echo 'unterminated start of a very long line here";
const r1 = wrapShellLine(st1, 30);
assert.equal(r1.text, st1, "单引号未闭合不应折行");
const r2 = wrapShellLine("aaaa bbbb cccc dddd eeee ffff gggg hhhh", 30, r1.end);
assert.equal(r2.text, "aaaa bbbb cccc dddd eeee ffff gggg hhhh", "上一行单引号未闭合，本行仍在单引号内");

// 8) heredoc 内容不被动
const md = [
  "```bash",
  "cat > /tmp/x <<'EOF'",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "EOF",
  "echo done",
  "```",
].join("\n");
const t = transformMarkdown(md, 40);
const tLines = t.split("\n");
assert.equal(tLines[2], "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "heredoc 内容被改写");
assert.ok(tLines[4].includes("\\\n") || visualWidth(tLines[4]) <= 36);

// 9) 非 shell 代码块不动
const py = ["```python", "x = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'", "```"].join("\n");
assert.equal(transformMarkdown(py, 40), py);

// 10) 围栏外的普通文本不动
const prose = "这是一段很长很长很长很长很长很长很长很长很长很长很长很长的中文说明文字，不应该被改动。";
assert.equal(transformMarkdown(prose, 40), prose);

// 11) 极窄宽度直接放弃（避免过度破坏）
assert.equal(transformMarkdown("```bash\necho " + "a".repeat(200) + "\n```", 12).includes("\\\n"), false);

console.log("safe-copy: all tests passed");
