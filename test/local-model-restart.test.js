import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRestartController } from '../server/services/model-selection.js';

function harness({ target = { kind: 'local', id: 'qwen', name: 'Qwen' }, reservations = 0 } = {}) {
  const calls = [];
  let publishes = 0;
  const runtime = {
    getState: () => ({ status: 'failed', modelId: 'qwen', failure: { code: 'RUNTIME_EXITED' } }),
    activate: async (...args) => { calls.push(args); await new Promise(resolve => setTimeout(resolve, 5)); return { status: 'ready', modelId: 'qwen', baseUrl: 'http://127.0.0.1:9000' }; },
  };
  const controller = createLocalRestartController({
    runtime,
    preferenceTarget: async () => target,
    getInstalled: async id => ({ id, displayName: 'Qwen' }),
    governor: { reservationCount: () => reservations },
    schedulePublish: async () => { publishes += 1; },
  });
  return { controller, calls, get publishes() { return publishes; } };
}

test('local restart reselects the active model without touching external services', async () => {
  const h = harness();
  const result = await h.controller.restart();
  assert.equal(result.restart.status, 'restarted');
  assert.equal(result.selectedTarget.id, 'qwen');
  assert.deepEqual(h.calls, [['qwen', { persistSelection: false }]]);
  assert.equal(h.publishes, 1);
});

test('duplicate restart requests share one guarded activation', async () => {
  const h = harness();
  const [first, second] = await Promise.all([h.controller.restart(), h.controller.restart()]);
  assert.equal(h.calls.length, 1);
  assert.equal(first.restart.status, 'restarted');
  assert.equal(second.restart.status, 'restarted');
  assert.equal(h.publishes, 1);
});

test('restart rejects external selections without stopping or activating a local runtime', async () => {
  const h = harness({ target: { kind: 'external', id: 'svc-1', name: 'Remote' } });
  await assert.rejects(h.controller.restart(), error => error.code === 'LOCAL_MODEL_NOT_SELECTED');
  assert.equal(h.calls.length, 0);
  assert.equal(h.publishes, 0);
});

test('restart refuses to interrupt a model owned by an active response', async () => {
  const h = harness({ reservations: 1 });
  await assert.rejects(h.controller.restart(), error => error.code === 'MODEL_RESERVED');
  assert.equal(h.calls.length, 0);
  assert.equal(h.publishes, 0);
});
