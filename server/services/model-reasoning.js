const LEVELS = Object.freeze(['off', 'quick', 'standard', 'deep']);
const DEFAULT_BUDGETS = Object.freeze({ off: 0, quick: 256, standard: 640, deep: 1200 });

export const REASONING_LEVELS = LEVELS;

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 4096 ? parsed : fallback;
}

export function normalizeReasoningControl(entry = {}) {
  const raw = entry?.reasoningControl;
  if (!raw || raw.enabled !== true) {
    return { enabled: false, style: 'none', defaultLevel: 'off', startsInReasoning: false, levels: { ...DEFAULT_BUDGETS }, description: '' };
  }
  const levels = {};
  for (const level of LEVELS) levels[level] = integer(raw.levels?.[level], DEFAULT_BUDGETS[level]);
  levels.off = 0;
  const defaultLevel = LEVELS.includes(raw.defaultLevel) ? raw.defaultLevel : 'standard';
  return {
    enabled: true,
    style: ['hybrid', 'deliberate'].includes(raw.style) ? raw.style : 'deliberate',
    defaultLevel,
    startsInReasoning: Boolean(raw.startsInReasoning),
    levels,
    description: String(raw.description || 'Choose how much reasoning the model may use before its final answer.'),
  };
}

export function normalizeReasoningRequest(raw, control) {
  const normalized = normalizeReasoningControl({ reasoningControl: control });
  if (!normalized.enabled) return { supported: false, enabled: false, level: 'off', budgetTokens: 0, startsInReasoning: false, style: 'none' };
  const requested = typeof raw === 'string' ? raw : raw?.level;
  const level = LEVELS.includes(requested) ? requested : normalized.defaultLevel;
  return {
    supported: true,
    enabled: level !== 'off',
    level,
    budgetTokens: normalized.levels[level],
    startsInReasoning: level !== 'off' && normalized.startsInReasoning,
    style: normalized.style,
  };
}

function trailingTagPrefixLength(value, tag) {
  const max = Math.min(value.length, tag.length - 1);
  for (let length = max; length > 0; length -= 1) if (value.endsWith(tag.slice(0, length))) return length;
  return 0;
}

export function createReasoningDeltaRouter({ startsInReasoning = false, onReasoning = async () => {}, onContent = async () => {} } = {}) {
  let state = startsInReasoning ? 'reasoning' : 'content';
  let pending = '';
  let structuredReasoningSeen = false;
  let inCodeSpan = false;

  function codeStateAfter(value, initial = inCodeSpan) {
    let next = initial;
    for (const char of String(value || '')) if (char === '`') next = !next;
    return next;
  }
  async function emit(value) {
    const text = String(value || '');
    if (!text) return;
    if (state === 'reasoning') await onReasoning(text);
    else await onContent(text);
    inCodeSpan = codeStateAfter(text);
  }
  function usableTagIndex(tag) {
    let code = inCodeSpan;
    for (let index = 0; index <= pending.length - tag.length; index += 1) {
      const char = pending[index];
      if (char === '`') { code = !code; continue; }
      if (!code && pending.startsWith(tag, index)) return index;
    }
    return -1;
  }
  async function routeTagged(chunk) {
    pending += String(chunk || '');
    while (pending) {
      const tag = state === 'reasoning' ? '</think>' : '<think>';
      const index = usableTagIndex(tag);
      if (index >= 0) {
        const before = pending.slice(0, index);
        pending = pending.slice(index + tag.length);
        await emit(before);
        state = state === 'reasoning' ? 'content' : 'reasoning';
        inCodeSpan = false;
        continue;
      }
      const keep = trailingTagPrefixLength(pending, tag);
      const safe = pending.slice(0, pending.length - keep);
      pending = pending.slice(pending.length - keep);
      await emit(safe);
      return;
    }
  }
  async function push({ reasoning = '', content = '' } = {}) {
    if (reasoning) {
      if (pending) { await emit(pending); pending = ''; }
      structuredReasoningSeen = true;
      await onReasoning(String(reasoning));
    }
    if (!content) return;
    if (structuredReasoningSeen) await onContent(String(content));
    else await routeTagged(String(content));
  }
  async function flush() {
    if (!pending) return;
    const value = pending; pending = '';
    await emit(value);
  }
  return { push, flush, state: () => state };
}
