import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())), '../..');
const { createAgentSession, ModelRuntime, SessionManager, SettingsManager } = await import(join(packageRoot, 'dist/index.js'));
const { loadExtensions, clearExtensionCache } = await import(join(packageRoot, 'dist/core/extensions/loader.js'));
const { AssistantMessageEventStream } = await import(join(packageRoot, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js'));
const extensionPath = fileURLToPath(new URL('../extensions/goal/index.ts', import.meta.url));
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

for (const scenario of ['completed', 'stalled', 'error', 'aborted', 'pause']) {
  await test(`真实 Pi SDK 生命周期：${scenario}`, { timeout: 20000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-goal-runtime-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    clearExtensionCache();
    const extensions = await loadExtensions([extensionPath], root);
    assert.deepEqual(extensions.errors, []);
    const resourceLoader = {
      getExtensions: () => extensions,
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => 'Offline lifecycle test.', getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      extendResources() {}, async reload() {},
    };
    const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null,
      modelsStorePath: join(root, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
    const model = modelRuntime.getModels('openai')[0];
    assert.ok(model);
    await modelRuntime.setRuntimeApiKey('openai', 'offline-test-not-a-real-key');
    const manager = SessionManager.inMemory(root);
    const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model,
      thinkingLevel: 'off', tools: ['get_goal', 'create_goal', 'update_goal'], resourceLoader, sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    });
    t.after(() => session.dispose());
    const errors = [];
    await session.bindExtensions({ mode: 'json', onError: (error) => errors.push(error) });
    let requests = 0;
    session.agent.streamFunction = (_model, context, options) => {
      requests++;
      assert.ok(requests <= 55, '测试必须在有限请求内结束');
      assert.ok(context.messages.some((message) => JSON.stringify(message.content).includes('SDK目标')));
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        const step = Math.ceil(requests / 2);
        const toolTurn = scenario === 'completed' && requests % 2 === 1;
        const stopReason = scenario === 'pause' ? 'aborted' : scenario === 'error' || scenario === 'aborted' ? scenario : toolTurn ? 'toolUse' : 'stop';
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage,
          stopReason, errorMessage: stopReason === 'error' ? 'test provider failure' : undefined,
          content: toolTurn
            ? [{ type: 'toolCall', id: `step-${step}`, name: 'update_goal', arguments: { summary: `已验证第 ${step} 步`, ...(step === 25 ? { status: 'completed' } : {}) } }]
            : [{ type: 'text', text: '本阶段执行结束。' }],
        };
        stream.push({ type: 'start', partial: message });
        if (scenario === 'pause') {
          options.signal.addEventListener('abort', () => {
            stream.push({ type: 'error', reason: 'aborted', error: message });
            stream.end();
          }, { once: true });
          void session.prompt('/goal pause');
          return;
        }
        stream.push(stopReason === 'error' || stopReason === 'aborted'
          ? { type: 'error', reason: stopReason, error: message }
          : { type: 'done', reason: stopReason, message });
        stream.end();
      });
      return stream;
    };
    await session.prompt('/goal create SDK目标');
    await session.prompt('/goal auto on');
    await session.waitForIdle();
    const statuses = manager.getBranch().filter((entry) => entry.type === 'custom' && entry.customType === 'goal-event' && entry.data.kind === 'status');
    assert.deepEqual(errors, []);
    assert.equal(statuses.at(-1)?.data.status, scenario === 'completed' ? 'completed' : 'paused', JSON.stringify({ requests, tools: session.getActiveToolNames(), messages: session.messages.filter((message) => message.role === 'toolResult') }));
    assert.equal(requests, scenario === 'completed' ? 50 : scenario === 'stalled' ? 3 : 1);
    assert.equal(manager.getBranch().some((entry) => entry.type === 'custom' && entry.data?.kind === 'accounting'), false);
    assert.equal(session.isStreaming, false);
  });
}
