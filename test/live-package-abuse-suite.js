import assert from 'node:assert/strict';

const base = String(process.env.KL01_TEST_URL || 'http://127.0.0.1:32155').replace(/\/+$/u, '');
const timeoutMs = Math.max(30_000, Number(process.env.KL01_TEST_CASE_TIMEOUT_MS || 120_000));
const localProfile = { version: 6, effort: 1, research: { mode: 'off' } };

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function json(path, options = {}) {
  const result = await request(path, options);
  if (!result.response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${result.response.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

async function createRun(title, text) {
  const chat = await json('/api/chats', { method: 'POST', body: JSON.stringify({ title }) });
  const runId = `run-package-abuse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  await json(`/api/chats/${encodeURIComponent(chat.id)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ runId, text, attachments: [], profile: localProfile }),
  });
  return { chat, runId };
}

async function waitForTerminal(chatId, runId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chat = await json(`/api/chats/${encodeURIComponent(chatId)}`);
    const message = [...(chat.messages || [])].reverse().find(item => item.role === 'assistant' && item.runId === runId);
    if (message && ['completed', 'cancelled', 'failed'].includes(String(message.status || ''))) return { chat, message };
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${runId} did not reach a terminal state within ${timeoutMs} ms`);
}

const report = { base, checks: [] };
const health = await json('/api/health');
assert.equal(health.status, 'ok');
report.checks.push({ name: 'health', status: 'pass' });

const first = await createRun('Package abuse — duplicate send', 'Reply exactly with: PACKAGE_ABUSE_FIRST');
const duplicate = await request(`/api/chats/${encodeURIComponent(first.chat.id)}/messages`, {
  method: 'POST',
  body: JSON.stringify({ runId: `${first.runId}-duplicate`, text: 'Reply exactly with: SHOULD_NOT_RUN', attachments: [], profile: localProfile }),
});
assert.equal(duplicate.response.status, 409);
assert.equal(duplicate.body?.error?.code, 'CHAT_BUSY');
report.checks.push({ name: 'duplicate-send', status: 'pass', response: duplicate.body?.error?.code });

const restartWhileBusy = await request('/api/runtime/restart', { method: 'POST', body: '{}' });
report.checks.push({ name: 'restart-while-busy', status: restartWhileBusy.response.status, code: restartWhileBusy.body?.error?.code || null });

await json(`/api/chats/${encodeURIComponent(first.chat.id)}/stop`, { method: 'POST', body: JSON.stringify({ runId: first.runId, reason: 'package-abuse' }) });
const stopped = await waitForTerminal(first.chat.id, first.runId);
assert.notEqual(stopped.message.status, 'failed');
report.checks.push({ name: 'stop-active-run', status: stopped.message.status });

const retryRunId = `run-package-abuse-retry-${Date.now().toString(36)}`;
await json(`/api/chats/${encodeURIComponent(first.chat.id)}/messages`, {
  method: 'POST',
  body: JSON.stringify({ runId: retryRunId, text: 'Reply exactly with: PACKAGE_ABUSE_RETRY', attachments: [], profile: localProfile }),
});
const retried = await waitForTerminal(first.chat.id, retryRunId);
assert.equal(retried.message.status, 'completed');
assert.match(String(retried.message.content || ''), /PACKAGE_ABUSE_RETRY/u);
report.checks.push({ name: 'post-stop-retry', status: 'pass' });

const unicode = await createRun('Package abuse — Unicode', 'Respond in one short sentence: Café, नमस्ते, and 🧪 are test input.');
const unicodeResult = await waitForTerminal(unicode.chat.id, unicode.runId);
assert.equal(unicodeResult.message.status, 'completed');
assert.ok(String(unicodeResult.message.content || '').trim().length > 0);
report.checks.push({ name: 'unicode-input', status: 'pass' });

const simultaneous = await Promise.all(['ONE', 'TWO', 'THREE'].map(token => createRun(`Package abuse — concurrent ${token}`, `Reply exactly with: PACKAGE_ABUSE_${token}`)));
const concurrentResults = await Promise.all(simultaneous.map(async item => {
  const result = await waitForTerminal(item.chat.id, item.runId);
  return { runId: item.runId, status: result.message.status, content: String(result.message.content || '') };
}));
for (const item of concurrentResults) assert.equal(item.status, 'completed');
report.checks.push({ name: 'three-concurrent-chats', status: 'pass', results: concurrentResults.map(item => item.status) });

const reload = await json(`/api/chats/${encodeURIComponent(first.chat.id)}`);
assert.ok((reload.messages || []).some(item => item.runId === retryRunId && item.status === 'completed'));
report.checks.push({ name: 'chat-persistence-readback', status: 'pass' });

console.log(JSON.stringify({ status: 'PASS', ...report }, null, 2));
