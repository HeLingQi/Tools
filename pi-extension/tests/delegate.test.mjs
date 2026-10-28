import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())), '../..');
const { loadExtensions } = await import(join(packageRoot, 'dist/core/extensions/loader.js'));
const extensionPath = fileURLToPath(new URL('../extensions/delegate.ts', import.meta.url));

await test('delegate extension', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-delegate-test-'));
  const bin = join(root, 'bin');
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'workspace');
  await Promise.all([bin, agentDir, cwd].map((dir) => mkdir(dir)));
  await writeFile(join(agentDir, 'lean.md'), 'Only implement the assigned task.');
  const originalEnv = { ...process.env };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  delete process.env.PI_DELEGATE_CHILD;
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(join(bin, 'pi'), `#!${process.execPath}
const fs = require('node:fs');
let task = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', x => task += x);
process.stdin.on('end', () => {
  fs.writeFileSync('capture.json', JSON.stringify({ task, args: process.argv.slice(2), child: process.env.PI_DELEGATE_CHILD }));
  const usage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 } };
  const emit = x => process.stdout.write(JSON.stringify(x) + '\\n');
  const message = (text, stopReason = 'stop') => emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage, stopReason, errorMessage: stopReason === 'error' ? 'provider unavailable' : undefined } });
  if (task === 'hang') {
    process.on('SIGTERM', () => {});
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
    return;
  }
  if (task === 'invalid-json') return process.stdout.write('not-json\\n');
  if (task === 'oversize-event') return process.stdout.write('x'.repeat(9 * 1024 * 1024));
  if (task === 'no-result') return;
  if (task === 'exit-error') { process.stderr.write('cannot start'); process.exitCode = 7; return; }
  if (task === 'drip') {
    let n = 0;
    const tick = setInterval(() => {
      message('进度' + n++);
      if (n === 8) { clearInterval(tick); message('完成'); emit({ type: 'agent_settled', aborted: false }); }
    }, 100);
    return;
  }
  if (task === 'busy-tool') {
    emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} });
    setTimeout(() => {
      emit({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: {}, isError: false });
      message('完成');
      emit({ type: 'agent_settled', aborted: false });
    }, 1000);
    return;
  }
  if (task === 'progress-then-hang') {
    process.on('SIGTERM', () => {});
    message('已完成一半');
    setInterval(() => {}, 1000);
    return;
  }
  emit({ type: 'tool_execution_start', toolName: 'read' });
  if (task === 'model-error') { message('partial evidence', 'error'); emit({ type: 'agent_settled', aborted: false }); return; }
  if (task === 'length') { message('partial evidence', 'length'); emit({ type: 'agent_settled', aborted: false }); return; }
  if (task === 'incomplete') { message('unfinished', 'toolUse'); return; }
  if (task === 'retry') message('failed attempt', 'error');
  message(task === 'large' ? '中文结果'.repeat(20000) : '完成：中文\\u2028line\\u2029end');
  emit({ type: 'agent_settled', aborted: false });
});
`);
  await chmod(join(bin, 'pi'), 0o755);
  await writeFile(join(bin, 'codegraph'), `#!${process.execPath}
require('node:fs').writeFileSync('synced.json', JSON.stringify(process.argv.slice(2)));
`);
  await chmod(join(bin, 'codegraph'), 0o755);

  async function load() {
    const loaded = await loadExtensions([extensionPath], cwd);
    assert.deepEqual(loaded.errors, [], 'extension must load through the actual Pi loader');
    const extension = loaded.extensions[0];
    let active = ['read', 'bash', 'edit', 'write'];
    loaded.runtime.getActiveTools = () => active;
    loaded.runtime.setActiveTools = (names) => { active = names; };
    const ctx = { cwd, model: { id: 'gpt-6-astra', provider: '787880' }, hasUI: false };
    const emit = async (name, event = {}) => {
      for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
    };
    const tool = extension.tools.get('delegate')?.definition;
    return { extension, tool, ctx, emit, active: () => active };
  }
  const h = await load();
  const call = (task, agent = 'pi-std', signal, update) => h.tool.execute('test', { agent, task }, signal, update, h.ctx);

  await t.test('only Astra activates delegation, model switches preserve other tools', async () => {
    assert.equal(h.tool.defaultActive, false);
    assert.equal(h.extension.handlers.has('tool_call'), false, 'no hard edit guard');
    await h.emit('session_start');
    assert.deepEqual(h.active(), ['read', 'bash', 'edit', 'write', 'delegate']);
    for (const id of ['gpt-5.6-sol', 'gemini-3.8-flash', 'gpt-6-astra-other']) {
      h.ctx.model = { id };
      await h.emit('model_select', { model: h.ctx.model });
      assert.deepEqual(h.active(), ['read', 'bash', 'edit', 'write']);
      await assert.rejects(call('blocked'), /gpt-6-astra/);
    }
    h.ctx.model = undefined;
    await h.emit('session_start');
    assert.equal(h.active().includes('delegate'), false);
    h.ctx.model = { id: 'gpt-6-astra', provider: '787880' };
    await h.emit('model_select', { model: h.ctx.model });
    assert.equal(h.active().includes('delegate'), true);
    await h.emit('session_start');
    assert.equal(h.active().filter(x => x === 'delegate').length, 1);
    assert.ok(h.tool.promptGuidelines.join(' ').includes('pi-sol'));
  });

  await t.test('child marker disables the extension even with Astra', async () => {
    process.env.PI_DELEGATE_CHILD = '1';
    try {
      const child = await load();
      assert.equal(child.extension.tools.size, 0);
      assert.equal(child.extension.handlers.size, 0);
    } finally { delete process.env.PI_DELEGATE_CHILD; }
  });

  await t.test('rejects bad input and missing lean.md before spawning', async () => {
    await assert.rejects(call('   '), /task|任务/);
    await assert.rejects(call('x', 'unknown'), /agent|代理/);
    await rename(join(agentDir, 'lean.md'), join(agentDir, 'lean.hidden'));
    try { await assert.rejects(call('x'), /lean.md|ENOENT/); }
    finally { await rename(join(agentDir, 'lean.hidden'), join(agentDir, 'lean.md')); }
    assert.equal(existsSync(join(cwd, 'capture.json')), false);
  });

  await t.test('passes literal input, correct models and lean file without shell interpretation', async () => {
    for (const [agent, model] of [['pi-std', '787880/gemini-3.8-flash'], ['pi-sol', '787880/gpt-5.6-sol']]) {
      const task = '--help @secret $(touch SHOULD_NOT_EXIST)\nEOF\n中文任务';
      const updates = [];
      const result = await call(task, agent, undefined, x => updates.push(x));
      assert.equal(result.isError, false);
      assert.match(result.content[0].text, /完成：中文\u2028line\u2029end/);
      assert.equal(result.usage.totalTokens, 14);
      assert.equal(result.usage.cost.total, 0.1);
      const capture = JSON.parse(await readFile(join(cwd, 'capture.json'), 'utf8'));
      assert.equal(capture.task, task);
      assert.equal(capture.child, '1');
      assert.equal(capture.args[capture.args.indexOf('--model') + 1], model);
      assert.ok(capture.args.includes(join(agentDir, 'lean.md')));
      assert.ok(capture.args.includes('--no-session'));
      assert.equal(existsSync(join(cwd, 'SHOULD_NOT_EXIST')), false);
      assert.ok(updates.length > 0);
    }
  });

  await t.test('model errors, token exhaustion, startup errors and incomplete output are failures', async () => {
    for (const task of ['model-error', 'length', 'exit-error', 'incomplete', 'no-result', 'invalid-json', 'oversize-event']) {
      const result = await call(task);
      assert.equal(result.isError, true, task);
      if (task === 'model-error' || task === 'length') assert.match(result.content[0].text, /partial evidence/);
    }
    const recovered = await call('retry');
    assert.equal(recovered.isError, false, 'successful retry clears the previous model error');
    assert.equal(recovered.usage.totalTokens, 28);
  });

  await t.test('large output is capped and the full report is saved privately', async () => {
    const result = await call('large');
    assert.equal(result.isError, false);
    assert.ok(Buffer.byteLength(result.content[0].text) < 60 * 1024);
    assert.ok(result.details.fullOutputPath);
    const info = await stat(result.details.fullOutputPath);
    assert.equal(info.mode & 0o777, 0o600);
    assert.match(await readFile(result.details.fullOutputPath, 'utf8'), /中文结果/);
    assert.ok(info.size > 100000);
    await rm(dirname(result.details.fullOutputPath), { recursive: true, force: true });
  });

  await t.test('syncs the nearest existing CodeGraph index, never initializes one', async () => {
    assert.equal(existsSync(join(cwd, 'synced.json')), false);
    await mkdir(join(cwd, '.codegraph'));
    await writeFile(join(cwd, '.codegraph', 'codegraph.db'), '');
    const result = await call('sync');
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(await readFile(join(cwd, 'synced.json'), 'utf8')), ['sync', '-q', cwd]);
    await rm(join(cwd, 'synced.json'));
    const failed = await call('model-error');
    assert.equal(failed.isError, true);
    assert.equal(existsSync(join(cwd, 'synced.json')), false, 'failed runs must not sync the index');
    await rm(join(cwd, '.codegraph'), { recursive: true });
    await rename(join(bin, 'pi'), join(bin, 'pi.hidden'));
    const oldPath = process.env.PATH;
    process.env.PATH = bin;
    try { assert.equal((await call('missing-pi')).isError, true); }
    finally { process.env.PATH = oldPath; await rename(join(bin, 'pi.hidden'), join(bin, 'pi')); }
  });

  async function waitForPids() {
    for (let i = 0; i < 100; i++) {
      if (existsSync(join(cwd, 'pids.json'))) return JSON.parse(await readFile(join(cwd, 'pids.json'), 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('child failed to start');
  }
  const alive = (pid) => {
    try {
      const status = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      return status !== '' && !status.startsWith('Z');
    } catch { return false; }
  };
  for (const reason of ['abort', 'timeout', 'shutdown']) {
    await t.test(`${reason} stops child and descendants`, async () => {
      await rm(join(cwd, 'pids.json'), { force: true });
      const controller = new AbortController();
      const timer = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 900000 ? (reason === 'timeout' ? 500 : ms) : ms === 5000 ? 80 : ms === 20000 ? 100 : ms, ...args);
      let pids = [];
      try {
        const running = call('hang', 'pi-std', controller.signal);
        pids = await waitForPids();
        if (reason === 'abort') controller.abort();
        if (reason === 'shutdown') await h.emit('session_shutdown');
        const result = await running;
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, reason === 'timeout' ? /超时/ : /取消|关闭/);
        for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise(resolve => timer(resolve, 20));
        assert.ok(pids.every(pid => !alive(pid)), 'no running child remains');
      } finally {
        globalThis.setTimeout = timer;
        for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
    });
  }

  await t.test('progress resets the idle timer and long tools are not stalls', async () => {
    const timer = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 900000 ? 300 : ms, ...args);
    try {
      const drip = await call('drip');
      assert.equal(drip.isError, false, drip.content[0].text);
      const busy = await call('busy-tool');
      assert.equal(busy.isError, false, busy.content[0].text);
    } finally { globalThis.setTimeout = timer; }
  });

  await t.test('timeout keeps the output received so far', async () => {
    const timer = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 900000 ? 300 : ms === 5000 ? 80 : ms === 20000 ? 100 : ms, ...args);
    try {
      const result = await call('progress-then-hang');
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /超时/);
      assert.match(result.content[0].text, /已完成一半/);
    } finally { globalThis.setTimeout = timer; }
  });
});
