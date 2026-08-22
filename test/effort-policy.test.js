import test from 'node:test';
import assert from 'node:assert/strict';
import { effortPolicy, internalModeForQuestion, shouldGroundQuestion } from '../server/services/effort-policy.js';
import { normalizeExecutionProfile } from '../server/services/response-profile.js';
import { planResearchActivation } from '../server/research/activation.js';
import { createResearchBrief, planQueries, researchBudgetPolicy } from '../server/research/planner.js';
import { selectRelevantExcerpts } from '../server/research/page-reader.js';
import { evidenceFromDossier } from '../server/research/evidence-ledger.js';
import { artifactEnvelope } from '../server/research/contracts.js';
import { inspect as inspectDeterministic } from '../server/engine/index.js';
import { attachVisibleSources } from '../server/services/message-flow.js';
import { encyclopediaTitleRelevant } from '../server/research/research-service.js';
import { createPageDossier } from '../server/research/dossier.js';

test('Thorough level two is the grounded beta default and stable facts are sent to research', () => {
  const profile = normalizeExecutionProfile({}, { reasoningSupported:true });
  assert.equal(profile.effort, 2);
  assert.equal(profile.response.thinking, 'standard');
  assert.equal(shouldGroundQuestion('when was jantar mantar built'), true);
  const plan = planResearchActivation('when was jantar mantar built', { turnWeb:'force', strategy:'balanced' });
  assert.equal(plan.useWeb, true);
  assert.equal(plan.query.includes('jantar mantar'), true);
});

test('greetings, supplied text work, and creative work do not waste a web search', () => {
  assert.equal(shouldGroundQuestion('hi'), false);
  assert.equal(shouldGroundQuestion('Rewrite this paragraph more clearly'), false);
  assert.equal(shouldGroundQuestion('Write a poem about the moon'), false);
  assert.equal(shouldGroundQuestion('what is CJP'), true);
  assert.equal(shouldGroundQuestion('Turn these prompt notes into a revision plan', { hasAttachedSource:true }), false);
});

test('web search preserves explicit Off, Auto, and On contracts', () => {
  const prompt = 'Turn these prompt notes into a revision plan';
  const off = planResearchActivation(prompt, { turnWeb:'off', strategy:'balanced' });
  const auto = planResearchActivation(prompt, { turnWeb:'auto', strategy:'balanced' });
  const on = planResearchActivation(prompt, { turnWeb:'force', strategy:'balanced' });
  assert.equal(off.useWeb, false);
  assert.equal(auto.useWeb, false);
  assert.equal(on.useWeb, true);
  assert.equal(planResearchActivation('Search the web for current weather in Pune', { turnWeb:'off', strategy:'balanced' }).useWeb, false);
  assert.equal(normalizeExecutionProfile({ research:{ mode:'off' } }).research.mode, 'off');
  assert.equal(normalizeExecutionProfile({ research:{ mode:'auto' } }).research.mode, 'auto');
  assert.equal(normalizeExecutionProfile({ research:{ mode:'force' } }).research.mode, 'force');
});

test('legacy profiles migrate and web-off execution is capped at Quick by the server', () => {
  const profile = normalizeExecutionProfile({ effort:9, research:{ mode:'off' } }, { reasoningSupported:true });
  assert.equal(profile.effort, 3);
  assert.equal(profile.response.thinking, 'quick');
  assert.equal(profile.modeId, 'standard');
  assert.equal(effortPolicy(3, { webEnabled:false }).effectiveLevel, 1);
});

test('every beta effort level stays on the single standard execution path', () => {
  for (let level=0; level<=3; level+=1) {
    assert.equal(internalModeForQuestion('Compare two database designs', effortPolicy(level)), 'standard');
    assert.equal(effortPolicy(level).modeId, 'standard');
  }
  const profile=normalizeExecutionProfile({version:5,effort:9,modeId:'red-team',workflow:{definition:{name:'Five-pass review'}}},{reasoningSupported:true});
  assert.equal(profile.effort,3);
  assert.equal(profile.modeId,'standard');
  assert.equal(profile.workflow.definition,null);
});

test('research has immutable beta caps and still creates recovery query families', () => {
  const base = researchBudgetPolicy({ budgetClass:'standard', effort:{ maxQueries:4, maxPages:3, maxRounds:2, noGainTolerance:1, maxDurationMs:75_000 } });
  const maximal = researchBudgetPolicy({ budgetClass:'extended', effort:{ maxQueries:999, maxPages:999, maxRounds:999, noGainTolerance:999, maxDurationMs:999_999 } });
  assert.equal(base.queryHardCap,4);
  assert.equal(base.pageHardCap,3);
  assert.equal(maximal.queryHardCap,8);
  assert.equal(maximal.pageHardCap,5);
  assert.equal(maximal.maxRounds,3);
  assert.equal(maximal.maxDurationMs,180_000);
  assert.equal(maximal.expansionStep,0);
  assert.equal(maximal.repairReserve,0);
  const plan = { useWeb:true, query:'cockroach janta party', claimClass:'general', strategy:'diverse', effort:{ level:3, maxQueries:8, maxPages:5 } };
  const brief = createResearchBrief('What is the Cockroach Janta Party?', plan);
  const first = planQueries(brief, plan, { explorationRound:0 });
  const recovery = planQueries(brief, plan, { explorationRound:2 });
  assert.ok(recovery.some(item => item.intent === 'recovery-2'));
  assert.ok(recovery.some(item => !first.some(initial => initial.id === item.id)));
});

