import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentLibrary } from '../server/services/document-library.js';

function textbook() {
  return [
    '# Engineering Mathematics',
    '## Chapter 1: Matrices',
    'Exercise 1.1: Find the determinant of the given matrix.',
    'Use cofactor expansion and check the sign pattern.',
    '',
    '## Chapter 3: Recurrence Relations',
    '### Exercise 3.4: Boundary-term induction',
    'Prove that the finite sum of consecutive odd integers equals the square of the number of terms.',
    'Step 1: Verify the base case for one term.',
    'Step 2: Assume the result for k terms and add the terminal odd term 2k + 1.',
    'Step 3: Simplify k squared plus 2k plus 1 to obtain (k + 1) squared.',
    '',
    '### Exercise 3.5: Tower of Hanoi recurrence',
    'Derive T(n) = 2T(n - 1) + 1 and solve it.',
    '',
    '## Chapter 7: Electrical Machines',
    '### Worked Example 7.2: Transformer loss',
    'Copper loss varies with the square of load current. At half load it is one quarter of full-load copper loss.',
  ].join('\n');
}

function input(name = 'engineering-mathematics.md', text = textbook()) {
  return {
    attachment: { id:`att-${name}`, name, extension:'md', type:'text/markdown', size:Buffer.byteLength(text), kind:'text' },
    text,
  };
}

async function fixture(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kl01-documents-'));
  t.after(() => fs.rm(rootDir, { recursive:true, force:true }));
  return { rootDir, library:createDocumentLibrary({ rootDir }) };
}

test('ingests a textbook once and selects an exact exercise with bounded neighbouring context', async t => {
  const { library } = await fixture(t);
  const result = await library.prepareContext('chat-a', 'Explain Exercise 3.4, especially step 2.', [input()], { persist:true });
  assert.equal(result.documents.length, 1);
  assert.match(result.attachmentInputs[0].text, /Exercise 3\.4/u);
  assert.match(result.attachmentInputs[0].text, /terminal odd term 2k \+ 1/u);
  assert.doesNotMatch(result.attachmentInputs[0].text, /Transformer loss/u);
  assert.ok(result.attachmentInputs[0].text.length < textbook().length);
  assert.equal(result.attachments[0].documentId, result.documents[0].id);
});

test('resolves an indirect follow-up from the previous selected exercise without reattachment', async t => {
  const { library } = await fixture(t);
  await library.prepareContext('chat-a', 'Help me with Exercise 3.4.', [input()], { persist:true });
  const followup = await library.prepareContext('chat-a', 'Why does the second step work?', [], { persist:true });
  assert.equal(followup.documents.length, 1);
  assert.match(followup.attachmentInputs[0].text, /Assume the result for k terms/u);
  assert.match(followup.attachmentInputs[0].text, /2k \+ 1/u);
});

test('finds a concept through deterministic synonym expansion instead of requiring the exact exercise label', async t => {
  const { library } = await fixture(t);
  await library.prepareContext('chat-a', 'Store this textbook.', [input()], { persist:true });
  const result = await library.prepareContext('chat-a', 'Show me the induction problem with the boundary term.', [], { persist:false });
  assert.match(result.attachmentInputs[0].text, /Boundary-term induction/u);
  assert.match(result.attachmentInputs[0].text, /finite sum of consecutive odd integers/u);
});

test('persists processed documents and retrieval state across service restarts', async t => {
  const { rootDir, library } = await fixture(t);
  await library.prepareContext('chat-a', 'Explain Exercise 3.4.', [input()], { persist:true });
  const restarted = createDocumentLibrary({ rootDir });
  const result = await restarted.prepareContext('chat-a', 'Explain that step again.', [], { persist:false });
  assert.match(result.attachmentInputs[0].text, /Exercise 3\.4/u);
});

