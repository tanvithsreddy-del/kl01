import assert from 'node:assert/strict';

const base = String(process.env.KL01_TEST_URL || 'http://127.0.0.1:32154').replace(/\/+$/u, '');
const timeoutMs = Math.max(60_000, Number(process.env.KL01_TEST_CASE_TIMEOUT_MS || 240_000));

async function json(path, options = {}) {
  const response = await fetch(`${base}${path}`, { headers:{ 'content-type':'application/json', ...(options.headers || {}) }, ...options });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}

const question = 'Analyze Cockroach Janta Party: what is it, who founded it, and is it a satirical movement or a conventional political party?';
const chat = await json('/api/chats', { method:'POST', body:JSON.stringify({ title:'Deep beta stall regression' }) });
const runId = `run-beta-stall-${Date.now().toString(36)}`;
const startedAt = Date.now();
await json(`/api/chats/${encodeURIComponent(chat.id)}/messages`, {
  method:'POST',
  body:JSON.stringify({ runId, text:question, attachments:[], profile:{ version:6, effort:3, research:{ mode:'auto' } } }),
});

let answer = null;
while (Date.now() - startedAt < timeoutMs) {
  const current = await json(`/api/chats/${encodeURIComponent(chat.id)}`);
  answer = [...(current.messages || [])].reverse().find(message => message.role === 'assistant' && message.runId === runId) || null;
  if (answer && ['completed', 'failed', 'cancelled'].includes(String(answer.status || ''))) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}

const elapsedMs = Date.now() - startedAt;
assert.ok(answer, `Deep run timed out after ${timeoutMs} ms`);
assert.equal(answer.status, 'completed');
assert.equal(answer.executionProfile?.modeId, 'standard');
assert.equal(answer.workflow ?? null, null, 'Deep must not start a workflow graph');
assert.match(String(answer.content || ''), /Cockroach Janta Party|CJP/iu);
assert.match(String(answer.content || ''), /satir|political movement/iu);
assert.ok(Number(answer.work?.counters?.queries || 0) <= 8, 'query hard cap exceeded');
assert.ok(Number(answer.work?.counters?.read || 0) <= 5, 'page hard cap exceeded');
assert.ok(elapsedMs < timeoutMs, 'Deep run exceeded its regression timeout');

console.log(JSON.stringify({
  status:'PASS',
  elapsedMs,
  answer:answer.content,
  mode:answer.executionProfile?.modeId,
  workflow:answer.workflow ?? null,
  workStatus:answer.work?.status,
  queries:answer.work?.counters?.queries,
  pages:answer.work?.counters?.read,
}, null, 2));