test('historical date extraction prefers construction evidence and rejects isolated image years', () => {
  const question='When was the Jantar Mantar in Jaipur built?';
  const excerpts=selectRelevantExcerpts({title:'Jantar Mantar, Jaipur',text:'Jantar Mantar in Jaipur. 1928\n\nConstruction of the observatory began in 1728 and it was completed in 1734.'},{question,claims:[{text:question}]});
  assert.match([...excerpts].sort((a,b)=>b.score-a.score)[0].text,/1728|1734/u);
  const claim={id:'c1',text:question,evidenceQuery:'Jantar Mantar in Jaipur completed year',freshness:'low'};
  const excerpt=artifactEnvelope({type:'Excerpt',runId:'r1',payload:{text:'Jantar Mantar in Jaipur. 1928'}});
  const dossier=artifactEnvelope({type:'PageDossier',runId:'r1',payload:{url:'https://example.com/jantar',domain:'example.com',lineageId:'publisher:example.com',timestampHint:null,sourceProfile:{taskTier:1,classIds:['encyclopedia']},pageRole:{kind:'reference'},facts:[{claimId:'c1',stance:'supports',statement:'Jantar Mantar in Jaipur. 1928',excerptIds:[excerpt.artifactId],factKind:'date',atomicValue:'1928'}]}});
  const [evidence]=evidenceFromDossier(dossier,[excerpt],{runId:'r1',claims:[claim],taskProfile:'history'});
  assert.equal(evidence.payload.accepted,false);
  assert.equal(evidence.payload.rejectionReason,'QUESTION_NOT_ANSWERED');
});

test('direct historical prose becomes usable evidence without trusting a small-model classification', async () => {
  const question='When was the Jantar Mantar in Jaipur built?';
  const claim={id:'c1',text:question,evidenceQuery:'Jantar Mantar in Jaipur completed year',freshness:'low'};
  const page={url:'https://example.com/jantar',title:'Jantar Mantar, Jaipur',domain:'example.com',mode:'direct',timestampHint:null,lineageId:'publisher:example.com',contentHash:'abc',sourceProfile:{taskTier:1,classIds:['encyclopedia'],evidenceRole:'secondary'},excerpts:[{text:'Exactly when construction began is unknown, but several instruments had been built by 1728, and construction continued until 1738. Ram Singh completed restoring the Jantar Mantar in 1876.',startOrdinal:0,score:10}]};
  const dossier=await createPageDossier(page,{runId:'r-direct',question,claims:[claim]});
  const evidence=evidenceFromDossier(dossier.dossierArtifact,dossier.excerptArtifacts,{runId:'r-direct',claims:[claim],taskProfile:'history'});
  assert.equal(evidence.some(item=>item.payload.accepted),true);
  assert.match(evidence.find(item=>item.payload.accepted).payload.statement,/1728/u);
  assert.doesNotMatch(evidence.find(item=>item.payload.accepted).payload.statement,/1876/u);
});

test('historical source prompts use the subject and reject a tangential encyclopedia title', () => {
  const plan={useWeb:true,query:'site:wikipedia.org find when the Eiffel Tower was completed',target:'find when the Eiffel Tower was completed',claimClass:'stable-history',sourceConstraint:{kind:'domain',domain:'wikipedia.org'}};
  const brief=createResearchBrief('Use Wikipedia to find when the Eiffel Tower was completed',plan);
  const queries=planQueries(brief,plan);
  assert.equal(queries[0].query,'the Eiffel Tower completed year');
  const profile={classIds:['encyclopedia']};
  assert.equal(encyclopediaTitleRelevant({title:'Eiffel Tower - Wikipedia',sourceProfile:profile},brief,plan),true);
  assert.equal(encyclopediaTitleRelevant({title:"Watkin's Tower - Wikipedia",sourceProfile:profile},brief,plan),false);
  assert.equal(encyclopediaTitleRelevant({title:'Statue of Liberty - Wikipedia',sourceProfile:profile},brief,plan),false);
  const capitalPlan={target:'the capital of Bhutan'};
  const capitalBrief=createResearchBrief('Look up the capital of Bhutan',capitalPlan);
  assert.equal(encyclopediaTitleRelevant({title:'Thimphu - Wikipedia',sourceProfile:profile,excerpts:[{text:'Thimphu is the capital and largest city of Bhutan.'}]},capitalBrief,capitalPlan),true);
});

