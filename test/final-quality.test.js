import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicAnswerContractRepair, finalQualityRewritePrompt, finalRewriteReason, needsGroundedExpansion } from '../server/services/final-quality.js';

test('detects a long answer that stops mid-sentence but leaves short code-like replies alone', () => {
  assert.equal(finalRewriteReason('Make a plan.', `${'Complete plan sentence. '.repeat(60)}The final exercise covers`), 'incomplete-ending');
  assert.equal(finalRewriteReason('Name the variable.', 'current'), null);
  assert.equal(finalRewriteReason('Return JSON.', '{"ok":true}'), null);
});

test('requests a bounded rewrite when a simple or compact answer becomes a lecture', () => {
  const draft = `${'This is a supported explanatory sentence. '.repeat(60)}`;
  assert.equal(finalRewriteReason('Explain it simply.', draft), 'compactness-missed');
  assert.equal(finalRewriteReason('Give an exhaustive analysis.', draft), null);
  assert.match(finalQualityRewritePrompt('Explain it simply.', draft, 'compactness-missed'), /at most 160 words/u);
});

test('an attachment explanation cannot collapse into an unexplained formula', () => {
  assert.equal(needsGroundedExpansion("Explain Ohm's law and the relationship.", '$I = E/R$', [{ text:'Current equals voltage divided by resistance.' }]), true);
  assert.equal(needsGroundedExpansion("Explain Ohm's law and the relationship.", 'Current equals voltage divided by resistance, so more resistance means less current at a fixed voltage.', [{ text:'Current equals voltage divided by resistance.' }]), false);
});

test('an explanatory request rejects a bare numeric answer as non-responsive', () => {
  assert.equal(finalRewriteReason('Why does resistance reduce current? Explain it simply.', '120'), 'answer-does-not-address-request');
  assert.equal(finalRewriteReason('How does this formula work?', '42'), 'answer-does-not-address-request');
  assert.equal(finalRewriteReason("Explain Ohm's law and the relationship.", '$ I = \\frac{E}{R} $\n$ E = I \\times R $'), 'answer-does-not-address-request');
  assert.equal(finalRewriteReason('Reply with exactly: 120', '120'), null);
});

test('a broken duplicate-removal implementation is replaced by a deterministic contract repair', () => {
  const request = 'Write a JavaScript function uniquePreserveOrder(values) that removes duplicates while preserving first-seen order.';
  const broken = 'function uniquePreserveOrder(values) { return values.filter((value, index) => values.every((_, i) => i === index)); } // uses a set';
  const repaired = deterministicAnswerContractRepair(request, broken);
  assert.match(repaired, /return \[\.\.\.new Set\(values\)\]/u);
  assert.equal(deterministicAnswerContractRepair(request, 'function uniquePreserveOrder(values) { return [...new Set(values)]; }'), null);
});

test('a grouped-average SQL contract rejects WHERE aggregates and wrong tables', () => {
  const request = 'Write a SQL query that returns each department and the average salary from employees, including only departments whose average salary is above 50000.';
  const broken = 'SELECT Department, AVG(Salary) FROM Department WHERE AVG(Salary) > 50000;';
  const repaired = deterministicAnswerContractRepair(request, broken);
  assert.match(repaired, /FROM employees[\s\S]*GROUP BY department[\s\S]*HAVING AVG\(salary\) > 50000/iu);
  assert.equal(deterministicAnswerContractRepair(request, 'SELECT department, AVG(salary) FROM employees GROUP BY department HAVING AVG(salary) > 50000;'), null);
});

test('a binary-search explanation cannot reverse its pointer updates', () => {
  const request = 'Explain binary search in a compact study note.';
  const broken = 'If the target is less than the midpoint, set low = mid + 1. Otherwise set high = mid - 1.';
  const repaired = deterministicAnswerContractRepair(request, broken);
  assert.match(repaired, /smaller[\s\S]*high = mid - 1[\s\S]*larger[\s\S]*low = mid \+ 1/iu);
});

test('a stack and queue comparison uses canonical insertion and removal ends', () => {
  const request = 'Explain the difference between a stack and a queue. Include LIFO and FIFO.';
  const misleading = 'A queue adds and removes items at the end.';
  const repaired = deterministicAnswerContractRepair(request, misleading);
  assert.match(repaired, /stack follows LIFO[\s\S]*queue follows FIFO/iu);
  assert.match(repaired, /rear and remove them from the front/iu);
});
