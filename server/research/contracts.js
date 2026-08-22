import crypto from 'node:crypto';
import { fail } from '../lib/errors.js';

export const WORK_EVENT_SCHEMA = 1;
export const ARTIFACT_SCHEMA = 1;
export const RUN_JOURNAL_SCHEMA = 1;
export const SOURCE_WORK_SCHEMA = 1;

export const SOURCE_WORK_STATES = Object.freeze(['queued','opening','reading','extracting','summarising','checked','used','skipped','unavailable']);
const SOURCE_WORK_TRANSITIONS = Object.freeze({
  queued:new Set(['opening','skipped','unavailable']),
  opening:new Set(['reading','extracting','skipped','unavailable']),
  reading:new Set(['extracting','skipped','unavailable']),
  extracting:new Set(['summarising','checked','skipped','unavailable']),
  summarising:new Set(['checked','skipped','unavailable']),
  checked:new Set(['used','skipped']),
  used:new Set(), skipped:new Set(), unavailable:new Set(),
});
const SOURCE_WORK_TERMINAL = new Set(['used','skipped','unavailable']);
function sourceHost(url=''){try{return new URL(String(url)).hostname.toLowerCase().replace(/^www\./u,'');}catch{return'';}}
function sourceCanonicalUrl(url=''){try{const u=new URL(String(url));u.hash='';if(u.pathname.length>1)u.pathname=u.pathname.replace(/\/+$/u,'');return u.toString();}catch{return String(url||'');}}
function boundedString(value,max=500){return String(value??'').normalize('NFC').replace(/\s+/gu,' ').trim().slice(0,max);}
function boundedSourceProfile(value){if(!value||typeof value!=='object')return null;return deepFreeze({domain:boundedString(value.domain,255),classIds:Object.freeze([...new Set(Array.isArray(value.classIds)?value.classIds:[])].slice(0,16).map(x=>boundedString(x,80))),taskProfile:value.taskProfile?boundedString(value.taskProfile,80):null,taskTier:Number.isFinite(Number(value.taskTier))?Number(value.taskTier):null,anchor:Boolean(value.anchor),anchorTier:Number.isFinite(Number(value.anchorTier))?Number(value.anchorTier):null,anchorDomain:value.anchorDomain?boundedString(value.anchorDomain,255):null,userOverride:value.userOverride?boundedString(value.userOverride,40):'neutral',discoveryRole:value.discoveryRole?boundedString(value.discoveryRole,80):null,evidenceRole:value.evidenceRole?boundedString(value.evidenceRole,80):null,known:Boolean(value.known),why:Object.freeze((Array.isArray(value.why)?value.why:[]).slice(0,8).map(x=>boundedString(x,160)))});}
export function sourceWorkId(runId,url){return `source-${sha256({runId:String(runId||''),url:sourceCanonicalUrl(url)}).slice(0,24)}`;}
export function createSourceWork(input={}){
  const url=sourceCanonicalUrl(input.url);const state=SOURCE_WORK_STATES.includes(input.state)?input.state:'queued';const stamp=input.updatedAt||input.createdAt||new Date().toISOString();
  return Object.freeze({schemaVersion:SOURCE_WORK_SCHEMA,sourceId:String(input.sourceId||sourceWorkId(input.runId,url)),runId:String(input.runId||''),url,domain:boundedString(input.domain||sourceHost(url),255),title:boundedString(input.title,500),state,createdAt:input.createdAt||stamp,updatedAt:stamp,mode:input.mode?boundedString(input.mode,40):null,reason:input.reason?boundedString(input.reason,120):null,summary:input.summary?boundedString(input.summary,1200):'',excerptPreview:input.excerptPreview?boundedString(input.excerptPreview,500):'',excerptCount:Math.max(0,Math.min(12,Number(input.excerptCount||0))),evidenceAccepted:Math.max(0,Math.min(64,Number(input.evidenceAccepted||0))),evidenceIds:Object.freeze([...new Set(Array.isArray(input.evidenceIds)?input.evidenceIds:[])].slice(0,64).map(String)),claimIds:Object.freeze([...new Set(Array.isArray(input.claimIds)?input.claimIds:[])].slice(0,32).map(String)),dossierArtifactId:input.dossierArtifactId?String(input.dossierArtifactId):null,lineageId:input.lineageId?String(input.lineageId):null,contentLineageId:input.contentLineageId?String(input.contentLineageId):null,sourceProfile:boundedSourceProfile(input.sourceProfile),revision:Math.max(1,Number(input.revision||1))});
}
export function transitionSourceWork(current,nextState,patch={}){
  if(!current||current.schemaVersion!==SOURCE_WORK_SCHEMA)throw fail('SOURCE_WORK_INVALID','Source work state is invalid.',500);
  if(!SOURCE_WORK_STATES.includes(nextState))throw fail('SOURCE_WORK_STATE','Source work state is invalid.',500,{nextState});
  if(current.state!==nextState&&!SOURCE_WORK_TRANSITIONS[current.state]?.has(nextState))throw fail('SOURCE_WORK_TRANSITION',`Source work cannot move from ${current.state} to ${nextState}.`,409,{sourceId:current.sourceId,from:current.state,to:nextState});
  return createSourceWork({...current,...patch,sourceId:current.sourceId,runId:current.runId,url:current.url,state:nextState,createdAt:current.createdAt,updatedAt:patch.updatedAt||new Date().toISOString(),revision:Number(current.revision||1)+1});
}
export function sourceWorkTerminal(value){return SOURCE_WORK_TERMINAL.has(String(value?.state||''));}
export function recoverSourceWork(value){if(!value||value.schemaVersion!==SOURCE_WORK_SCHEMA)return null;if(sourceWorkTerminal(value)||value.state==='checked')return createSourceWork(value);return createSourceWork({...value,state:'queued',reason:'recovery-retry',revision:Number(value.revision||1)+1,updatedAt:new Date().toISOString()});}


