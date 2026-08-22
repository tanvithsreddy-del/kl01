import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTACHMENT_CONTEXT_CHARS, buildAttachmentContext, composeInputWithAttachments } from '../server/services/model-capabilities.js';
import { groundedExtractiveReply, inspectExplicitOutputConstraints, inspectSourceOnlyOutput, inspectUnsupportedDocumentQuotes, sourceOnlyFailureReply, isSourceOnlyRequest, requiredExactReply } from '../server/services/output-constraints.js';
import { compose } from '../server/services/prompts.js';

test('attached text is bounded and retrieval-selected instead of blindly filling the model context', () => {
  const filler = 'Background mathematical adversary note with examples and notation.\n'.repeat(480);
  const source = [
    '# Mathematical adversary notes',
    filler,
    '## Revision priorities',
    'Revise proof by contradiction, induction, and counterexamples first. Build a seven-day revision plan with daily recall questions.',
    '## Practice',
    'Use timed problem sets and record every error in an error log.',
  ].join('\n');
  const prompt = composeInputWithAttachments('Turn these prompt notes into a revision plan', [{ attachment:{ name:'08_mathematical_adversary.md' }, text:source }]);
  assert.match(prompt, /Revision priorities/u);
  assert.match(prompt, /seven-day revision plan/u);
  assert.match(prompt, /Treat this as user-provided reference material/u);
  assert.ok(prompt.lastIndexOf('Turn these prompt notes into a revision plan') > prompt.lastIndexOf('END LOCAL ATTACHMENT EVIDENCE'), 'the user request must follow the retrieved evidence');
  assert.ok(prompt.length <= 'Turn these prompt notes into a revision plan'.length + MAX_ATTACHMENT_CONTEXT_CHARS + 2);
});

test('base instruction requires a finished attachment work product instead of a source dump', () => {
  const prompt = compose('chat-base');
  assert.match(prompt.system, /requested finished work/u);
  assert.match(prompt.system, /Do not dump, transcribe, or enumerate repetitive source text/u);
});

test('attachment retrieval collapses large ordinal-only repetition into an explicit source pattern', () => {
  const source = Array.from({ length:12 }, (_, index) => `Background note ${index + 1}: preserve definitions before applying a theorem.`).join('\n');
  const prompt = composeInputWithAttachments('Create a revision plan', [{ attachment:{ name:'notes.md' }, text:source }]);
  assert.match(prompt, /Source pattern: the preceding line repeats/u);
  assert.doesNotMatch(prompt, /Background note 12/u);
});

test('attachment retrieval emits a small, labelled local evidence packet instead of an unbounded document dump', () => {
  const source = [
    '# Electrical machines',
    '## Safety',
    'Disconnect the supply before inspecting a motor.',
    '## Transformer losses',
    'Copper loss varies with the square of load current. Core loss is approximately constant at rated voltage.',
    '## Worked example',
    'At half load, copper loss is one quarter of full-load copper loss.',
    '## Background',
    'Generic background material that should not displace the answerable transformer section.'.repeat(300),
  ].join('\n\n');
  const packet = buildAttachmentContext('Explain how transformer copper loss changes at half load.', [{ attachment:{ name:'machines.md' }, text:source }]);
  assert.match(packet, /LOCAL ATTACHMENT EVIDENCE/u);
  assert.match(packet, /\[machines\.md · excerpt \d+\]/u);
  assert.match(packet, /one quarter of full-load copper loss/u);
  assert.ok(packet.length < source.length / 4, 'retrieval packet must be materially smaller than its source');
});

test('an explicit attached-source-only request rejects invented subject matter', () => {
  const request = 'Turn these notes into a revision plan. Use the attached notes only.';
  const attachments = [{ text:'Monday: induction. Tuesday: recurrence relations. Record proof assumptions.' }];
  assert.deepEqual(inspectSourceOnlyOutput(request, 'Monday: induction. Tuesday: recurrence relations.', attachments), []);
  assert.ok(inspectSourceOnlyOutput(request, 'Study Fibonacci and pigeonhole proofs.', attachments).includes('fibonacci'));
  assert.match(sourceOnlyFailureReply(), /only the supplied material/u);
});

test('an inline fact packet rejects and recovers from an invented detail', () => {
  const request = 'Using only these facts: Delhi is in India; India has a monsoon season; the prompt contains no other facts. Write a two-sentence summary and do not add outside facts.';
  assert.equal(isSourceOnlyRequest(request), true);
  assert.deepEqual(inspectSourceOnlyOutput(request, 'Delhi is in India. India has heavy summer rainfall.', []), ['heavy', 'summer', 'rainfall']);
  assert.equal(groundedExtractiveReply(request, []), 'Delhi is in India. India has a monsoon season.');
  assert.deepEqual(inspectExplicitOutputConstraints(request, 'Delhi is in India, and India has a monsoon season.').violations, ['Expected exactly 2 sentences; found 1.']);
});

test('source-only checking permits neutral organisation words while retaining a subject-matter guard', () => {
  const request = 'Turn these notes into a revision plan. Use the attached notes only.';
  const attachments = [{ text:'Monday: induction. Tuesday: recurrence relations. Record proof assumptions.' }];
  const organised = 'Revision plan: Monday focus on induction. Tuesday work on recurrence relations. Self-check: record proof assumptions.';
  assert.deepEqual(inspectSourceOnlyOutput(request, organised, attachments), []);
  assert.ok(inspectSourceOnlyOutput(request, 'Add Fibonacci algorithms and cybersecurity vulnerabilities.', attachments).includes('fibonacci'));
});

