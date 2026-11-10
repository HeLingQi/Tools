import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import verify from '../extensions/verify.ts';

const packageRoot = resolve(dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())), '../..');
const { execCommand } = await import(join(packageRoot, 'dist/core/exec.js'));

const ok = { stdout: '', stderr: '', code: 0, killed: false, truncated: false };
const failed = { stdout: '', stderr: 'boom', code: 1, killed: false, truncated: false };

function harness(run = async () => ok) {
  const events = new Map();
  const commands = new Map();
  const calls = [];
  const notices = [];
  const statuses = [];
  let idle = true;
  let pending = false;
  let hasUI = true;
  let signal;

  verify({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    exec: (...args) => {
      calls.push(args);
      return run(...args);
    },
  });

  const ctx = {
    cwd: '/work/original',
    mode: 'tui',
    get hasUI() { return hasUI; },
    get signal() { return signal; },
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    ui: {
      notify: (message, level) => {
        assert.ok(['info', 'warning', 'error'].includes(level), `不支持的通知类型 ${level}`);
        notices.push({ message, level });
      },
      setStatus: (key, value) => statuses.push({ key, value }),
    },
  };

  return {
    events, commands, calls, notices, statuses, ctx,
    setIdle: (value) => { idle = value; },
    setPending: (value) => { pending = value; },
    setHasUI: (value) => { hasUI = value; },
    setSignal: (value) => { signal = value; },
  };
}

const baseEntry = { type: 'custom', customType: 'other-extension', data: { keep: true } };
const boundary = (patch = {}) => ({
  outcome: 'completed',
  continue: false,
  entries: [baseEntry],
  context: { pendingMessages: [] },
  ...patch,
});

{
  const h = harness();
  assert.equal(await h.events.get('agent_before_settle')(boundary(), h.ctx), undefined);
  assert.equal(h.calls.length, 0, '默认禁用');
  await h.commands.get('verify').handler('   ', h.ctx);
  assert.match(h.notices.at(-1).message, /未启用.*\/verify <shell命令>/s);
  assert.equal(h.calls.length, 0, '空命令只查看状态');

  h.setHasUI(false);
  await h.commands.get('verify').handler('echo forbidden', h.ctx);
  assert.match(h.notices.at(-1).message, /非 UI/);
  assert.equal(await h.events.get('agent_before_settle')(boundary(), h.ctx), undefined);
}

{
  const h = harness();
  const command = "  printf 'ok'  ";
  await h.commands.get('verify').handler(command, h.ctx);
  h.ctx.cwd = '/work/changed';
  const result = await h.events.get('agent_before_settle')(boundary(), h.ctx);
  assert.deepEqual(h.calls[0], [
    'bash', ['-o', 'pipefail', '-c', command],
    { cwd: '/work/original', timeout: 120000, maxBuffer: 1024 * 1024, signal: h.calls[0][2].signal },
  ], '命令原样保存并固定设置时 cwd');
  assert.equal(result.continue, undefined, '成功不续跑');
  assert.deepEqual(result.entries.slice(0, -1), [baseEntry], '保留其他扩展 entries');
  assert.match(result.entries.at(-1).content, /验证通过.*命令：  printf 'ok'  .*目录：\/work\/original/s);

  await h.events.get('agent_before_settle')(boundary(), h.ctx);
  assert.equal(h.calls.length, 2, '每次收尾重跑，delegate/MCP 改动后不复用通过结果');
}

{
  const h = harness();
  await h.commands.get('verify').handler('echo first', h.ctx);
  h.setIdle(false);
  await h.commands.get('verify').handler('echo second', h.ctx);
  assert.match(h.notices.at(-1).message, /代理忙碌/);
  h.setIdle(true);
  await h.events.get('agent_before_settle')(boundary(), h.ctx);
  assert.equal(h.calls[0][1][3], 'echo first', '忙碌时不修改命令');
}

{
  let execSignal;
  const h = harness((_command, _args, options) => new Promise((resolve) => {
    execSignal = options.signal;
    options.signal.addEventListener('abort', () => resolve({ ...failed, killed: true }), { once: true });
  }));
  await h.commands.get('verify').handler('sleep 9', h.ctx);
  const checking = h.events.get('agent_before_settle')(boundary(), h.ctx);
  await Promise.resolve();
  assert.ok(execSignal instanceof AbortSignal, '执行必须拿到可取消 signal');
  h.setIdle(false);
  await h.commands.get('verify').handler('off', h.ctx);
  assert.equal(execSignal.aborted, true, 'off 在忙碌时仍可取消');
  assert.equal(await checking, undefined, '取消竞态不续跑也不回写结果');
  assert.equal(await h.events.get('agent_before_settle')(boundary(), h.ctx), undefined, 'off 后保持关闭');
}

