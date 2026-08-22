import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearchBrief } from '../server/research/planner.js';
import { createPageReader } from '../server/research/page-reader.js';
import { createPageDossier } from '../server/research/dossier.js';
import { evidenceFromDossier, reconcileClaims } from '../server/research/evidence-ledger.js';
import { buildContextPacket } from '../server/research/context-builder.js';
import { draftResearchAnswer } from '../server/research/answerer.js';
import { verifyAndRepair } from '../server/research/verifier.js';
import { planResearchActivation } from '../server/research/activation.js';
import { candidateConsumesPageBudget, prioritizeResearchCandidates } from '../server/research/research-service.js';
import { artifactEnvelope } from '../server/research/contracts.js';

const officePlan={
  useWeb:true,
  claimClass:'current-office',
  freshness:'current',
  target:'India',
  officeRole:'prime minister',
  strategy:'balanced',
};

test('office targets remove full role names after possessive normalization',()=>{
  const cases=[
    ["who is the UK's current prime minister",'United Kingdom','prime minister'],
    ["who is Canada's current prime minister",'Canada','prime minister'],
    ["who is India's current president",'India','president'],
  ];
  for(const [question,target,officeRole] of cases){const plan=planResearchActivation(question,{strategy:'balanced'});assert.equal(plan.claimClass,'current-office',question);assert.equal(plan.target,target,question);assert.equal(plan.officeRole,officeRole,question);assert.equal(plan.query,`${target} ${officeRole} current`,question);}
});

test('software freshness detection permits dotted product names',()=>{
  const plan=planResearchActivation('Look up the current Node.js LTS release',{strategy:'balanced'});
  assert.equal(plan.claimClass,'software-latest');
  assert.equal(plan.freshness,'current');
});

function structuredCandidate(){
  return {
    url:'https://www.wikidata.org/wiki/Q192711',
    title:'Narendra Modi — Prime Minister of India',
    timestampHint:'2014-05-26',
    sourceProfile:{
      domain:'wikidata.org',
      classIds:['encyclopedia'],
      taskProfile:'government-public-office',
      taskTier:2,
      anchor:true,
      evidenceRole:'contextual',
    },
    structuredEvidence:{
      kind:'wikidata-current-office',
      text:'Narendra Modi is the current prime minister of India.',
      officeId:'Q192711',
      personId:'Q1058',
      personName:'Narendra Modi',
      officeLabel:'Prime Minister of India',
      officeRole:'prime minister',
      target:'India',
      startDate:'2014-05-26',
      retrievedAt:'2026-08-13T02:00:00.000Z',
    },
  };
}

