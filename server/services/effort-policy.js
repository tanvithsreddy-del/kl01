export const EFFORT_PROFILE_VERSION = 6;
export const DEFAULT_EFFORT_LEVEL = 2;

// Beta deliberately keeps one execution path. Effort changes bounded research
// and reasoning depth; it never expands into a multi-pass workflow graph.
export const EFFORT_LEVELS = Object.freeze([
  Object.freeze({ level:0, id:'instant', label:'Instant', description:'Minimal reasoning, with web evidence still required for factual claims.', thinking:'off', modeId:'standard', maxQueries:3, maxPages:2, maxRounds:1, noGainTolerance:1, maxDurationMs:45_000 }),
  Object.freeze({ level:1, id:'quick', label:'Quick', description:'A concise sourced answer with a small verification pass.', thinking:'quick', modeId:'standard', maxQueries:4, maxPages:3, maxRounds:2, noGainTolerance:1, maxDurationMs:75_000 }),
  Object.freeze({ level:2, id:'thorough', label:'Thorough', description:'Recommended default: focused evidence and careful synthesis.', thinking:'standard', modeId:'standard', maxQueries:6, maxPages:4, maxRounds:3, noGainTolerance:2, maxDurationMs:120_000 }),
  Object.freeze({ level:3, id:'deep', label:'Deep', description:'More analysis over a still-bounded evidence packet.', thinking:'deep', modeId:'standard', maxQueries:8, maxPages:5, maxRounds:3, noGainTolerance:2, maxDurationMs:180_000, preBeta:true }),
]);

export function migrateLegacyEffort(value, version = EFFORT_PROFILE_VERSION) {
  const number=Number(value);
  if(!Number.isFinite(number))return DEFAULT_EFFORT_LEVEL;
  if(Number(version||0)>=EFFORT_PROFILE_VERSION)return Math.min(3,Math.max(0,Math.round(number)));
  if(number<=0)return 0;
  if(number<=2)return 1;
  if(number<=4)return 2;
  return 3;
}

export function normalizeEffortLevel(value, fallback = DEFAULT_EFFORT_LEVEL) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(3, Math.max(0, Math.round(number))) : fallback;
}

export function effortPolicy(value, { webEnabled = true } = {}) {
  const requestedLevel = normalizeEffortLevel(value);
  const effectiveLevel = webEnabled ? requestedLevel : Math.min(1, requestedLevel);
  return { ...EFFORT_LEVELS[effectiveLevel], requestedLevel, effectiveLevel, webEnabled };
}

const NON_FACTUAL = [
  /^\s*(?:hi|hello|hey|thanks|thank\s+you|good\s+(?:morning|afternoon|evening)|bye)\b[\s!.?]*$/iu,
  /^\s*(?:rewrite|rephrase|proofread|polish|correct|shorten|expand|translate|summari[sz]e|edit)\b/iu,
  /^\s*(?:write|draft|compose|brainstorm|invent|create)\b.{0,100}\b(?:story|poem|fiction|scene|dialogue|slogan|names?|ideas?|caption|email|message|post|speech|script)\b/iu,
  /^\s*(?:reply|respond|say|output|print)\s+(?:exactly|only|with)\b/iu,
];

export function shouldGroundQuestion(text = '', { hasAttachedSource = false } = {}) {
  const value = String(text || '').normalize('NFKC').trim();
  if (!value || hasAttachedSource || NON_FACTUAL.some(pattern => pattern.test(value))) return false;
  return /\p{L}/u.test(value);
}

export function internalModeForQuestion() { return 'standard'; }