test('explicit correction requests reduce to the named subject for evidence scoring', () => {
  const plan={claimClass:'general'};
  const brief=createResearchBrief('No, Cockroach Janta Party — look it up and explain what it is.',plan);
  assert.equal(brief.requiredClaims[0].evidenceQuery,'Cockroach Janta Party');
});

test('definition evidence must define the requested subject instead of a nearby concept', () => {
  const claim={id:'c1',text:'What is photosynthesis?',evidenceQuery:'What is photosynthesis?',freshness:'low'};
  const excerpt=artifactEnvelope({type:'Excerpt',runId:'r2',payload:{text:'Photosynthetic efficiency is the fraction of light energy converted during photosynthesis.'}});
  const dossier=artifactEnvelope({type:'PageDossier',runId:'r2',payload:{url:'https://example.com/efficiency',domain:'example.com',lineageId:'publisher:example.com',timestampHint:null,sourceProfile:{taskTier:1,classIds:['encyclopedia']},pageRole:{kind:'reference'},facts:[{claimId:'c1',stance:'supports',statement:'Photosynthetic efficiency is the fraction of light energy converted during photosynthesis.',excerptIds:[excerpt.artifactId],factKind:'explanation',atomicValue:null}]}});
  const [evidence]=evidenceFromDossier(dossier,[excerpt],{runId:'r2',claims:[claim],taskProfile:'general-reference'});
  assert.equal(evidence.payload.accepted,false);
  assert.equal(evidence.payload.rejectionReason,'QUESTION_NOT_ANSWERED');
});

test('definition excerpt ranking prefers a direct definition over nearby statistics', () => {
  const question='What is photosynthesis?';
  const excerpts=selectRelevantExcerpts({title:'Photosynthesis',text:'Photosynthesis converts about 100 billion tons of carbon each year.\n\nPhotosynthesis is the biological process by which plants use light energy to make chemical energy.\n\nPhotosynthetic efficiency measures the fraction of energy converted during photosynthesis.'},{question,claims:[{text:question}]});
  assert.match([...excerpts].sort((a,b)=>b.score-a.score)[0].text,/^Photosynthesis is the biological process/u);
});

test('definition excerpt ranking tolerates source citation markers before the copula', () => {
  const question='What is photosynthesis?';
  const navigation=Array.from({length:20},(_,index)=>`Navigation item ${index} about photosynthesis statistics.`).join('\n\n');
  const excerpts=selectRelevantExcerpts({title:'Photosynthesis',text:`${navigation}\n\nPhotosynthesis [ note 1 ] is a system of biological processes that convert light energy into chemical energy.\n\nThe average rate of energy captured by global photosynthesis is approximately 130 terawatts.`},{question,claims:[{text:question}]});
  assert.match([...excerpts].sort((a,b)=>b.score-a.score)[0].text,/^Photosynthesis \[ note 1 \] is a system/iu);
});

test('comparison excerpt ranking prefers an actual distinction over a page heading', () => {
  const question='Explain the difference between mass and weight.';
  const excerpts=selectRelevantExcerpts({title:'Mass vs Weight - The Difference',text:'Mass vs Weight – The Difference Between Mass and Weight.\n\nMass is the amount of matter in an object and is measured in kilograms.\n\nWeight is the force of gravity on that mass and is measured in newtons.'},{question,claims:[{text:question}]});
  const best=[...excerpts].sort((a,b)=>b.score-a.score)[0].text;
  assert.match(best,/amount of matter|force of gravity/iu);
});

test('plain-language arithmetic reaches the deterministic calculator before research', () => {
  const result=inspectDeterministic('What is 27 multiplied by 43?');
  assert.equal(result.matched,true);
  assert.equal(result.display,'1161');
});

test('calculation instructions do not bypass the deterministic calculator', () => {
  const result=inspectDeterministic('Calculate 27 multiplied by 43. State only the arithmetic and final number.');
  assert.equal(result.matched,true);
  assert.equal(result.display,'1161');
});

test('researched workflow answers retain a visible citation and deduplicated source list', () => {
  const attached=attachVisibleSources('A verified answer.',[
    {url:'https://example.com/fact',title:'Primary fact',domain:'example.com'},
    {url:'https://example.com/fact',title:'Duplicate',domain:'example.com'},
  ]);
  assert.match(attached.content,/A verified answer\. \[1\]/u);
  assert.match(attached.content,/Sources\n\[1\] \[Primary fact\]\(https:\/\/example\.com\/fact\)/u);
  assert.equal(attached.sources.length,1);
});
