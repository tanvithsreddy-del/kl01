import { DEFAULT_EFFORT_LEVEL, EFFORT_PROFILE_VERSION, effortPolicy, migrateLegacyEffort } from './effort-policy.js';
const ENUMS = Object.freeze({
  thinking: new Set(['off', 'quick', 'standard', 'deep', 'maximum', 'adaptive']),
  length: new Set(['tiny', 'concise', 'normal', 'detailed', 'exhaustive', 'custom']),
  creativity: new Set(['deterministic', 'precise', 'balanced', 'creative', 'experimental', 'custom']),
  construction: new Set(['direct', 'explanation-first', 'step-by-step', 'examples-first', 'socratic', 'explore-alternatives']),
  format: new Set(['auto', 'prose', 'bullets', 'outline', 'procedure', 'table', 'matrix', 'faq', 'tutorial', 'report', 'memo', 'specification', 'json', 'yaml', 'markdown', 'html', 'code-only', 'diff']),
  audience: new Set(['general', 'beginner', 'practitioner', 'expert', 'executive', 'child', 'teacher', 'investor', 'customer', 'developer', 'researcher']),
  tone: new Set(['neutral', 'friendly', 'formal', 'persuasive', 'critical', 'encouraging', 'academic', 'technical', 'playful']),
  clarification: new Set(['ask-important', 'state-assumptions', 'proceed', 'never-ask']),
});

export const DEFAULT_EXECUTION_PROFILE = Object.freeze({
  version: EFFORT_PROFILE_VERSION,
  effort: DEFAULT_EFFORT_LEVEL,
  modeId: 'standard',
  context: Object.freeze({ scope: 'compressed', recentMessages: 12, includeAttachments: true, allocation: 'automatic', conversationPercent: 35, attachmentsPercent: 40, stagesPercent: 15, answerReservePercent: 10, selectedMessageIds: Object.freeze([]) }),
  research: Object.freeze({ mode: 'auto', strategy: 'inherit' }),
  workflow: Object.freeze({ definition: null, recipeId: null, slotTargets: Object.freeze({}) }),
  response: Object.freeze({
    thinking: 'standard',
    length: 'normal',
    creativity: 'balanced',
    construction: 'direct',
    format: 'auto',
    audience: 'general',
    tone: 'neutral',
    clarification: 'ask-important',
    includeAssumptions: false,
    includeAlternatives: false,
    includeCounterarguments: false,
    includeLimitations: true,
    executiveSummary: false,
    endChecklist: false,
    maxTokens: null,
    sampling: Object.freeze({ temperature: null, topP: null, topK: null, minP: null, repeatPenalty: null, seed: null }),
  }),
});

