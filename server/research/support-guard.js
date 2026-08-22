import { traceable } from '../services/structured-grounding.js';

export const TRUTH_VERSION = 2;

function clean(v){return String(v??'').normalize('NFC').replace(/\s+/gu,' ').trim();}
function canon(v){return clean(v).toLocaleLowerCase().replace(/[’]/gu,"'").replace(/[^\p{L}\p{N}$€£¥%.'-]+/gu,' ').replace(/\s+/gu,' ').trim();}
const NEG=/\b(?:not|no|never|without|neither|nor|cannot|can't|didn't|doesn't|isn't|wasn't|weren't|hasn't|haven't|won't)\b/iu;
function isNegated(v){return NEG.test(canon(v).replace(/\bnot\s+only\b/giu,'only'));}

const RELATIONS=[
  {id:'acquire',words:['acquire','acquired','acquires','acquiring','buy','bought','buys','purchase','purchased','purchases']},
  {id:'begin',words:['begin','began','begins','started','start','starts','commenced','commence','launched','launch']},
  {id:'end',words:['end','ended','ends','stopped','stop','ceased','cease','terminated','terminate']},
  {id:'reduce',words:['reduce','reduced','reduces','lower','lowered','lowers','decrease','decreased','decreases','cut','cuts']},
  {id:'increase',words:['increase','increased','increases','raise','raised','raises','grew','grow','grown']},
  {id:'approve',words:['approve','approved','approves','authorized','authorised']},
  {id:'reject',words:['reject','rejected','rejects','denied','deny','refused','refuse']},
];
const OPPOSITE=new Map([['begin','end'],['end','begin'],['reduce','increase'],['increase','reduce'],['approve','reject'],['reject','approve']]);
const STATUS_PAIRS=[['alive','dead'],['valid','invalid'],['active','inactive'],['open','closed'],['legal','illegal'],['available','unavailable'],['supported','unsupported'],['approved','rejected']];
const STOP=new Set(['the','an','is','are','was','were','be','been','being','has','have','had','did','does','do','to','of','in','on','at','for','from','as','by','with','and','or','that','this','it']);
function words(v){return canon(v).match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)||[];}
function relationIds(v){const set=new Set();const w=new Set(words(v));for(const rel of RELATIONS)if(rel.words.some(x=>w.has(x)))set.add(rel.id);return set;}
function normalizeNumber(raw){const x=String(raw).replace(/,/g,'');const n=Number(x);if(Number.isFinite(n))return String(Number.isInteger(n)?n:Number(n.toFixed(9)));return x;}
function currencyIn(prefix,suffix){const joined=`${prefix} ${suffix}`.toLocaleLowerCase();if(/\$|\busd\b|\bdollars?\b/u.test(joined))return'usd';if(/€|\beur\b|\beuros?\b/u.test(joined))return'eur';if(/£|\bgbp\b|\bpounds?\b/u.test(joined))return'gbp';if(/₹|\binr\b|\brupees?\b/u.test(joined))return'inr';if(/¥|\bjpy\b|\byen\b/u.test(joined))return'jpy';return'';}
function numericValues(v){const text=clean(v);const out=[];for(const m of text.matchAll(/\b\d[\d,]*(?:\.\d+)?\b/gu)){const num=normalizeNumber(m[0]);const idx=m.index||0;const prefix=text.slice(Math.max(0,idx-12),idx);const suffix=text.slice(idx+m[0].length,idx+m[0].length+32);const scale=(suffix.match(/^\s*(thousand|million|billion|trillion|k|m|bn|tn)\b/iu)||[])[1]?.toLocaleLowerCase()||'';const scaleNorm={k:'thousand',m:'million',bn:'billion',tn:'trillion'}[scale]||scale;const pct=/^\s*(?:%|percent\b)/iu.test(suffix)?'%':'';const currency=currencyIn(prefix,suffix);out.push(`${num}|${scaleNorm}|${currency}|${pct}`);}return [...new Set(out)];}
function numericCompatible(candidate,source){const wanted=numericValues(candidate);if(!wanted.length)return true;const available=new Set(numericValues(source));return wanted.every(x=>available.has(x));}
function futureScoped(v){return /\b(?:will|shall|scheduled\s+to|expected\s+to|set\s+to|plans?\s+to|due\s+to)\b/iu.test(clean(v));}
function presentState(v){return /\b(?:is|are|currently|now|serves?|leads?)\b/iu.test(clean(v))&&!futureScoped(v);}
function pastState(v){return /\b(?:was|were|formerly|previously|used\s+to)\b/iu.test(clean(v))&&!futureScoped(v);}
function temporalContradiction(candidate,source){const cf=futureScoped(candidate),sf=futureScoped(source);if(cf!==sf&&(cf||sf))return true;const cp=presentState(candidate),sp=presentState(source),cpa=pastState(candidate),spa=pastState(source);if(cp&&spa&&!sp)return true;if(cpa&&sp&&!cp)return true;return false;}
function uncertain(v){return /\b(?:may|might|perhaps|possibly|possible|alleged|allegedly|rumou?red|unconfirmed|claimed)\b/iu.test(clean(v));}
function conditional(v){return /(?:^|[.!?;]\s*)if\b|\bunless\b|\bin\s+the\s+event\s+that\b/iu.test(clean(v));}
function epistemicContradiction(candidate,source){if(!uncertain(candidate)&&uncertain(source))return true;if(!conditional(candidate)&&conditional(source))return true;return false;}
function statusContradiction(candidate,source){const c=new Set(words(candidate)),s=new Set(words(source));for(const [a,b] of STATUS_PAIRS){if(c.has(a)&&s.has(b)&&!s.has(a))return true;if(c.has(b)&&s.has(a)&&!s.has(b))return true;}return false;}
function relationContradiction(candidate,source){const c=relationIds(candidate),s=relationIds(source);for(const id of c){const opp=OPPOSITE.get(id);if(opp&&s.has(opp)&&!s.has(id))return true;}return false;}
function relationWordIndex(tokens,relId){const rel=RELATIONS.find(r=>r.id===relId);if(!rel)return -1;return tokens.findIndex(t=>rel.words.includes(t));}
function contentSide(tokens){return tokens.filter(t=>!STOP.has(t));}
function activeSignature(v,relId){const t=words(v);const i=relationWordIndex(t,relId);if(i<1||i>=t.length-1)return null;const before=contentSide(t.slice(Math.max(0,i-6),i));const after=contentSide(t.slice(i+1,i+7));if(!before.length||!after.length)return null;return{subject:before.slice(-3).join(' '),object:after.slice(0,4).join(' ')};}
function passiveSignature(v,relId){const t=words(v);const i=relationWordIndex(t,relId);if(i<1)return null;const by=t.indexOf('by',i+1);if(by<0||by>=t.length-1)return null;const patient=contentSide(t.slice(Math.max(0,i-5),i).filter(x=>!['was','were','is','are','been','being'].includes(x)));const agent=contentSide(t.slice(by+1,by+5));if(!patient.length||!agent.length)return null;return{subject:agent.slice(0,3).join(' '),object:patient.slice(-4).join(' ')};}
function signature(v,relId){return passiveSignature(v,relId)||activeSignature(v,relId);}

function argumentTokens(v){return new Set(contentSide(words(v)));}
function argumentsCompatible(a,b){const A=argumentTokens(a),B=argumentTokens(b);if(!A.size||!B.size)return true;let shared=0;for(const t of A)if(B.has(t))shared++;return shared/Math.min(A.size,B.size)>=0.6;}
function relationArgumentContradiction(candidate,source){
  const cR=relationIds(candidate),sR=relationIds(source);
  for(const id of cR){
    if(!sR.has(id)||!['acquire','approve','reject'].includes(id))continue;
    const c=signature(candidate,id),s=signature(source,id);if(!c||!s)continue;
    if(id==='acquire'&&(!argumentsCompatible(c.subject,s.subject)||!argumentsCompatible(c.object,s.object)))return true;
    if(['approve','reject'].includes(id)&&!argumentsCompatible(c.object,s.object))return true;
  }
  return false;
}
function directionContradiction(candidate,source){const cR=relationIds(candidate),sR=relationIds(source);for(const id of cR){if(!sR.has(id)||id!=='acquire')continue;const c=signature(candidate,id),s=signature(source,id);if(!c||!s)continue;if(c.subject===s.object&&c.object===s.subject&&c.subject!==c.object)return true;}return false;}
function constraints(candidate,source){
  if(!numericCompatible(candidate,source))return{ok:false,reason:'CRITICAL_VALUE_MISMATCH'};
  if(relationContradiction(candidate,source))return{ok:false,reason:'RELATION_MISMATCH'};
  if(statusContradiction(candidate,source))return{ok:false,reason:'STATUS_MISMATCH'};
  if(directionContradiction(candidate,source))return{ok:false,reason:'RELATION_DIRECTION_MISMATCH'};
  if(relationArgumentContradiction(candidate,source))return{ok:false,reason:'RELATION_ARGUMENT_MISMATCH'};
  if(temporalContradiction(candidate,source))return{ok:false,reason:'TEMPORAL_SCOPE_MISMATCH'};
  if(epistemicContradiction(candidate,source))return{ok:false,reason:'EPISTEMIC_SCOPE_MISMATCH'};
  if(isNegated(candidate)!==isNegated(source))return{ok:false,reason:'POLARITY_MISMATCH'};
  return{ok:true,reason:null};
}

function semanticTokens(v){const out=[];for(const token of words(v)){if(STOP.has(token)||['serves','serve','served','serving','currently'].includes(token))continue;let mapped=token;for(const rel of RELATIONS){if(rel.words.includes(token)){mapped=rel.id;break;}}out.push(mapped);}return new Set(out);}
function semanticTraceable(candidate,source){const wanted=semanticTokens(candidate);if(!wanted.size)return false;const available=semanticTokens(source);let shared=0;for(const token of wanted)if(available.has(token))shared+=1;const threshold=wanted.size<=2?1:wanted.size<=4?0.66:0.5;return shared/wanted.size>=threshold;}
function lexicallyTraceable(candidate,source,mode){return traceable(candidate,[source],mode)||(mode!=='exact'&&semanticTraceable(candidate,source));}

function segments(v){const text=clean(v);if(!text)return[];const sentences=text.split(/(?<=[.!?;])\s+|\n+/u).map(clean).filter(Boolean);const out=[...sentences];for(let i=0;i+1<sentences.length;i++)out.push(`${sentences[i]} ${sentences[i+1]}`);return [...new Set(out)];}

function supportOne(value,sources=[],mode='paraphrase'){
  const candidate=clean(value);const sourceList=(sources||[]).map(clean).filter(Boolean);if(!candidate||!sourceList.length)return{supported:false,status:'unsupported',reason:'NO_SOURCE'};
  let sawTraceable=false;let firstReason='NOT_TRACEABLE';
  for(let si=0;si<sourceList.length;si++){
    const relevant=[];
    for(const segment of segments(sourceList[si])){if(!lexicallyTraceable(candidate,segment,mode))continue;sawTraceable=true;relevant.push({segment,check:constraints(candidate,segment)});}
    const supported=relevant.find(x=>x.check.ok);
    if(supported){const supportCanon=canon(supported.segment);const directConflict=relevant.find(x=>!x.check.ok&&['POLARITY_MISMATCH','RELATION_MISMATCH','STATUS_MISMATCH','RELATION_DIRECTION_MISMATCH','RELATION_ARGUMENT_MISMATCH'].includes(x.check.reason)&&!(canon(x.segment).includes(supportCanon)&&canon(x.segment)!==supportCanon));if(!directConflict)return{supported:true,status:'supported',reason:null,sourceIndex:si,matchedText:supported.segment};firstReason='SOURCE_INTERNAL_CONFLICT';continue;}
    if(relevant.length&&firstReason==='NOT_TRACEABLE')firstReason=relevant[0].check.reason;
  }
  // Multi-excerpt synthesis is allowed only when no individually traceable segment
  // expressed a contradictory semantic relation. This preserves legitimate composite
  // summaries without letting an opposite statement pass through lexical overlap.
  if(!sawTraceable){const joined=sourceList.join(' ');if(lexicallyTraceable(candidate,joined,mode)){const check=constraints(candidate,joined);if(check.ok)return{supported:true,status:'supported',reason:null,sourceIndex:null,matchedText:null};firstReason=check.reason;}}
  return{supported:false,status:firstReason==='NOT_TRACEABLE'?'uncertain':'unsupported',reason:firstReason};
}

const GENERIC_PREDICATE=/\b(?:is|are|was|were|has|have|had|will|shall|became|become|serves?|leads?|took|takes?|cost|costs|rose|rises?|fell|falls?|grew|grows?|released|announced|confirmed|reported|found|shows?|showed)\b/iu;
function hasPredicate(v){return GENERIC_PREDICATE.test(clean(v))||relationIds(v).size>0;}
function predicatePrefix(v){const t=words(v);let idx=t.findIndex(x=>GENERIC_PREDICATE.test(x));for(const rel of RELATIONS){const i=relationWordIndex(t,rel.id);if(i>=0&&(idx<0||i<idx))idx=i;}if(idx<1)return null;return t.slice(0,idx+1).join(' ');}
function propositionClauses(value){const text=clean(value);const raw=text.split(/\s+(?:and|but)\s+/iu).map(clean).filter(Boolean);if(raw.length<2||raw.length>4||!hasPredicate(raw[0]))return[text];const prefix=predicatePrefix(raw[0]);const out=[raw[0]];for(const part of raw.slice(1)){if(hasPredicate(part))out.push(part);else if(prefix)out.push(`${prefix} ${part}`);else return[text];}return out;}
export function supportGuard(value,sources=[],mode='paraphrase'){
  const clauses=propositionClauses(value);if(clauses.length===1)return supportOne(value,sources,mode);
  const matches=[];for(const clause of clauses){const result=supportOne(clause,sources,mode);if(!result.supported)return{supported:false,status:result.status||'uncertain',reason:result.reason||'PARTIAL_PROPOSITION_SUPPORT',failedClause:clause};matches.push(result);}
  return{supported:true,status:'supported',reason:null,compound:true,clauseCount:clauses.length,matches};
}
export function supportsText(value,sources=[],mode='paraphrase'){return supportGuard(value,sources,mode).supported;}

function scaleMultiplier(value=''){return({thousand:1e3,million:1e6,billion:1e9,trillion:1e12,k:1e3,m:1e6,bn:1e9,tn:1e12}[String(value).toLocaleLowerCase()]||1);}
function quantityCurrency(text=''){return currencyIn(clean(text).slice(0,24),clean(text).slice(-40));}
function quantityUnit(text=''){const low=clean(text).toLocaleLowerCase();if(/(?:%|\bpercent\b)/u.test(low))return'percent';const m=low.match(/\b(?:kg|kilograms?|g|grams?|mg|milligrams?|km|kilometers?|kilometres?|cm|centimeters?|centimetres?|mm|millimeters?|millimetres?|miles?|mph|km\/h)\b/u);if(!m)return'';const x=m[0];if(/^kg|kilogram/u.test(x))return'kg';if(/^mg|milligram/u.test(x))return'mg';if(/^g|gram/u.test(x))return'g';if(/^km\/h$/u.test(x))return'km/h';if(/^km|kilomet/u.test(x))return'km';if(/^cm|centim/u.test(x))return'cm';if(/^mm|millim/u.test(x))return'mm';if(/^mile/u.test(x))return'mile';if(x==='mph')return'mph';return x;}
function parseQuantity(value){const text=clean(value);const range=text.match(/(?:[$€£¥]\s*)?(\d[\d,]*(?:\.\d+)?)\s*(?:-|–|—|to|through)\s*(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|trillion|k|m|bn|tn)?/iu);if(range){const mult=scaleMultiplier(range[3]||'');const a=Number(String(range[1]).replace(/,/g,''))*mult,b=Number(String(range[2]).replace(/,/g,''))*mult;if(Number.isFinite(a)&&Number.isFinite(b))return{type:'quantity',min:Math.min(a,b),max:Math.max(a,b),currency:quantityCurrency(text),unit:quantityUnit(text)};}
 const m=text.match(/(?:[$€£¥]\s*)?(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|trillion|k|m|bn|tn)?/iu);if(!m)return null;const n=Number(String(m[1]).replace(/,/g,''))*scaleMultiplier(m[2]||'');if(!Number.isFinite(n))return null;return{type:'quantity',min:n,max:n,currency:quantityCurrency(text),unit:quantityUnit(text)};}
function parseDateAtomic(value){const text=clean(value);if(/^\d{4}$/u.test(text)){const y=Number(text);return{type:'date',min:`${y}-01-01`,max:`${y}-12-31`,precision:'year'};}const ms=Date.parse(text);if(!Number.isFinite(ms))return null;const d=new Date(ms);const iso=d.toISOString().slice(0,10);return{type:'date',min:iso,max:iso,precision:'day'};}
function temporalQualifier(value){const t=clean(value).toLocaleLowerCase();const year=(t.match(/\b(?:19|20)\d{2}\b/u)||[])[0];if(year)return`year:${year}`;if(/\b(?:now|currently|present|today)\b/u.test(t))return'current';if(/\b(?:formerly|previously|past)\b/u.test(t))return'past';if(/\b(?:future|upcoming|will)\b/u.test(t))return'future';return null;}
function statusCore(value){return canon(value).replace(/\b(?:in\s+(?:19|20)\d{2}|now|currently|present|today|formerly|previously|past|future|upcoming)\b/gu,' ').replace(/\s+/gu,' ').trim();}
export function canonicalAtomicValue(kind,value){const k=String(kind||'other');const raw=clean(value);if(!raw)return null;if(k==='number'){const q=parseQuantity(raw);return q||{type:'number-text',value:canon(raw)};}if(k==='date'){const d=parseDateAtomic(raw);return d||{type:'date-text',value:canon(raw)};}if(k==='status')return{type:'status',value:statusCore(raw),scope:temporalQualifier(raw),negated:isNegated(raw)};if(k==='identity')return{type:'identity',value:canon(raw)};return{type:k,value:canon(raw)};}
function rangesOverlap(a,b){return a.min<=b.max&&b.min<=a.max;}
export function compareAtomicValues(kind,aRaw,bRaw){const a=canonicalAtomicValue(kind,aRaw),b=canonicalAtomicValue(kind,bRaw);if(!a||!b)return{relation:'unknown',a,b};if(a.type==='quantity'&&b.type==='quantity'){if(a.currency&&b.currency&&a.currency!==b.currency)return{relation:'conflict',a,b,reason:'CURRENCY_MISMATCH'};if(a.unit&&b.unit&&a.unit!==b.unit)return{relation:'conflict',a,b,reason:'UNIT_MISMATCH'};if(!rangesOverlap(a,b))return{relation:'conflict',a,b,reason:'VALUE_RANGE_DISJOINT'};const exact=a.min===b.min&&a.max===b.max&&(!a.currency||!b.currency||a.currency===b.currency)&&(!a.unit||!b.unit||a.unit===b.unit);return{relation:exact?'equivalent':'compatible',a,b};}
 if(a.type==='date'&&b.type==='date'){if(!rangesOverlap(a,b))return{relation:'conflict',a,b,reason:'DATE_RANGE_DISJOINT'};return{relation:a.min===b.min&&a.max===b.max?'equivalent':'compatible',a,b};}
 if(a.type==='status'&&b.type==='status'){if(a.value===b.value&&a.negated===b.negated)return{relation:a.scope===b.scope?'equivalent':'compatible',a,b};if(a.scope&&b.scope&&a.scope!==b.scope)return{relation:'compatible',a,b,reason:'DIFFERENT_TEMPORAL_SCOPE'};if(statusContradiction(a.value,b.value)||a.negated!==b.negated)return{relation:'conflict',a,b,reason:'STATUS_MISMATCH'};return{relation:a.value===b.value?'equivalent':'conflict',a,b,reason:a.value===b.value?null:'STATUS_VALUE_MISMATCH'};}
 const av=a.value??JSON.stringify(a),bv=b.value??JSON.stringify(b);return{relation:av===bv?'equivalent':'conflict',a,b,reason:av===bv?null:'ATOMIC_VALUE_MISMATCH'};}
