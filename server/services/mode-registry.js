const CATEGORY_ORDER = Object.freeze(['core', 'agents', 'review', 'writing', 'ideas', 'strategy', 'learning', 'coding', 'research']);

function record(id, label, category, pattern, description, focus, options = {}) {
  return Object.freeze({
    id, label, category, pattern, description, focus,
    multiAgent: Boolean(options.multiAgent),
    defaultPasses: Number(options.defaultPasses || 1),
    minimumPasses: Number(options.minimumPasses || options.defaultPasses || 1),
    maximumPasses: Number(options.maximumPasses || options.defaultPasses || 1),
    tags: Object.freeze([...(options.tags || [])]),
  });
}

const MODES = [
  // Core
  record('standard', 'Standard', 'core', 'direct', 'One direct response using the selected response controls.', 'Answer the request directly and completely.', { defaultPasses: 1, tags: ['fast'] }),
  record('fast-answer', 'Fast Answer', 'core', 'direct', 'A compact low-latency answer with no extra review pass.', 'Prioritise speed, clarity, and the minimum sufficient answer.', { defaultPasses: 1, tags: ['fast'] }),
  record('deep-answer', 'Deep Answer', 'core', 'deep', 'Draft, challenge, and revise a thorough answer.', 'Develop a careful answer, test its assumptions and completeness, then improve it.', { defaultPasses: 3, tags: ['reasoning'] }),
  record('explore', 'Explore', 'core', 'explore', 'Develop materially different approaches before choosing one.', 'Explore distinct interpretations and solution paths instead of converging immediately.', { defaultPasses: 3, tags: ['reasoning'] }),
  record('clarify-first', 'Clarify First', 'core', 'direct', 'Ask only the questions whose answers could materially change the result.', 'Identify material ambiguity and respond with a short, prioritised clarification form before attempting the task.', { defaultPasses: 1, tags: ['interactive'] }),

  // Multi-agent
  record('debate', 'Debate', 'agents', 'debate', 'Advocate, skeptic, rebuttal, and judge examine the question.', 'Build and challenge the strongest competing cases.', { multiAgent: true, defaultPasses: 4, minimumPasses: 3, maximumPasses: 21, tags: ['agents', 'reasoning'] }),
  record('council', 'Council', 'agents', 'council', 'Independent experts answer before a chair synthesises.', 'Collect independent expert judgments and combine them without erasing disagreement.', { multiAgent: true, defaultPasses: 4, minimumPasses: 3, maximumPasses: 9, tags: ['agents'] }),
  record('answer-tournament', 'Answer Tournament', 'agents', 'tournament', 'Several candidates compete against a visible rubric.', 'Generate genuinely different candidate answers, evaluate them, and combine the strongest parts.', { multiAgent: true, defaultPasses: 5, minimumPasses: 4, maximumPasses: 10, tags: ['agents', 'compare'] }),
  record('red-team', 'Red Team', 'agents', 'red-team', 'A proposal is attacked, repaired, and audited.', 'Search aggressively for failure modes, repair them, and preserve unresolved risks.', { multiAgent: true, defaultPasses: 5, minimumPasses: 4, maximumPasses: 12, tags: ['agents', 'review'] }),
  record('consensus', 'Consensus', 'agents', 'consensus', 'Independent analyses are mapped into agreement and dispute.', 'Separate consensus, conflict, unique insights, and unresolved questions.', { multiAgent: true, defaultPasses: 5, minimumPasses: 4, maximumPasses: 10, tags: ['agents'] }),
  record('perspective-panel', 'Perspective Panel', 'agents', 'perspectives', 'Technical, practical, economic, ethical, and adversarial lenses respond.', 'Examine the request through several explicitly different perspectives.', { multiAgent: true, defaultPasses: 6, minimumPasses: 4, maximumPasses: 9, tags: ['agents'] }),
  record('devils-advocate', "Devil's Advocate", 'agents', 'devil', 'Build the strongest objection and assess whether it changes the answer.', 'Challenge the apparent conclusion with the strongest plausible opposing case.', { multiAgent: true, defaultPasses: 3, minimumPasses: 3, maximumPasses: 3, tags: ['agents', 'review'] }),
  record('dialectic', 'Dialectic', 'agents', 'dialectic', 'Thesis, antithesis, and synthesis.', 'Develop a strong position, its strongest opposition, and a synthesis that resolves what it can.', { multiAgent: true, defaultPasses: 3, minimumPasses: 3, maximumPasses: 3, tags: ['agents'] }),

  // Review
  record('review', 'Review', 'review', 'audit', 'Review a draft for correctness, completeness, clarity, and requirements.', 'Identify precise issues, then produce a corrected final version.', { defaultPasses: 3, tags: ['review'] }),
  record('check-work', 'Check Work', 'review', 'audit', 'Challenge claims and distinguish computed, inferred, subjective, and unresolved content.', 'Audit the work carefully and preserve uncertainty instead of manufacturing confidence.', { defaultPasses: 3, tags: ['review', 'reasoning'] }),
  record('fact-inference-split', 'Fact–Inference Split', 'review', 'audit', 'Separate facts, calculations, inferences, assumptions, opinions, and unknowns.', 'Classify every material statement by epistemic type and revise misleading presentation.', { defaultPasses: 3, tags: ['review'] }),
  record('claim-audit', 'Claim Audit', 'review', 'audit', 'Extract claims and identify what supports or weakens each one.', 'Create a claim register, test support, and clearly mark what requires external verification.', { defaultPasses: 3, tags: ['review'] }),
  record('logic-audit', 'Logic Audit', 'review', 'audit', 'Check contradictions, implications, definitions, and missing alternatives.', 'Audit the reasoning structure and repair invalid or ambiguous logic.', { defaultPasses: 3, tags: ['review', 'reasoning'] }),
  record('requirement-audit', 'Requirement Audit', 'review', 'audit', 'Trace every requirement to the proposed result.', 'Report each requirement as met, partial, missed, or conflicting, then repair the result.', { defaultPasses: 3, tags: ['review'] }),
  record('failure-premortem', 'Failure Premortem', 'review', 'audit', 'Assume the plan failed and identify causes, signals, safeguards, and recovery.', 'Find likely failure paths before they occur and convert them into practical controls.', { defaultPasses: 3, tags: ['review', 'strategy'] }),
  record('stress-test', 'Stress Test', 'review', 'audit', 'Test a solution under tighter time, money, compute, load, and adversarial conditions.', 'Expose brittle assumptions and improve the solution under difficult scenarios.', { defaultPasses: 3, tags: ['review'] }),
  record('confidence-map', 'Confidence Map', 'review', 'audit', 'Map well-supported, uncertain, and assumption-dependent sections.', 'Explain confidence qualitatively and identify the evidence that would change it.', { defaultPasses: 3, tags: ['review'] }),

  // Writing
  record('write', 'Write', 'writing', 'direct', 'Create a polished draft from the request.', 'Write the requested artifact while respecting audience, tone, facts, and constraints.', { defaultPasses: 1, tags: ['writing'] }),
  record('rewrite', 'Rewrite', 'writing', 'transform', 'Transform existing writing while preserving intended facts.', 'Diagnose the current text, produce distinct revisions, and return the strongest revision.', { defaultPasses: 3, tags: ['writing'] }),
  record('style-studio', 'Style Studio', 'writing', 'transform', 'Create controlled stylistic variants and synthesise the strongest version.', 'Explore several deliberate styles without changing factual content.', { defaultPasses: 3, tags: ['writing', 'creative'] }),
  record('editor-room', 'Editor Room', 'writing', 'deep', 'Structural, line, audience, and final editing passes.', 'Improve organisation, clarity, voice, and audience fit while preserving meaning.', { defaultPasses: 3, tags: ['writing', 'review'] }),
  record('argument-builder', 'Argument Builder', 'writing', 'deep', 'Build a position, claims, objections, rebuttals, and conclusion.', 'Construct the strongest defensible argument and acknowledge its limits.', { defaultPasses: 3, tags: ['writing', 'reasoning'] }),
  record('story-room', 'Story Room', 'writing', 'transform', 'Develop narrative possibilities before writing the strongest version.', 'Create vivid, coherent storytelling with controlled genre, voice, pacing, and ending.', { defaultPasses: 3, tags: ['writing', 'creative'] }),
  record('naming-studio', 'Naming Studio', 'writing', 'brainstorm', 'Generate, cluster, challenge, and rank names.', 'Produce diverse naming directions and evaluate them against memorable, relevant, and practical criteria.', { defaultPasses: 4, tags: ['writing', 'ideas'] }),
  record('compression', 'Compression', 'writing', 'compress', 'Reduce material to the requested level without losing key decisions.', 'Identify the information hierarchy and produce a faithful concise version.', { defaultPasses: 2, tags: ['writing'] }),

  // Ideas
  record('brainstorm', 'Brainstorm', 'ideas', 'brainstorm', 'Generate broadly, cluster, challenge, rank, and develop finalists.', 'Produce diverse useful ideas rather than cosmetic variants.', { defaultPasses: 4, tags: ['ideas'] }),
  record('diverge-converge', 'Diverge and Converge', 'ideas', 'brainstorm', 'Explore widely before evaluating and converging.', 'Keep generation and judgment separate, then develop the best directions.', { defaultPasses: 4, tags: ['ideas'] }),
  record('wild-ideas', 'Wild Ideas', 'ideas', 'brainstorm', 'Explore unconventional possibilities while separating plausible from speculative.', 'Push beyond obvious answers without disguising fantasy as practicality.', { defaultPasses: 4, tags: ['ideas', 'creative'] }),
  record('constraint-creativity', 'Constraint Creativity', 'ideas', 'brainstorm', 'Use hard constraints as design material.', 'Generate novel options that obey every locked constraint.', { defaultPasses: 4, tags: ['ideas'] }),
  record('analogy-engine', 'Analogy Engine', 'ideas', 'explore', 'Transfer useful structures from other domains.', 'Find non-superficial analogies and test exactly where each one breaks.', { defaultPasses: 3, tags: ['ideas'] }),
  record('combination-lab', 'Combination Lab', 'ideas', 'brainstorm', 'Systematically combine existing ideas and test coherence.', 'Create combinations with a real integrated advantage rather than feature piles.', { defaultPasses: 4, tags: ['ideas'] }),
  record('opportunity-miner', 'Opportunity Miner', 'ideas', 'brainstorm', 'Find expensive, repetitive, frustrating, or underserved work.', 'Identify concrete software opportunities, users, pain, and asymmetric wedges.', { defaultPasses: 4, tags: ['ideas', 'strategy'] }),

  // Strategy
  record('decision', 'Decision', 'strategy', 'decision', 'Compare options against visible criteria and weights.', 'Make the criteria, tradeoffs, missing evidence, and recommendation explicit.', { defaultPasses: 4, tags: ['strategy'] }),
  record('decision-sensitivity', 'Decision Sensitivity', 'strategy', 'decision', 'Test whether a recommendation survives changed weights and assumptions.', 'Identify which assumptions actually control the decision.', { defaultPasses: 4, tags: ['strategy', 'reasoning'] }),
  record('scenario-planner', 'Scenario Planner', 'strategy', 'decision', 'Build optimistic, base, pessimistic, and wildcard scenarios.', 'Develop distinct plausible futures, leading indicators, and robust actions.', { defaultPasses: 4, tags: ['strategy'] }),
  record('counterfactual-lab', 'Counterfactual Lab', 'strategy', 'decision', 'Change one assumption at a time and trace what changes.', 'Separate conclusions that are robust from those dependent on fragile assumptions.', { defaultPasses: 4, tags: ['strategy', 'reasoning'] }),
  record('strategy-room', 'Strategy Room', 'strategy', 'council', 'Strategist, operator, customer, competitor, investor, and critic perspectives.', 'Produce a strategy that survives operational, market, and adversarial scrutiny.', { multiAgent: true, defaultPasses: 6, minimumPasses: 4, maximumPasses: 9, tags: ['strategy', 'agents'] }),
  record('roadmap', 'Roadmap', 'strategy', 'decision', 'Build phases, dependencies, checkpoints, decision gates, and exit conditions.', 'Turn the goal into an ordered, testable path with explicit dependencies.', { defaultPasses: 4, tags: ['strategy'] }),
  record('prioritise', 'Prioritise', 'strategy', 'decision', 'Rank work by impact, effort, urgency, risk, reversibility, and custom criteria.', 'Produce a defensible order of operations and explain tradeoffs.', { defaultPasses: 4, tags: ['strategy'] }),
  record('negotiation', 'Negotiation', 'strategy', 'deep', 'Map objectives, BATNA, concessions, red lines, and response branches.', 'Prepare a practical negotiation strategy for both parties and likely branches.', { defaultPasses: 3, tags: ['strategy'] }),

  // Learning
  record('tutor', 'Tutor', 'learning', 'learning', 'Teach adaptively with explanation, examples, and a check for understanding.', 'Teach the requested concept at the selected level and invite active recall.', { defaultPasses: 3, tags: ['learning'] }),
  record('socratic-tutor', 'Socratic Tutor', 'learning', 'direct', 'Guide discovery with focused questions rather than immediately lecturing.', 'Ask one useful question at a time, give hints before solutions, and avoid unnecessary exposition.', { defaultPasses: 1, tags: ['learning', 'interactive'] }),
  record('explain-levels', 'Explain at Levels', 'learning', 'explore', 'Explain for child, beginner, practitioner, and expert audiences.', 'Show how the same concept changes in depth and vocabulary across levels.', { defaultPasses: 3, tags: ['learning'] }),
  record('study-guide', 'Study Guide', 'learning', 'learning', 'Create objectives, concepts, examples, practice, and revision structure.', 'Build a complete study guide that prioritises understanding and retrieval practice.', { defaultPasses: 3, tags: ['learning'] }),
  record('examiner', 'Examiner', 'learning', 'direct', 'Ask a question and grade the next response using a visible rubric.', 'Act as a fair examiner: present one question, the rubric, and no solution until the learner answers.', { defaultPasses: 1, tags: ['learning', 'interactive'] }),
  record('flashcard-builder', 'Flashcard Builder', 'learning', 'transform', 'Create, deduplicate, and improve active-recall cards.', 'Produce concise question-answer cards that test one idea each.', { defaultPasses: 3, tags: ['learning'] }),
  record('misconception-hunter', 'Misconception Hunter', 'learning', 'audit', 'Predict and contrast likely misunderstandings.', 'Identify tempting wrong models, explain why they fail, and replace them with correct mental models.', { defaultPasses: 3, tags: ['learning', 'review'] }),
  record('teach-back', 'Teach Back', 'learning', 'direct', 'Ask the user to explain and then diagnose gaps on the next turn.', 'Prompt the learner to teach the concept back using a compact diagnostic rubric.', { defaultPasses: 1, tags: ['learning', 'interactive'] }),

  // Coding
  record('code', 'Code', 'coding', 'direct', 'Implement the requested code with the selected explanation level.', 'Produce usable code that respects the stated environment, constraints, and error handling.', { defaultPasses: 1, tags: ['coding'] }),
  record('code-architect', 'Code Architect', 'coding', 'coding', 'Design modules, interfaces, state flow, invariants, and implementation order.', 'Build a concrete architecture before implementation and identify failure boundaries.', { defaultPasses: 4, tags: ['coding'] }),
  record('debug', 'Debug', 'coding', 'coding', 'Reproduce, hypothesise, narrow, fix, and check regressions.', 'Diagnose the root cause instead of applying a cosmetic patch.', { defaultPasses: 4, tags: ['coding', 'review'] }),
  record('code-review', 'Code Review', 'coding', 'audit', 'Review correctness, security, performance, maintainability, and tests.', 'Find concrete defects with evidence and propose minimal safe repairs.', { defaultPasses: 3, tags: ['coding', 'review'] }),
  record('refactor', 'Refactor', 'coding', 'coding', 'Preserve behaviour while improving a selected quality.', 'State the behaviour contract, design the refactor, and verify likely regressions.', { defaultPasses: 4, tags: ['coding'] }),
  record('test-builder', 'Test Builder', 'coding', 'coding', 'Design unit, integration, property, fuzz, and failure-injection tests.', 'Create a test strategy that targets contracts and likely failure modes.', { defaultPasses: 4, tags: ['coding', 'review'] }),
  record('adversarial-code-review', 'Adversarial Code Review', 'coding', 'red-team', 'Independent reviewers attack the implementation before synthesis.', 'Search for correctness, security, concurrency, compatibility, and test weaknesses.', { multiAgent: true, defaultPasses: 5, minimumPasses: 4, maximumPasses: 12, tags: ['coding', 'agents'] }),
  record('patch-tournament', 'Patch Tournament', 'coding', 'tournament', 'Generate competing patches, evaluate risk, and select one.', 'Produce materially different repair strategies and choose the safest contract-preserving option.', { multiAgent: true, defaultPasses: 5, minimumPasses: 4, maximumPasses: 10, tags: ['coding', 'agents'] }),
  record('explain-code', 'Explain Code', 'coding', 'learning', 'Explain overview, data flow, state, edge cases, and risks.', 'Make the code understandable without inventing behaviour not visible in the supplied source.', { defaultPasses: 3, tags: ['coding', 'learning'] }),
  record('spec-to-code', 'Spec to Code', 'coding', 'coding', 'Lock requirements, design, implement, review, and trace.', 'Turn the specification into an implementation plan and code with requirement traceability.', { defaultPasses: 4, tags: ['coding'] }),

  // Research
  record('research', 'Research', 'research', 'research', 'Decompose, examine supplied evidence, compare, and synthesise.', 'Research using available context and sources; distinguish evidence from inference.', { defaultPasses: 4, tags: ['research'] }),
  record('literature-map', 'Literature Map', 'research', 'research', 'Organise supplied sources by approach, evidence, date, and disagreement.', 'Map the intellectual landscape and identify gaps without inventing sources.', { defaultPasses: 4, tags: ['research'] }),
  record('evidence-table', 'Evidence Table', 'research', 'research', 'Build claims, supporting evidence, contradiction, and confidence.', 'Create an auditable evidence table grounded only in available material.', { defaultPasses: 4, tags: ['research', 'review'] }),
  record('compare-sources', 'Compare Sources', 'research', 'research', 'Find consensus, conflict, methodological differences, and missing evidence.', 'Compare the supplied sources accurately and preserve important disagreement.', { defaultPasses: 4, tags: ['research'] }),
  record('question-decomposer', 'Question Decomposer', 'research', 'explore', 'Turn a broad question into a structured research programme.', 'Create prioritised subquestions, dependencies, and evidence requirements.', { defaultPasses: 3, tags: ['research'] }),
  record('unknowns-first', 'Unknowns First', 'research', 'audit', 'Begin with what is unknown and what information has highest value.', 'Identify uncertainty and the next evidence that would most improve the answer.', { defaultPasses: 3, tags: ['research', 'review'] }),
];

