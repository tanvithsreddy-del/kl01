export const DEFAULT_RESPONSE_PROFILE = Object.freeze({
  version: 6,
  effort: 2,
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

const RESEARCH_STRATEGIES = new Set(['inherit', 'balanced', 'diverse', 'source-first']);
const LEGACY_SOURCE_LENSES = new Set(['inherit', 'balanced', 'primary-first', 'diverse']);
function canonicalResearchStrategy(inputResearch = {}) {
  if (RESEARCH_STRATEGIES.has(String(inputResearch.strategy))) return String(inputResearch.strategy);
  const legacy = LEGACY_SOURCE_LENSES.has(String(inputResearch.sourceLens)) ? String(inputResearch.sourceLens) : 'inherit';
  return legacy === 'primary-first' ? 'source-first' : legacy;
}

export function cloneResponseProfile(profile = DEFAULT_RESPONSE_PROFILE) {
  const response = profile?.response || {};
  const inputResearch = profile?.research && typeof profile.research === 'object' ? profile.research : {};
  const strategy = canonicalResearchStrategy(inputResearch);
  const rawEffort = Math.round(Number(profile?.effort ?? DEFAULT_RESPONSE_PROFILE.effort) || 0);
  const effort = Number(profile?.version || 0) >= 6
    ? Math.min(3, Math.max(0, rawEffort))
    : rawEffort <= 0 ? 0 : rawEffort <= 2 ? 1 : rawEffort <= 4 ? 2 : 3;
  return {
    version: 6,
    effort,
    modeId: 'standard',
    context: { ...DEFAULT_RESPONSE_PROFILE.context, ...(profile?.context || {}), selectedMessageIds: [...(profile?.context?.selectedMessageIds || [])] },
    research: {
      mode: ['auto','off','force'].includes(String(inputResearch.mode)) ? String(inputResearch.mode) : 'auto',
      strategy,
    },
    workflow: { definition: null, recipeId: null, slotTargets: {} },
    response: {
      ...DEFAULT_RESPONSE_PROFILE.response,
      ...response,
      sampling: { ...DEFAULT_RESPONSE_PROFILE.response.sampling, ...(response.sampling || {}) },
    },
  };
}

export function responseProfileSummary(profile, { reasoningSupported = false, modes = [] } = {}) {
  const normalized = cloneResponseProfile(profile);
  const effortLabels = ['Instant','Quick','Thorough','Deep'];
  if (normalized.research.mode === 'off') return `${effortLabels[Math.min(normalized.effort, 1)]} · Web off`;
  if (normalized.effort !== 2) return effortLabels[normalized.effort];
  const value = cloneResponseProfile(profile).response;
  const labels = [];
  if (reasoningSupported && !['standard', 'adaptive'].includes(value.thinking)) labels.push(value.thinking === 'off' ? 'No thinking' : `${value.thinking[0].toUpperCase()}${value.thinking.slice(1)} thinking`);
  if (value.length !== 'normal') labels.push(value.length[0].toUpperCase() + value.length.slice(1));
  if (value.creativity !== 'balanced') labels.push(value.creativity[0].toUpperCase() + value.creativity.slice(1));
  if (value.format !== 'auto') labels.push(value.format.replaceAll('-', ' '));
  const research = cloneResponseProfile(profile).research;
  if (research.mode === 'force') labels.push('Research on');
  else if (research.mode === 'off') labels.push('Research off');
  const toggles = ['includeAssumptions','includeAlternatives','includeCounterarguments','executiveSummary','endChecklist'].filter(key => value[key]).length;
  if (toggles) labels.push(`+${toggles}`);
  return labels.length ? labels.slice(0, 2).join(' · ') : 'Thorough';
}

export function reasoningPayload(profile, { reasoningSupported = false } = {}) {
  if (!reasoningSupported) return null;
  const selected = cloneResponseProfile(profile).response.thinking;
  if (selected === 'maximum') return { level: 'deep' };
  if (selected === 'adaptive') return { level: 'standard' };
  return { level: selected };
}

export function groundingWarning(profile = {}) {
  const normalized = cloneResponseProfile(profile);
  if (normalized.research.mode === 'off') return { kind:'web-off', title:'Web search is off', message:'Factual answers cannot be verified. Effort is limited to Quick and hallucinations are more likely.' };
  if (normalized.effort === 0) return { kind:'instant', title:'Instant mode is high risk', message:'Deliberate checking is disabled. Web search still runs for facts, but small local models may still misread evidence.' };
  return null;
}