test('reprocesses an older persisted document index on first read without reattachment', async t => {
  const { rootDir, library } = await fixture(t);
  const source = ['THE THOUGHT IS IN THE QUESTION THE INFORMATION IS IN THE ANSWER','','=Ques. What is a watt?=','','Ans. A watt is the electrical unit of power.'].join('\n');
  const stored = await library.prepareContext('chat-a', 'Store this textbook.', [input('guide.txt', source)], { persist:true });
  const file = path.join(rootDir, `${stored.documents[0].id}.json`);
  const old = JSON.parse(await fs.readFile(file, 'utf8'));
  old.processorVersion = 2;
  old.chunks = [{ id:'chunk-1', order:0, heading:'stale', lineStart:1, lineEnd:1, part:0, aliases:[], frequencies:{answer:1}, content:'THE THOUGHT IS IN THE QUESTION THE INFORMATION IS IN THE ANSWER' }];
  await fs.writeFile(file, JSON.stringify(old), 'utf8');
  const restarted = createDocumentLibrary({ rootDir });
  const result = await restarted.prepareContext('chat-a', 'Find the question that asks what a watt is.', [], { persist:false });
  const migrated = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(migrated.processorVersion, 4);
  assert.ok(migrated.chunks.some(chunk => /electrical unit of power/iu.test(chunk.content)));
  assert.match(result.attachmentInputs[0].text, /electrical unit of power/iu);
});

test('isolates documents between chats and deduplicates repeated content safely', async t => {
  const { library } = await fixture(t);
  const first = await library.prepareContext('chat-a', 'Store this.', [input('first.md')], { persist:true });
  const repeated = await library.prepareContext('chat-a', 'Store this duplicate.', [input('copy.md')], { persist:true });
  assert.equal(first.documents[0].id, repeated.documents[0].id);
  assert.equal((await library.listChat('chat-a')).documents.length, 1);
  const isolated = await library.prepareContext('chat-b', 'Explain Exercise 3.4.', [], { persist:false });
  assert.deepEqual(isolated.documents, []);
  assert.deepEqual(isolated.attachmentInputs, []);
});

test('branch linking preserves document access and deleting the last link removes the local copy', async t => {
  const { rootDir, library } = await fixture(t);
  const stored = await library.prepareContext('chat-a', 'Explain Exercise 3.4.', [input()], { persist:true });
  const documentId = stored.documents[0].id;
  await library.linkChatDocuments('chat-branch', [documentId]);
  await library.detachChat('chat-a');
  assert.equal((await library.listChat('chat-branch')).documents.length, 1);
  assert.match((await library.prepareContext('chat-branch', 'Explain that exercise.', [], { persist:false })).attachmentInputs[0].text, /Exercise 3\.4/u);
  await library.detachChat('chat-branch');
  assert.equal((await library.listChat('chat-branch')).documents.length, 0);
  const files = await fs.readdir(rootDir);
  assert.equal(files.filter(name => name.startsWith(`${documentId}.`)).length, 0);
});

test('editing away the last attached message removes its chat link and unreferenced local copy', async t => {
  const { rootDir, library } = await fixture(t);
  const stored = await library.prepareContext('chat-a', 'Store this.', [input()], { persist:true });
  const documentId = stored.documents[0].id;
  const result = await library.syncChatDocuments('chat-a', []);
  assert.deepEqual(result.removed, [documentId]);
  assert.deepEqual((await library.listChat('chat-a')).documents, []);
  await assert.rejects(fs.access(path.join(rootDir, `${documentId}.json`)));
});

test('recovers a corrupt index without exposing an unrelated document', async t => {
  const { rootDir, library } = await fixture(t);
  await library.prepareContext('chat-a', 'Store this.', [input()], { persist:true });
  await fs.writeFile(path.join(rootDir, 'index.json'), '{broken', 'utf8');
  const recovered = createDocumentLibrary({ rootDir });
  const result = await recovered.prepareContext('chat-b', 'Explain Exercise 3.4.', [], { persist:false });
  assert.deepEqual(result.documents, []);
  const files = await fs.readdir(rootDir);
  assert.ok(files.some(name => name.startsWith('index.json.corrupt-')));
});

