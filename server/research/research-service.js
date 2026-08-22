import { artifactEnvelope, createSourceWork, transitionSourceWork, recoverSourceWork, sourceWorkId } from './contracts.js';
import { TRUTH_VERSION } from './support-guard.js';
import { createResearchBrief, planQueries, researchDecision, researchBudgetPolicy } from './planner.js';
import { createDiscoveryGovernor } from './discovery-governor.js';
import { createPageReader } from './page-reader.js';
import { createPageDossier, revalidatePageDossier } from './dossier.js';
import { evidenceFromDossier, reconcileClaims } from './evidence-ledger.js';
import { buildContextPacket } from './context-builder.js';
import { draftResearchAnswer } from './answerer.js';
import { verifyAndRepair } from './verifier.js';
import { sourceProfileFor, createSourceOperations } from './source-ledger.js';
import { WORK_HEARTBEAT_MS } from '../config.js';

function now(){return new Date().toISOString();}
function approxTokens(v){return Math.max(0,Math.ceil(String(v||'').length/4));}
function domain(url){try{return new URL(url).hostname.toLowerCase().replace(/^www\./u,'');}catch{return'';}}
function canonicalUrl(url){try{const u=new URL(url);u.hash='';if(u.pathname.length>1)u.pathname=u.pathname.replace(/\/+$/u,'');return u.toString();}catch{return String(url||'');}}
function clone(v){return structuredClone(v);}
function packetEvidenceIds(packet){const explicit=packet?.payload?.includedEvidenceIds;if(Array.isArray(explicit))return explicit;return [...new Set((packet?.payload?.claimCoverage||[]).flatMap(c=>c.includedEvidenceIds||[]))];}
const TITLE_STOP=new Set(['use','find','look','lookup','wikipedia','official','current','latest','when','what','where','which','with','from','that','this','were','was','the','and','for','capital','construction','completed','complete','built','year','facts','evidence','source','report']);
function significantTokens(value){return new Set((String(value||'').normalize('NFKC').toLocaleLowerCase('en').match(/[\p{L}\p{N}]{3,}/gu)||[]).filter(token=>!TITLE_STOP.has(token)));}
export function encyclopediaTitleRelevant(page,brief,webPlan={}){if(page?.structuredEvidence)return true;const classes=new Set(page?.sourceProfile?.classIds||page?.rankFeatures?.sourceProfile?.classIds||[]);if(!classes.has('encyclopedia'))return true;const query=String(webPlan?.target||brief?.requiredClaims?.map(claim=>claim.evidenceQuery||claim.text).join(' ')||brief?.question||'');const title=significantTokens(page?.title||'');const wanted=significantTokens(query);if(title.size&&wanted.size){let shared=0;for(const token of wanted)if(title.has(token))shared+=1;if(shared>=Math.max(1,Math.ceil(wanted.size*.6)))return true;}const capital=query.match(/\bcapital\s+of\s+(?:the\s+)?([^?.!,;]+)/iu);if(capital){const subject=significantTokens(capital[1]);const excerpt=String(page?.excerpts?.map(item=>item.text||'').join(' ')||'').toLocaleLowerCase('en');if(/\bcapital\b/u.test(excerpt)&&subject.size&&[...subject].every(token=>excerpt.includes(token)))return true;}return false;}
function researchContextBudget(described){const contextSize=Math.max(0,Number(described?.contextSize||0));if(contextSize>0&&!described?.contextUnknown){const reservedOutputTokens=Math.min(1024,Math.max(384,Math.floor(contextSize*0.18)));const tokenBudget=Math.min(2600,Math.max(512,Math.floor(contextSize*0.25)));return{contextSize,contextUnknown:false,contextEstimated:Boolean(described?.contextEstimated),tokenBudget,reservedOutputTokens};}return{contextSize:null,contextUnknown:true,contextEstimated:true,tokenBudget:1200,reservedOutputTokens:512};}
function truthCurrent(artifact){return Number(artifact?.payload?.truthVersion||0)===TRUTH_VERSION;}
function packetCurrent(artifact){return artifact?.type==='ContextPacket'&&truthCurrent(artifact)&&Number(artifact?.payload?.packetVersion||0)===2;}
export function candidateConsumesPageBudget(candidate){return candidate?.structuredEvidence?.kind!=='wikidata-current-office';}
export function prioritizeResearchCandidates(candidates=[]){return [...candidates].sort((a,b)=>Number(candidateConsumesPageBudget(a))-Number(candidateConsumesPageBudget(b)));}
function budgetFor(brief){const policy=researchBudgetPolicy({budgetClass:brief.budgetClass||'standard',effort:brief.effort});return{budgetClass:policy.budgetClass,queriesRemaining:policy.querySoftCap,pagesRemaining:policy.pageSoftCap,queryLimit:policy.querySoftCap,pageLimit:policy.pageSoftCap,querySoftCap:policy.querySoftCap,pageSoftCap:policy.pageSoftCap,queryHardCap:policy.queryHardCap,pageHardCap:policy.pageHardCap,queriesUsed:0,pagesUsed:0,targetUsefulPages:policy.targetUsefulPages,targetQueryPaths:policy.targetQueryPaths,targetIndependentSources:policy.targetIndependentSources,expansionStep:policy.expansionStep,repairReserve:policy.repairReserve,maxRounds:policy.maxRounds,noGainTolerance:policy.noGainTolerance,maxDurationMs:policy.maxDurationMs,discoveryRounds:0,noGainRounds:0};}
function workBase(brief){return{version:2,kind:'research',status:'running',stage:'planning',startedAt:now(),completedAt:null,live:{label:'Planning what needs verification',detail:null},counters:{queries:0,candidates:0,opened:0,read:0,used:0,claimsSupported:0,claimsTotal:brief.requiredClaims.length},telemetry:{rawWebTextTokens:0,rawWebTextEstimated:true,selectedExcerptTokens:0,selectedExcerptEstimated:true,modelInputTokens:0,modelOutputTokens:0,totalModelTokens:0,allModelCountsExact:true,currentTokPerSec:null},sourceWorks:[],sources:[],claims:brief.requiredClaims.map(c=>({id:c.id,text:c.text,status:c.status})),verification:null,context:null,fallbacks:[],degradations:[],timeline:[]};}
function latestOfType(items,type){return [...items].filter(a=>a?.type===type).sort((a,b)=>Date.parse(a.createdAt||0)-Date.parse(b.createdAt||0)).at(-1)||null;}
function artifactsOfType(items,type){return items.filter(a=>a?.type===type);}
function safeWork(value,brief){const base=workBase(brief);if(!value||typeof value!=='object')return base;return{...base,...clone(value),version:2,status:'running',completedAt:null,live:{label:'Resuming verified research',detail:null},counters:{...base.counters,...clone(value.counters||{})},telemetry:{...base.telemetry,...clone(value.telemetry||{})},sourceWorks:Array.isArray(value.sourceWorks)?clone(value.sourceWorks).slice(0,40):[],sources:Array.isArray(value.sources)?clone(value.sources):[],claims:Array.isArray(value.claims)?clone(value.claims):[],timeline:Array.isArray(value.timeline)?clone(value.timeline).slice(-120):[],fallbacks:Array.isArray(value.fallbacks)?clone(value.fallbacks):[],degradations:Array.isArray(value.degradations)?clone(value.degradations):[]};}