test('current office structured evidence survives the complete truth pipeline',async()=>{
  const brief=createResearchBrief('who is indias pm',officePlan);
  assert.equal(brief.requiredClaims[0].evidenceQuery,'current prime minister of India');
  assert.deepEqual(brief.requiredClaims[0].evidenceRequirement,{minAccepted:1,minIndependent:1,preferredClasses:['official-primary','wire','major-independent-press'],primaryPreferred:true,current:true});

  const reader=createPageReader({
    web:{fetch:async()=>{throw new Error('structured evidence must not refetch');},render:async()=>{throw new Error('structured evidence must not render');}},
    sourceOperations:{record:async()=>{}},
  });
  const page=await reader.read(structuredCandidate(),{question:brief.question,claims:brief.requiredClaims});
  assert.equal(page.timestampHint,'2026-08-13T02:00:00.000Z');
  assert.equal(page.structuredEvidence.personName,'Narendra Modi');

  let modelCalls=0;
  const dossier=await createPageDossier(page,{runId:'run-office',question:brief.question,claims:brief.requiredClaims,targetExecutor:{complete:async()=>{modelCalls+=1;throw new Error('not expected');}}});
  assert.equal(modelCalls,0);
  assert.equal(dossier.dossierArtifact.payload.method,'structured-exact');
  assert.deepEqual(dossier.dossierArtifact.payload.facts.map(f=>({stance:f.stance,factKind:f.factKind,atomicValue:f.atomicValue})),[{stance:'supports',factKind:'identity',atomicValue:'Narendra Modi'}]);

  const evidence=evidenceFromDossier(dossier.dossierArtifact,dossier.excerptArtifacts,{runId:'run-office',claims:brief.requiredClaims,taskProfile:brief.taskProfile});
  assert.equal(evidence.length,1);
  assert.equal(evidence[0].payload.accepted,true,evidence[0].payload.rejectionReason);
  assert.equal(evidence[0].payload.freshness.timestampBasis,'parsed-timestamp');
  const reconciled=reconcileClaims(brief.requiredClaims,evidence,{runId:'run-office'});
  assert.equal(reconciled.claims[0].status,'strong');

  const byId=new Map([...dossier.excerptArtifacts,evidence].map(item=>[item.artifactId,item]));
  const context=await buildContextPacket({runId:'run-office',question:brief.question,claims:reconciled.claims,evidenceArtifacts:evidence,artifactLookup:async id=>byId.get(id),maxResearchTokens:1200});
  let answerModelCalls=0;const draft=await draftResearchAnswer({runId:'run-office',question:brief.question,claims:reconciled.claims,contextPacket:context,evidenceArtifacts:evidence,targetExecutor:{complete:async()=>{answerModelCalls+=1;throw new Error('not expected');}}});
  assert.equal(answerModelCalls,0);
  const verified=verifyAndRepair({runId:'run-office',draftArtifact:draft.artifact,claims:reconciled.claims,evidenceArtifacts:evidence,excerptArtifacts:dossier.excerptArtifacts,dossierArtifacts:[dossier.dossierArtifact],allowedEvidenceIds:context.payload.includedEvidenceIds});
  assert.match(verified.final.payload.answer,/Narendra Modi is the current prime minister of India/u);
  assert.equal(verified.final.payload.partial,false);
  assert.equal(verified.final.payload.sources.length,1);
});

test('late structured office evidence outranks pages and does not spend the page budget',()=>{
  const ordinary={url:'https://en.wikipedia.org/wiki/President_of_Mexico'};
  const structured={...structuredCandidate(),url:'https://www.wikidata.org/wiki/Q6294'};
  assert.equal(candidateConsumesPageBudget(ordinary),true);
  assert.equal(candidateConsumesPageBudget(structured),false);
  assert.deepEqual(prioritizeResearchCandidates([ordinary,structured]),[structured,ordinary]);
});

test('verifier replaces a cited question restatement with exact evidence',async()=>{
  const brief=createResearchBrief('who is indias pm',officePlan);const claim={...brief.requiredClaims[0],status:'strong'};
  const excerpt={schemaVersion:1,artifactId:'excerpt-1',type:'Excerpt',runId:'run-echo',payload:{text:'Narendra Modi is the current prime minister of India.'}};
  const evidence={schemaVersion:1,artifactId:'evidence-1',type:'EvidenceRecord',runId:'run-echo',payload:{accepted:true,claimId:claim.id,statement:'Narendra Modi is the current prime minister of India.',excerptIds:['excerpt-1'],provenance:{url:'https://www.wikidata.org/wiki/Q192711',domain:'wikidata.org'}}};
  const draft={schemaVersion:1,artifactId:'draft-1',type:'AnswerDraft',runId:'run-echo',payload:{sentences:[{text:'who is indias pm',evidenceIds:['evidence-1'],claimIds:[claim.id],kind:'factual'}]}};
  const verified=verifyAndRepair({runId:'run-echo',draftArtifact:draft,claims:[claim],evidenceArtifacts:[evidence],excerptArtifacts:[excerpt],allowedEvidenceIds:['evidence-1']});
  assert.match(verified.final.payload.answer,/Narendra Modi/u);assert.equal(verified.verification.payload.repairs[0].reason,'QUESTION_RESTATEMENT');
});

