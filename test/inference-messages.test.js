import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatMessages } from '../server/services/inference.js';
import { constraintFailureReply, inspectExplicitOutputConstraints, outputConstraintRepairMessage } from '../server/services/output-constraints.js';

test('inference keeps all system instructions before the conversation for strict model templates', () => {
  const source = [
    { role:'system', content:'Base rules.' },
    { role:'user', content:'Calculate 27 multiplied by 43.' },
    { role:'system', content:'The deterministic result is 1161.' },
    { role:'assistant', content:'Earlier response.' },
    { role:'system', content:'Follow the requested format.' },
    { role:'user', content:'State only the arithmetic and final number.' },
  ];
  const normalized = normalizeChatMessages(source);
  assert.deepEqual(normalized.map(message => message.role), ['system','user','assistant','user']);
  assert.equal(normalized[0].content, 'Base rules.\n\nThe deterministic result is 1161.\n\nFollow the requested format.');
  assert.deepEqual(source.map(message => message.role), ['system','user','system','assistant','system','user']);
});

test('literal stanza boundaries are checked before a streamed answer is accepted', () => {
  const request = 'Write exactly three stanzas. Every stanza must begin with A and end with e.';
  const invalid = 'A first stanza ends wrong.\n\nA second stanza ends wrong.\n\nA final stanza ends wrong.';
  const report = inspectExplicitOutputConstraints(request, invalid);
  assert.ok(report.violations.some(item => item.includes('end with e')));
  assert.match(outputConstraintRepairMessage(request, invalid, report), /Return only the corrected final answer/u);
  assert.match(constraintFailureReply(), /could not reliably satisfy/u);
  const valid = 'A small pet shines bright e\n\nA kind dog rests by me\n\nA bird sings softly e';
  assert.deepEqual(inspectExplicitOutputConstraints(request, valid).violations, []);
});