export function createResearchService({web,discovery,preferences,targetExecutor,coordinator,sourceOperations=createSourceOperations()}={}){
  if(!web||!discovery||!preferences||!coordinator)throw new Error('research service dependencies required');
  const discoveryGovernor=createDiscoveryGovernor({discovery,preferences,sourceOperations});
  const pageReader=createPageReader({web,sourceOperations});

  async function execute({runId,messageId,question,webPlan,signal=null,onWork=null,resumeArtifacts=[],resumeWorkSnapshot=null,targetId=null,nodeId='research',allowFallback=true}={}){
    const recovered=Array.isArray(resumeArtifacts)?resumeArtifacts:[];
    const recoveredBrief=latestOfType(recovered,'ResearchBrief');
    const recoveredState=latestOfType(recovered,'ResearchState');
    const brief=recoveredBrief?.payload?.brief||recoveredState?.payload?.brief||createResearchBrief(question,webPlan);
    let claims=clone(recoveredState?.payload?.claims||brief.requiredClaims);
    const budget={...budgetFor(brief),...clone(recoveredState?.payload?.budget||{})};
    const work=safeWork(resumeWorkSnapshot||recoveredState?.payload?.work,brief);
    const artifacts=new Map(recovered.map(a=>[a.artifactId,a]));
    const recoveredEvidence=artifactsOfType(recovered,'EvidenceRecord');
    let evidence=recoveredEvidence.filter(truthCurrent);
    let dossiers=artifactsOfType(recovered,'PageDossier');
    const excerpts=artifactsOfType(recovered,'Excerpt');
    let conflicts=artifactsOfType(recovered,'Conflict').filter(truthCurrent);
    const legacyTruthNeedsRevalidation=recoveredEvidence.some(a=>!truthCurrent(a))||artifactsOfType(recovered,'Conflict').some(a=>!truthCurrent(a));
    const visited=new Set(recoveredState?.payload?.visitedUrls||dossiers.map(a=>a.payload?.url).filter(Boolean));
    const lineages=new Set(recoveredState?.payload?.lineages||evidence.map(a=>a.payload?.independenceGroup).filter(Boolean));
    const contentLineages=new Set(recoveredState?.payload?.contentLineages||[]);
    const executedQueries=new Set(recoveredState?.payload?.executedQueryIds||[]);
    const candidateUrls=new Set(recoveredState?.payload?.candidateUrls||visited);
    let followupUsed=Boolean(recoveredState?.payload?.followupUsed);
    let tokenTotal=Number(work.telemetry?.totalModelTokens||0);
    const collectionStartedAt=Date.now();
    let collectionLimitNoted=false;
    let lastEventAt=Date.now();
    let currentOperation=recovered.length?'Resuming verified research':'Planning what needs verification';
    let latestStateId=recoveredState?.artifactId||null;
    let latestContextPacket=[...artifactsOfType(recovered,'ContextPacket')].filter(packetCurrent).sort((a,b)=>Date.parse(a.createdAt||0)-Date.parse(b.createdAt||0)).at(-1)||null;
    const sourceWorks=new Map();
    for(const raw of Array.isArray(work.sourceWorks)?work.sourceWorks:[]){const recoveredWork=recoverSourceWork(raw);if(recoveredWork)sourceWorks.set(recoveredWork.sourceId,recoveredWork);}
    for(const legacy of Array.isArray(work.sources)?work.sources:[]){const id=sourceWorkId(runId,legacy.url);if(sourceWorks.has(id))continue;sourceWorks.set(id,createSourceWork({runId,sourceId:id,url:legacy.url,domain:legacy.domain,title:legacy.title,state:legacy.used?'used':legacy.status==='skipped'?'skipped':'checked',mode:legacy.mode,reason:legacy.reason,summary:legacy.summary,excerptPreview:legacy.excerptPreview,evidenceAccepted:legacy.evidenceAccepted,evidenceIds:legacy.evidenceIds,claimIds:legacy.claimIds,lineageId:legacy.lineageId,sourceProfile:legacy.sourceProfile}));}
    for(const dossier of dossiers){const d=dossier.payload||{};const id=sourceWorkId(runId,d.url);const existing=sourceWorks.get(id);const relatedEvidence=evidence.filter(a=>a.payload?.sourceId===dossier.artifactId&&a.payload?.accepted);if(existing&&['used','skipped'].includes(existing.state))continue;sourceWorks.set(id,createSourceWork({...existing,runId,sourceId:id,url:d.url,domain:d.domain,title:d.title,state:'checked',mode:d.mode,summary:d.summary,excerptPreview:existing?.excerptPreview||'',excerptCount:(d.excerptIds||[]).length,evidenceAccepted:relatedEvidence.length,evidenceIds:relatedEvidence.map(a=>a.artifactId),claimIds:[...new Set(relatedEvidence.map(a=>a.payload?.claimId).filter(Boolean))],dossierArtifactId:dossier.artifactId,lineageId:d.lineageId,contentLineageId:d.contentLineageId,sourceProfile:d.sourceProfile,revision:Math.max(1,Number(existing?.revision||0)+1)}));}

    // Final result already committed: resume can publish it with zero network/model work.
    const recoveredFinal=[...artifactsOfType(recovered,'VerifiedAnswer')].filter(truthCurrent).sort((a,b)=>Date.parse(a.createdAt||0)-Date.parse(b.createdAt||0)).at(-1)||null;
    const recoveredVerification=[...artifactsOfType(recovered,'VerificationResult')].filter(truthCurrent).sort((a,b)=>Date.parse(a.createdAt||0)-Date.parse(b.createdAt||0)).at(-1)||null;
    if(recoveredFinal&&recoveredVerification){
      const recoveredUsed=new Set((recoveredFinal.payload.sources||[]).map(s=>canonicalUrl(s.url)));for(const [id,item] of [...sourceWorks]){if(item.state==='checked')sourceWorks.set(id,transitionSourceWork(item,recoveredUsed.has(canonicalUrl(item.url))?'used':'skipped',recoveredUsed.has(canonicalUrl(item.url))?{}:{reason:'not-used-in-final'}));}
      work.sourceWorks=[...sourceWorks.values()].sort((a,b)=>Date.parse(a.createdAt||0)-Date.parse(b.createdAt||0)||a.sourceId.localeCompare(b.sourceId)).slice(0,40);for(const source of work.sources)source.used=recoveredUsed.has(canonicalUrl(source.url));work.counters.used=work.sources.filter(s=>s.used).length;
      work.status=recoveredFinal.payload.partial?'partial':'completed';work.stage='complete';work.completedAt=now();work.live={label:work.status==='partial'?'Completed with verified limits':'Research complete',detail:'Recovered from committed verified answer'};
      work.verification={passed:recoveredVerification.payload.passed,unsupportedCount:recoveredVerification.payload.unsupportedCount,repairs:recoveredVerification.payload.repairs?.length||0,unresolvedClaimIds:recoveredVerification.payload.unresolvedClaimIds||[],conflicts:conflicts.length};
      return{brief,claims,answer:recoveredFinal.payload.answer,sources:recoveredFinal.payload.sources||[],work,artifacts:{contextPacket:latestContextPacket,draft:latestOfType(recovered,'AnswerDraft'),verification:recoveredVerification,final:recoveredFinal,dossiers,excerpts,evidence,conflicts},status:work.status,recovered:true};
    }

    const snapshot=()=>{
      work.sourceWorks=[...sourceWorks.values()].sort((a,b)=>Date.parse(a.createdAt||0)-Date.parse(b.createdAt||0)||a.sourceId.localeCompare(b.sourceId)).slice(0,40);
      work.claims=claims.map(c=>({id:c.id,text:c.text,status:c.status,supportingEvidenceIds:[...(c.supportingEvidenceIds||[])],contradictingEvidenceIds:[...(c.contradictingEvidenceIds||[])],independenceCount:new Set(c.independenceGroups||[]).size,resolution:c.resolution||null}));
      work.telemetry.workTokens=Number(work.telemetry.rawWebTextTokens||0)+Number(work.telemetry.modelInputTokens||0)+Number(work.telemetry.modelOutputTokens||0);
      work.telemetry.workTokensEstimated=Boolean(work.telemetry.rawWebTextEstimated||!work.telemetry.allModelCountsExact);
      work.counters.claimsSupported=claims.filter(c=>['supported','strong'].includes(c.status)).length;
      work.counters.candidates=candidateUrls.size;
      return clone(work);
    };
    const event=(type,payload={},meta={})=>{
      lastEventAt=Date.now();
      const snap=snapshot();const publicPayload=meta.omitWork?{messageId,...payload}:{messageId,work:snap,...payload};
      const e=coordinator.publish(runId,type,publicPayload,{stageId:nodeId,tokenTotal,tokenExact:work.telemetry.allModelCountsExact,...meta});
      if(!e)return null;
      const run=coordinator.get(runId);
      if(run){const nodeSnapshots={...(run.nodeSnapshots||{}),[nodeId]:snap,...(nodeId==='research'?{research:snap}:{})};coordinator.attach(runId,{currentStageId:nodeId,nodeSnapshots});}
      onWork?.(snapshot(),e);return e;
    };
    const setLive=(stage,label,detail=null)=>{work.stage=stage;work.live={label,detail};currentOperation=label;event('research-progress',{stage,label,detail});};
    const sourceWorkFor=(url,candidate={})=>{const sourceId=sourceWorkId(runId,url);let item=sourceWorks.get(sourceId);if(!item){item=createSourceWork({runId,sourceId,url,domain:candidate.domain||domain(url),title:candidate.title||'',state:'queued',contentLineageId:candidate.contentLineageId||null,lineageId:candidate.lineageId||null,sourceProfile:candidate.sourceProfile||candidate.rankFeatures?.sourceProfile||null});sourceWorks.set(sourceId,item);event('source-work-delta',{sourceWork:{...item}},{sourceRef:item.url,omitWork:true});}return item;};
    const sourceWorkTransition=(item,nextState,patch={},{emit=true}={})=>{const current=sourceWorks.get(item.sourceId)||item;const next=transitionSourceWork(current,nextState,patch);sourceWorks.set(next.sourceId,next);if(emit)event('source-work-delta',{sourceWork:{...next}},{sourceRef:next.url,omitWork:true});return next;};
    const timeline=(type,label,extra={})=>{work.timeline.push({at:now(),type,label,...extra});if(work.timeline.length>120)work.timeline.splice(0,work.timeline.length-120);};
    const collectionLimitReached=()=>{const elapsedMs=Date.now()-collectionStartedAt;if(elapsedMs<Number(budget.maxDurationMs||120000))return false;if(!collectionLimitNoted){collectionLimitNoted=true;work.degradations.push({code:'RESEARCH_COLLECTION_LIMIT',message:'Evidence collection reached its time limit; KL01 is analysing the useful evidence already gathered.'});timeline('research-collection-limited','Evidence collection time limit reached',{elapsedMs,limitMs:budget.maxDurationMs});event('research-collection-limited',{elapsedMs,limitMs:budget.maxDurationMs});}return true;};
    const commit=async artifact=>{if(signal?.aborted)throw signal.reason||Object.assign(new Error('Research cancelled'),{code:'CANCELLED'});artifacts.set(artifact.artifactId,artifact);await coordinator.commitArtifact(runId,artifact);return artifact;};
    async function revalidateRecoveredTruth(){
      if(!legacyTruthNeedsRevalidation)return false;
      const currentSources=new Set(evidence.map(a=>a.payload?.sourceId).filter(Boolean));
      let rebuilt=0;let changed=false;const originals=[...dossiers];
      for(const original of originals){
        let dossier=original;
        if(!truthCurrent(original)){
          const existing=dossiers.find(x=>truthCurrent(x)&&x.supersedes===original.artifactId);
          dossier=existing||revalidatePageDossier(original,excerpts,{runId,nodeId:`${nodeId}-dossier-revalidate`});
          if(!existing){await commit(dossier);dossiers.push(dossier);changed=true;}
          const source=work.sources.find(x=>canonicalUrl(x.url)===canonicalUrl(original.payload?.url));if(source){source.summary=dossier.payload.summary;source.method=dossier.payload.method;source.truthRevalidated=true;}
        }
        if(currentSources.has(dossier.artifactId))continue;
        if(truthCurrent(dossier)&&Array.isArray(dossier.payload?.facts)&&dossier.payload.facts.length===0){currentSources.add(dossier.artifactId);continue;}
        const derived=evidenceFromDossier(dossier,excerpts,{runId,claims,taskProfile:brief.taskProfile,nodeId:`${nodeId}-evidence-revalidate`});
        for(const artifact of derived){await commit(artifact);evidence.push(artifact);rebuilt+=1;changed=true;}
        currentSources.add(dossier.artifactId);
      }
      if(!changed)return false;
      const reconciled=reconcileClaims(claims,evidence,{runId,nodeId:`${nodeId}-evidence-revalidate`});claims=reconciled.claims;conflicts=reconciled.conflicts;
      for(const conflict of conflicts)await commit(conflict);
      latestContextPacket=null;
      return true;
    }
    const checkpoint=async label=>{
      const state=artifactEnvelope({type:'ResearchState',runId,nodeId,supersedes:latestStateId,payload:{truthVersion:TRUTH_VERSION,label,brief,claims,budget,visitedUrls:[...visited],lineages:[...lineages],contentLineages:[...contentLineages],executedQueryIds:[...executedQueries],candidateUrls:[...candidateUrls],followupUsed,work:snapshot()},inputRefs:[...evidence.map(a=>a.artifactId),...conflicts.map(a=>a.artifactId)].slice(-100),retentionClass:'interrupted-run'});
      await commit(state);latestStateId=state.artifactId;return state;
    };
    const heartbeat=setInterval(()=>{if(Date.now()-lastEventAt>=WORK_HEARTBEAT_MS){timeline('heartbeat',currentOperation);event('research-heartbeat',{stage:work.stage,label:currentOperation});}},WORK_HEARTBEAT_MS);heartbeat.unref?.();
    const telemetry=t=>{if(!t)return;if(Number.isFinite(t.inputTokens)){work.telemetry.modelInputTokens+=t.inputTokens;work.telemetry.allModelCountsExact&&=!t.inputEstimated;}if(Number.isFinite(t.outputTokens)){work.telemetry.modelOutputTokens+=t.outputTokens;work.telemetry.allModelCountsExact&&=!t.outputEstimated;}work.telemetry.totalModelTokens=work.telemetry.modelInputTokens+work.telemetry.modelOutputTokens;work.telemetry.currentTokPerSec=Number(t.outputTokens||0)>0&&Number(t.durationMs||0)>0?Number((Number(t.outputTokens)/(Number(t.durationMs)/1000)).toFixed(1)):work.telemetry.currentTokPerSec||null;tokenTotal=work.telemetry.totalModelTokens;event('research-token-telemetry',{telemetry:clone(work.telemetry)});};

    async function processCandidate(candidate){
      if(signal?.aborted)throw signal.reason;
      if(collectionLimitReached())return false;
      const url=canonicalUrl(candidate.url);
      const consumesPageBudget=candidateConsumesPageBudget(candidate);
      if(!url||visited.has(url)||(consumesPageBudget&&budget.pagesRemaining<=0)||(consumesPageBudget&&Number(budget.pagesUsed||0)>=Number(budget.pageHardCap||32)))return false;
      let sourceWork=sourceWorkFor(url,candidate);
      if(candidate.contentLineageId&&contentLineages.has(candidate.contentLineageId)){sourceWork=sourceWorkTransition(sourceWork,'skipped',{reason:'duplicate-content-lineage'});timeline('source-skipped','Repeated source content',{url,reason:'duplicate-content-lineage',sourceId:sourceWork.sourceId});return false;}
      visited.add(url);if(consumesPageBudget){budget.pagesUsed=Number(budget.pagesUsed||0)+1;budget.pagesRemaining=Math.max(0,Number(budget.pageLimit||budget.pageSoftCap||0)-budget.pagesUsed);}
      sourceWork=sourceWorkTransition(sourceWork,'opening',{title:candidate.title||sourceWork.title,domain:candidate.domain||sourceWork.domain});
      setLive('reading',`Reading ${candidate.domain||domain(url)}`,candidate.title||url);
      const page=await pageReader.read({...candidate,url},{signal,question,claims,onEvent:(type,data)=>{
        if(signal?.aborted)return;
        if(type==='page-reading'&&['opening','reading'].includes(sourceWorks.get(sourceWork.sourceId)?.state)){sourceWork=sourceWorkTransition(sourceWork,'reading',{title:data.title||sourceWork.title,domain:data.domain||sourceWork.domain,mode:data.mode||sourceWork.mode});}
        if(type==='page-extracting'&&['opening','reading','extracting'].includes(sourceWorks.get(sourceWork.sourceId)?.state)){if(sourceWorks.get(sourceWork.sourceId)?.state==='opening')sourceWork=sourceWorkTransition(sourceWork,'reading',{title:data.title||sourceWork.title,domain:data.domain||sourceWork.domain,mode:data.mode||sourceWork.mode});sourceWork=sourceWorkTransition(sourceWork,'extracting',{title:data.title||sourceWork.title,domain:data.domain||sourceWork.domain,mode:data.mode||sourceWork.mode});}
        timeline(type,data.title||data.url||type,{...data,sourceId:sourceWork.sourceId});event(type,{source:{...data,sourceId:sourceWork.sourceId}},{sourceRef:url});
      }});
      if(signal?.aborted)throw signal.reason||Object.assign(new Error('Research cancelled'),{code:'CANCELLED'});
      if(page.status!=='unavailable')work.counters.opened+=1;
      if(page.status!=='usable'){
        const finalState=page.status==='unavailable'?'unavailable':'skipped';sourceWork=sourceWorkTransition(sourceWork,finalState,{url:page.url||url,title:page.title||candidate.title||sourceWork.title,domain:page.domain||candidate.domain||domain(url),reason:page.failure?.code||'unavailable'});
        work.sources.push({sourceId:sourceWork.sourceId,url:page.url||url,title:page.title||candidate.title||'',domain:page.domain||candidate.domain||domain(url),status:'skipped',reason:page.failure?.code||'unavailable',mode:null});
        event('research-source-skipped',{source:work.sources.at(-1)});await checkpoint('source-skipped');return false;
      }
      if(!encyclopediaTitleRelevant(page,brief,webPlan)){
        sourceWork=sourceWorkTransition(sourceWork,'skipped',{url:page.url||url,title:page.title||candidate.title||sourceWork.title,domain:page.domain||candidate.domain||domain(url),reason:'WEB_TITLE_IRRELEVANT'});
        work.sources.push({sourceId:sourceWork.sourceId,url:page.url||url,title:page.title||candidate.title||'',domain:page.domain||candidate.domain||domain(url),status:'skipped',reason:'WEB_TITLE_IRRELEVANT',mode:page.mode});
        timeline('source-skipped','Encyclopedia title does not match the requested subject',{url:page.url||url,reason:'WEB_TITLE_IRRELEVANT',sourceId:sourceWork.sourceId});event('research-source-skipped',{source:work.sources.at(-1)});await checkpoint('source-skipped');return false;
      }
      if(page.lineageId)lineages.add(page.lineageId);if(candidate.contentLineageId)contentLineages.add(candidate.contentLineageId);
      work.telemetry.rawWebTextTokens+=Math.max(0,Math.ceil(Number(page.textChars||0)/4));
      work.telemetry.selectedExcerptTokens+=page.excerpts.reduce((sum,x)=>sum+approxTokens(x.text),0);
      if(sourceWorks.get(sourceWork.sourceId)?.state!=='extracting'){if(sourceWorks.get(sourceWork.sourceId)?.state==='opening')sourceWork=sourceWorkTransition(sourceWork,'reading',{title:page.title,domain:page.domain,mode:page.mode});sourceWork=sourceWorkTransition(sourceWork,'extracting',{title:page.title,domain:page.domain,mode:page.mode});}
      sourceWork=sourceWorkTransition(sourceWork,'summarising',{title:page.title,domain:page.domain,mode:page.mode,excerptCount:page.excerpts.length});
      setLive('summarising',`Summarising ${page.domain}`,`${page.excerpts.length} relevant excerpt${page.excerpts.length===1?'':'s'}`);
      page.contentLineageId=candidate.contentLineageId||page.contentLineageId||null;const d=await createPageDossier(page,{runId,nodeId:`${nodeId}-dossier`,question,claims,targetExecutor,targetId,signal,onTelemetry:telemetry,allowFallback});
      if(signal?.aborted)throw signal.reason||Object.assign(new Error('Research cancelled'),{code:'CANCELLED'});
      for(const a of d.excerptArtifacts){await commit(a);excerpts.push(a);}
      await commit(d.dossierArtifact);dossiers.push(d.dossierArtifact);work.counters.read+=1;
      const ev=evidenceFromDossier(d.dossierArtifact,d.excerptArtifacts,{runId,claims,taskProfile:brief.taskProfile,nodeId:`${nodeId}-evidence`});
      for(const a of ev){await commit(a);evidence.push(a);}
      const reconciled=reconcileClaims(claims,evidence,{runId,nodeId:`${nodeId}-evidence`});claims=reconciled.claims;
      for(const c of reconciled.conflicts){if(conflicts.some(x=>x.payload.claimId===c.payload.claimId&&x.payload.reason===c.payload.reason&&JSON.stringify(x.payload.values||[])===JSON.stringify(c.payload.values||[])))continue;await commit(c);conflicts.push(c);}
      const accepted=ev.filter(a=>a.payload.accepted).length;
      const acceptedEvidence=ev.filter(a=>a.payload.accepted);
      sourceWork=sourceWorkTransition(sourceWork,'checked',{summary:d.dossierArtifact.payload.summary,excerptPreview:d.excerptArtifacts[0]?.payload?.text?.slice(0,500)||'',excerptCount:d.excerptArtifacts.length,evidenceAccepted:accepted,evidenceIds:acceptedEvidence.map(a=>a.artifactId),claimIds:[...new Set(acceptedEvidence.map(a=>a.payload.claimId))],dossierArtifactId:d.dossierArtifact.artifactId,lineageId:page.lineageId,contentLineageId:page.contentLineageId,sourceProfile:d.dossierArtifact.payload.sourceProfile});
      work.sources.push({sourceId:sourceWork.sourceId,url:page.url,title:page.title,domain:page.domain,status:'read',used:false,mode:page.mode,method:d.dossierArtifact.payload.method,summary:d.dossierArtifact.payload.summary,excerptPreview:d.excerptArtifacts[0]?.payload?.text?.slice(0,500)||'',evidenceAccepted:accepted,evidenceIds:acceptedEvidence.map(a=>a.artifactId),evidencePreview:acceptedEvidence.slice(0,6).map(a=>({id:a.artifactId,claimId:a.payload.claimId,statement:a.payload.statement,strength:a.payload.strength,excerptIds:[...(a.payload.excerptIds||[])]})),claimIds:[...new Set(acceptedEvidence.map(a=>a.payload.claimId))],lineageId:page.lineageId,sourceProfile:d.dossierArtifact.payload.sourceProfile});
      timeline('dossier-committed',`Read ${page.domain}`,{acceptedEvidence:accepted,sourceId:sourceWork.sourceId});
      event('research-dossier',{source:work.sources.at(-1),claims:claims.map(c=>({id:c.id,status:c.status}))},{artifactId:d.dossierArtifact.artifactId,sourceRef:page.url});
      await checkpoint('dossier-committed');
      return accepted>0;
    }

    function unresolvedCritical(){return claims.some(c=>c.importance==='critical'&&!['supported','strong','not-applicable'].includes(c.status));}
    function exactStructuredClaimSatisfied(){const acceptedStructured=new Set(evidence.filter(a=>a.payload?.accepted&&a.payload?.strength==='strong'&&a.payload?.provenance?.structuredEvidence?.kind==='wikidata-current-office').map(a=>a.payload.claimId));return claims.filter(c=>c.importance==='critical').every(c=>['supported','strong'].includes(c.status)&&acceptedStructured.has(c.id));}
    function expandProductiveBudget(gain,{degraded=false}={}){if(gain<=0||degraded||!unresolvedCritical())return false;let changed=false;const step=Math.max(1,Number(budget.expansionStep||4));if(budget.queriesRemaining<=0&&Number(budget.queryLimit||0)<Number(budget.queryHardCap||32)){budget.queryLimit=Math.min(Number(budget.queryHardCap||32),Number(budget.queryLimit||0)+step);changed=true;}if(budget.pagesRemaining<=0&&Number(budget.pageLimit||0)<Number(budget.pageHardCap||32)){budget.pageLimit=Math.min(Number(budget.pageHardCap||32),Number(budget.pageLimit||0)+step);changed=true;}budget.queriesRemaining=Math.max(0,Number(budget.queryLimit||0)-Number(budget.queriesUsed||0));budget.pagesRemaining=Math.max(0,Number(budget.pageLimit||0)-Number(budget.pagesUsed||0));if(changed){timeline('research-budget-expanded','Extending productive research',{queryLimit:budget.queryLimit,pageLimit:budget.pageLimit});event('research-budget',{budgetClass:budget.budgetClass,queryLimit:budget.queryLimit,pageLimit:budget.pageLimit,reason:'information-gain'});}return changed;}
    function ensureRepairBudget(reason){const reserve=Math.max(1,Number(budget.repairReserve||4));let changed=false;if(budget.queriesRemaining<=0&&Number(budget.queryLimit||0)<Number(budget.queryHardCap||32)){budget.queryLimit=Math.min(Number(budget.queryHardCap||32),Number(budget.queryLimit||0)+reserve);changed=true;}if(budget.pagesRemaining<=0&&Number(budget.pageLimit||0)<Number(budget.pageHardCap||32)){budget.pageLimit=Math.min(Number(budget.pageHardCap||32),Number(budget.pageLimit||0)+reserve);changed=true;}budget.queriesRemaining=Math.max(0,Number(budget.queryLimit||0)-Number(budget.queriesUsed||0));budget.pagesRemaining=Math.max(0,Number(budget.pageLimit||0)-Number(budget.pagesUsed||0));if(changed){timeline('research-repair-budget',`Reserved research repair budget`,{reason,queryLimit:budget.queryLimit,pageLimit:budget.pageLimit});event('research-budget',{budgetClass:budget.budgetClass,queryLimit:budget.queryLimit,pageLimit:budget.pageLimit,reason});}return changed;}

    function conflictPlanningClaims(ids){const wanted=new Set(ids||[]);return claims.map(claim=>{if(!wanted.has(claim.id))return claim;const conflict=conflicts.find(c=>c.payload?.claimId===claim.id);if(!conflict)return claim;let details=[];if(conflict.payload?.reason==='ATOMIC_VALUE_DISAGREEMENT')details=(conflict.payload.values||[]).map(x=>x.raw).filter(Boolean);else{const refs=new Set(conflict.inputRefs||[]);details=evidence.filter(a=>refs.has(a.artifactId)).map(a=>a.payload?.statement).filter(Boolean);}const suffix=[...new Set(details)].slice(0,4).join(' versus ');return suffix?{...claim,text:`${claim.text} Conflicting evidence: ${suffix}`} : claim;});}
    async function discoverAndRead(claimIds=null,{queryCap=null,pageCap=null,resolution=false,verification=false}={}){
      if(collectionLimitReached())return 0;
      const planningClaims=resolution?conflictPlanningClaims(claimIds):claims;
      budget.discoveryRounds=Number(budget.discoveryRounds||0)+1;
      const planned=planQueries({...brief,requiredClaims:planningClaims},webPlan,{onlyClaimIds:claimIds,includeCounter:true,resolution,verification,explorationRound:budget.discoveryRounds-1});
      const queries=planned.filter(q=>!executedQueries.has(q.id));
      const allowed=Math.min(budget.queriesRemaining,queryCap??queries.length);
      if(allowed<=0)return 0;
      const batch=queries.slice(0,allowed);for(const q of batch)executedQueries.add(q.id);
      setLive('searching',`Searching ${batch.length} query path${batch.length===1?'':'s'}`,resolution?'Targeting conflicting evidence':verification?'Seeking independent confirmation':null);
      const found=await discoveryGovernor.discoverQueries(batch,{...webPlan,taskProfile:brief.taskProfile},{signal,budget:{queriesRemaining:batch.length},maxCandidates:Math.min(30,Math.max(1,budget.pagesRemaining*3)),onEvent:(type,data)=>{if(type==='query-completed')work.counters.queries+=1;timeline(type,data.query||data.intent||type,data);event(type,{query:data});}});
      budget.queriesUsed=Number(budget.queriesUsed||0)+found.completedQueries;budget.queriesRemaining=Math.max(0,Number(budget.queryLimit||budget.querySoftCap||0)-budget.queriesUsed);
      for(const item of found.candidates)candidateUrls.add(canonicalUrl(item.url));
      if(found.degraded&&!work.degradations.some(x=>x.code==='DISCOVERY_DEGRADED'))work.degradations.push({code:'DISCOVERY_DEGRADED',message:'Some search paths failed; continuing with independent paths.'});
      let gain=0;let pages=0;let pageNoGain=0;
      for(const candidate of prioritizeResearchCandidates(found.candidates)){
        const consumesPageBudget=candidateConsumesPageBudget(candidate);
        if(collectionLimitReached())break;if(consumesPageBudget&&pageCap!=null&&pages>=pageCap)break;if(consumesPageBudget&&budget.pagesRemaining<=0)continue;
        if(visited.has(canonicalUrl(candidate.url)))continue;
        const before=claims.map(c=>c.status).join('|');const accepted=await processCandidate(candidate);if(consumesPageBudget)pages+=1;
        const progressed=accepted||before!==claims.map(c=>c.status).join('|');if(progressed){gain+=1;pageNoGain=0;}else pageNoGain+=1;
        const decision=researchDecision({claims,budget,remainingActions:found.candidates.length-pages,lastInformationGain:progressed?1:0});
        if(decision.action==='finish')break;
        if(pageNoGain>=4){timeline('research-no-gain','Changing search path after low-yield pages',{consecutivePages:pageNoGain});break;}
      }
      budget.noGainRounds=gain?0:budget.noGainRounds+1;expandProductiveBudget(gain,{degraded:found.degraded});await checkpoint('discovery-round');return gain;
    }

    function finalizeSourceWorks(finalSources=[]){
      const usedUrls=new Set((finalSources||[]).map(s=>canonicalUrl(s.url)));
      for(const [id,item] of [...sourceWorks.entries()]){
        if(item.state!=='checked')continue;
        const used=usedUrls.has(canonicalUrl(item.url));sourceWorkTransition(item,used?'used':'skipped',used?{}:{reason:'not-used-in-final'});
      }
      for(const source of work.sources)source.used=usedUrls.has(canonicalUrl(source.url));
      work.counters.used=work.sources.filter(s=>s.used).length;
    }

    async function buildAndVerify(contextPacket=null){
      setLive('context','Building evidence packet');
      let packet=contextPacket;
      if(!packet){
        const described=targetExecutor?.describe?await targetExecutor.describe(targetId).catch(()=>null):null;
        const contextBudget=researchContextBudget(described);
        packet=await buildContextPacket({runId,question,claims,evidenceArtifacts:evidence,conflictArtifacts:conflicts,artifactLookup:async id=>artifacts.get(id)||coordinator.artifact(runId,id),targetExecutor,targetId,allowFallback,signal,maxResearchTokens:contextBudget.tokenBudget,reservedOutputTokens:contextBudget.reservedOutputTokens});
        packet=artifactEnvelope({...packet,payload:{...packet.payload,targetContextSize:contextBudget.contextSize,targetContextUnknown:contextBudget.contextUnknown,targetContextEstimated:contextBudget.contextEstimated,reservedOutputTokens:contextBudget.reservedOutputTokens}});
        await commit(packet);latestContextPacket=packet;
      }
      work.context={inputTokens:packet.payload.inputTokens,estimated:packet.payload.estimated,tokenBudget:packet.payload.tokenBudget,targetContextSize:packet.payload.targetContextSize??null,targetContextUnknown:Boolean(packet.payload.targetContextUnknown),targetContextEstimated:Boolean(packet.payload.targetContextEstimated),includedArtifacts:packet.payload.includedArtifactRefs.length,excludedArtifacts:packet.payload.excludedArtifactRefs.length,omittedCriticalScope:packet.payload.omittedCriticalScope};await checkpoint('context-built');
      setLive('drafting','Building answer from accepted evidence');
      let draft=await draftResearchAnswer({runId,question,claims,contextPacket:packet,evidenceArtifacts:evidence,targetExecutor,targetId,signal,allowFallback});if(draft.telemetry)telemetry(draft.telemetry);await commit(draft.artifact);
      setLive('verification','Checking every answer claim');
      let verified=verifyAndRepair({runId,draftArtifact:draft.artifact,claims,evidenceArtifacts:evidence,excerptArtifacts:excerpts,dossierArtifacts:dossiers,conflictArtifacts:conflicts,allowedEvidenceIds:packetEvidenceIds(packet),omittedClaimIds:packet.payload.omittedCriticalScope||[]});await commit(verified.verification);await commit(verified.final);
      return{packet,draft,verified};
    }

    try{
      const revalidatedLegacyTruth=await revalidateRecoveredTruth();
      if(revalidatedLegacyTruth)timeline('truth-revalidated','Revalidated recovered evidence under Truth Engine v2',{evidenceRecords:evidence.length,conflicts:conflicts.length});
      if(!recoveredBrief){const briefArtifact=artifactEnvelope({type:'ResearchBrief',runId,nodeId,payload:{brief},retentionClass:'interrupted-run'});await commit(briefArtifact);}
      event(recovered.length?'research-resumed':'research-started',{brief:{taskProfile:brief.taskProfile,freshness:brief.freshness,claims:brief.requiredClaims.map(c=>({id:c.id,text:c.text}))}});timeline(recovered.length?'research-resumed':'research-started',recovered.length?'Research resumed':'Research started');await checkpoint(recovered.length?'resumed':'brief-committed');

      // If context had already committed before a crash, drafting/verifying resumes with zero refetch.
      if(latestContextPacket){
        const result=await buildAndVerify(latestContextPacket);const {draft,verified}=result;
        finalizeSourceWorks(verified.final.payload.sources);work.verification={passed:verified.verification.payload.passed,unsupportedCount:verified.verification.payload.unsupportedCount,repairs:verified.verification.payload.repairs.length,unresolvedClaimIds:verified.verification.payload.unresolvedClaimIds,conflicts:conflicts.length};work.status=verified.final.payload.partial?'partial':'completed';work.stage='complete';work.live={label:work.status==='partial'?'Completed with verified limits':'Research complete',detail:'Resumed from committed evidence packet'};work.completedAt=now();timeline('research-completed',work.live.label);event('research-completed',{final:{partial:verified.final.payload.partial,sources:verified.final.payload.sources.length}});return{brief,claims,answer:verified.final.payload.answer,sources:verified.final.payload.sources,work:snapshot(),artifacts:{contextPacket:latestContextPacket,draft:draft.artifact,verification:verified.verification,final:verified.final,dossiers,excerpts,evidence,conflicts},status:work.status,recovered:true};
      }

      // Explicit direct URLs are candidates, never evidence shortcuts.
      if(webPlan?.directUrls?.length){for(const rawUrl of webPlan.directUrls.slice(0,Math.min(3,budget.pagesRemaining))){if(collectionLimitReached())break;const url=canonicalUrl(rawUrl);if(visited.has(url))continue;const p=sourceProfileFor({url},{...webPlan,taskProfile:brief.taskProfile}, {}, null);await processCandidate({url,domain:domain(url),title:url,lineageId:null,rankFeatures:{sourceProfile:p},sourceProfile:p});}}

      let rounds=0;
      while(!collectionLimitReached()&&rounds<Number(budget.maxRounds||3)){rounds+=1;const decision=researchDecision({claims,budget,remainingActions:budget.queriesRemaining+budget.pagesRemaining,lastInformationGain:1});if(decision.action!=='continue')break;const gain=await discoverAndRead(decision.claimIds,{queryCap:Math.min(Math.max(3,Number(brief.effort?.level||0)+2),budget.queriesRemaining)});const post=researchDecision({claims,budget,remainingActions:budget.queriesRemaining+budget.pagesRemaining,lastInformationGain:gain});if(post.action!=='continue')break;if(gain===0&&budget.noGainRounds>=Number(budget.noGainTolerance||2))break;}

      const disputed=claims.filter(c=>c.status==='disputed').map(c=>c.id);
      if(disputed.length)ensureRepairBudget('conflict-resolution');
      if(!collectionLimitReached()&&disputed.length&&budget.queriesRemaining>0&&budget.pagesRemaining>0){setLive('conflict-resolution','Resolving conflicting evidence',`${disputed.length} disputed claim${disputed.length===1?'':'s'}`);await discoverAndRead(disputed,{queryCap:Math.min(3,budget.queriesRemaining),pageCap:3,resolution:true});}

      const independent=new Set(evidence.filter(a=>a.payload.accepted).map(a=>a.payload.independenceGroup)).size;
      if(claims.every(c=>['supported','strong'].includes(c.status))&&!exactStructuredClaimSatisfied()&&independent<budget.targetIndependentSources)ensureRepairBudget('independent-verification');
      if(!collectionLimitReached()&&claims.every(c=>['supported','strong'].includes(c.status))&&!exactStructuredClaimSatisfied()&&independent<budget.targetIndependentSources&&budget.queriesRemaining>0&&budget.pagesRemaining>0){setLive('verification-search','Checking independent confirmation');await discoverAndRead(claims.map(c=>c.id),{queryCap:Math.min(2,budget.queriesRemaining),pageCap:2,verification:true});}

      let {packet:contextPacket,draft,verified}=await buildAndVerify();
      if(!followupUsed&&verified.needsFollowupClaimIds.length){ensureRepairBudget('verification-followup');}
      if(!collectionLimitReached()&&!followupUsed&&verified.needsFollowupClaimIds.length&&budget.queriesRemaining>0&&budget.pagesRemaining>0){followupUsed=true;await checkpoint('followup-authorized');setLive('followup','Repairing weak answer claims',`${verified.needsFollowupClaimIds.length} claim${verified.needsFollowupClaimIds.length===1?'':'s'}`);const gain=await discoverAndRead(verified.needsFollowupClaimIds,{queryCap:Math.min(2,budget.queriesRemaining),pageCap:2,verification:true});if(gain){contextPacket=await buildContextPacket({runId,question,claims,evidenceArtifacts:evidence,conflictArtifacts:conflicts,artifactLookup:async id=>artifacts.get(id)||coordinator.artifact(runId,id),targetExecutor,targetId,allowFallback,signal,maxResearchTokens:contextPacket.payload.tokenBudget,reservedOutputTokens:contextPacket.payload.reservedOutputTokens||512});contextPacket=artifactEnvelope({...contextPacket,payload:{...contextPacket.payload,targetContextSize:contextPacket.payload.targetContextSize??null,targetContextUnknown:Boolean(contextPacket.payload.targetContextUnknown),targetContextEstimated:Boolean(contextPacket.payload.targetContextEstimated)}});await commit(contextPacket);latestContextPacket=contextPacket;({draft,verified}=await buildAndVerify(contextPacket));}}

      finalizeSourceWorks(verified.final.payload.sources);
      work.verification={passed:verified.verification.payload.passed,unsupportedCount:verified.verification.payload.unsupportedCount,repairs:verified.verification.payload.repairs.length,unresolvedClaimIds:verified.verification.payload.unresolvedClaimIds,conflicts:conflicts.length};
      work.status=verified.final.payload.partial?'partial':'completed';work.stage='complete';work.live={label:work.status==='partial'?'Completed with verified limits':'Research complete',detail:null};work.completedAt=now();timeline('research-completed',work.live.label);event('research-completed',{final:{partial:verified.final.payload.partial,sources:verified.final.payload.sources.length}});
      return{brief,claims,answer:verified.final.payload.answer,sources:verified.final.payload.sources,work:snapshot(),artifacts:{contextPacket,draft:draft.artifact,verification:verified.verification,final:verified.final,dossiers,excerpts,evidence,conflicts},status:work.status};
    }catch(error){
      work.status=signal?.aborted?'cancelled':'failed';work.stage=signal?.aborted?'cancelled':'failed';work.live={label:signal?.aborted?'Research stopped':'Research failed',detail:error?.publicMessage||error?.message||'Unknown failure'};work.completedAt=now();timeline('research-failed',work.live.label,{code:error?.code||error?.name||'UNKNOWN'});event('research-failed',{error:{code:error?.code||error?.name||'UNKNOWN',message:work.live.detail}});throw error;
    }finally{clearInterval(heartbeat);}
  }

  async function research(args={}){return execute({...args,resumeArtifacts:[]});}
  async function resumeResearch(args={}){const resumeArtifacts=args.resumeArtifacts||await coordinator.artifacts(args.runId);const nodeId=args.nodeId||'research';const live=coordinator.get(args.runId);const resumeWorkSnapshot=args.resumeWorkSnapshot||live?.nodeSnapshots?.[nodeId]||(nodeId==='research'?live?.nodeSnapshots?.research:null)||null;return execute({...args,resumeArtifacts,resumeWorkSnapshot});}
  return{research,resumeResearch,limits:{wholeRunDeadline:false,adaptive:{lookup:researchBudgetPolicy('lookup'),standard:researchBudgetPolicy('standard'),extended:researchBudgetPolicy('extended')},hardCaps:{queries:8,pages:5,collectionMs:180000},stallWatchdogMs:10000,heartbeatMs:WORK_HEARTBEAT_MS,recoveryMs:30*60*1000}};
}
