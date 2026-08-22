import fs from 'node:fs';
import { WEB_OPERATION_STATS_FILE } from '../lib/paths.js';
import { sha256 } from './contracts.js';
import { readJsonRecovering, writeJson } from '../services/store.js';

export const TASK_PROFILES = Object.freeze(['history','current-news','software','science','medicine','law','finance-business','government-public-office','general-reference']);
export const SOURCE_CLASSES = Object.freeze(['official-primary','regulator','standards-body','academic-paper','journal','encyclopedia','wire','major-independent-press','specialist-publication','forum','personal-blog','aggregator','official-project','university','international-organization','unknown']);

const CLASS_TASK_TIER = Object.freeze({
  'official-primary': {'government-public-office':0,'law':0,'finance-business':1,'software':1,'current-news':1,'history':1,'science':2,'medicine':2,'general-reference':1},
  regulator: {'law':0,'finance-business':0,'medicine':0,'government-public-office':1,'current-news':1,'science':1,'general-reference':1,'history':2,'software':3},
  'standards-body': {software:0,science:1,medicine:1,law:1,'general-reference':1,'finance-business':2,history:2,'current-news':3,'government-public-office':3},
  'academic-paper': {science:0,medicine:0,history:0,'general-reference':1,software:2,law:2,'finance-business':2,'current-news':3,'government-public-office':3},
  journal: {science:0,medicine:0,history:1,'general-reference':1,'finance-business':2,law:2,'current-news':2,software:3,'government-public-office':3},
  encyclopedia: {history:0,'general-reference':0,'government-public-office':2,science:2,medicine:2,law:2,software:2,'finance-business':2,'current-news':3},
  wire: {'current-news':0,'government-public-office':1,'finance-business':1,'general-reference':2,history:3,science:3,medicine:3,law:3,software:3},
  'major-independent-press': {'current-news':1,'government-public-office':1,'finance-business':2,'general-reference':2,history:3,science:3,medicine:3,law:3,software:3},
  'specialist-publication': {software:1,science:1,medicine:1,law:1,'finance-business':1,'general-reference':2,'current-news':2,history:2,'government-public-office':2},
  'official-project': {software:0,'general-reference':1,science:2,'current-news':2,'finance-business':2,history:3,medicine:3,law:3,'government-public-office':3},
  university: {history:1,science:1,medicine:1,'general-reference':1,law:2,software:2,'finance-business':2,'current-news':3,'government-public-office':3},
  'international-organization': {medicine:0,'finance-business':0,law:1,science:1,'government-public-office':1,'general-reference':1,'current-news':2,history:2,software:3},
  forum: {software:3,'general-reference':4,history:4,'current-news':4,science:4,medicine:5,law:5,'finance-business':5,'government-public-office':5},
  'personal-blog': {software:3,'general-reference':4,history:4,'current-news':4,science:4,medicine:5,law:5,'finance-business':5,'government-public-office':5},
  aggregator: {software:4,'general-reference':4,history:4,'current-news':5,science:5,medicine:5,law:5,'finance-business':5,'government-public-office':5},
  unknown: {software:3,'general-reference':3,history:3,'current-news':3,science:3,medicine:4,law:4,'finance-business':3,'government-public-office':3},
});

const LEDGER_FILE = new URL('./source-ledger-data.json', import.meta.url);
let LEDGER_STATUS = { status:'unloaded', checksum:null, explicitOverrides:0, error:null };
export function validateBundledLedger(value) {
  if (!value || value.version !== 2 || !value.records || typeof value.records !== 'object' || Array.isArray(value.records)) return false;
  if (value.checksum !== sha256(value.records)) return false;
  for (const [domain, record] of Object.entries(value.records)) {
    if (!domain || !record || !Array.isArray(record.classes) || !record.classes.length) return false;
    if (record.classes.some(item => !SOURCE_CLASSES.includes(item))) return false;
    if (record.anchorTasks && (!Array.isArray(record.anchorTasks) || record.anchorTasks.some(item=>!TASK_PROFILES.includes(item)))) return false;
  }
  return true;
}
function loadBundledOverrides() {
  try {
    const value = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    if (!validateBundledLedger(value)) throw new Error('checksum-or-schema');
    LEDGER_STATUS = { status:'ready', checksum:value.checksum, explicitOverrides:Object.keys(value.records).length, error:null };
    return new Map(Object.entries(value.records));
  } catch (error) {
    LEDGER_STATUS = { status:'fallback-class-only', checksum:null, explicitOverrides:0, error:error?.code || error?.message || 'invalid-ledger' };
    return new Map();
  }
}
const OVERRIDES = loadBundledOverrides();

