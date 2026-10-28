import assert from 'node:assert/strict';
import autoCompact from '../extensions/auto-compact.ts';

const events = new Map();
const commands = new Map();
const continuationMessages = [];
autoCompact({
  on: (name, handler) => events.set(name, handler),
  registerCommand: (name, command) => commands.set(name, command),
  sendMessage: (message, options) => continuationMessages.push({ message, options }),
});

let usage = 91;
let idle = false;
let compactCount = 0;
let finish;
let fail;
const ctx = {
  hasUI: false,
  getContextUsage: () => ({ percent: usage, tokens: 91000, contextWindow: 100000 }),
  isIdle: () => idle,
  compact: (options) => {
    assert.equal(idle, true, 'must not interrupt active agent run');
    compactCount++;
    finish = options.onComplete;
    fail = options.onError;
  },
  waitForIdle: async () => { idle = true; },
};

await events.get('turn_end')?.({}, ctx);
assert.equal(compactCount, 0, 'turn_end is still within an active run');
idle = true;
await events.get('agent_settled')({}, ctx);
assert.equal(compactCount, 1, 'compact when run settles');
await events.get('agent_settled')({}, ctx);
assert.equal(compactCount, 1, 'do not compact twice during one attempt');
finish({});
assert.deepEqual(continuationMessages, [{
  message: {
    customType: 'auto-compact-continue',
    content: 'Continue the current task from the compaction summary. Follow the recorded next steps, verify the work, and only finish when the original task is complete.',
    display: false,
  },
  options: { triggerTurn: true },
}], 'automatic compaction must resume the interrupted task once');
await events.get('agent_settled')({}, ctx);
assert.equal(compactCount, 1, 'still above threshold after compaction must not loop');
usage = 30;
await events.get('agent_settled')({}, ctx);
usage = 91;
await events.get('agent_settled')({}, ctx);
assert.equal(compactCount, 2, 're-arm only after usage drops');
finish({});
assert.equal(continuationMessages.length, 2, 'each automatic compaction resumes exactly once');
idle = false;
await commands.get('auto-compact-now').handler('', ctx);
assert.equal(compactCount, 3, 'manual command must wait until idle');
finish({});
assert.equal(continuationMessages.length, 2, 'manual compaction must not start unsolicited work');
usage = 30;
await events.get('agent_settled')({ aborted: false }, ctx);
usage = 91;
await events.get('agent_settled')({ aborted: true }, ctx);
assert.equal(compactCount, 3, 'user abort must not trigger compaction or restart work');
await events.get('agent_settled')({ aborted: false }, ctx);
assert.equal(compactCount, 4, 'normal settled run still compacts after an abort');
fail(new Error('test failure'));
assert.equal(continuationMessages.length, 2, 'failed compaction must not resume from missing summary');
console.log('auto-compact lifecycle OK');
