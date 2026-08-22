import { artifactEnvelope, sha256 } from './contracts.js';
import { TRUTH_VERSION } from './support-guard.js';

function clean(v){return String(v??'').normalize('NFC').replace(/\s+/gu,' ').trim();}
function approxTokens(v){return Math.max(1,Math.ceil(String(v||'').length/4));}
function strengthWeight(v){return v==='strong'?5:v==='moderate'?3:1;}
function importanceWeight(v){return v==='critical'?5:v==='high'?3:1;}
function freshnessWeight(record,claim){return claim?.freshness==='high'&&record?.freshness?.satisfied?3:0;}
function relevanceWeight(record){return Math.max(0,Math.min(1,Number(record?.evidenceDimensions?.claimRelevance||0)))*4;}
function roleWeight(e){const role=String(e?.provenance?.evidenceRole||'');const page=String(e?.provenance?.pageRole?.kind||'');return /primary|official|regulator|standard/u.test(role)||['primary-document','official-overview'].includes(page)?2:0;}
function recordText(record,excerpt){const p=record.payload;const source=`${p.provenance?.domain||''} ${p.provenance?.url||''}`.trim();return `[${record.artifactId}] claim=${p.claimId} stance=${p.stance} source=${source}\nStatement: ${clean(p.statement)}\nExact excerpt: ${clean(excerpt?.payload?.text||'')}`;}
function claimHeader(claim){return `CLAIM ${claim.id} [${claim.status}] ${clean(claim.text)}`;}
function abortIf(signal){if(signal?.aborted){const error=new Error('Evidence assembly cancelled');error.code='EVIDENCE_CANCEL';throw error;}}
function contextOverflow(message='Critical evidence cannot fit the selected model context.'){const error=new Error(message);error.code='CONTEXT_OVERFLOW';error.publicMessage='Context full · prioritising critical evidence';return error;}
function reqFor(claim){return{minAccepted:Math.max(1,Number(claim?.evidenceRequirement?.minAccepted||1)),minIndependent:Math.max(1,Number(claim?.evidenceRequirement?.minIndependent||1)),preferredClasses:[...(claim?.evidenceRequirement?.preferredClasses||[])],primaryPreferred:Boolean(claim?.evidenceRequirement?.primaryPreferred)};}
function unitEvidenceCount(unit){return unit.members.length;}
function unitGroups(unit){return new Set(unit.members.map(x=>x.record.payload.independenceGroup).filter(Boolean));}
function unitContents(unit){return new Set(unit.members.map(x=>x.record.payload.provenance?.contentLineageId).filter(Boolean));}
function unitHasPrimary(unit){return unit.members.some(x=>roleWeight(x.record.payload)>0);}
function unitPreferredClasses(unit,claim){const wanted=new Set(reqFor(claim).preferredClasses);return [...new Set(unit.members.flatMap(x=>x.record.payload.provenance?.sourceClasses||[]).filter(x=>wanted.has(x)))];}
function unitScore(unit,selectedGroups,claim){const groups=[...unitGroups(unit)];const novel=groups.filter(x=>!selectedGroups.has(x)).length;const req=reqFor(claim);const primaryBonus=req.primaryPreferred&&unitHasPrimary(unit)?12:0;const classBonus=unitPreferredClasses(unit,claim).length*3;return novel*20+primaryBonus+classBonus+unit.value-(unit.cost/5000);}
function proofStatus(claim,rows,conflictIds=[]){const req=reqFor(claim);const evidenceIds=[...new Set(rows.map(x=>x.record.artifactId))];const groups=[...new Set(rows.map(x=>x.record.payload.independenceGroup).filter(Boolean))];const classes=[...new Set(rows.flatMap(x=>x.record.payload.provenance?.sourceClasses||[]))];const primaryIncluded=rows.some(x=>roleWeight(x.record.payload)>0);const disputed=claim.status==='disputed';const conflictPreserved=disputed&&conflictIds.length>0&&evidenceIds.length>=2;const meetsCount=evidenceIds.length>=req.minAccepted;const meetsIndependent=groups.length>=req.minIndependent;const meetsRequirement=disputed?conflictPreserved:(['supported','strong'].includes(claim.status)?meetsCount&&meetsIndependent:false);return{claimId:claim.id,status:claim.status,requiredAccepted:req.minAccepted,requiredIndependent:req.minIndependent,primaryPreferred:req.primaryPreferred,preferredClasses:req.preferredClasses,evidenceIds,independenceGroups:groups,sourceClasses:classes,primaryIncluded,conflictIds,conflictPreserved,meetsRequirement,complete:['supported','strong'].includes(claim.status)?meetsRequirement:disputed?conflictPreserved:false};}

