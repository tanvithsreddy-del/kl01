const VERSION = 'web-query-v1';

const NO_WEB = [
  /\b(?:do not|don't|dont|without)\s+(?:use|search|check|browse|look(?:ing)?\s+up)\s+(?:the\s+)?(?:web|internet|online)\b/iu,
  /\b(?:stay|keep(?:\s+this)?)\s+(?:fully\s+)?offline\b/iu,
  /\bweb\s+(?:off|disabled)\b/iu,
];
const EXPLICIT_WEB = /\b(?:search\s+(?:the\s+)?web|search\s+online|browse\s+(?:the\s+)?web|look\s+(?:this|that|it)?\s*up|check\s+(?:the\s+)?web|check\s+online|use\s+wikipedia|check\s+wiki(?:pedia)?|find\s+(?:a\s+)?source|find\s+another\s+source)\b/iu;
const FOLLOWUP_LOOKUP = /^\s*(?:are\s+you\s+sure\??\s*)?(?:look\s+(?:it|that|this)?\s*up|check\s+(?:it\s+)?online|check\s+wiki(?:pedia)?|use\s+wikipedia|find\s+another\s+source)\s*[?.!]*\s*$/iu;
const SOURCE_WIKI = /\b(?:check|use)\s+(?:wiki|wikipedia)\b/iu;
const ANOTHER_SOURCE = /\b(?:find|use|give\s+me)\s+(?:an?\s+)?(?:other|another|different)\s+source\b/iu;
const OFFICIAL_SOURCE = /\b(?:use|check|from)\s+(?:(?:an?|the)\s+)?official\s+(?:site|website|source)\b/iu;
const NAMED_PUBLIC_SOURCE = /\b(?:check|use)\s+(?:reuters|associated\s+press|ap|afp|britannica|arxiv)\b/iu;
const NAMED_SOURCE_DOMAINS = [
  [/\breuters\b/iu, 'reuters.com', 'Reuters'],
  [/\b(?:associated\s+press|ap)\b/iu, 'apnews.com', 'Associated Press'],
  [/\bafp\b/iu, 'afp.com', 'AFP'],
  [/\bbritannica\b/iu, 'britannica.com', 'Britannica'],
  [/\barxiv\b/iu, 'arxiv.org', 'arXiv'],
];
const DIRECT_URL = /https?:\/\/[^\s<>"']+/giu;
const NEWS = /\b(?:news|headlines?|breaking|latest\s+(?:news|developments?|updates?)|what\s+happened\s+(?:today|this\s+week)|announced\s+today|recent\s+local)\b|(?:समाचार|खबर|ख़बर|ताज़ा)/iu;
const WEATHER = /\b(?:weather|forecast|temperature|rain(?:ing)?|snow(?:ing)?|humidity|wind(?:y)?|conditions?)\b.{0,60}\b(?:today|now|current|tonight|tomorrow|this\s+(?:morning|afternoon|evening|week))\b|\b(?:today|now|current|tonight|tomorrow)\b.{0,60}\b(?:weather|forecast|temperature|rain|snow)\b/iu;
const CURRENT_OFFICE = /\b(?:who(?:'s|\s+is)|current|currently|incumbent|present)\b.{0,100}\b(?:president|prime\s+minister|pm|ceo|governor|mayor|chief\s+minister|chair(?:person|man|woman)?|leader)\b|\b(?:president|prime\s+minister|ceo|governor|mayor|chief\s+minister|chair(?:person|man|woman)?)\b.{0,80}\b(?:now|today|current|currently|incumbent)\b/iu;
const OFFICE_SHORTHAND = /^\s*(?:[^?!.]{1,70}\s+)?(?:president|prime\s+minister|pm|ceo|governor|mayor|chief\s+minister|chair(?:person|man|woman)?)\s*[?.!]*\s*$|^\s*(?:president|prime\s+minister|pm|ceo|governor|mayor|chief\s+minister|chair(?:person|man|woman)?)\s+(?:of\s+)?[^?!.]{1,70}[?.!]*\s*$/iu;
const LATEST_SOFTWARE = /\b(?:latest|newest|current)\s+(?:stable\s+)?(?:version|release)\b|\b(?:version|release)\b.{0,30}\b(?:latest|current|newest)\b|\b(?:latest|newest|current)\s+(?:stable\s+)?[^?\n]{1,50}\s+(?:version|release)\b/iu;
const CURRENT_GENERAL = /\b(?:today|right\s+now|currently|latest|this\s+week|recent(?:ly)?)\b/iu;
const CURRENT_STATUS = /\bcurrent\s+(?:status|state|value|price|rate|version|release|availability|schedule|result|score|standing|office[-\s]?holder)\b/iu;
const HISTORICAL_DATE = /\b(?:when|what\s+year)\b.{0,100}\b(?:built|constructed|founded|established|opened|completed|created|invented|born|died)\b|\b(?:built|constructed|founded|established|opened|completed)\b.{0,80}\b(?:when|what\s+year)\b/iu;
const SIMPLE_FACT = /^\s*(?:who|what|when|where)\b/iu;

const OFFICE_ROLES = [
  ['prime minister', 'prime minister'], ['chief minister', 'chief minister'], ['president', 'president'],
  ['governor', 'governor'], ['mayor', 'mayor'], ['chairperson', 'chairperson'], ['chairman', 'chairperson'],
  ['chairwoman', 'chairperson'], ['ceo', 'CEO'], ['pm', 'prime minister'], ['leader', 'leader'],
];

// A deliberately small, inspectable entity table. It fixes high-confidence country/possessive
// mistakes without turning spell correction into a second language model.
const ENTITY_ALIASES = new Map(Object.entries({
  'negeria':'Nigeria', 'negerias':'Nigeria', 'nigeria':'Nigeria', 'nigerias':'Nigeria',
  'usa':'United States', 'u.s.':'United States', 'us':'United States', 'america':'United States',
  'uk':'United Kingdom', 'u.k.':'United Kingdom', 'britain':'United Kingdom',
  'uae':'United Arab Emirates', 'south korea':'South Korea', 'north korea':'North Korea',
}));

const COUNTRY_NAMES = [
  'Nigeria','Kenya','India','Pakistan','Bangladesh','Sri Lanka','Nepal','Bhutan','China','Japan','Indonesia','Malaysia','Singapore','Philippines','Vietnam','Thailand','Myanmar','Australia','New Zealand','Canada','Mexico','Brazil','Argentina','Chile','Colombia','Peru','France','Germany','Italy','Spain','Portugal','Netherlands','Belgium','Switzerland','Austria','Poland','Ukraine','Russia','Turkey','Israel','Egypt','South Africa','Ghana','Ethiopia','Tanzania','Uganda','Rwanda','Saudi Arabia','United Arab Emirates','United States','United Kingdom','South Korea','North Korea'];

function clean(value = '') {
  return String(value).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}
function tokens(value = '') {
  return clean(value).toLocaleLowerCase('en').replace(/[^\p{L}\p{N}'’.-]+/gu, ' ').split(/\s+/u).filter(Boolean);
}
function levenshtein(a, b) {
  const x = String(a).toLowerCase(); const y = String(b).toLowerCase();
  if (x === y) return 0;
  const prev = Array.from({ length:y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i += 1) {
    let left = i; let diag = i - 1;
    for (let j = 1; j <= y.length; j += 1) {
      const old = prev[j];
      const next = Math.min(prev[j] + 1, left + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev[j] = next; left = next; diag = old;
    }
  }
  return prev[y.length];
}
function canonicalEntityToken(token) {
  const raw = String(token || '').replace(/[’']/gu, "'");
  const possessiveStripped = raw.replace(/(?:'s|s)$/iu, '');
  const lower = possessiveStripped.toLocaleLowerCase('en');
  if (ENTITY_ALIASES.has(lower)) return { value:ENTITY_ALIASES.get(lower), confidence:1, changed:true };
  const exact=COUNTRY_NAMES.find(name=>name.toLocaleLowerCase('en')===lower);
  if (exact) return { value:exact, confidence:1, changed:raw!==exact };
  if (lower.length < 5) return null;
  let best = null;
  for (const name of COUNTRY_NAMES) {
    if (name.includes(' ')) continue;
    const d = levenshtein(lower, name.toLowerCase());
    if (d <= 2 && (!best || d < best.distance)) best = { value:name, distance:d };
  }
  if (best && (best.distance === 1 || lower.length >= 7)) return { value:best.value, confidence:best.distance === 1 ? 0.98 : 0.92, changed:true };
  return null;
}

function normalizeCountryTypos(value) {
  const parts = clean(value).split(/(\s+|[^\p{L}\p{M}\p{N}'’.\-]+)/u);
  const corrections=[];
  const output = parts.map(part => {
    if (!/[\p{L}]/u.test(part)) return part;
    const hit = canonicalEntityToken(part);
    if (!hit || hit.confidence < 0.92) return part;
    if (part.toLocaleLowerCase('en').replace(/['’]/gu,'') === hit.value.toLocaleLowerCase('en')) return hit.value;
    corrections.push({ from:part, to:hit.value, confidence:hit.confidence });
    return hit.value;
  }).join('');
  return { text:output, corrections };
}

function detectOfficeRole(text) {
  const lower = clean(text).toLocaleLowerCase('en');
  for (const [needle, role] of OFFICE_ROLES) if (new RegExp(`\\b${needle.replace(/ /g,'\\s+')}\\b`, 'iu').test(lower)) return role;
  return null;
}

function rolePattern(role) {
  const value=String(role || '').toLowerCase();
  if (value === 'prime minister') return '(?:prime\\s+minister|pm)';
  if (value === 'chairperson') return '(?:chairperson|chairman|chairwoman)';
  if (value === 'ceo') return 'ceo';
  return String(role || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
}

function extractOfficeTarget(text, role) {
  let value = clean(text)
    .replace(/^\s*(?:who(?:'s|\s+is)|what(?:'s|\s+is))\s+(?:the\s+)?/iu, '')
    .replace(/\b(?:current|currently|incumbent|present)\b/giu, ' ')
    .replace(new RegExp(`\\b${rolePattern(role)}\\b`, 'igu'), ' ')
    .replace(/\b(?:of|for|in)\b/giu, ' ')
    .replace(/[?!.]+$/u, ' ')
    .replace(/\s+/gu, ' ').trim();
  value = value.replace(/(?:'s|’s)$/iu, '').trim();
  if (!value) return '';
  const normalized = normalizeCountryTypos(value);
  return normalized.text.replace(/^(?:the\s+)/iu,'').trim();
}

function stripWebWrappers(value) {
  let out = clean(value).replace(/[?!.]+$/u, '').trim();
  const patterns = [
    /^\s*(?:please\s+)?(?:use|check)\s+(?:(?:an?|the)\s+)?official\s+(?:site|website|source)\s+(?:(?:to|for)\s+)?/iu,
    /^\s*(?:please\s+)?(?:check|use)\s+(?:reuters|associated\s+press|ap|afp|britannica|arxiv)\s+(?:(?:to|for)\s+)?/iu,
    /^\s*(?:please\s+)?(?:search\s+(?:the\s+)?web(?:\s+for)?|search\s+online(?:\s+for)?|browse\s+(?:the\s+)?web(?:\s+for)?|look\s+(?:this|that|it)?\s*up(?:\s+for)?|check\s+(?:the\s+)?web(?:\s+for)?|check\s+online(?:\s+for)?|use\s+wikipedia(?:\s+to)?|check\s+wiki(?:pedia)?(?:\s+for)?|find\s+(?:a\s+)?source(?:\s+for)?)\s*[:,-]?\s*/iu,
    /\s+\b(?:on\s+the\s+web|online)\s*$/iu,
  ];
  for (let pass=0; pass<3; pass+=1) for (const pattern of patterns) out = out.replace(pattern,'').trim();
  return out;
}

function sourceConstraint(text, prior) {
  if (SOURCE_WIKI.test(text)) return { kind:'domain', domain:'wikipedia.org', label:'Wikipedia', strictFirst:true };
  if (OFFICIAL_SOURCE.test(text)) return { kind:'official', label:'official source', strictFirst:true };
  if (NAMED_PUBLIC_SOURCE.test(text)) {
    const hit=NAMED_SOURCE_DOMAINS.find(([pattern])=>pattern.test(text));
    if(hit)return { kind:'domain', domain:hit[1], label:hit[2], strictFirst:true };
  }
  if (prior?.sourceConstraint && /\b(?:same\s+source|that\s+source)\b/iu.test(text)) return structuredClone(prior.sourceConstraint);
  return null;
}


const VERIFY_FOLLOWUP = /^\s*(?:are\s+you\s+sure|is\s+that\s+(?:right|correct|true)|verify\s+(?:that|this))\s*[?.!]*\s*$/iu;
const CITE_REQUEST = /\b(?:cite|give|provide|include|show)\s+(?:me\s+)?(?:public\s+)?(?:sources?|citations?|references?)\b|\bwith\s+(?:public\s+)?(?:sources?|citations?|references?)\b/iu;
const SUPPLIED_TRANSFORM = /^\s*(?:rewrite|rephrase|proofread|polish|correct|shorten|expand|translate|summari[sz]e|turn\s+this\s+into|edit\s+this)\b/iu;
const CREATIVE_TASK = /^\s*(?:write|draft|compose|brainstorm|invent|create)\b.{0,80}\b(?:story|poem|fiction|scene|dialogue|slogan|names?|ideas?|caption|email|message|post|speech|script)\b/iu;
const MARKET_PRICE = /\b(?:bitcoin|btc|ethereum|eth|crypto(?:currency)?|stock|share|shares|ticker|nasdaq|sensex|nifty|dow|s&p)\b.{0,90}\b(?:price|worth|value|trading|quote|market\s+cap|up|down)\b|\b(?:price|quote)\b.{0,80}\b(?:stock|share|bitcoin|btc|ethereum|eth|crypto)\b/iu;
const TICKER_PRICE = /\b[A-Z]{1,5}\b\s+(?:stock\s+)?(?:price|quote|trading\s+at)\b/u;
const CURRENCY_CODE = '(?:usd|eur|gbp|inr|jpy|cny|cad|aud|chf|sgd|hkd|aed)';
const FX_RATE = new RegExp(`\\b(?:exchange|fx|forex|currency)\\s+rate\\b|\\b${CURRENCY_CODE}\\s*(?:\\/|[-–]|to)\\s*${CURRENCY_CODE}\\b|\\b${CURRENCY_CODE}\\b.{0,50}\\b(?:rate|to\\s+${CURRENCY_CODE})\\b|\\b\\d+(?:\\.\\d+)?\\s*${CURRENCY_CODE}\\s+(?:in|to)\\s+${CURRENCY_CODE}\\b|\\b${CURRENCY_CODE}\\s+${CURRENCY_CODE}\\b.{0,30}\\b(?:today|now|rate)\\b`, 'iu');
const CURRENT_PRICE = /\b(?:price|cost|deal|discount|availability|available|in\s+stock|stock\s+status)\b.{0,100}\b(?:now|today|current|currently|india|online|near\s+me)\b|\b(?:price|cost)\s+of\s+[^?!.]{2,100}|^\s*[^?!.]{2,80}\b(?:price|cost)\s*[?.!]*\s*$|\bwhere\s+can\s+i\s+buy\b|\bhow\s+much\s+does\s+[^?!.]{1,100}\s+cost\b|\bhow\s+much\s+is\s+[^?!.]{1,100}\s+worth\b/iu;
const CURRENT_MODEL_OFFERING = /\b(?:newest|latest|current|new)\b.{0,60}\b(?:ai\s+)?(?:models?|model\s+family|offering|plan|tier)\b|\b(?:openai|anthropic|claude|gemini|qwen|llama)\b.{0,70}\b(?:newest|latest|current)\b/iu;
const SECURITY_STATUS = /\bcurrently\s+vulnerable\b|\bis\s+[^?!.]{1,100}\s+(?:currently\s+)?vulnerable\b|\bsecurity\s+(?:advisory|status|patch)|\b(?:latest|current)\s+cves?\b|\bis\s+[^?!.]{1,100}\s+patched\b|\bvulnerabilit(?:y|ies)\b.{0,50}\b(?:today|now|current|latest)\b|\b(?:today|now|current|latest)\b.{0,50}\bvulnerabilit(?:y|ies)\b/iu;
const RELEASE_CHANGE = /\b(?:what(?:'s|\s+is)?\s+new\s+in|what\s+changed\s+in|breaking\s+changes?\s+in|release\s+notes?\s+for)\b.{0,100}\b\d+(?:\.\d+){0,2}\b/iu;
const CURRENT_LAW = /\b(?:still\s+(?:valid|legal|in\s+force)|currently\s+(?:legal|illegal|valid)|is\s+.+\s+legal\s+(?:now|today|in\s+\p{L}+)|current\s+(?:law|rule|regulation)|regulation\s+(?:now|today)|eligib(?:le|ility)\s+(?:now|today|currently)|still\s+(?:applicable|applies)|(?:applicable|applies)\s+(?:now|today|currently))\b/iu;
const SPORTS_VOLATILE = /\b(?:next|upcoming|today(?:'s)?|latest|current|live)\b.{0,70}\b(?:game|match|fixture|event|fight|race|score|standings?|schedule)\b|\b(?:score|standings?|table|fixtures?|schedule)\b.{0,60}\b(?:today|now|current|next|upcoming)\b/iu;
const EVENT_SCHEDULE = /\b(?:next|upcoming|today(?:'s)?)\b.{0,80}\b(?:event|conference|keynote|launch|concert|show)\b|\b(?:event|keynote|launch|concert)\b.{0,60}\b(?:start\s+time|starts?|date|when)\b/iu;
const TRANSIT_SCHEDULE = /\b(?:train|flight|bus|metro|ferry)\b.{0,80}\b(?:timings?|schedule|status|delay|departure|arrival|today|tomorrow|next)\b/iu;
const LOCAL_LISTING = /\b(?:near\s+me|nearby|open\s+now|playing\s+near\s+me|showtimes?|currently\s+open)\b/iu;
const JOBS = /\b(?:internships?|jobs?|open\s+roles?|vacanc(?:y|ies)|hiring|positions?)\b.{0,100}\b(?:open|available|current|now|today|in\s+\p{L}+)|\b(?:who|companies?|startups?)\s+(?:is|are)\s+hiring\b/iu;
const THIS_YEAR_DATE = /\b(?:when|what\s+date)\b.{0,100}\bthis\s+year\b|\bthis\s+year\b.{0,100}\b(?:when|date)\b/iu;
const CURRENT_STATS = /\b(?:population|gdp|inflation|unemployment|interest\s+rate|cpi|growth\s+rate|crime\s+rate|market\s+share)\b/iu;
const CURRENT_STATS_HARD = /\b(?:current|currently|latest|today|this\s+(?:month|quarter|year))\b.{0,80}\b(?:population|gdp|inflation|unemployment|interest\s+rate|cpi|growth\s+rate|market\s+share)\b|\b(?:population|gdp|inflation|unemployment|interest\s+rate|cpi|growth\s+rate|market\s+share)\b.{0,80}\b(?:current|currently|latest|today|this\s+(?:month|quarter|year))\b/iu;
const PUBLIC_STATUS = /\b(?:is|are)\b.{0,80}\b(?:married|dating|single|engaged|divorced|alive|retired|still\s+at|still\s+with)\b/iu;
const RECOMMENDATION = /\b(?:best|recommend|recommendation|where\s+should\s+i|good\s+(?:hotel|restaurant|place|product)|things\s+to\s+do)\b/iu;
const MEDICAL_CURRENT = /\b(?:current|latest|new|recent)\b.{0,80}\b(?:evidence|guideline|treatment|therapy|study|research|consensus)\b|\b(?:evidence|guideline|treatment)\b.{0,80}\b(?:currently|today|latest)\b/iu;
const SCIENCE_CURRENT = /\b(?:latest|new|recent|current)\b.{0,100}\b(?:stud(?:y|ies)|research|evidence|discovery|consensus|papers?|literature|publications?)\b|\b(?:papers?|literature|publications?)\b.{0,80}\b(?:latest|new|recent|current)\b/iu;
const ENTERTAINMENT_CURRENT = /\b(?:movies?|films?)\b.{0,70}\b(?:in\s+(?:theaters?|cinemas?)|playing|showtimes?|now|today|latest|releases?)\b|\b(?:latest|new)\b.{0,50}\b(?:movies?|films?)\s+releases?\b/iu;
const OUTAGE_STATUS = /\b(?:is|are)\s+[^?!.]{1,100}\s+(?:down|offline|unavailable)\b|\b(?:outage|service\s+status|status\s+page)\b/iu;
const EXTERNAL_REFERENCE = /\b(?:paper|article|report|website|site|documentation|docs|release\s+notes|manual)\b.{0,80}\b(?:says?|states?|claims?|mentions?|according\s+to|what\s+does)\b|\bwhat\s+does\b.{0,80}\b(?:paper|article|report|website|documentation|docs)\b/iu;
const FICTIONAL_CONTEXT = /\b(?:fictional|imaginary|made[-\s]?up|in\s+my\s+(?:story|novel|game)|for\s+my\s+(?:story|novel|game))\b/iu;
const HISTORICAL_CONTEXT = /\b(?:in|as\s+of|during|around)\s+(?:\d{1,4}\s*(?:ad|bc|bce|ce)?|the\s+\d{1,2}(?:st|nd|rd|th)\s+century)\b|\b(?:ancient|medieval|historical)\b/iu;
const STABLE_DEFINITION = /^\s*(?:what\s+is|define|explain)\s+(?:the\s+|an?\s+)?(?:electrical\s+current|current\s+account|current\s+ratio(?:\s+in\s+accounting)?|currency\s+exchange\s+rate|exchange\s+rate|inflation|unemployment|gdp|cpi|population|vulnerability|market\s+share|stock\s+price|ticker\s+symbol|train\s+schedule|movie\s+release|service\s+outage|status\s+page|security\s+(?:advisory|patch)|cve|cost\s+accounting|cost\s+function)\s*[?.!]*\s*$/iu;
const ABSTRACT_PRICE_COST = /\b(?:price\s+of\s+freedom|cost\s+of\s+(?:an?\s+)?algorithm|cost\s+function|cost\s+accounting)\b/iu;
const BIOLOGY_ALIVE = /\b(?:water|viruses?|bacteria|plants?|fire|ai|computers?|dinosaurs?)\s+alive\b/iu;
function explanatoryDefinition(text){
  if(/^\s*(?:define\b|what\s+does\b.+\bmean\s*[?.!]*\s*$)/iu.test(text))return true;
  if(!/^\s*explain\b/iu.test(text))return false;
  return !/\b(?:latest|today|now|currently|recent)\b|\bcurrent\b.{0,60}\b(?:in|on|for)\b/iu.test(text);
}
function genericArticleDefinition(text){
  return /^\s*what\s+is\s+(?:an?|the\s+concept\s+of)\s+[^?!.]{1,100}[?.!]*\s*$/iu.test(text) && !/\b(?:today|now|currently|latest|recent)\b/iu.test(text);
}
const TECHNICAL_RECOMMENDATION = /\b(?:algorithm|data\s+structure|array|linked\s+list|time\s+complexity|sorting?)\b/iu;

function previousThread(chat) {
  const messages=Array.isArray(chat?.messages)?chat.messages:[];
  for(let i=messages.length-1;i>=0;i-=1){const thread=messages[i]?.web?.thread||messages[i]?.webPlan||null;if(thread?.target||thread?.query||thread?.original)return structuredClone(thread);}
  return null;
}

function hasPastTemporalMarker(text) {
  if (/\b(?:bc|bce|ancient|medieval)\b/iu.test(text)) return true;
  const currentYear = new Date().getUTCFullYear();
  for (const match of String(text).matchAll(/\b(1\d{3}|20\d{2})\b/gu)) if (Number(match[1]) < currentYear) return true;
  return false;
}

function classify(text, prior = null) {
  if (SUPPLIED_TRANSFORM.test(text) || CREATIVE_TASK.test(text) || FICTIONAL_CONTEXT.test(text)) return { claimClass:'supplied-or-creative', freshness:'stable', activation:'local', reason:'supplied-transform' };
  if (STABLE_DEFINITION.test(text) || ABSTRACT_PRICE_COST.test(text) || BIOLOGY_ALIVE.test(text) || explanatoryDefinition(text) || genericArticleDefinition(text)) return { claimClass:'stable-concept', freshness:'stable', activation:'local', reason:'stable-definition' };
  if (hasPastTemporalMarker(text) && /\b(?:president|prime\s+minister|pm|ceo|governor|mayor|chief\s+minister|chair(?:person|man|woman)?)\b/iu.test(text)) return { claimClass:'stable-history', freshness:'stable', activation:'local', reason:'historical-office-holder' };
  if (VERIFY_FOLLOWUP.test(text) && prior) return { claimClass:prior.claimClass || 'factual-verification', freshness:prior.freshness || 'none', activation:'preferred', reason:'verify-prior', officeRole:prior.officeRole || null };
  if (/^\s*latest\??\s*$/iu.test(text) && prior) return { claimClass:prior.claimClass || 'current-general', freshness:'current', activation:'required', reason:'latest-followup', officeRole:prior.officeRole || null };
  if (WEATHER.test(text) || (/\b(?:weather|forecast|temperature)\b/iu.test(text) && tokens(text).length <= 10 && !/\b(?:explain|define|why|how\s+does|what\s+is\s+weather)\b/iu.test(text))) return { claimClass:'weather-current', freshness:'current', activation:'required', reason:'weather-current' };
  if (CURRENT_OFFICE.test(text) || OFFICE_SHORTHAND.test(text)) return { claimClass:'current-office', freshness:'current', activation:'required', reason:'current-office', officeRole:detectOfficeRole(text) };
  if (MARKET_PRICE.test(text) || TICKER_PRICE.test(text)) return { claimClass:'market-current', freshness:'current', activation:'required', reason:'current-market-price' };
  if (FX_RATE.test(text)) return { claimClass:'fx-current', freshness:'current', activation:'required', reason:'current-fx-rate' };
  if (LATEST_SOFTWARE.test(text)) return { claimClass:'software-latest', freshness:'current', activation:'required', reason:'software-latest' };
  if (CURRENT_MODEL_OFFERING.test(text)) return { claimClass:'model-offering-current', freshness:'current', activation:'required', reason:'current-model-offering' };
  if (SECURITY_STATUS.test(text)) return { claimClass:'security-current', freshness:'current', activation:'required', reason:'security-status' };
  if (RELEASE_CHANGE.test(text)) return { claimClass:'software-change-current', freshness:'current', activation:'required', reason:'software-release-change' };
  if (CURRENT_LAW.test(text)) return { claimClass:'law-current', freshness:'current', activation:'required', reason:'current-law' };
  if (TRANSIT_SCHEDULE.test(text)) return { claimClass:'transit-current', freshness:'current', activation:'required', reason:'transit-schedule' };
  if (SPORTS_VOLATILE.test(text)) return { claimClass:'sports-current', freshness:'current', activation:'required', reason:'sports-schedule' };
  if (EVENT_SCHEDULE.test(text)) return { claimClass:'event-current', freshness:'current', activation:'required', reason:'event-schedule' };
  if (LOCAL_LISTING.test(text) || ENTERTAINMENT_CURRENT.test(text)) return { claimClass:'local-current', freshness:'current', activation:'required', reason:'local-listing' };
  if (OUTAGE_STATUS.test(text)) return { claimClass:'service-status-current', freshness:'current', activation:'required', reason:'service-status' };
  if (JOBS.test(text)) return { claimClass:'jobs-current', freshness:'current', activation:'required', reason:'jobs-current' };
  if (THIS_YEAR_DATE.test(text)) return { claimClass:'date-current', freshness:'current', activation:'required', reason:'date-this-year' };
  if (CURRENT_STATS.test(text) && HISTORICAL_CONTEXT.test(text)) return { claimClass:'stable-history', freshness:'stable', activation:'local', reason:'historical-statistic' };
  if (CURRENT_STATS_HARD.test(text)) return { claimClass:'statistics-current', freshness:'current', activation:'required', reason:'current-statistic' };
  if (CURRENT_STATUS.test(text)) return { claimClass:'current-status', freshness:'current', activation:'required', reason:'current-status' };
  if (NEWS.test(text)) return { claimClass:'news-current', freshness:'current', activation:'required', reason:'news-current' };
  if (CURRENT_PRICE.test(text) && !/\b(?:launch|original|historical|in\s+\d{4})\b/iu.test(text)) return { claimClass:'retail-current', freshness:'current', activation:'required', reason:'current-price' };
  // Medical/scientific evidence is deliberately classified before the generic
  // `current + simple fact` rule. Its frozen K3 policy is `preferred`: fresh
  // external evidence materially improves confidence, but this classifier alone
  // does not turn every such question into a hard current-fact requirement.
  if (MEDICAL_CURRENT.test(text)) return { claimClass:'medical-current', freshness:'high', activation:'preferred', reason:'medical-current-evidence' };
  if (SCIENCE_CURRENT.test(text)) return { claimClass:'science-current', freshness:'high', activation:'preferred', reason:'science-current-evidence' };
  if ((CURRENT_GENERAL.test(text) || CURRENT_STATUS.test(text)) && SIMPLE_FACT.test(text)) return { claimClass:'current-general', freshness:'current', activation:'required', reason:'current-fact' };
  if (CURRENT_STATS.test(text)) return { claimClass:'statistics-drifting', freshness:'dated', activation:'preferred', reason:'drifting-statistic' };
  if (PUBLIC_STATUS.test(text)) return { claimClass:'public-status', freshness:'dated', activation:'preferred', reason:'public-status' };
  if (RECOMMENDATION.test(text) && TECHNICAL_RECOMMENDATION.test(text)) return { claimClass:'stable-recommendation', freshness:'stable', activation:'local', reason:'stable-technical-recommendation' };
  if (RECOMMENDATION.test(text)) return { claimClass:'recommendation-current', freshness:'dated', activation:'preferred', reason:'recommendation-currentness' };
  if (EXTERNAL_REFERENCE.test(text)) return { claimClass:'external-reference', freshness:'none', activation:'preferred', reason:'named-external-reference' };
  if (HISTORICAL_DATE.test(text)) return { claimClass:'stable-history', freshness:'stable', activation:'local', reason:'stable-history' };
  return { claimClass:'general', freshness:'none', activation:'local', reason:'local-default' };
}
function targetFromText(text, classification, prior) {
  const correction = normalizeCountryTypos(text);
  if ((FOLLOWUP_LOOKUP.test(text) || VERIFY_FOLLOWUP.test(text) || /^\s*latest\??\s*$/iu.test(text)) && prior) return { target:prior.target || '', correctedText:correction.text, corrections:correction.corrections, officeRole:prior.officeRole || classification.officeRole || null };
  if (classification.claimClass === 'current-office') {
    const role = classification.officeRole || prior?.officeRole || detectOfficeRole(correction.text);
    const target = extractOfficeTarget(correction.text, role) || prior?.target || '';
    return { target, correctedText:correction.text, corrections:correction.corrections, officeRole:role };
  }
  const whatAbout = correction.text.match(/^\s*what\s+about\s+(.+?)[?.!]*$/iu);
  if (whatAbout && prior) return { target:whatAbout[1].replace(/[?!.]+$/u,'').trim(), correctedText:correction.text, corrections:correction.corrections, officeRole:prior.officeRole || null };
  const meant = correction.text.match(/\b(?:i\s+meant|meant)\s+([\p{L}\p{M}][\p{L}\p{M}\s.'’\-]{1,100})/iu);
  if (meant) return { target:meant[1].replace(/[?!.]+$/u,'').trim(), correctedText:correction.text, corrections:correction.corrections, officeRole:prior?.officeRole || null, userCorrection:true };
  return { target:'', correctedText:correction.text, corrections:correction.corrections, officeRole:classification.officeRole || prior?.officeRole || null };
}

function buildQuery(text, classification, targetInfo, prior, constraint) {
  const directUrls = [...clean(text).matchAll(DIRECT_URL)].map(match => match[0].replace(/[),.;!?]+$/u,''));
  if (directUrls.length) return { query:directUrls[0], directUrls, target:directUrls[0] };
  const followup = FOLLOWUP_LOOKUP.test(text) || VERIFY_FOLLOWUP.test(text) || /^\s*latest\??\s*$/iu.test(text) || /^\s*what\s+about\s+/iu.test(text);
  let subject = followup && prior ? (prior.target || prior.query || '') : stripWebWrappers(targetInfo.correctedText || text);
  if (/^\s*what\s+about\s+/iu.test(text) && prior) {
    const newTarget = targetInfo.target;
    if (prior.claimClass === 'current-office' && prior.officeRole && newTarget) subject = `${newTarget} ${prior.officeRole}`;
    else subject = newTarget || subject;
  }
  if (classification.claimClass === 'current-office') {
    const role = targetInfo.officeRole || classification.officeRole || prior?.officeRole || 'office holder';
    const target = targetInfo.target || prior?.target || subject.replace(new RegExp(`\\b${role}\\b`,'iu'),'').trim();
    subject = `${target} ${role}`.trim();
  }
  if (classification.claimClass === 'software-latest' && !/\b(?:version|release)\b/iu.test(subject)) subject = `${subject} latest release`;
  if (classification.claimClass === 'news-current' && !/\b(?:news|latest|recent)\b/iu.test(subject)) subject = `${subject} latest news`;
  if (classification.claimClass === 'weather-current' && !/\b(?:weather|forecast|temperature)\b/iu.test(subject)) subject = `${subject} weather`;
  if (classification.freshness === 'current' && !/\b(?:latest|current|today|now|202\d)\b/iu.test(subject)) subject = `${subject} current`;
  subject = subject.replace(/\s+/gu,' ').trim().slice(0,400);
  // Keep the semantic target separate from query-only source constraints.
  // Otherwise a later “another source” follow-up can inherit `site:x` as the
  // topic and become logically impossible when x is then excluded.
  const naturalTarget = targetInfo.target || prior?.target || subject;
  if (constraint?.kind === 'domain' && constraint.domain && !new RegExp(`site:${constraint.domain.replace(/\./g,'\\.')}`,'iu').test(subject)) subject = `site:${constraint.domain} ${subject}`.trim();
  if (constraint?.kind === 'official' && !/\bofficial\b/iu.test(subject)) subject = `${subject} official`.trim();
  return { query:subject, directUrls:[], target:naturalTarget };
}

function strategyFromInputs(strategy) { const raw=String(strategy||''); return ['balanced','diverse','source-first','off'].includes(raw)?raw:'balanced'; }
function localTarget(text){return stripWebWrappers(text).replace(/^\s*(?:what\s+is|who\s+is|tell\s+me\s+about|explain|define)\s+/iu,'').replace(/[?!.]+$/u,'').trim().slice(0,240);}

export function planResearchActivation(message,{chat=null,turnWeb='auto',strategy=null}={}){
  const effectiveStrategy=strategyFromInputs(strategy);const original=clean(message);const prior=previousThread(chat);const sameTurnOffline=NO_WEB.some(pattern=>pattern.test(original));const directUrls=[...original.matchAll(DIRECT_URL)].map(match=>match[0].replace(/[),.;!?]+$/u,''));const userExplicit=EXPLICIT_WEB.test(original)||FOLLOWUP_LOOKUP.test(original)||CITE_REQUEST.test(original)||OFFICIAL_SOURCE.test(original)||NAMED_PUBLIC_SOURCE.test(original)||directUrls.length>0;
  if(!original||sameTurnOffline)return{version:'research-activation-v1',activation:'disabled',useWeb:false,required:false,explicit:false,disabled:true,reason:!original?'empty':'explicit-offline',original,query:'',variants:[],target:prior?.target||'',claimClass:'none',freshness:'none',sourceConstraint:null,directUrls:[],corrections:[],excludeDomains:[],strategy:effectiveStrategy};
  let classification=classify(original,prior);
  if((FOLLOWUP_LOOKUP.test(original)||VERIFY_FOLLOWUP.test(original)||/^\s*latest\??\s*$/iu.test(original)||/^\s*what\s+about\s+/iu.test(original))&&prior){const forceFresh=/^\s*latest\??\s*$/iu.test(original);const verify=VERIFY_FOLLOWUP.test(original);classification={claimClass:prior.claimClass||classification.claimClass,freshness:forceFresh?'current':(prior.freshness||classification.freshness),activation:forceFresh?'required':verify?'preferred':(prior.activation||(prior.required?'required':classification.activation)),reason:forceFresh?'latest-followup':verify?'verify-prior':classification.reason,officeRole:prior.officeRole||classification.officeRole};}
  let activation,reason;if(turnWeb==='off'||turnWeb==='offline'){activation='disabled';reason='run-stay-local';}else if(userExplicit){activation='explicit';reason=FOLLOWUP_LOOKUP.test(original)?'explicit-followup':CITE_REQUEST.test(original)?'explicit-citations':directUrls.length?'explicit-url':'explicit-search';}else if(turnWeb==='force'){activation='explicit';reason='run-force';}else if(effectiveStrategy==='off'){activation='disabled';reason='strategy-off';}else{activation=classification.activation||'local';reason=classification.reason||classification.claimClass||'local-default';}
  const useWeb=['preferred','required','explicit'].includes(activation);const constraint=sourceConstraint(original,prior);const targetInfo=targetFromText(original,classification,prior);
  if(!useWeb)return{version:'research-activation-v1',activation,useWeb:false,required:false,explicit:false,disabled:activation==='disabled',reason,original,query:'',variants:[],target:targetInfo.target||prior?.target||localTarget(original),claimClass:classification.claimClass,freshness:classification.freshness,officeRole:targetInfo.officeRole||classification.officeRole||prior?.officeRole||null,sourceConstraint:constraint,directUrls:[],corrections:targetInfo.corrections,excludeDomains:[],strategy:effectiveStrategy,userCorrection:Boolean(targetInfo.userCorrection)};
  const built=buildQuery(original,classification,targetInfo,prior,constraint);const minimizedOriginal=stripWebWrappers(original).slice(0,400);const variants=[];const add=value=>{const q=clean(value);if(q&&!variants.includes(q)&&variants.length<3)variants.push(q);};add(built.query);if(targetInfo.corrections.length)add(minimizedOriginal);if(classification.freshness==='current'&&built.query&&!/\b202\d\b/u.test(built.query))add(`${built.query} ${new Date().getUTCFullYear()}`);const excludeDomains=[];if(ANOTHER_SOURCE.test(original)&&Array.isArray(prior?.domains))excludeDomains.push(...prior.domains.slice(0,8));if(/\b(?:do\s+not|don't|dont|without)\s+(?:use|check|cite)\s+(?:wiki|wikipedia)\b/iu.test(original))excludeDomains.push('wikipedia.org');
  return{version:'research-activation-v1',activation,useWeb:true,required:activation!=='preferred',explicit:activation==='explicit',disabled:false,reason,original,query:built.query,variants,target:built.target||localTarget(original),claimClass:classification.claimClass,freshness:classification.freshness,officeRole:targetInfo.officeRole||classification.officeRole||prior?.officeRole||null,sourceConstraint:constraint,directUrls:built.directUrls,corrections:targetInfo.corrections,excludeDomains:[...new Set(excludeDomains)],strategy:effectiveStrategy,userCorrection:Boolean(targetInfo.userCorrection)};
}
export function webQueryThread(plan,sources=[]){if(!plan?.useWeb)return null;const domains=[...new Set((sources||[]).map(source=>source.domain).filter(Boolean))].slice(0,8);return{version:2,query:plan.query,target:plan.target||plan.query,claimClass:plan.claimClass,freshness:plan.freshness,activation:plan.activation||null,required:Boolean(plan.required),officeRole:plan.officeRole||null,sourceConstraint:plan.sourceConstraint||null,strategy:plan.strategy||'balanced',domains};}
export const RESEARCH_ACTIVATION_VERSION='research-activation-v1';