export function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
export function sha256(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex'); }
export function newId(prefix) { return `${prefix}-${crypto.randomBytes(12).toString('hex')}`; }

function deepFreeze(value){if(!value||typeof value!=='object'||Object.isFrozen(value))return value;for(const child of Object.values(value))deepFreeze(child);return Object.freeze(value);}

export function workEvent(input = {}) {
  const seq = Number(input.seq);
  if (!Number.isInteger(seq) || seq < 1) throw fail('WORK_EVENT_SEQ', 'Work event sequence is invalid.', 500);
  return Object.freeze({
    schemaVersion: WORK_EVENT_SCHEMA,
    seq,
    runId: String(input.runId || ''),
    generation: Number(input.generation || 1),
    nodeId: input.nodeId ? String(input.nodeId) : null,
    attemptId: input.attemptId ? String(input.attemptId) : null,
    artifactId: input.artifactId ? String(input.artifactId) : null,
    type: String(input.type || 'status'),
    timestamp: input.timestamp || new Date().toISOString(),
    elapsedActiveMs: Math.max(0, Number(input.elapsedActiveMs || 0)),
    elapsedWaitingMs: Math.max(0, Number(input.elapsedWaitingMs || 0)),
    tokenDelta: Number.isFinite(Number(input.tokenDelta)) ? Number(input.tokenDelta) : null,
    tokenTotal: Number.isFinite(Number(input.tokenTotal)) ? Number(input.tokenTotal) : null,
    tokenExact: Boolean(input.tokenExact),
    targetRef: input.targetRef || null,
    sourceRef: input.sourceRef || null,
    state: input.state || null,
    fallback: input.fallback || null,
    degradation: input.degradation || null,
    publicPayload: input.publicPayload && typeof input.publicPayload === 'object' ? structuredClone(input.publicPayload) : {},
  });
}

export function artifactEnvelope(input = {}) {
  const payload = deepFreeze(structuredClone(input.payload ?? null));
  const envelope = {
    schemaVersion: ARTIFACT_SCHEMA,
    artifactId: String(input.artifactId || newId('artifact')),
    type: String(input.type || 'UnknownArtifact'),
    runId: String(input.runId || ''),
    nodeId: input.nodeId ? String(input.nodeId) : null,
    attemptId: input.attemptId ? String(input.attemptId) : null,
    createdAt: input.createdAt || new Date().toISOString(),
    inputRefs: Object.freeze(Array.isArray(input.inputRefs) ? [...input.inputRefs] : []),
    provenanceRefs: Object.freeze(Array.isArray(input.provenanceRefs) ? [...input.provenanceRefs] : []),
    payloadHash: sha256(payload),
    payload,
    supersedes: input.supersedes || null,
    visibility: input.visibility || 'work',
    retentionClass: input.retentionClass || 'active-run',
  };
  return Object.freeze(envelope);
}

export function validateArtifactEnvelope(value) {
  if (!value || value.schemaVersion !== ARTIFACT_SCHEMA || !value.artifactId || !value.type || !value.runId) return false;
  return value.payloadHash === sha256(value.payload);
}

export function originHash({ chatId, messageId, question } = {}) { return sha256({ chatId:String(chatId||''), messageId:String(messageId||''), question:String(question||'') }); }