export async function buildContextPacket({runId,question,claims,evidenceArtifacts,conflictArtifacts=[],artifactLookup,targetExecutor=null,targetId=null,maxResearchTokens=6000,reservedOutputTokens=1500,nodeId='research-context',allowFallback=true,signal=null}={}){
  abortIf(signal);
  const accepted=evidenceArtifacts.filter(a=>a.payload?.accepted);
  const excerptCache=new Map();
  async function excerptFor(record){
    abortIf(signal);
    for(const id of record.payload.excerptIds||[]){
      if(excerptCache.has(id))return excerptCache.get(id);
      const item=await artifactLookup?.(id);abortIf(signal);
      if(item){excerptCache.set(id,item);return item;}
    }
    return null;
  }
  const candidates=[];const seen=new Set();
  for(const claim of claims){
    abortIf(signal);
    const related=accepted.filter(a=>a.payload.claimId===claim.id);
    for(const record of related){
      const excerpt=await excerptFor(record);abortIf(signal);
      const key=`${claim.id}|${record.payload.independenceGroup}|${clean(record.payload.statement).toLowerCase()}`;
      if(seen.has(key))continue;seen.add(key);
      const text=recordText(record,excerpt);const cost=approxTokens(text);
      const conflict=conflictArtifacts.some(c=>c.payload?.claimId===claim.id&&c.inputRefs?.includes(record.artifactId));
      const value=(importanceWeight(claim.importance)*strengthWeight(record.payload.strength)+roleWeight(record.payload)+freshnessWeight(record.payload,claim)+relevanceWeight(record.payload)+(conflict?8:0)+(record.payload.atomicValue?2:0))/cost;
      candidates.push({claim,record,excerpt,text,cost,value,conflict});
    }
  }
  candidates.sort((a,b)=>b.value-a.value||a.cost-b.cost);

  // Conflict sides are indivisible. Context compression may remove a whole conflict,
  // but never retain one side while hiding the other.
  const units=[];const claimedByConflict=new Set();const duplicateLineageExcluded=[];let unitSeq=0;
  for(const conflict of conflictArtifacts){
    const claim=claims.find(c=>c.id===conflict.payload?.claimId);if(!claim)continue;
    const refs=new Set(conflict.inputRefs||[]);const members=candidates.filter(x=>x.claim.id===claim.id&&refs.has(x.record.artifactId));
    if(members.length<2)continue;
    members.forEach(x=>claimedByConflict.add(x.record.artifactId));
    units.push({id:`unit-${++unitSeq}`,kind:'conflict',claim,members,cost:members.reduce((n,x)=>n+x.cost,0),value:members.reduce((n,x)=>n+x.value,0)+16,critical:claim.importance==='critical',conflictId:conflict.artifactId});
  }
  // Equivalent accepted records from the same content lineage add no independent proof.
  // Keep the highest-value representative unless a record is part of an explicit conflict set.
  // This is a second line of defence after discovery syndication collapse because retries,
  // recovery, and separately generated dossiers can still reintroduce duplicate evidence.
  const lineageSeen=new Set();
  for(const item of candidates){
    if(claimedByConflict.has(item.record.artifactId))continue;
    const lineage=String(item.record.payload.provenance?.contentLineageId||'');
    const key=lineage?`${item.claim.id}|${item.record.payload.stance}|${lineage}`:null;
    if(key&&lineageSeen.has(key)){duplicateLineageExcluded.push({artifactId:item.record.artifactId,reason:'DUPLICATE_CONTENT_LINEAGE'});continue;}
    if(key)lineageSeen.add(key);
    units.push({id:`unit-${++unitSeq}`,kind:'record',claim:item.claim,members:[item],cost:item.cost,value:item.value,critical:item.claim.importance==='critical',conflictId:null});
  }
  units.sort((a,b)=>Number(b.critical)-Number(a.critical)||b.value-a.value||a.cost-b.cost);

  const selectedUnits=[];const protectedUnitIds=new Set();const excluded=[...duplicateLineageExcluded];const forcedOmitted=new Set();let used=approxTokens(question)+80;
  const selectUnit=(unit,{protect=false}={})=>{if(selectedUnits.includes(unit))return true;if(used+unit.cost>maxResearchTokens)return false;selectedUnits.push(unit);used+=unit.cost;if(protect)protectedUnitIds.add(unit.id);return true;};

  // Build a minimum ProofSet for every critical claim. Supported/strong claims must
  // preserve their evidenceRequirement counts and independence; disputed claims must
  // preserve both sides of a known conflict. Weak/unresolved claims receive their best
  // available evidence without pretending that it is a complete proof.
  for(const claim of claims.filter(c=>c.importance==='critical')){
    const options=units.filter(u=>u.claim.id===claim.id);if(!options.length)continue;
    const chosen=[];const groups=new Set();let acceptedCount=0;
    if(claim.status==='disputed'){
      const conflict=options.find(u=>u.kind==='conflict');
      if(conflict)chosen.push(conflict);
      else chosen.push(options[0]);
    }else if(['supported','strong'].includes(claim.status)){
      const req=reqFor(claim);const remaining=[...options];
      while(remaining.length&&(acceptedCount<req.minAccepted||groups.size<req.minIndependent)){
        remaining.sort((a,b)=>unitScore(b,groups,claim)-unitScore(a,groups,claim));
        const pick=remaining.shift();chosen.push(pick);acceptedCount+=unitEvidenceCount(pick);for(const g of unitGroups(pick))groups.add(g);
      }
    }else chosen.push(options[0]);
    const cost=chosen.reduce((n,u)=>n+u.cost,0);
    const claimRows=chosen.flatMap(u=>u.members);const conflictIds=chosen.filter(u=>u.conflictId).map(u=>u.conflictId);
    const required=proofStatus(claim,claimRows,conflictIds);
    const structurallyComplete=!['supported','strong','disputed'].includes(claim.status)||required.meetsRequirement;
    if(structurallyComplete&&used+cost<=maxResearchTokens){for(const u of chosen)selectUnit(u,{protect:true});}
    else{
      forcedOmitted.add(claim.id);
      for(const u of chosen)for(const member of u.members)excluded.push({artifactId:member.record.artifactId,reason:structurallyComplete?(u.kind==='conflict'?'CONFLICT_SET_NO_FIT':'PROOF_SET_NO_FIT'):'PROOF_SET_INCOMPLETE'});
    }
  }

  const selected=()=>selectedUnits.flatMap(u=>u.members);
  // Add useful redundancy after minimum ProofSets fit, never leaking a single side of
  // an omitted conflict or adding partial evidence to a claim whose minimum proof was omitted.
  const remaining=units.filter(unit=>!selectedUnits.includes(unit)&&!forcedOmitted.has(unit.claim.id));
  while(remaining.length){
    const selectedGroups=new Set(selected().map(x=>x.record.payload.independenceGroup).filter(Boolean));const selectedContents=new Set(selected().map(x=>x.record.payload.provenance?.contentLineageId).filter(Boolean));
    remaining.sort((a,b)=>{const novelty=u=>[...unitGroups(u)].filter(x=>!selectedGroups.has(x)).length*8+[...unitContents(u)].filter(x=>!selectedContents.has(x)).length*5;return novelty(b)-novelty(a)||b.value-a.value||a.cost-b.cost;});
    const unit=remaining.shift();if(selectUnit(unit))continue;for(const member of unit.members)excluded.push({artifactId:member.record.artifactId,reason:unit.kind==='conflict'?'CONFLICT_SET_NO_FIT':'TOKEN_BUDGET'});
  }

  function buildText(){
    const rows=selected();const sections=[];
    for(const claim of claims){
      const claimRows=rows.filter(x=>x.claim.id===claim.id);sections.push(claimHeader(claim));
      if(!claimRows.length){sections.push('No accepted evidence included for this claim.');continue;}
      for(const row of claimRows)sections.push(row.text);
      const conflict=conflictArtifacts.find(c=>c.payload?.claimId===claim.id&&selectedUnits.some(u=>u.conflictId===c.artifactId));if(conflict)sections.push(`CONFLICT ${conflict.artifactId}: ${conflict.payload.reason}`);
    }
    return `QUESTION\n${clean(question)}\n\nEVIDENCE\n${sections.join('\n\n')}\n\nINSTRUCTIONS\nUse only accepted evidence above for factual claims. Preserve disputed/unresolved status. Do not add unsupported facts.`;
  }
  async function tokenCount(text){
    abortIf(signal);
    if(!targetExecutor)return{count:approxTokens(text),estimated:true};
    const result=await targetExecutor.count([{role:'user',content:text}],{runId,stageId:nodeId,targetId,allowFallback,signal});abortIf(signal);return result;
  }

  let packetText=buildText();let count=await tokenCount(packetText);const removed=[];
  // Exact tokenizer may make approximations optimistic. Remove only unprotected extras first.
  while(count.count>maxResearchTokens&&selectedUnits.length){
    abortIf(signal);
    let removable=-1;
    for(let i=selectedUnits.length-1;i>=0;i--){if(!protectedUnitIds.has(selectedUnits[i].id)){removable=i;break;}}
    if(removable<0)break;
    const [drop]=selectedUnits.splice(removable,1);
    for(const member of drop.members)removed.push({artifactId:member.record.artifactId,reason:'TOKENIZER_REPACK'});
    packetText=buildText();count=await tokenCount(packetText);
  }
  // If minimum ProofSets themselves cannot fit under exact tokenization, omit whole claims
  // lowest-value/importance first. Never nibble evidence out of a proof set.
  while(count.count>maxResearchTokens&&selectedUnits.length){
    abortIf(signal);
    const represented=[...new Set(selectedUnits.map(u=>u.claim.id))].map(id=>{
      const claim=claims.find(c=>c.id===id);const claimUnits=selectedUnits.filter(u=>u.claim.id===id);
      return{claim,units:claimUnits,value:claimUnits.reduce((n,u)=>n+u.value,0),importance:importanceWeight(claim?.importance)};
    }).sort((a,b)=>a.importance-b.importance||a.value-b.value);
    const victim=represented[0];if(!victim)break;forcedOmitted.add(victim.claim.id);
    for(const unit of victim.units){const idx=selectedUnits.indexOf(unit);if(idx>=0)selectedUnits.splice(idx,1);protectedUnitIds.delete(unit.id);for(const member of unit.members)removed.push({artifactId:member.record.artifactId,reason:'TOKENIZER_SCOPE_REDUCTION'});}
    packetText=buildText();count=await tokenCount(packetText);
  }
  if(count.count>maxResearchTokens)throw contextOverflow();

  const rows=selected();const includedEvidenceIds=[...new Set(rows.map(x=>x.record.artifactId))];
  const proofSets=claims.map(claim=>{
    const claimRows=rows.filter(x=>x.claim.id===claim.id);const conflictIds=selectedUnits.filter(u=>u.claim.id===claim.id&&u.conflictId).map(u=>u.conflictId);const proof=proofStatus(claim,claimRows,conflictIds);
    const acceptedForClaim=accepted.filter(a=>a.payload.claimId===claim.id);
    return{...proof,omitted:forcedOmitted.has(claim.id)||(!proof.evidenceIds.length&&acceptedForClaim.length>0),acceptedEvidenceCount:acceptedForClaim.length};
  });
  const omittedCritical=claims.filter(c=>c.importance==='critical'&&(forcedOmitted.has(c.id)||(!proofSets.find(p=>p.claimId===c.id)?.meetsRequirement&&['supported','strong','disputed'].includes(c.status)))).map(c=>c.id);
  const allExcluded=[...excluded,...removed];
  const omittedScopeLedger=claims.map(claim=>{const acceptedIds=accepted.filter(a=>a.payload.claimId===claim.id).map(a=>a.artifactId);const proof=proofSets.find(p=>p.claimId===claim.id);const includedIds=proof?.evidenceIds||[];const omittedIds=acceptedIds.filter(id=>!includedIds.includes(id));if(!omittedIds.length&&!forcedOmitted.has(claim.id)&&proof?.meetsRequirement)return null;const reasons=[...new Set(allExcluded.filter(x=>omittedIds.includes(x.artifactId)).map(x=>x.reason))];return{claimId:claim.id,status:claim.status,acceptedEvidenceCount:acceptedIds.length,includedEvidenceCount:includedIds.length,requiredAccepted:proof?.requiredAccepted||1,requiredIndependent:proof?.requiredIndependent||1,selectedIndependent:proof?.independenceGroups?.length||0,meetsRequirement:Boolean(proof?.meetsRequirement),omittedEvidenceIds:omittedIds,reasons:reasons.length?reasons:[forcedOmitted.has(claim.id)?'CLAIM_SCOPE_OMITTED':proof?.meetsRequirement?'NOT_SELECTED':'PROOF_REQUIREMENT_NOT_REPRESENTED']};}).filter(Boolean);
  const evidenceSnapshotRefs=[...new Set(accepted.map(a=>a.artifactId))].sort();const evidenceSnapshotHash=sha256(evidenceSnapshotRefs);
  const payload={truthVersion:TRUTH_VERSION,packetVersion:2,question,evidenceSnapshotRefs,evidenceSnapshotHash,claimCoverage:claims.map(c=>({claimId:c.id,status:c.status,includedEvidenceIds:proofSets.find(p=>p.claimId===c.id)?.evidenceIds||[],meetsRequirement:Boolean(proofSets.find(p=>p.claimId===c.id)?.meetsRequirement),omitted:Boolean(omittedCritical.includes(c.id))})),proofSets,omittedScopeLedger,includedEvidenceIds,includedArtifactRefs:[...new Set([...rows.flatMap(x=>[x.record.artifactId,...(x.record.payload.excerptIds||[])]),...selectedUnits.map(u=>u.conflictId).filter(Boolean)])],excludedArtifactRefs:allExcluded,tokenBudget:maxResearchTokens,inputTokens:count.count,estimated:Boolean(count.estimated),reservedOutputTokens,compressionActions:[...(excluded.length?['exclude-low-value-or-over-budget']:[]),...(removed.some(x=>x.reason==='TOKENIZER_REPACK')?['tokenizer-repack']:[]),...(removed.some(x=>x.reason==='TOKENIZER_SCOPE_REDUCTION')?['claim-value-scope-reduction']:[]),...(conflictArtifacts.length?['preserve-conflict-sets']:[]),...([...proofSets].some(p=>p.requiredAccepted>1||p.requiredIndependent>1)?['preserve-proof-requirements']:[])],packetText,omittedCriticalScope:omittedCritical};
  return artifactEnvelope({type:'ContextPacket',runId,nodeId,payload,inputRefs:[...new Set([...payload.evidenceSnapshotRefs,...payload.includedArtifactRefs])],provenanceRefs:payload.includedArtifactRefs,retentionClass:'interrupted-run'});
}