test('ordinary page analysis receives the user question explicitly',async()=>{
  const claim={id:'claim-1',text:'What is the current Node.js LTS release?',evidenceQuery:'current Node.js LTS release',importance:'critical',freshness:'high'};
  const page={
    url:'https://nodejs.org/en/download',domain:'nodejs.org',title:'Download Node.js',mode:'direct',timestampHint:'2026-08-13',contentHash:'abc',durationMs:10,lineageId:'publisher:nodejs.org',sourceProfile:{classIds:['official-project'],taskTier:0,evidenceRole:'primary-project'},
    excerpts:[{id:'x1',text:'Node.js 24 is the current active LTS release.',startOrdinal:0,score:4,exact:true}],
  };
  let request=null;
  const targetExecutor={complete:async input=>{request=input;return{text:JSON.stringify({summary:'Node.js 24 is the current active LTS release.',summaryExcerptIds:[],facts:[]}),inputTokens:10,outputTokens:10,durationMs:1};}};
  await createPageDossier(page,{runId:'run-question',question:'Which Node release should I install?',claims:[claim],targetExecutor});
  const payload=JSON.parse(request.user);
  assert.equal(payload.QUESTION,'Which Node release should I install?');
  assert.equal(payload.CLAIMS[0].evidenceQuery,'current Node.js LTS release');
});

test('a grounded fact survives when only its optional atomic value is unsupported',async()=>{
  const plan=planResearchActivation('Look up the current Node.js LTS release',{strategy:'balanced'});
  const brief=createResearchBrief('Look up the current Node.js LTS release',plan);
  const page={
    url:'https://nodejs.org/en/blog/release/v24.11.0',domain:'nodejs.org',title:'Node.js 24.11.0 (LTS)',mode:'direct',timestampHint:'2026-08-12',contentHash:'node-lts',durationMs:10,lineageId:'publisher:nodejs.org',sourceProfile:{classIds:['official-project'],taskTier:1,evidenceRole:'primary-project'},
    excerpts:[{text:'Node.js 24.11.0 is the current active LTS release.',startOrdinal:0,score:4,exact:true}],
  };
  const targetExecutor={complete:async input=>{const request=JSON.parse(input.user);const id=request.WEB_EXCERPTS[0].id;return{text:JSON.stringify({summary:'Node.js 24.11.0 is the current active LTS release.',summaryExcerptIds:[id],facts:[{claimId:brief.requiredClaims[0].id,stance:'supports',statement:'Node.js 24.11.0 is the current active LTS release.',excerptIds:[id],factKind:'status',atomicValue:'Node.js 99.0.0'}]}),inputTokens:10,outputTokens:10,durationMs:1};}};
  const dossier=await createPageDossier(page,{runId:'run-software',question:brief.question,claims:brief.requiredClaims,targetExecutor});
  assert.equal(dossier.dossierArtifact.payload.facts.length,1);
  assert.equal(dossier.dossierArtifact.payload.facts[0].atomicValue,null);
  assert.equal(dossier.dossierArtifact.payload.facts[0].factKind,'other');
  const evidence=evidenceFromDossier(dossier.dossierArtifact,dossier.excerptArtifacts,{runId:'run-software',claims:brief.requiredClaims,taskProfile:brief.taskProfile});
  assert.equal(evidence[0].payload.accepted,true,evidence[0].payload.rejectionReason);
});

test('LTS evidence cannot be substituted with a merely current software release',()=>{
  const claim={id:'c-lts',text:'Look up the current Node.js LTS release',evidenceQuery:'current Node.js LTS release',freshness:'low'};
  const make=(statement,text)=>{const excerpt=artifactEnvelope({type:'Excerpt',runId:'r-lts',payload:{text}});const dossier=artifactEnvelope({type:'PageDossier',runId:'r-lts',payload:{url:'https://nodejs.org/en/blog/release/test',domain:'nodejs.org',lineageId:'publisher:nodejs.org',timestampHint:null,sourceProfile:{taskTier:0,classIds:['official-project']},pageRole:{kind:'primary-document'},facts:[{claimId:claim.id,stance:'supports',statement,excerptIds:[excerpt.artifactId],factKind:'status',atomicValue:null}]}});return evidenceFromDossier(dossier,[excerpt],{runId:'r-lts',claims:[claim],taskProfile:'software'})[0];};
  assert.equal(make('Node.js 26.0.0 (Current)','Node.js 26.0.0 (Current)').payload.rejectionReason,'QUESTION_NOT_ANSWERED');
  assert.equal(make('Node.js 24.11.0 (LTS)','Node.js 24.11.0 (LTS)').payload.accepted,true);
});