function host(value=''){try{return new URL(value.includes('://')?value:`https://${value}`).hostname.toLowerCase().replace(/^www\./u,'');}catch{return String(value||'').toLowerCase().replace(/^www\./u,'');}}
function domainMatch(domain,key){return domain===key||domain.endsWith(`.${key}`);}
function suffixClasses(domain){
  const out=[];
  if(/(?:^|\.)gov(?:\.[a-z]{2,3})?$/iu.test(domain)||/(?:^|\.)gob\.[a-z]{2}$/iu.test(domain)||domain.endsWith('.nic.in'))out.push('official-primary');
  if(/(?:^|\.)edu(?:\.[a-z]{2})?$/iu.test(domain)||/\.ac\.[a-z]{2}$/iu.test(domain))out.push('university');
  if(/^docs\./iu.test(domain)||domain.endsWith('.readthedocs.io'))out.push('official-project');
  if(domain==='europa.eu'||domain.endsWith('.europa.eu')||domain==='un.org'||domain.endsWith('.un.org'))out.push('international-organization');
  return out;
}
function overrideFor(domain){for(const [key,value] of OVERRIDES)if(domainMatch(domain,key))return{domain:key,...value};return null;}
export function taskProfileFromPlan(plan={}){const c=plan.claimClass||'';if(c==='stable-history')return'history';if(c==='news-current'||c==='weather-current')return'current-news';if(c==='software-latest'||c==='software-change-current'||c==='security-current')return'software';if(c==='current-office')return'government-public-office';if(c==='law-current')return'law';if(c==='medical-current')return'medicine';if(c==='science-current')return'science';if(['market-current','fx-current','retail-current','statistics-current','statistics-drifting'].includes(c))return'finance-business';return plan.taskProfile||'general-reference';}
export function sourceProfileFor(input,plan={},_legacyPrefs={},operational=null){
  const domain=host(input?.domain||input?.url||input);const override=overrideFor(domain);const classes=[...new Set([...(override?.classes||[]),...suffixClasses(domain)])];if(!classes.length)classes.push('unknown');
  const task=taskProfileFromPlan(plan);const taskTier=Math.min(...classes.map(cls=>CLASS_TASK_TIER[cls]?.[task]??CLASS_TASK_TIER[cls]?.['general-reference']??3));
  const anchorTasks=override?.anchorTasks||[];const anchor=Boolean(override&&(!anchorTasks.length||anchorTasks.includes(task)));const anchorTier=anchor?0:1;
  return {domain,classIds:classes,taskProfile:task,taskTier,anchor,anchorTier,anchorDomain:override?.domain||null,userOverride:'neutral',userTier:1,discoveryRole:override?.discoveryRole||'candidate',evidenceRole:override?.evidenceRole||'contextual',operationalStats:operational||null,known:Boolean(override),why:[`task:${task}`,`class:${classes.join('+')}`,anchor?`anchor:${override.domain}`:'anchor:none']};
}
export function preferredAnchorDomains(taskOrPlan='general-reference',{limit=3}={}){
  const task=typeof taskOrPlan==='string'?taskOrPlan:taskProfileFromPlan(taskOrPlan||{});const rows=[];let order=0;
  for(const [domain,record] of OVERRIDES){const tasks=record.anchorTasks||[];if(tasks.length&&!tasks.includes(task)){order+=1;continue;}const classes=record.classes||['unknown'];const tier=Math.min(...classes.map(cls=>CLASS_TASK_TIER[cls]?.[task]??3));rows.push({domain,tier,role:record.discoveryRole||'candidate',order});order+=1;}
  rows.sort((a,b)=>a.tier-b.tier||(a.role==='orientation'?-1:0)-(b.role==='orientation'?-1:0)||a.order-b.order);return rows.slice(0,Math.max(0,limit)).map(x=>x.domain);
}
export function sourceLedgerStats(){return{explicitOverrides:OVERRIDES.size,positiveAnchors:OVERRIDES.size,classRules:SOURCE_CLASSES.length,taskProfiles:TASK_PROFILES.length,coverage:'class-first-unbounded',operationalDomainCapacity:5000,ledgerStatus:LEDGER_STATUS.status,checksum:LEDGER_STATUS.checksum,error:LEDGER_STATUS.error};}

export function createSourceOperations({file=WEB_OPERATION_STATS_FILE,maxDomains=5000}={}){
  let loaded=null;
  async function all(){if(loaded)return loaded;loaded=await readJsonRecovering(file,{version:1,domains:{}});if(!loaded||loaded.version!==1||typeof loaded.domains!=='object')loaded={version:1,domains:{}};return loaded;}
  async function record(domain,{ok=false,latencyMs=0,renderNeeded=false,failureCode=null}={}){domain=host(domain);if(!domain)return;const data=await all();const cur=data.domains[domain]||{attempts:0,successes:0,failures:0,totalLatencyMs:0,renderNeeded:0,lastFailureCode:null,updatedAt:null};cur.attempts+=1;ok?cur.successes+=1:cur.failures+=1;cur.totalLatencyMs+=Math.max(0,Number(latencyMs||0));if(renderNeeded)cur.renderNeeded+=1;cur.lastFailureCode=failureCode?String(failureCode).slice(0,80):cur.lastFailureCode;cur.updatedAt=new Date().toISOString();data.domains[domain]=cur;const keys=Object.keys(data.domains);if(keys.length>maxDomains)keys.sort((a,b)=>Date.parse(data.domains[a].updatedAt||0)-Date.parse(data.domains[b].updatedAt||0)).slice(0,keys.length-maxDomains).forEach(k=>delete data.domains[k]);await writeJson(file,data);}
  async function get(domain){const data=await all();const cur=data.domains[host(domain)];if(!cur)return null;return{attempts:cur.attempts,successRate:cur.attempts?cur.successes/cur.attempts:null,medianLatencyMs:null,averageLatencyMs:cur.attempts?cur.totalLatencyMs/cur.attempts:null,renderRate:cur.attempts?cur.renderNeeded/cur.attempts:null,lastFailureCode:cur.lastFailureCode};}
  async function clear(){loaded={version:1,domains:{}};await writeJson(file,loaded);}
  return{record,get,clear};
}