test('the direct-synthesis policy is limited to explicit attachment source-only requests', () => {
  assert.equal(isSourceOnlyRequest('Use the attached notes only to make a plan.'), true);
  assert.equal(isSourceOnlyRequest('Turn the attached notes into a plan.'), false);
  assert.equal(isSourceOnlyRequest('Explain that same textbook section like I am a first-year student.'), true);
  assert.equal(isSourceOnlyRequest('Make a plan from this book.'), true);
});

test('source-only grounding ignores LaTeX control syntax while still checking prose claims', () => {
  const request = 'Use the attached textbook only.';
  const attachments = [{ text:'Current equals voltage divided by resistance. Total resistance is the sum of the resistances.' }];
  const answer = '$$ I = \\frac{V}{R} $$\nTotal resistance: $$R_{\\text{total}} = R + R\' + R\'\' + \\dots$$';
  assert.deepEqual(inspectSourceOnlyOutput(request, answer, attachments), []);
  assert.ok(inspectSourceOnlyOutput(request, 'Fibonacci sorting is required.', attachments).includes('fibonacci'));
});

test('Hinglish book-bound questions reject new detail in a direct textbook answer', () => {
  const request = 'bhai primary cell ka depolarizer kya karta hai? book se simple bata';
  const attachments = [{ text:'[guide.txt · What is a depolarizer? · lines 10-14]\n=Ques. What is a depolarizer?=\n\nAns. A substance that combines with hydrogen at the positive electrode and prevents polarization.' }];
  assert.equal(isSourceOnlyRequest(request), true);
  assert.deepEqual(inspectSourceOnlyOutput(request, 'It combines with hydrogen and prevents polarization.', attachments), []);
  assert.ok(inspectSourceOnlyOutput(request, 'A depolarizer is a substance used in a primary cell to combine hydrogen ions at the positive electrode, preventing them from escaping and causing polarization.', attachments).includes('ions'));
  assert.equal(groundedExtractiveReply(request, attachments), 'According to the supplied document: A substance that combines with hydrogen at the positive electrode and prevents polarization.');
});

test('a rejected source-only draft falls back to the most relevant source paragraph', () => {
  const attachments = [{ text:'[guide.txt · resistance · lines 10-20]\nSilver is a conductive metal.\n\nResistance opposes electric current. Ohm’s law states that current falls as resistance increases for a constant voltage.\n\nUnrelated history.' }];
  assert.match(groundedExtractiveReply('Explain Ohm law current voltage resistance.', attachments), /^According to the supplied document: Resistance opposes electric current/u);
  assert.doesNotMatch(groundedExtractiveReply('Explain Ohm law current voltage resistance.', attachments), /Silver/u);
});

test('an inferred Ohm-law follow-up receives an explanation instead of a bare formula', () => {
  const attachments = [{ text:'[guide.txt · circuits · lines 40-55]\nTo make this plain, electric current = electromotive force / resistance or I = E/R.\n\nThe resistance depends on the circuit material and dimensions.' }];
  const answer = groundedExtractiveReply('Why does resistance reduce the current? Explain that same textbook section simply.', attachments);
  assert.match(answer, /If voltage stays the same/iu);
  assert.match(answer, /less current flows/iu);
});

test('an extractive exercise lookup preserves the exact question and answer', () => {
  const attachments = [{ text:'[guide.txt · What is a watt? · lines 3-5]\n=Ques. What is a watt?=\n\nAns. A watt is the electrical unit of power.' }];
  const answer = groundedExtractiveReply('Find the question that asks what a watt is.', attachments);
  assert.match(answer, /The textbook question is: “What is a watt\?”/u);
  assert.match(answer, /electrical unit of power/u);
});

test('a rejected document plan falls back to a grounded topic-by-topic schedule', () => {
  const attachments = [{ text:'[guide.txt · electric current · lines 1-3]\npipe R carries the electric current through a long hydraulic analogy that begins before this retrieved chunk and should not become the study focus.\n\nElectric current is measured in amperes.\n\n[guide.txt · What is an ohm? · lines 4-6]\nAn ohm is a resistance measured by a mercury column.\n\n[guide.txt · resistance · lines 7-9]\nResistance opposes the flow of current.\n\n[guide.txt · energy · lines 10-12]\nElectrical energy can be transformed into heat.' }];
  const answer = groundedExtractiveReply('Make a compact three-day revision plan from this book for electric current, resistance, and energy. Include one self-test question per day.', attachments);
  assert.match(answer, /Day 1 — electric current/iu);
  assert.match(answer, /Day 1[^]*Electric current is measured in amperes/iu);
  assert.doesNotMatch(answer, /pipe R carries/iu);
  assert.doesNotMatch(answer.match(/Day 1[^]*?(?=### Day 2)/iu)?.[0] || '', /mercury/iu);
  assert.match(answer, /Day 3 — energy/iu);
  assert.equal((answer.match(/Self-test:/gu) || []).length, 3);
  assert.match(answer, /Resistance opposes the flow of current/iu);
});

test('document quotations must exist verbatim in the selected local evidence', () => {
  const attachments = [{ text:'Resistance is that property of a substance that opposes the flow of electric current.' }];
  assert.deepEqual(inspectUnsupportedDocumentQuotes('The book says “Resistance is that property of a substance that opposes the flow of electric current.”', attachments), []);
  assert.equal(inspectUnsupportedDocumentQuotes('The book says “Resistance limits current by opposing electric charges.”', attachments).length, 1);
});

test('a literal reply request is extracted exactly without asking the model to paraphrase it', () => {
  assert.equal(requiredExactReply('Reply with exactly: local hello'), 'local hello');
  assert.equal(requiredExactReply('Say hello to the class.'), null);
});