test('an open lookup answer is not misclassified as contradictory evidence',()=>{
  const make=(claim,stance,statement)=>{const excerpt=artifactEnvelope({type:'Excerpt',runId:'r-open-question',payload:{text:statement}});const dossier=artifactEnvelope({type:'PageDossier',runId:'r-open-question',payload:{url:'https://nodejs.org/en/blog/release/v24.11.0',domain:'nodejs.org',lineageId:'publisher:nodejs.org',timestampHint:null,sourceProfile:{taskTier:0,classIds:['official-project']},pageRole:{kind:'primary-document'},facts:[{claimId:claim.id,stance,statement,excerptIds:[excerpt.artifactId],factKind:'status',atomicValue:null}]}});return evidenceFromDossier(dossier,[excerpt],{runId:'r-open-question',claims:[claim],taskProfile:'software'})[0];};
  const open={id:'c-open',text:'Look up the current Node.js LTS release',evidenceQuery:'current Node.js LTS release',freshness:'low'};
  const recovered=make(open,'contradicts','The current Node.js LTS release is Node.js 24.11.0 (LTS).');
  assert.equal(recovered.payload.accepted,true,recovered.payload.rejectionReason);
  assert.equal(recovered.payload.stance,'supports');
  assert.equal(recovered.payload.evidenceDimensions.reportedStance,'contradicts');

  const proposition={id:'c-proposition',text:'Is Node.js 26 the current LTS release?',evidenceQuery:'Node.js 26 current LTS release',freshness:'low'};
  const contradiction=make(proposition,'contradicts','Node.js 26 is not the current LTS release.');
  assert.equal(contradiction.payload.accepted,true,contradiction.payload.rejectionReason);
  assert.equal(contradiction.payload.stance,'contradicts');
});

test('a definition must identify what the subject is, not merely praise its importance',()=>{
  const claim={id:'c-definition',text:'What is photosynthesis?',evidenceQuery:'What is photosynthesis?',freshness:'low'};
  const make=statement=>{const excerpt=artifactEnvelope({type:'Excerpt',runId:'r-definition',payload:{text:statement}});const dossier=artifactEnvelope({type:'PageDossier',runId:'r-definition',payload:{url:'https://example.com/photosynthesis',domain:'example.com',lineageId:'publisher:example.com',timestampHint:null,sourceProfile:{taskTier:1,classIds:['encyclopedia']},pageRole:{kind:'reference'},facts:[{claimId:claim.id,stance:'supports',statement,excerptIds:[excerpt.artifactId],factKind:'explanation',atomicValue:null}]}});return evidenceFromDossier(dossier,[excerpt],{runId:'r-definition',claims:[claim]})[0];};
  assert.equal(make('Photosynthesis is critical for most life on Earth.').payload.rejectionReason,'QUESTION_NOT_ANSWERED');
  assert.equal(make('Photosynthesis is the biological process that converts light energy into chemical energy.').payload.accepted,true);
  assert.equal(make('Photosynthesis [ note 1 ] is a system of biological processes that convert light energy into chemical energy.').payload.accepted,true);
});

