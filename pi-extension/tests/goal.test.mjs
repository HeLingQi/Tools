import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())), '../..');
const { loadExtensions, clearExtensionCache } = await import(join(packageRoot, 'dist/core/extensions/loader.js'));
const extensionPath = fileURLToPath(new URL('../extensions/goal/index.ts', import.meta.url));

function recordedUsage(totalTokens, fields = {}) {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...fields,
  };
}

async function load(entries = []) {
  clearExtensionCache();
  const loaded = await loadExtensions([extensionPath], '/tmp');
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const sent = [];
  const notices = [];
  const widgets = new Map();
  let aborted = false;
  const ctx = {
    hasUI: false, mode: 'json', signal: undefined,
    isIdle: () => true, hasPendingMessages: () => false,
    abort: () => { aborted = true; },
    waitForIdle: async () => {},
    sessionManager: { getBranch: () => entries },
    ui: { setStatus() {}, setWidget: (key, value) => widgets.set(key, value), notify: (text) => notices.push(text) },
  };
  loaded.runtime.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data: structuredClone(data) });
  loaded.runtime.sendMessage = (message, options) => sent.push({ message, options });
  const emit = async (name, event = {}) => {
    let result;
    for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  const call = (name, params = {}) => extension.tools.get(name).definition.execute('test', params, undefined, undefined, ctx);
  const state = async () => (await call('get_goal')).details.goal;
  const settle = async (text = '继续执行下一步。', patch = {}) => {
    const result = await emit('agent_before_settle', {
      outcome: 'completed', entries: [], continue: false,
      context: { canContinue: true, pendingMessages: [], contextMessages: [{ role: 'assistant', content: [{ type: 'text', text }] }] },
      ...patch,
    });
    for (const entry of result?.entries ?? []) {
      if (entry.type === 'custom') loaded.runtime.appendEntry(entry.customType, entry.data);
    }
    return result;
  };
  await emit('session_start');
  return { extension, entries, sent, notices, widgets, ctx, emit, call, state, settle, aborted: () => aborted,
    command: (args) => extension.commands.get('goal').handler(args, ctx) };
}