function enumValue(group, value, fallback) { return ENUMS[group].has(String(value)) ? String(value) : fallback; }
function finite(value, min, max, fallback = null) {
  if (value === '' || value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
function boolean(value, fallback = false) { return value == null ? fallback : Boolean(value); }

const RESEARCH_STRATEGIES = new Set(['inherit', 'balanced', 'diverse', 'source-first']);
const LEGACY_SOURCE_LENSES = new Set(['inherit', 'balanced', 'primary-first', 'diverse']);
function canonicalResearchStrategy(inputResearch = {}) {
  if (RESEARCH_STRATEGIES.has(String(inputResearch.strategy))) return String(inputResearch.strategy);
  const legacy = LEGACY_SOURCE_LENSES.has(String(inputResearch.sourceLens)) ? String(inputResearch.sourceLens) : 'inherit';
  return legacy === 'primary-first' ? 'source-first' : legacy;
}

export function normalizeExecutionProfile(input = {}, { reasoningSupported = false } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const response = source.response && typeof source.response === 'object' ? source.response : {};
  const defaults = DEFAULT_EXECUTION_PROFILE.response;
  const effort = source.effort == null ? DEFAULT_EFFORT_LEVEL : migrateLegacyEffort(source.effort, source.version);
  const policy = effortPolicy(effort, { webEnabled: source.research?.mode !== 'off' });
  const thinking = reasoningSupported ? policy.thinking : 'off';
  const inputResearch = source.research && typeof source.research === 'object' ? source.research : {};
  const strategy = canonicalResearchStrategy(inputResearch);
  return {
    version: EFFORT_PROFILE_VERSION,
    effort,
    modeId: 'standard',
    context: {
      scope: ['compressed','full-original','recent','pinned','selected','none'].includes(String(source.context?.scope)) ? String(source.context.scope) : 'compressed',
      recentMessages: Math.round(finite(source.context?.recentMessages, 2, 100, 12)),
      includeAttachments: boolean(source.context?.includeAttachments, true),
      allocation: source.context?.allocation === 'custom' ? 'custom' : 'automatic',
      conversationPercent: Math.round(finite(source.context?.conversationPercent, 0, 100, 35)),
      attachmentsPercent: Math.round(finite(source.context?.attachmentsPercent, 0, 100, 40)),
      stagesPercent: Math.round(finite(source.context?.stagesPercent, 0, 100, 15)),
      answerReservePercent: Math.round(finite(source.context?.answerReservePercent, 5, 80, 10)),
      selectedMessageIds: Array.isArray(source.context?.selectedMessageIds) ? source.context.selectedMessageIds.slice(0,100).map(String) : [],
    },
    research: {
      mode: ['auto','off','force'].includes(String(inputResearch.mode)) ? String(inputResearch.mode) : 'auto',
      strategy,
    },
    workflow: { definition:null, recipeId:null, slotTargets:{} },
    response: {
      thinking,
      length: enumValue('length', response.length, defaults.length),
      creativity: enumValue('creativity', response.creativity, defaults.creativity),
      construction: enumValue('construction', response.construction, defaults.construction),
      format: enumValue('format', response.format, defaults.format),
      audience: enumValue('audience', response.audience, defaults.audience),
      tone: enumValue('tone', response.tone, defaults.tone),
      clarification: enumValue('clarification', response.clarification, defaults.clarification),
      includeAssumptions: boolean(response.includeAssumptions, defaults.includeAssumptions),
      includeAlternatives: boolean(response.includeAlternatives, defaults.includeAlternatives),
      includeCounterarguments: boolean(response.includeCounterarguments, defaults.includeCounterarguments),
      includeLimitations: boolean(response.includeLimitations, defaults.includeLimitations),
      executiveSummary: boolean(response.executiveSummary, defaults.executiveSummary),
      endChecklist: boolean(response.endChecklist, defaults.endChecklist),
      maxTokens: finite(response.maxTokens, 64, 32768, null),
      sampling: {
        temperature: finite(response.sampling?.temperature, 0, 2, null),
        topP: finite(response.sampling?.topP, 0.01, 1, null),
        topK: finite(response.sampling?.topK, 0, 200, null),
        minP: finite(response.sampling?.minP, 0, 1, null),
        repeatPenalty: finite(response.sampling?.repeatPenalty, 0.5, 2, null),
        seed: finite(response.sampling?.seed, -1, 2147483647, null),
      },
    },
  };
}

const LENGTH_TOKENS = Object.freeze({ tiny: 128, concise: 320, normal: 768, detailed: 1536, exhaustive: 3072 });
const CREATIVE_SAMPLING = Object.freeze({
  deterministic: { temperature: 0.1, topP: 0.8 },
  precise: { temperature: 0.25, topP: 0.88 },
  balanced: { temperature: 0.6, topP: 0.95 },
  creative: { temperature: 0.9, topP: 0.97 },
  experimental: { temperature: 1.15, topP: 0.99 },
});

export function responseRuntimeOptions(profile) {
  const response = profile.response;
  const samplingPreset = CREATIVE_SAMPLING[response.creativity] || CREATIVE_SAMPLING.balanced;
  const custom = response.sampling || {};
  return {
    maxTokens: response.maxTokens || LENGTH_TOKENS[response.length] || LENGTH_TOKENS.normal,
    sampling: {
      temperature: custom.temperature ?? samplingPreset.temperature,
      topP: custom.topP ?? samplingPreset.topP,
      topK: custom.topK,
      minP: custom.minP,
      repeatPenalty: custom.repeatPenalty,
      seed: custom.seed,
    },
  };
}

export function responseProfileSystemMessage(profile) {
  const response = profile.response;
  const instructions = ['Follow explicit output constraints exactly, including requested literal text, line counts, and formats.', 'Never present model memory as verified evidence. Use deterministic tool results and the supplied verified research packet for factual claims; clearly separate sourced facts, calculations, inference, opinion, and unresolved uncertainty.', 'For education, early-career, software, and India-specific questions, prefer practical next steps, explain jargon plainly, preserve important dates and eligibility conditions, and distinguish official rules from advice.'];
  if (response.length !== 'normal') {
    const length = {
      tiny: 'Answer in the fewest words that still satisfy the request.',
      concise: 'Be concise and omit nonessential background.',
      detailed: 'Give a detailed answer with useful explanation and examples.',
      exhaustive: 'Be comprehensive, covering important edge cases and tradeoffs.',
      custom: 'Respect the configured output-token ceiling.',
    }[response.length];
    if (length) instructions.push(length);
  }
  if (response.construction !== 'direct') {
    const construction = {
      'explanation-first': 'Build the explanation before presenting the conclusion.',
      'step-by-step': 'Organize the response as a clear ordered sequence.',
      'examples-first': 'Begin with a concrete example, then generalize.',
      socratic: 'Guide the user with focused questions where that materially helps; do not withhold a necessary answer.',
      'explore-alternatives': 'Explore multiple materially different approaches before recommending one.',
    }[response.construction];
    if (construction) instructions.push(construction);
  }
  if (response.format !== 'auto') instructions.push(`Use ${response.format.replaceAll('-', ' ')} as the primary output format.`);
  if (response.audience !== 'general') instructions.push(`Write for a ${response.audience} audience.`);
  if (response.tone !== 'neutral') instructions.push(`Use a ${response.tone} tone.`);
  if (response.clarification === 'state-assumptions') instructions.push('Do not pause for clarification; state material assumptions before proceeding.');
  if (response.clarification === 'proceed') instructions.push('Make reasonable assumptions and proceed without asking follow-up questions.');
  if (response.clarification === 'never-ask') instructions.push('Do not ask follow-up questions.');
  if (response.includeAssumptions) instructions.push('Include a distinct assumptions section when assumptions are material.');
  if (response.includeAlternatives) instructions.push('Include meaningful alternatives and when each is preferable.');
  if (response.includeCounterarguments) instructions.push('Include the strongest relevant counterargument or objection.');
  if (!response.includeLimitations) instructions.push('Do not add a separate limitations section unless it is essential to avoid a misleading answer.');
  if (response.executiveSummary) instructions.push('Begin with a compact executive summary.');
  if (response.endChecklist) instructions.push('End with an actionable checklist when the request permits one.');
  return instructions.length ? { role: 'system', content: `Response profile for this message:\n- ${instructions.join('\n- ')}` } : null;
}