test('recognises plain-text textbook question headings and reports useful line ranges', async t => {
  const { library } = await fixture(t);
  const source = ['INTRODUCTION','','=Ques. What is a watt?=','','Ans. A watt is the electrical unit of power.','','=Ques. What is an ohm?=','','Ans. An ohm is a unit of resistance.'].join('\n');
  const result = await library.prepareContext('chat-a', 'Find the question that asks what a watt is.', [input('guide.txt', source)], { persist:true });
  assert.match(result.attachmentInputs[0].text, /A watt is the electrical unit of power/u);
  assert.doesNotMatch(result.attachmentInputs[0].text, /unit of resistance/u);
  assert.match(result.attachmentInputs[0].text, /lines 3-5/u);
});

test('an exact textbook question outranks a longer chapter that repeats the subject', async t => {
  const { library } = await fixture(t);
  const source = ['=The Watt-Hour.=','The watt-hour chapter repeats watt and consumption and watt many times.','','=Ques. What is a watt?=','','Ans. A watt is the electrical unit of power.'].join('\n');
  const result = await library.prepareContext('chat-a', 'Find the question that asks what a watt is.', [input('guide.txt', source)], { persist:true });
  assert.match(result.attachmentInputs[0].text, /electrical unit of power/iu);
  assert.doesNotMatch(result.attachmentInputs[0].text, /watt-hour chapter/iu);
});

test('rare subject terms outrank broad chapter context and relative-clause that is not treated as a follow-up', async t => {
  const { library } = await fixture(t);
  const source = [
    'PRIMARY CELLS',
    'A primary cell has metal plates and an electrolyte. Current flows through the circuit.',
    '',
    '=Ques. What is a depolarizer?=',
    'Ans. A depolarizer combines with hydrogen that would otherwise cause polarization.',
    '',
    '=Ques. What is a watt?=',
    'Ans. A watt is the electrical unit of power.',
  ].join('\n');
  await library.prepareContext('chat-a', 'Tell me about primary cells.', [input('guide.txt', source)], { persist:true });
  const rare = await library.prepareContext('chat-a', 'bhai primary cell ka depolarizer kya karta hai?', [], { persist:false });
  assert.match(rare.attachmentInputs[0].text, /combines with hydrogen/u);
  assert.doesNotMatch(rare.attachmentInputs[0].text, /metal plates/u);
  assert.doesNotMatch(rare.attachmentInputs[0].text, /single or liquid form/u);
  const relative = await library.prepareContext('chat-a', 'Find the question that asks what a watt is.', [], { persist:false });
  assert.match(relative.attachmentInputs[0].text, /electrical unit of power/u);
  assert.doesNotMatch(relative.attachmentInputs[0].text, /depolarizer/u);
});