const INDEX = new Map(MODES.map(mode => [mode.id, mode]));

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

export function normalizeModeSettings(input = {}) {
  return {
    participants: boundedInteger(input.participants, 3, 2, 8),
    rounds: boundedInteger(input.rounds, 1, 1, 5),
    candidateCount: boundedInteger(input.candidateCount, 3, 2, 8),
    showStages: input.showStages !== false,
    execution: String(input.execution) === 'parallel' ? 'parallel' : 'sequential',
    judgeStyle: ['balanced', 'strict', 'practical', 'evidence-first'].includes(String(input.judgeStyle)) ? String(input.judgeStyle) : 'balanced',
    customRoles: Array.isArray(input.customRoles) ? input.customRoles.slice(0, 8).map(value => String(value || '').trim().slice(0, 80)).filter(Boolean) : [],
    targetIds: Array.isArray(input.targetIds) ? input.targetIds.slice(0, 8).map(value => String(value || '').trim().slice(0, 180)).filter(Boolean) : [],
    judgeTargetId: input.judgeTargetId ? String(input.judgeTargetId).trim().slice(0, 180) : null,
    restoreTargetAfterRun: input.restoreTargetAfterRun !== false,
  };
}

export function getMode(id = 'standard') { return INDEX.get(String(id)) || INDEX.get('standard'); }
export function hasMode(id) { return INDEX.has(String(id)); }
export function listModes() {
  return {
    version: 2,
    categories: CATEGORY_ORDER.map(id => ({ id, label: ({ core: 'Core', agents: 'Agents', review: 'Review', writing: 'Writing', ideas: 'Ideas', strategy: 'Strategy', learning: 'Learning', coding: 'Coding', research: 'Research' })[id] })),
    modes: MODES.map(({ focus: _focus, ...mode }) => ({ ...mode })),
  };
}

export function validateModeRegistry() {
  const ids = new Set();
  for (const mode of MODES) {
    if (!/^[a-z0-9-]+$/u.test(mode.id) || ids.has(mode.id)) throw new Error(`Invalid duplicate mode id ${mode.id}`);
    ids.add(mode.id);
    if (!mode.label || !mode.category || !mode.pattern || !mode.focus) throw new Error(`Incomplete mode metadata ${mode.id}`);
  }
  return { modes: MODES.length, categories: CATEGORY_ORDER.length, schemaVersion: 2 };
}

export function modeProfileSystemMessage(id='standard') {
  const mode=getMode(id);if(!mode||mode.id==='standard'||mode.multiAgent)return null;
  return {role:'system',content:`Response mode: ${mode.label}\n${mode.focus}\nThis is a one-pass response profile. Do not pretend multiple agents or stages ran.`};
}