await test('goal 本地扩展', async (t) => {
  await t.test('工具、状态和展示不再暴露预算或记账', async () => {
    const h = await load();
    for (const name of ['create_goal', 'update_goal']) {
      const schema = h.extension.tools.get(name).definition.parameters;
      assert.doesNotMatch(JSON.stringify(schema), /maxTurns|maxToolCalls|maxCostUsd|maxTokens|maxWallMs/);
    }
    const result = await h.call('create_goal', { goal: '实现并验证', mode: 'auto' });
    assert.equal(result.isError, undefined);
    assert.equal('budgets' in result.details.goal, false);
    assert.equal('accounting' in result.details.goal, false);
    assert.doesNotMatch(result.content[0].text, /budget|accounting|tokens|cost/i);
    assert.equal(h.extension.handlers.has('message_end'), false);
    assert.equal(h.extension.handlers.has('tool_execution_end'), false);
  });

  await t.test('兼容旧会话，忽略预算和记账事件，切换分支恢复对应目标', async () => {
    const at = '2026-01-01T00:00:00.000Z';
    const wrap = (data) => ({ type: 'custom', customType: 'goal-event', data });
    const h = await load([
      wrap({ kind: 'created', goalId: 'old', text: '旧目标', mode: 'auto', budgets: { maxTurns: 1 }, at }),
      wrap({ kind: 'accounting', goalId: 'old', delta: { assistantTurns: 100 }, at }),
      wrap({ kind: 'updated', goalId: 'old', patch: { summary: '旧进度', budgets: { maxTokens: 1 } }, at }),
    ]);
    assert.equal((await h.state()).summary, '旧进度');
    assert.equal('budgets' in await h.state(), false);
    assert.equal((await h.settle()).continue, true);
    const branch = structuredClone(h.entries);
    h.entries.length = 0;
    await h.emit('session_tree');
    assert.equal(await h.state(), undefined);
    assert.equal(h.widgets.get('goal'), undefined);
    h.entries.push(...branch);
    await h.emit('session_start');
    assert.equal((await h.state()).goalId, 'old');
    assert.equal(h.sent.length, 0, '恢复会话不会未经用户操作自行启动');
  });

  await t.test('拒绝空目标，blocked 不能被静默覆盖，完成仍保留最终回复机会', async () => {
    const h = await load();
    assert.equal((await h.call('create_goal', { goal: '  ' })).isError, true);
    await h.call('create_goal', { goal: '任务' });
    const blocked = await h.call('update_goal', { status: 'blocked', summary: '缺少凭据' });
    assert.notEqual(blocked.terminate, true);
    assert.equal((await h.call('create_goal', { goal: '替代目标' })).isError, true);
    await h.call('update_goal', { status: 'active' });
    assert.deepEqual((await h.state()).blockers, []);
    const done = await h.call('update_goal', { status: 'completed', summary: '已验证' });
    assert.notEqual(done.terminate, true);
    assert.notEqual((await h.settle())?.continue, true);
  });

  await t.test('完成时只结算当前目标创建后的 Pi 已记录 usage，并优先 totalTokens', async () => {
    const wrap = (data) => ({ type: 'custom', customType: 'goal-event', data });
    const createdAt = new Date(Date.now() - 5000).toISOString();
    const h = await load([
      { type: 'message', message: { role: 'assistant', usage: recordedUsage(900) } },
      wrap({ kind: 'created', goalId: 'current', text: '统计当前目标', mode: 'assist', at: createdAt }),
      { type: 'message', message: { role: 'assistant', usage: recordedUsage(100, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }) } },
      { type: 'message', message: { role: 'toolResult', toolName: 'delegate', usage: recordedUsage(25) } },
      { type: 'compaction', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
      { type: 'branch_summary', usage: recordedUsage(8) },
      { type: 'usage', usage: recordedUsage(9) },
    ]);

    const result = await h.call('update_goal', { status: 'completed', summary: '已完成' });
    const completion = result.details.goal.completion;
    assert.equal(completion.totalTokens, 152);
    assert.ok(completion.durationMs >= 5000 && completion.durationMs < 60000, completion.durationMs);
    const persisted = h.entries.at(-1).data.completion;
    assert.deepEqual(persisted, completion);
    const completionLine = h.widgets.get('goal').find((value) => value.startsWith('总耗时:'));
    assert.ok(completionLine);
    assert.ok(result.content[0].text.includes(completionLine));
    assert.ok(completionLine.includes('总 Token: 152'));
  });

  await t.test('两个目标严格隔离，完成后的重复消息和重复完成不改变首次快照', async () => {
    const wrap = (data) => ({ type: 'custom', customType: 'goal-event', data });
    const firstAt = '2026-01-01T00:00:00.000Z';
    const secondAt = new Date(Date.now() - 3000).toISOString();
    const h = await load([
      wrap({ kind: 'created', goalId: 'first', text: '第一个', mode: 'assist', at: firstAt }),
      { type: 'message', message: { role: 'assistant', usage: recordedUsage(40) } },
      wrap({ kind: 'status', goalId: 'first', status: 'completed', at: '2026-01-01T00:00:10.000Z' }),
      { type: 'message', message: { role: 'assistant', usage: recordedUsage(500) } },
      wrap({ kind: 'created', goalId: 'second', text: '第二个', mode: 'assist', at: secondAt }),
      { type: 'message', message: { role: 'assistant', usage: recordedUsage(7) } },
    ]);

    await h.call('update_goal', { status: 'completed', summary: '首次完成' });
    const firstCompletion = structuredClone((await h.state()).completion);
    assert.equal(firstCompletion.totalTokens, 7);
    h.entries.push({ type: 'message', message: { role: 'assistant', usage: recordedUsage(999) } });
    await h.command('done 再次完成');
    assert.deepEqual((await h.state()).completion, firstCompletion);
    assert.deepEqual(h.entries.at(-1).data.completion, firstCompletion);

    const reloaded = await load(structuredClone(h.entries));
    assert.deepEqual((await reloaded.state()).completion, firstCompletion);
  });

  await t.test('旧完成事件按首次完成边界恢复快照，分支 reload 不计完成后消息并统一展示耗时', async () => {
    const wrap = (data) => ({ type: 'custom', customType: 'goal-event', data });
    const branch = [
      wrap({ kind: 'created', goalId: 'legacy', text: '旧目标', mode: 'assist', at: '2026-01-01T00:00:00.000Z' }),
      { type: 'message', message: { role: 'assistant', usage: recordedUsage(12) } },
      wrap({ kind: 'status', goalId: 'legacy', status: 'completed', reason: '完成', at: '2026-01-01T01:02:03.456Z' }),
      { type: 'message', message: { role: 'assistant', usage: recordedUsage(999) } },
    ];
    const h = await load(structuredClone(branch));
    const expected = { completedAt: '2026-01-01T01:02:03.456Z', durationMs: 3723456, totalTokens: 12 };
    assert.deepEqual((await h.state()).completion, expected);
    const line = '总耗时: 1小时 2分 3秒 · 总 Token: 12';
    assert.ok((await h.call('get_goal')).content[0].text.includes(line));
    await h.command('show');
    assert.ok(h.notices.at(-1).includes(line));
    assert.ok(h.widgets.get('goal').includes(line));

    h.entries.length = 0;
    await h.emit('session_tree');
    assert.equal(await h.state(), undefined);
    h.entries.push(...structuredClone(branch));
    await h.emit('session_start');
    assert.deepEqual((await h.state()).completion, expected);
  });

  await t.test('旧目标没有任何可读 usage 时明确显示 Token 不可用', async () => {
    const wrap = (data) => ({ type: 'custom', customType: 'goal-event', data });
    const h = await load([
      wrap({ kind: 'created', goalId: 'legacy', text: '无 usage', mode: 'assist', at: '2026-01-01T00:00:00.000Z' }),
      wrap({ kind: 'status', goalId: 'legacy', status: 'completed', at: '2026-01-01T00:00:01.000Z' }),
    ]);
    assert.deepEqual((await h.state()).completion, { completedAt: '2026-01-01T00:00:01.000Z', durationMs: 1000 });
    assert.ok((await h.call('get_goal')).content[0].text.includes('总耗时: 1秒 · 总 Token: 不可用'));
  });

  await t.test('有实质进度可续跑 25 次，不受旧轮数限制', async () => {
    const h = await load();
    await h.call('create_goal', { goal: '长任务', mode: 'auto' });
    for (let i = 0; i < 25; i++) {
      await h.call('update_goal', { summary: `已验证第 ${i + 1} 步` });
      assert.equal((await h.settle()).continue, true, `第 ${i + 1} 次续跑`);
    }
    assert.equal((await h.state()).status, 'active');
    assert.equal(h.sent.length, 0, '边界续跑不额外排入 followUp 消息');
  });

  await t.test('重复摘要、附带说明和调用工具不能无限重置停滞检测', async () => {
    const h = await load();
    await h.call('create_goal', { goal: '任务', mode: 'auto' });
    await h.call('update_goal', { summary: '处理中' });
    for (let i = 0; i < 2; i++) {
      await h.call('update_goal', { summary: '处理中', progressNote: 'still working' });
      await h.emit('tool_execution_end', { toolName: 'read' });
      assert.equal((await h.settle()).continue, true);
    }
    await h.call('update_goal', { summary: '处理中', nextAction: '换个描述' });
    assert.notEqual((await h.settle())?.continue, true);
    assert.equal((await h.state()).status, 'paused');
  });

  for (const outcome of ['aborted', 'error']) {
    await t.test(`${outcome} 不会触发自动重启`, async () => {
      const h = await load();
      await h.call('create_goal', { goal: '任务', mode: 'auto' });
      assert.notEqual((await h.settle('', { outcome }))?.continue, true);
      assert.equal((await h.state()).status, 'paused');
      assert.equal(h.sent.length, 0);
    });
  }

  await t.test('等待输入和队列已有工作时不抢占，附加消息使最终回答可续跑', async () => {
    const h = await load();
    await h.call('create_goal', { goal: '任务', mode: 'auto' });
    h.ctx.hasPendingMessages = () => true;
    assert.notEqual((await h.settle())?.continue, true);
    h.ctx.hasPendingMessages = () => false;
    assert.notEqual((await h.settle('', { continue: true }))?.continue, true);
    const continuation = await h.settle('', { context: { canContinue: false, pendingMessages: [], contextMessages: [] } });
    assert.equal(continuation.continue, true);
    assert.equal(continuation.entries.at(-1).type, 'custom_message');
    assert.notEqual((await h.settle('请确认是否继续？'))?.continue, true);
    assert.equal((await h.state()).status, 'blocked');
    await h.call('update_goal', { status: 'active' });
    assert.equal((await h.settle('已实现“请确认”弹窗并通过测试。')).continue, true);
  });

  for (const mode of ['manual', 'assist']) {
    await t.test(`${mode} 不自动续跑`, async () => {
      const h = await load();
      await h.call('create_goal', { goal: '任务', mode });
      assert.notEqual((await h.settle())?.continue, true);
    });
  }

  await t.test('只清理扩展自有消息，不误删含目标标记的源码、用户消息', async () => {
    const h = await load();
    const user = { role: 'user', content: '解释 [GOAL ACTIVE]' };
    const tool = { role: 'toolResult', content: [{ type: 'text', text: '源码含 [GOAL CONTINUATION]' }] };
    const old = { role: 'custom', customType: 'goal-steering-context', content: '旧目标' };
    const messages = [user, tool, old];
    assert.deepEqual((await h.emit('context', { messages })).messages, [user, tool]);
    await h.call('create_goal', { goal: '新目标', mode: 'auto' });
    let output = (await h.emit('context', { messages })).messages;
    assert.equal(output.length, 3);
    assert.deepEqual(output.slice(0, 2), [user, tool]);
    assert.match(output[2].content, /新目标/);
    await h.call('update_goal', { summary: '新进度' });
    output = (await h.emit('context', { messages: output })).messages;
    assert.equal(output.length, 3);
    assert.match(output[2].content, /新进度/);
  });

  await t.test('auto on 启动，pause 不等待长任务结束，resume 恢复并清除停滞计数', async () => {
    const h = await load();
    await h.command('create 测试目标');
    await h.command('auto on');
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].options.triggerTurn, true);
    await h.settle();
    h.ctx.waitForIdle = async () => { throw new Error('pause must not wait'); };
    await h.command('pause');
    assert.equal(h.aborted(), true);
    assert.equal((await h.state()).status, 'paused');
    await h.command('resume');
    assert.equal((await h.state()).noProgressTurns, 0);
    assert.equal(h.sent.length, 2);
    await h.command('done');
    await h.command('resume');
    assert.equal((await h.state()).status, 'completed');
    assert.equal(h.sent.length, 2);
  });
});