test('instruction boilerplate cannot outrank the direct textbook concept', async t => {
  const { library } = await fixture(t);
  const source = [
    '# RELATIONSHIPS AND EXAMPLES',
    'This textbook includes a long relationship example. Use only the attached values and explain the result simply. '.repeat(20),
    '# RESISTANCE AND CONDUCTIVITY',
    'Resistance opposes the flow of electric current.',
    "Ohm's law states that current falls as resistance increases for a constant voltage.",
    '# DIVIDED CIRCUIT EXAMPLE',
    'A worked example applies ohms and current to 100 lamps in parallel. The total is 1.8 ohms.',
    '# DIRECT FORMULA',
    "Ohm's law states that current = electromotive force / resistance, or I = E/R. In units, amperes = volts / ohms.",
  ].join('\n\n');
  const request = "According to this textbook, explain Ohm's law simply and include the relationship between current, voltage, and resistance. Use the attached textbook only.";
  await library.prepareContext('chat-a', request, [input('guide.txt', source)], { persist:true });
  const selected = await library.prepareContext('chat-a', request, [], { persist:false });
  assert.match(selected.attachmentInputs[0].text, /Ohm's law states/iu);
  assert.match(selected.attachmentInputs[0].text, /amperes = volts \/ ohms/iu);
  assert.doesNotMatch(selected.attachmentInputs[0].text, /long relationship example/iu);
  assert.doesNotMatch(selected.attachmentInputs[0].text, /100 lamps/iu);
  assert.doesNotMatch(selected.attachmentInputs[0].text, /magnetic flux/iu);
  assert.equal(selected.selection.length, 1);
});

test('a revision-plan request selects priorities and required plan ahead of repeated filler', async t => {
  const { library } = await fixture(t);
  const source = [
    '# Mathematical adversary notes',
    'These are user-supplied prompt notes. Use them as reference material.',
    '## Revision priorities',
    'Start with diagonalization proof patterns. Then practise induction and recurrence relations.',
    '## Required plan',
    'Monday: diagonalization. Tuesday: induction. Wednesday: recurrences. Thursday: counterexamples. Friday: timed mixed problems.',
    '## Self-check',
    'For every session, write one failed attempt and two retrieval-practice questions.',
    '## Filler notes',
    ...Array.from({length:300},(_,index)=>`Background note ${index+1}: preserve definitions and record proof assumptions.`),
  ].join('\n\n');
  const result=await library.prepareContext('chat-a','Turn these prompt notes into a revision plan.',[input('notes.md',source)],{persist:true});
  const selected=result.attachmentInputs[0].text;
  assert.match(selected,/Revision priorities/iu);
  assert.match(selected,/Required plan/iu);
  assert.match(selected,/diagonalization/iu);
  assert.match(selected,/Friday: timed mixed problems/iu);
  assert.ok((selected.match(/Background note/giu)||[]).length<20,'repeated filler dominated the bounded evidence');
});

test('an explicit same-section follow-up cannot jump to a newly matching chapter', async t => {
  const { library } = await fixture(t);
  const source = ['# OHM LAW','Current equals voltage divided by resistance. Resistance opposes current.','# EDDY CURRENTS','Eddy currents heat magnetic pole pieces and add resistance.'].join('\n\n');
  await library.prepareContext('chat-a', 'Explain Ohm law current and resistance.', [input('guide.txt', source)], { persist:true });
  const followup = await library.prepareContext('chat-a', 'Why does resistance reduce current? Explain that same section.', [], { persist:false });
  assert.match(followup.attachmentInputs[0].text, /voltage divided by resistance/iu);
  assert.doesNotMatch(followup.attachmentInputs[0].text, /magnetic pole pieces/iu);
});

test('fails closed at configured local storage and per-chat document limits without partial links', async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kl01-document-limits-'));
  t.after(() => fs.rm(rootDir, { recursive:true, force:true }));
  const limited = createDocumentLibrary({ rootDir, maxLibraryBytes:80, maxChatDocuments:1 });
  const firstText = 'A'.repeat(60);
  await limited.prepareContext('chat-a', 'Store first.', [input('first.txt', firstText)], { persist:true });
  await assert.rejects(limited.prepareContext('chat-a', 'Store second.', [input('second.txt', 'B'.repeat(30))], { persist:true }), error => error.code === 'DOCUMENT_LIBRARY_FULL');
  assert.equal((await limited.listChat('chat-a')).documents.length, 1);
  const chatLimited = createDocumentLibrary({ rootDir:path.join(rootDir, 'chat-limit'), maxLibraryBytes:1_000, maxChatDocuments:1 });
  await chatLimited.prepareContext('chat-a', 'Store first.', [input('first.txt', firstText)], { persist:true });
  await assert.rejects(chatLimited.prepareContext('chat-a', 'Store second.', [input('second.txt', 'B'.repeat(30))], { persist:true }), error => error.code === 'CHAT_DOCUMENT_LIMIT');
  assert.equal((await chatLimited.listChat('chat-a')).documents.length, 1);
});