test('an atomic value must be stated by both its evidence and its generated fact',async()=>{
  const claim={id:'c-date',text:'When was the Eiffel Tower completed?',evidenceQuery:'when Eiffel Tower completed',freshness:'low'};
  const page={url:'https://example.com/eiffel',domain:'example.com',title:'Eiffel Tower',mode:'direct',timestampHint:null,contentHash:'eiffel',durationMs:1,lineageId:'publisher:example.com',sourceProfile:{classIds:['encyclopedia'],taskTier:1},excerpts:[{text:'On March 31 2022, the tower celebrated the 133rd anniversary of its 1889 completion.',startOrdinal:0,score:5,exact:true}]};
  const targetExecutor={complete:async input=>{const id=JSON.parse(input.user).WEB_EXCERPTS[0].id;return{text:JSON.stringify({summary:'The Eiffel Tower was completed in 1889.',summaryExcerptIds:[id],facts:[{claimId:claim.id,stance:'supports',statement:'The Eiffel Tower was completed in 1889.',excerptIds:[id],factKind:'date',atomicValue:'2022'}]}),inputTokens:1,outputTokens:1,durationMs:1};}};
  const dossier=await createPageDossier(page,{runId:'r-date',question:claim.text,claims:[claim],targetExecutor});
  assert.equal(dossier.dossierArtifact.payload.facts[0].atomicValue,null);
  assert.equal(dossier.dossierArtifact.payload.facts[0].factKind,'other');
});

test('a grounded question-relevant summary recovers a missing support row',async()=>{
  const plan=planResearchActivation('Look up the current Node.js LTS release',{strategy:'balanced'});
  const brief=createResearchBrief('Look up the current Node.js LTS release',plan);
  const page={url:'https://nodejs.org/en/blog/release/v24.11.0',domain:'nodejs.org',title:'Node.js 24.11.0 (LTS)',mode:'direct',timestampHint:'2026-08-12',contentHash:'summary-recovery',durationMs:1,lineageId:'publisher:nodejs.org',sourceProfile:{classIds:['official-project'],taskTier:0,evidenceRole:'primary-project'},excerpts:[{text:'Node.js 24.11.0 is the current LTS release.',startOrdinal:0,score:4,exact:true}]};
  const targetExecutor={complete:async input=>{const id=JSON.parse(input.user).WEB_EXCERPTS[0].id;return{text:JSON.stringify({summary:'Node.js 24.11.0 is the current LTS release.',summaryExcerptIds:[id],facts:[]}),inputTokens:10,outputTokens:10,durationMs:1};}};
  const dossier=await createPageDossier(page,{runId:'run-summary',question:brief.question,claims:brief.requiredClaims,targetExecutor});
  assert.equal(dossier.dossierArtifact.payload.facts[0].stance,'supports');
  const evidence=evidenceFromDossier(dossier.dossierArtifact,dossier.excerptArtifacts,{runId:'run-summary',claims:brief.requiredClaims,taskProfile:brief.taskProfile});
  assert.equal(evidence[0].payload.accepted,true,evidence[0].payload.rejectionReason);
});

test('a direct capital sentence survives a small-model related classification',async()=>{
  const claim={id:'c-capital',text:'Look up the capital of Bhutan',evidenceQuery:'capital of Bhutan',freshness:'low'};
  const page={url:'https://example.com/bhutan',domain:'example.com',title:'Bhutan',mode:'direct',timestampHint:null,contentHash:'bhutan',durationMs:1,lineageId:'publisher:example.com',sourceProfile:{classIds:['encyclopedia'],taskTier:0},excerpts:[{text:'Thimphu, capital of Bhutan, is situated in the western central part of the country.',startOrdinal:0,score:5,exact:true},{text:'Punakha was the former capital of Bhutan.',startOrdinal:1,score:4,exact:true}]};
  const targetExecutor={complete:async input=>{const ids=JSON.parse(input.user).WEB_EXCERPTS.map(item=>item.id);return{text:JSON.stringify({summary:'Bhutan has had several important cities.',summaryExcerptIds:[ids[1]],facts:[{claimId:claim.id,stance:'related',statement:'Punakha was the former capital of Bhutan.',excerptIds:[ids[1]],factKind:'other',atomicValue:''}]}),inputTokens:1,outputTokens:1,durationMs:1};}};
  const dossier=await createPageDossier(page,{runId:'r-capital',question:claim.text,claims:[claim],targetExecutor});
  const support=dossier.dossierArtifact.payload.facts.filter(item=>item.stance==='supports');
  assert.equal(support.length,1);
  assert.match(support[0].statement,/^Thimphu, capital of Bhutan/iu);
  assert.doesNotMatch(support[0].statement,/former capital/iu);
  const evidence=evidenceFromDossier(dossier.dossierArtifact,dossier.excerptArtifacts,{runId:'r-capital',claims:[claim]});
  assert.equal(evidence.find(item=>item.payload.stance==='supports')?.payload.accepted,true);
});