{
  const logs = `${'x'.repeat(6100)}TAIL`;
  const h = harness(async () => ({ ...failed, stderr: logs }));
  await h.commands.get('verify').handler('exit 1', h.ctx);
  const first = await h.events.get('agent_before_settle')(boundary(), h.ctx);
  assert.equal(first.continue, true, '首次失败只续跑一次');
  assert.deepEqual(first.entries.slice(0, -1), [baseEntry]);
  assert.match(first.entries.at(-1).content, /不可信诊断数据.*输出已截断.*TAIL.*不得更改测试.*原有委派和权限规则/s);

  await h.events.get('before_agent_start')({ messageType: 'custom' }, h.ctx);
  const second = await h.events.get('agent_before_settle')(boundary(), h.ctx);
  assert.equal(second.continue, undefined, '内部续跑不重置修复预算');
  assert.match(second.entries.at(-1).content, /验证未通过，已停止自动修复/);

  await h.events.get('before_agent_start')({ messageType: 'user' }, h.ctx);
  const third = await h.events.get('agent_before_settle')(boundary(), h.ctx);
  assert.equal(third.continue, true, '新用户请求重置一次修复预算');
}

{
  const h = harness();
  await h.commands.get('verify').handler('true', h.ctx);
  assert.equal(await h.events.get('agent_before_settle')(boundary({ outcome: 'error' }), h.ctx), undefined);
  assert.equal(await h.events.get('agent_before_settle')(boundary({ continue: true }), h.ctx), undefined);
  assert.equal(await h.events.get('agent_before_settle')(boundary({ context: { pendingMessages: ['goal'] } }), h.ctx), undefined);
  h.setPending(true);
  assert.equal(await h.events.get('agent_before_settle')(boundary(), h.ctx), undefined);
  assert.equal(h.calls.length, 0, '错误、已有续跑或 pending 时不抢占');
}

for (const [name, run] of [
  ['killed', async () => ({ ...ok, killed: true })],
  ['truncated', async () => ({ ...ok, truncated: true })],
  ['throw', async () => { throw new Error('spawn exploded'); }],
]) {
  const h = harness(run);
  await h.commands.get('verify').handler('check', h.ctx);
  const result = await h.events.get('agent_before_settle')(boundary(), h.ctx);
  assert.equal(result.continue, true, `${name} 必须 fail closed`);
  assert.match(result.entries.at(-1).content, name === 'throw' ? /spawn exploded/ : new RegExp(name === 'killed' ? '已终止' : '输出超限'));
}

{
  const exception = `HEAD${'x'.repeat(6100)}TAIL`;
  const h = harness(async () => { throw new Error(exception); });
  await h.commands.get('verify').handler('check', h.ctx);
  const result = await h.events.get('agent_before_settle')(boundary(), h.ctx);
  assert.doesNotMatch(result.entries.at(-1).content, /HEAD/, '超长异常丢弃头部');
  assert.match(result.entries.at(-1).content, /执行异常：\[输出已截断.*TAIL/s);
}

for (const eventName of ['session_tree', 'session_start']) {
  const h = harness();
  await h.commands.get('verify').handler('true', h.ctx);
  await h.events.get(eventName)({ reason: eventName === 'session_start' ? 'reload' : undefined }, h.ctx);
  assert.equal(await h.events.get('agent_before_settle')(boundary(), h.ctx), undefined, `${eventName} 清除配置`);
  assert.equal(h.calls.length, 0);
}

{
  let execSignal;
  const h = harness((_command, _args, options) => new Promise((resolve) => {
    execSignal = options.signal;
    options.signal.addEventListener('abort', () => resolve({ ...failed, killed: true }), { once: true });
  }));
  await h.commands.get('verify').handler('sleep 9', h.ctx);
  const checking = h.events.get('agent_before_settle')(boundary(), h.ctx);
  await Promise.resolve();
  await h.events.get('session_shutdown')({ reason: 'reload' }, h.ctx);
  assert.equal(execSignal.aborted, true, 'shutdown 主动取消检查');
  assert.equal(await checking, undefined);
}

{
  const external = new AbortController();
  let combined;
  const h = harness((_command, _args, options) => {
    combined = options.signal;
    return new Promise((resolve) => options.signal.addEventListener('abort', () => resolve({ ...failed, killed: true }), { once: true }));
  });
  h.setSignal(external.signal);
  await h.commands.get('verify').handler('sleep 9', h.ctx);
  const checking = h.events.get('agent_before_settle')(boundary(), h.ctx);
  await Promise.resolve();
  external.abort();
  assert.equal(combined.aborted, true, '组合 ctx.signal');
  assert.equal(await checking, undefined, '外部取消不触发修复');
}

{
  const dir = await mkdtemp(join(tmpdir(), 'pi-verify-'));
  try {
    const result = await execCommand('bash', ['-o', 'pipefail', '-c', 'pwd; false | true'], dir, {
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.stdout.trim(), dir, '真实 Pi exec helper 使用指定 cwd');
    assert.notEqual(result.code, 0, 'pipefail 让失败管道返回非零');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log('verify lifecycle OK');
