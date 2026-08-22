import assert from 'node:assert/strict';

const base = String(process.env.KL01_TEST_URL || 'http://127.0.0.1:56441').replace(/\/+$/u, '');
const modelLabel = String(process.env.KL01_LUNA_MODEL || 'unknown');
const timeoutMs = Math.max(30_000, Number(process.env.KL01_TEST_CASE_TIMEOUT_MS || 180_000));
const profile = { version: 6, effort: 1, research: { mode: 'off' } };
const prompts = [
  { id: 'study-stack-queue', text: 'Explain the difference between a stack and a queue for a first-year BTech student. Include LIFO, FIFO, and one practical example of each.', expect:/LIFO[\s\S]*FIFO|FIFO[\s\S]*LIFO/iu, reject:/queue[\s\S]{0,100}remove(?:d|s|\s+items)?\s+from\s+the\s+end/iu },
  { id: 'code-unique-order', text: 'Write a JavaScript function uniquePreserveOrder(values) that removes duplicates while preserving first-seen order. Include a two-line explanation.', expect:/uniquePreserveOrder[\s\S]*(?:new\s+Set|\.includes\(|\.indexOf\s*\(\s*\w+\s*\)\s*===?\s*\w+)/iu },
  { id: 'code-recursion', text: 'Explain recursive factorial with a base case and recursive case, then give correct pseudocode.', expect:/n\s*(?:==?\s*0|<=\s*1)[\s\S]*return\s+1/iu },
  { id: 'arithmetic', text: 'Calculate 27 multiplied by 43. State only the arithmetic and final number.', expect:/1161/u },
  { id: 'sql-grouping', text: 'Write a SQL query that returns each department and the average salary from employees, including only departments whose average salary is above 50000.', expect:/AVG\s*\(salary\)[\s\S]*GROUP\s+BY[\s\S]*HAVING/iu },
  { id: 'hinglish-study', text: 'Hinglish mein binary search samjhao: sorted array kyun chahiye, aur ek chhota example do.', expect:/sorted[\s\S]*(?:middle|mid|half|aadha)/iu },
  { id: 'bounded-summary', text: 'Using only these facts: Delhi is in India; India has a monsoon season; the prompt contains no other facts. Write a two-sentence summary and do not add outside facts.', expect:/Delhi[\s\S]*India[\s\S]*monsoon season/iu, reject:/heavy|rainfall|summer|winter/iu, sentences:2 },
  { id: 'uncertainty', text: 'If you cannot establish an answer from the prompt, say that you are unsure. What is the exact chemical composition of an unknown sample?', expect:/unsure|cannot (?:determine|establish)|unknown/iu },
  { id: 'exact-output', text: 'Reply exactly with: LUNA_MARKER', exact:'LUNA_MARKER' },
  { id: 'long-context', text: `Explain binary search in a compact study note. Context marker: ${'study-context '.repeat(260)}`, expect:/binary search[\s\S]*(?:log\s*n|divide|half|sorted)/iu, reject:/(?:less|smaller)[\s\S]{0,100}low[\s\S]{0,40}\+\s*1|(?:greater|larger|more)[\s\S]{0,100}high[\s\S]{0,40}-\s*1/iu },
];

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function runCase(item, index) {
  const started = Date.now();
  const chat = await request('/api/chats', { method: 'POST', body: JSON.stringify({ title: `Luna model ${modelLabel} ${item.id}` }) });
  const runId = `run-luna-${Date.now().toString(36)}-${index}`;
  await request(`/api/chats/${encodeURIComponent(chat.id)}/messages`, { method: 'POST', body: JSON.stringify({ runId, text: item.text, attachments: [], profile }) });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await request(`/api/chats/${encodeURIComponent(chat.id)}`);
    const answer = [...(current.messages || [])].reverse().find(message => message.role === 'assistant' && message.runId === runId);
    if (answer && ['completed', 'cancelled', 'failed'].includes(String(answer.status || ''))) {
      return {
        model: modelLabel,
        id: item.id,
        status: answer.status,
        durationMs: Date.now() - started,
        answer: String(answer.content || ''),
        reasoning: String(answer.reasoning || ''),
        execution: answer.execution || null,
        telemetry: answer.telemetry || null,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${item.id} timed out after ${timeoutMs} ms`);
}

const health = await request('/api/health');
assert.equal(health.status, 'ok');
const results = [];
for (let index = 0; index < prompts.length; index += 1) {
  const result = await runCase(prompts[index], index);
  assert.equal(result.status, 'completed', `${result.id}: ${result.status}`);
  if (prompts[index].expect) assert.match(result.answer, prompts[index].expect, result.id);
  if (prompts[index].reject) assert.doesNotMatch(result.answer, prompts[index].reject, result.id);
  if (prompts[index].sentences) assert.equal((result.answer.match(/[^.!?\s][^.!?]*[.!?]+(?=\s|$)/gu) || []).length, prompts[index].sentences, result.id);
  if (prompts[index].exact != null) assert.equal(result.answer.trim(), prompts[index].exact, result.id);
  results.push(result);
  console.log(JSON.stringify({ id: result.id, status: result.status, durationMs: result.durationMs, answerChars: result.answer.length, reasoningChars: result.reasoning.length }));
}
console.log(JSON.stringify({ status: 'PASS', model: modelLabel, cases: results.length, results }, null, 2));
