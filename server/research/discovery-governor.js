import { canonicalizeUrl } from '../web/discovery.js';
import { rankCandidates } from '../web/rank.js';
import { createSourceOperations } from './source-ledger.js';
import { sha256 } from './contracts.js';

function clean(v=''){return String(v||'').normalize('NFKC').replace(/\s+/gu,' ').trim();}
function host(url){try{return new URL(url).hostname.toLowerCase().replace(/^www\./u,'');}catch{return'';}}
const SECOND_LEVEL_SUFFIXES=new Set(['co.uk','org.uk','ac.uk','gov.uk','com.au','net.au','org.au','co.in','firm.in','net.in','org.in','gen.in','ind.in','co.jp','co.kr','com.br','com.mx','co.nz','co.za','com.sg','com.hk']);
export function publisherGroupForDomain(value=''){const d=host(value.includes?.('://')?value:`https://${value}`)||String(value||'').toLowerCase();const parts=d.split('.').filter(Boolean);if(parts.length<=2)return`publisher:${d}`;const last2=parts.slice(-2).join('.');const root=SECOND_LEVEL_SUFFIXES.has(last2)&&parts.length>=3?parts.slice(-3).join('.'):last2;return`publisher:${root}`;}
function failureCode(attempt={}){const outcome=String(attempt.outcome||'');const code=String(attempt.errorCode||'');if(outcome==='TIMEOUT'||code==='DISCOVERY_TIMEOUT')return'DISCOVERY_TIMEOUT';if(outcome==='RATE_LIMIT'||outcome==='RATE_LIMIT_COOLDOWN'||/429|RATE/u.test(code))return'DISCOVERY_RATE_LIMIT';if(outcome==='CAPTCHA'||outcome==='BLOCKED')return'DISCOVERY_BLOCKED';if(outcome==='PARSE_CHANGED')return'DISCOVERY_PARSE';if(outcome==='ZERO_RESULTS')return'DISCOVERY_EMPTY';if(/DNS|ENOTFOUND|EAI_AGAIN/u.test(code))return'DISCOVERY_DNS';if(outcome==='NETWORK_FAILURE')return'DISCOVERY_OFFLINE';if(outcome==='CIRCUIT_OPEN')return'DISCOVERY_ADAPTER_STORM';return outcome==='RESULTS'?'OK':'DISCOVERY_UNKNOWN';}
function words(v){return new Set(clean(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').split(/\s+/u).filter(x=>x.length>2));}
function simText(a,b){const A=words(a),B=words(b);if(!A.size||!B.size)return 0;let hit=0;for(const t of A)if(B.has(t))hit++;return hit/Math.max(A.size,B.size);}
function commonPrefix(a='',b=''){a=clean(a).toLowerCase();b=clean(b).toLowerCase();let i=0;const n=Math.min(a.length,b.length);while(i<n&&a[i]===b[i])i++;return i;}
function sameContent(a,b){if(!a||!b)return false;if(a.material===b.material||a.snippet&&a.snippet===b.snippet)return true;if(a.snippet.length>=100&&b.snippet.length>=100&&commonPrefix(a.snippet,b.snippet)>=96)return true;const ratio=Math.min(a.material.length,b.material.length)/Math.max(1,Math.max(a.material.length,b.material.length));return a.material.length>=160&&b.material.length>=160&&ratio>=.9&&simText(a.material,b.material)>=.96;}
export function annotateCandidateLineage(candidates=[]){const contentGroups=[];return candidates.map((raw,index)=>{const c={...raw};const d=c.domain||host(c.url);const title=clean(c.title||'');const snippet=clean(c.snippet||'');const material=clean(`${title} ${snippet}`);const informative=material.length>=80||words(material).size>=8;let group=informative?contentGroups.find(g=>sameContent({snippet,material},g)):null;if(!group){const seed=informative?(material||c.url||`${d}:${index}`):(c.url||`${d}:${index}`);group={id:`content:${sha256(seed).slice(0,16)}`,snippet,material};contentGroups.push(group);}c.publisherGroup=c.publisherGroup||publisherGroupForDomain(d);c.contentLineageId=group.id;c.lineageId=c.publisherGroup;return c;});}
function candidateKey(c){try{return canonicalizeUrl(c.url);}catch{return null;}}
export function createDiscoveryGovernor({discovery,preferences:_preferences,sourceOperations=createSourceOperations()}={}){
  if(!discovery)throw new Error('discovery required');
  async function discoverQueries(queries,webPlan,{signal=null,maxCandidates=30,onEvent=null,budget=null}={}){
    const attempts=[];const candidateMap=new Map();let failures=0;let completedQueries=0;let noGainRounds=0;
    const queryBudget=Math.max(1,Math.min(192,Number(budget?.queriesRemaining??queries.length)));
    const failureTolerance=Math.max(6,Math.min(32,6+Number(webPlan?.effort?.level||0)*2));
    const noGainTolerance=Math.max(2,Number(webPlan?.effort?.noGainTolerance||2));
    for(const query of queries.slice(0,queryBudget)){
      if(signal?.aborted)throw signal.reason||Object.assign(new Error('cancelled'),{code:'CANCELLED'});
      onEvent?.('query-started',{queryId:query.id,intent:query.intent,query:query.query,claimIds:query.claimIds});
      const before=candidateMap.size;const plan={...webPlan,query:query.query,variants:[query.query],preferredSourceClasses:query.preferredClasses,queryIntent:query.intent};
      const complementary=String(webPlan?.strategy||'balanced')==='diverse'||query.intent!=='anchor';
      const result=await discovery.discover(plan,{signal,maxResults:Math.min(24,Math.max(8,maxCandidates)),complementary,onAttempt:item=>onEvent?.('discovery-attempt',{queryId:query.id,...item})});
      completedQueries+=1;
      for(const raw of result.attempts||[]){const code=failureCode(raw);attempts.push({...raw,queryId:query.id,failureCode:code});if(code!=='OK'&&code!=='DISCOVERY_EMPTY')failures+=1;onEvent?.('discovery-result',{queryId:query.id,adapter:raw.adapter,outcome:raw.outcome,failureCode:code,count:raw.count||0,durationMs:raw.durationMs||0});}
      for(const item of result.candidates||[]){const key=candidateKey(item);if(!key||candidateMap.has(key))continue;candidateMap.set(key,{...item,url:key,domain:host(key),discoveredFor:[...query.claimIds],queryIntent:query.intent});}
      const gain=candidateMap.size-before;noGainRounds=gain?0:noGainRounds+1;
      onEvent?.('query-completed',{queryId:query.id,intent:query.intent,candidateDelta:gain,candidateCount:candidateMap.size,status:result.status,reason:result.reason||null});
      if(webPlan?.claimClass==='current-office'&&[...candidateMap.values()].some(candidate=>candidate?.structuredEvidence?.kind==='wikidata-current-office'))break;
      if(candidateMap.size>=maxCandidates)break;
      if(failures>=failureTolerance&&completedQueries>=2)break;
      if(noGainRounds>=noGainTolerance&&candidateMap.size>0)break;
    }
    const annotated=annotateCandidateLineage([...candidateMap.values()]);
    const operationalByDomain={};for(const c of annotated)operationalByDomain[c.domain]=await sourceOperations.get(c.domain).catch(()=>null);
    const ranked=rankCandidates(annotated,webPlan,{limit:maxCandidates,operationalByDomain});
    return{status:ranked.length?'success':'failed',candidates:ranked,attempts,completedQueries,failures,degraded:failures>=failureTolerance,noGainRounds};
  }
  return{discoverQueries};
}