test('a subject lead definition survives a small-model empty classification',async()=>{
  const claim={id:'c-cjp',text:'No, Cockroach Janta Party — look it up and explain what it is.',evidenceQuery:'Cockroach Janta Party',freshness:'low'};
  const page={url:'https://en.wikipedia.org/wiki/Cockroach_Janta_Party',domain:'en.wikipedia.org',title:'Cockroach Janta Party',mode:'direct',timestampHint:null,contentHash:'cjp',durationMs:1,lineageId:'publisher:wikipedia.org',sourceProfile:{classIds:['encyclopedia'],taskTier:0},excerpts:[{text:'The Cockroach Janta Party (CJP), also known as the Cockroach movement, is an Indian youth-based satirical political movement.',startOrdinal:0,score:5,exact:true}]};
  const targetExecutor={complete:async input=>{const id=JSON.parse(input.user).WEB_EXCERPTS[0].id;return{text:JSON.stringify({summary:'Cockroach Janta Party',summaryExcerptIds:[id],facts:[]}),inputTokens:1,outputTokens:1,durationMs:1};}};
  const dossier=await createPageDossier(page,{runId:'r-cjp',question:claim.text,claims:[claim],targetExecutor});
  const fact=dossier.dossierArtifact.payload.facts.find(item=>item.stance==='supports');
  assert.match(fact?.statement||'',/satirical political movement/iu);
  const evidence=evidenceFromDossier(dossier.dossierArtifact,dossier.excerptArtifacts,{runId:'r-cjp',claims:[claim]});
  assert.equal(evidence.find(item=>item.payload.stance==='supports')?.payload.accepted,true);
});

test('an explicit comparison sentence survives a small-model empty classification',async()=>{
  const claim={id:'c-comparison',text:'Explain the difference between mass and weight.',evidenceQuery:'difference between mass and weight',freshness:'low'};
  const page={url:'https://example.com/mass-weight',domain:'example.com',title:'Mass and weight',mode:'direct',timestampHint:null,contentHash:'mass-weight',durationMs:1,lineageId:'publisher:example.com',sourceProfile:{classIds:['university'],taskTier:1},excerpts:[{text:'Mass refers to the amount of matter in an object, while weight is the gravitational force acting on it.',startOrdinal:0,score:5,exact:true},{text:'Mass vs Weight',startOrdinal:1,score:4,exact:true}]};
  const targetExecutor={complete:async input=>{const id=JSON.parse(input.user).WEB_EXCERPTS[1].id;return{text:JSON.stringify({summary:'Mass vs Weight',summaryExcerptIds:[id],facts:[]}),inputTokens:1,outputTokens:1,durationMs:1};}};
  const dossier=await createPageDossier(page,{runId:'r-comparison',question:claim.text,claims:[claim],targetExecutor});
  const fact=dossier.dossierArtifact.payload.facts.find(item=>item.stance==='supports');
  assert.match(fact?.statement||'',/amount of matter.*while weight.*gravitational force/iu);
  const evidence=evidenceFromDossier(dossier.dossierArtifact,dossier.excerptArtifacts,{runId:'r-comparison',claims:[claim]});
  assert.equal(evidence.find(item=>item.payload.stance==='supports')?.payload.accepted,true);
});
