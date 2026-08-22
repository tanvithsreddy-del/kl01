export const CONSERVATIVE_CUTOFF_YEAR = 2024;

const CAUTIONS = Object.freeze({
  current: 'Current information: you cannot know this from training alone. Say that plainly and do not invent an update.',
  statistic: 'Specific statistic: give a precise world figure only when you are certain it is in your training; otherwise say you do not know.',
  realtime: 'Current data: you cannot know live prices, scores, or availability. Say so rather than guessing.',
  personal: 'Personal detail: use only what appears in this conversation or the supplied user facts. Do not guess.',
});

const CURRENT_WORDS = /\b(?:today|latest|recent|recently|this\s+week|this\s+month|this\s+year|as\s+of|right\s+now|currently)\b/iu;
const CURRENT_ROLE = /\bcurrent\s+(?:president|prime\s+minister|ceo|leader|version|price|score|status|availability|rate|population)\b/iu;
const CURRENT_META = /(?:\bwhat\s+does\s+(?:today|latest|recent|recently|currently)\s+mean\b|\bdefine\s+(?:today|latest|recent|recently|currently)\b|\buse\s+the\s+(?:word|phrase)\s+(?:today|latest|recent|recently|currently)\b|\b(?:word|phrase)\s+(?:today|latest|recent|recently|currently)\b[^?.!]{0,48}\b(?:mean|definition|fictional\s+sentence)\b)/iu;
const STATISTIC_REQUEST = /\b(?:exactly\s+how\s+many|how\s+many\s+(?:people|users|students|households|companies|countries|cases|deaths|births|employees|residents|visitors|downloads|votes)|what\s+percentage\s+(?:of\s+)?(?:people|users|students|households|companies|countries|employees|residents|voters)|(?:exact|precise)\s+(?:world\s+)?(?:figure|number|rate|percentage|count))\b/iu;
const REALTIME_NOUN = /\b(?:price|prices|score|scores|availability|in\s+stock|exchange\s+rate|market\s+price|traffic|flight\s+status)\b/iu;
const REALTIME_FRAME = /\b(?:today|now|current|latest|live|right\s+now|tonight|this\s+evening|tomorrow|available|in\s+stock)\b/iu;
const REALTIME_QUESTION = /\b(?:what(?:'s|\s+is)|how\s+much|tell\s+me|check|give\s+me)\b[^?.!]{0,64}\b(?:price|score|availability|exchange\s+rate|traffic|flight\s+status)\b/iu;
const REALTIME_CONCEPT = /\b(?:price\s+elasticity|flight\s+status\s+code|traffic\s+flow\s+theory|product\s+availability|exchange\s+rate\s+(?:work|works)|wholesale\s+prices?\s+conceptually)\b/iu;
const REALTIME_META = /(?:\bwhat\s+does\s+(?:in\s+stock|availability|score|price|exchange\s+rate)\s+mean\b|\bdefine\s+(?:in\s+stock|availability|score|price|exchange\s+rate)\b)/iu;
const PERSONAL_REQUEST = /\b(?:what(?:'s|\s+is)|who(?:'s|\s+is)|where(?:'s|\s+is)|when(?:'s|\s+is)|do\s+you\s+know|tell\s+me|remind\s+me)\s+(?:about\s+)?my\b/iu;
const PERSONAL_ATTRIBUTE = /\bmy\s+(?:name|birthday|birthdate|age|address|phone|email|school|college|job|employer|city|hometown|favourite|favorite)\b/iu;
const PERSONAL_STATEMENT = /\b(?:my\s+(?:name|birthday|birthdate|age|address|phone|email|school|college|job|employer|city|hometown)\s+(?:is|are)|my\s+(?:favourite|favorite)\s+[\p{L}\p{N}_ -]{1,40}\s+(?:is|are)|i\s+(?:live|study|work)\s+(?:in|at|for))\b/iu;

function cutoffYearSignal(text) {
  for (const match of String(text || '').matchAll(/\b(19\d{2}|20\d{2}|21\d{2})\b/gu)) {
    if (Number(match[1]) >= CONSERVATIVE_CUTOFF_YEAR) return match[1];
  }
  return null;
}

function priorText(priorMessages = []) {
  return priorMessages
    .filter(message => message?.role === 'user')
    .map(message => String(message.content || ''))
    .join('\n');
}

export function scanBoundary(text, { priorMessages = [], deterministic = false } = {}) {
  const source = String(text || '').normalize('NFC');
  const matches = [];
  const year = cutoffYearSignal(source);
  const currentLanguage = !CURRENT_META.test(source) && (CURRENT_WORDS.test(source) || CURRENT_ROLE.test(source));
  if (!deterministic && (currentLanguage || year)) matches.push({ category: 'current', signal: year ? `year:${year}` : 'current-language', caution: CAUTIONS.current });
  if (!deterministic && STATISTIC_REQUEST.test(source)) matches.push({ category: 'statistic', signal: 'specific-world-figure', caution: CAUTIONS.statistic });
  const realtimeMeta = REALTIME_META.test(source);
  const explicitRealtimeFrame = REALTIME_FRAME.test(source) && !realtimeMeta;
  const realtimeQuestion = REALTIME_QUESTION.test(source) && !REALTIME_CONCEPT.test(source) && !realtimeMeta;
  if (REALTIME_NOUN.test(source) && (explicitRealtimeFrame || realtimeQuestion)) matches.push({ category: 'realtime', signal: 'live-data-request', caution: CAUTIONS.realtime });
  if (!PERSONAL_STATEMENT.test(source) && (PERSONAL_REQUEST.test(source) || PERSONAL_ATTRIBUTE.test(source)) && !PERSONAL_STATEMENT.test(priorText(priorMessages))) matches.push({ category: 'personal', signal: 'unsupplied-personal-detail', caution: CAUTIONS.personal });
  return { matches };
}

export function boundarySystemMessage(scan) {
  if (!scan?.matches?.length) return null;
  return { role: 'system', content: `Caution for this request:\n${scan.matches.map(item => `- ${item.caution}`).join('\n')}` };
}

export function boundaryPatterns() {
  return {
    current: `${CURRENT_WORDS} OR ${CURRENT_ROLE}; suppressed for metalinguistic uses matching ${CURRENT_META}`,
    cutoffYear: `year >= ${CONSERVATIVE_CUTOFF_YEAR}`,
    statistic: String(STATISTIC_REQUEST),
    realtimeNoun: String(REALTIME_NOUN),
    realtimeFrame: String(REALTIME_FRAME),
    realtimeQuestion: `${REALTIME_QUESTION}; conceptual uses matching ${REALTIME_CONCEPT} and metalinguistic uses matching ${REALTIME_META} do not trigger without an explicit live-data frame`,
    personalRequest: String(PERSONAL_REQUEST),
    personalAttribute: String(PERSONAL_ATTRIBUTE),
    personalPriorStatement: String(PERSONAL_STATEMENT),
  };
}
