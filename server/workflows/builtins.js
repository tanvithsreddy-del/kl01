import { fail } from '../lib/errors.js';
import { getMode, listModes } from '../services/mode-registry.js';
import { normalizeWorkflowDefinitionV2 } from './schema-v2.js';

export const MODE_WORKFLOW_DISPOSITION = Object.freeze({"standard":{"disposition":"RESPONSE_PROFILE","family":"SingleResponse"},"fast-answer":{"disposition":"RESPONSE_PROFILE","family":"SingleResponse"},"deep-answer":{"disposition":"WORKFLOW_V2","family":"DraftCritiqueRevise"},"explore":{"disposition":"WORKFLOW_V2","family":"DivergeEvaluateSynthesize"},"clarify-first":{"disposition":"RESPONSE_PROFILE","family":"SingleResponse"},"debate":{"disposition":"WORKFLOW_V2","family":"DebateGraph"},"council":{"disposition":"WORKFLOW_V2","family":"CouncilGraph"},"answer-tournament":{"disposition":"WORKFLOW_V2","family":"TournamentGraph"},"red-team":{"disposition":"WORKFLOW_V2","family":"RedTeamGraph"},"consensus":{"disposition":"WORKFLOW_V2","family":"CouncilGraph"},"perspective-panel":{"disposition":"WORKFLOW_V2","family":"CouncilGraph"},"devils-advocate":{"disposition":"WORKFLOW_V2","family":"DebateGraph"},"dialectic":{"disposition":"WORKFLOW_V2","family":"DebateGraph"},"review":{"disposition":"WORKFLOW_V2","family":"MapAuditCorrect"},"check-work":{"disposition":"WORKFLOW_V2","family":"MapAuditCorrect"},"fact-inference-split":{"disposition":"WORKFLOW_V2","family":"MapAuditCorrect"},"claim-audit":{"disposition":"WORKFLOW_V2","family":"MapAuditCorrect"},"logic-audit":{"disposition":"WORKFLOW_V2","family":"MapAuditCorrect"},"requirement-audit":{"disposition":"WORKFLOW_V2","family":"MapAuditCorrect"},"failure-premortem":{"disposition":"WORKFLOW_V2","family":"MapAuditCorrect"},"stress-test":{"disposition":"WORKFLOW_V2","family":"MapAuditCorrect"},"confidence-map":{"disposition":"WORKFLOW_V2","family":"MapAuditCorrect"},"write":{"disposition":"RESPONSE_PROFILE","family":"SingleResponse"},"rewrite":{"disposition":"WORKFLOW_V2","family":"DiagnoseVariantsFinalize"},"style-studio":{"disposition":"WORKFLOW_V2","family":"DiagnoseVariantsFinalize"},"editor-room":{"disposition":"WORKFLOW_V2","family":"DraftCritiqueRevise"},"argument-builder":{"disposition":"WORKFLOW_V2","family":"DraftCritiqueRevise"},"story-room":{"disposition":"WORKFLOW_V2","family":"DiagnoseVariantsFinalize"},"naming-studio":{"disposition":"WORKFLOW_V2","family":"DivergeClusterChallengeRank"},"compression":{"disposition":"WORKFLOW_V2","family":"HierarchyCompress"},"brainstorm":{"disposition":"WORKFLOW_V2","family":"DivergeClusterChallengeRank"},"diverge-converge":{"disposition":"WORKFLOW_V2","family":"DivergeClusterChallengeRank"},"wild-ideas":{"disposition":"WORKFLOW_V2","family":"DivergeClusterChallengeRank"},"constraint-creativity":{"disposition":"WORKFLOW_V2","family":"DivergeClusterChallengeRank"},"analogy-engine":{"disposition":"WORKFLOW_V2","family":"DivergeEvaluateSynthesize"},"combination-lab":{"disposition":"WORKFLOW_V2","family":"DivergeClusterChallengeRank"},"opportunity-miner":{"disposition":"WORKFLOW_V2","family":"DivergeClusterChallengeRank"},"decision":{"disposition":"WORKFLOW_V2","family":"OptionsCriteriaSensitivityRecommend"},"decision-sensitivity":{"disposition":"WORKFLOW_V2","family":"OptionsCriteriaSensitivityRecommend"},"scenario-planner":{"disposition":"WORKFLOW_V2","family":"OptionsCriteriaSensitivityRecommend"},"counterfactual-lab":{"disposition":"WORKFLOW_V2","family":"OptionsCriteriaSensitivityRecommend"},"strategy-room":{"disposition":"WORKFLOW_V2","family":"CouncilGraph"},"roadmap":{"disposition":"WORKFLOW_V2","family":"OptionsCriteriaSensitivityRecommend"},"prioritise":{"disposition":"WORKFLOW_V2","family":"OptionsCriteriaSensitivityRecommend"},"negotiation":{"disposition":"WORKFLOW_V2","family":"DraftCritiqueRevise"},"tutor":{"disposition":"WORKFLOW_V2","family":"DiagnoseTeachPractice"},"socratic-tutor":{"disposition":"RESPONSE_PROFILE","family":"SingleResponse"},"explain-levels":{"disposition":"WORKFLOW_V2","family":"DivergeEvaluateSynthesize"},"study-guide":{"disposition":"WORKFLOW_V2","family":"DiagnoseTeachPractice"},"examiner":{"disposition":"RESPONSE_PROFILE","family":"SingleResponse"},"flashcard-builder":{"disposition":"WORKFLOW_V2","family":"DiagnoseVariantsFinalize"},"misconception-hunter":{"disposition":"WORKFLOW_V2","family":"MapAuditCorrect"},"teach-back":{"disposition":"RESPONSE_PROFILE","family":"SingleResponse"},"code":{"disposition":"RESPONSE_PROFILE","family":"SingleResponse"},"code-architect":{"disposition":"WORKFLOW_V2","family":"ContractImplementReviewFinalize"},"debug":{"disposition":"WORKFLOW_V2","family":"ContractImplementReviewFinalize"},"code-review":{"disposition":"WORKFLOW_V2","family":"MapAuditCorrect"},"refactor":{"disposition":"WORKFLOW_V2","family":"ContractImplementReviewFinalize"},"test-builder":{"disposition":"WORKFLOW_V2","family":"ContractImplementReviewFinalize"},"adversarial-code-review":{"disposition":"WORKFLOW_V2","family":"RedTeamGraph"},"patch-tournament":{"disposition":"WORKFLOW_V2","family":"TournamentGraph"},"explain-code":{"disposition":"WORKFLOW_V2","family":"DiagnoseTeachPractice"},"spec-to-code":{"disposition":"WORKFLOW_V2","family":"ContractImplementReviewFinalize"},"research":{"disposition":"WORKFLOW_V2","family":"ResearchArtifactSynthesis"},"literature-map":{"disposition":"WORKFLOW_V2","family":"ResearchArtifactSynthesis"},"evidence-table":{"disposition":"WORKFLOW_V2","family":"ResearchArtifactSynthesis"},"compare-sources":{"disposition":"WORKFLOW_V2","family":"ResearchArtifactSynthesis"},"question-decomposer":{"disposition":"WORKFLOW_V2","family":"DivergeEvaluateSynthesize"},"unknowns-first":{"disposition":"WORKFLOW_V2","family":"MapAuditCorrect"}});

const clone = value => structuredClone(value);
const roles = Object.freeze({
  council: ['Technical expert', 'Practical operator', 'User advocate'],
  consensus: ['Independent analyst 1', 'Independent analyst 2', 'Independent analyst 3'],
  perspective: ['Technical reviewer', 'Practical reviewer', 'Economic reviewer', 'User-experience reviewer', 'Adversarial reviewer'],
  strategy: ['Strategist', 'Operator', 'Customer advocate', 'Competitor analyst', 'Skeptic'],
});
function slot(id, label, role, overrides = {}) {
  const targetId = overrides?.[id] || null;
  return { id, label, role, capabilityRequirements: { inputModalities: ['text'] }, targetPolicy: targetId ? { mode: 'explicit', targetId } : { mode: 'auto' }, fallbackPolicy: { allowFallback: true } };
}
function model(id, label, role, instruction, { slotId = id, deps = [], artifacts = 'dependencies', explicitArtifacts = [], final = false, joinPolicy = 'all', web = 'inherit', visibility = 'public', metadata = {} } = {}) {
  return { id, type: 'model', label, role, instruction, slotId, joinPolicy, capabilityRequirements: { inputModalities: ['text'] }, webPolicy: { mode: web }, contextPolicy: { conversation: 'base', artifacts: artifacts === 'explicit' ? { mode: 'explicit', nodeIds: explicitArtifacts } : { mode: artifacts }, research: 'shared', includeAttachments: true }, fallbackPolicy: { allowFallback: true }, visibility, final, metadata: { ...metadata, deps } };
}
function researchNode(id = 'research') { return { id, type: 'research', label: 'Research', role: 'Research OS', instruction: 'Build a verified EvidencePacket using the shared Research OS.', joinPolicy: 'all', webPolicy: { mode: 'required' }, contextPolicy: { conversation: 'base', artifacts: { mode: 'none' }, research: 'none', includeAttachments: true }, fallbackPolicy: { allowFallback: true }, visibility: 'public', final: false, metadata: { deps: [] } }; }
function edge(from, to) { return { from, to }; }
function chainEdges(ids) { return ids.slice(1).map((id, index) => edge(ids[index], id)); }
function definition(mode, family, slots, nodes, edges, { finalNodeId = nodes.at(-1)?.id, webPolicy = 'inherit' } = {}) {
  return normalizeWorkflowDefinitionV2({ version: 2, id: `builtin-${mode.id}`, modeId: mode.id, family, name: mode.label, description: mode.description, webPolicy: { mode: webPolicy }, visibility: { showIntermediate: true }, slots, nodes, edges, finalNodeId });
}
function seqFamily(mode, family, specs, overrides) {
  const slots = specs.map(spec => slot(spec.slotId || spec.id, spec.slotLabel || spec.role, spec.role, overrides));
  const nodes = specs.map((spec, index) => model(spec.id, spec.label, spec.role, spec.instruction || (index === 0 ? mode.focus : spec.label), { slotId: spec.slotId || spec.id, final: Boolean(spec.final), artifacts: index ? 'dependencies' : 'none' }));
  return definition(mode, family, slots, nodes, chainEdges(nodes.map(node => node.id)));
}
function draftCritique(mode, overrides) { return seqFamily(mode, 'DraftCritiqueRevise', [
  { id:'draft', label:'Draft', role:'Primary analyst', instruction:`${mode.focus} Produce a complete first draft.` },
  { id:'critique', label:'Challenge', role:'Critical reviewer', instruction:'Challenge the draft for errors, weak assumptions, omissions, contradictions, and missed requirements.' },
  { id:'final', label:'Revised answer', role:'Senior editor', instruction:'Produce the final answer from the declared draft and critique. Preserve unresolved uncertainty.', final:true },
], overrides); }
function divergeEvaluate(mode, overrides) { return seqFamily(mode, 'DivergeEvaluateSynthesize', [
  {id:'options',label:'Distinct approaches',role:'Explorer',instruction:`${mode.focus} Produce materially different approaches rather than cosmetic variants.`},
  {id:'evaluation',label:'Evaluation',role:'Evaluator',instruction:'Compare the declared approaches against explicit criteria, tradeoffs, and failure modes.'},
  {id:'final',label:'Synthesis',role:'Synthesist',instruction:'Produce the strongest answer while preserving useful alternatives and explaining the choice.',final:true},
], overrides); }
function mapAudit(mode, overrides) { return seqFamily(mode, 'MapAuditCorrect', [
  {id:'map',label:'Target map',role:'Analyst',instruction:`${mode.focus} Extract the material claims, requirements, assumptions, or failure surfaces.`},
  {id:'audit',label:'Audit findings',role:'Adversarial reviewer',instruction:'Test every declared item carefully. Give concrete findings and preserve unresolved issues.'},
  {id:'final',label:'Corrected result',role:'Corrector',instruction:'Return the corrected result and a compact account of material remaining uncertainty.',final:true},
], overrides); }
function diagnoseVariants(mode, overrides) { return seqFamily(mode, 'DiagnoseVariantsFinalize', [
  {id:'diagnose',label:'Diagnosis',role:'Editor',instruction:`${mode.focus} Diagnose what should change and what must be preserved.`},
  {id:'variants',label:'Candidate versions',role:'Creative editor',instruction:'Produce meaningfully different transformations that obey the diagnosis and locked facts.'},
  {id:'final',label:'Final version',role:'Final editor',instruction:'Select or combine the strongest candidate and return a polished final result.',final:true},
], overrides); }
function brainstorm(mode, overrides) { return seqFamily(mode, 'DivergeClusterChallengeRank', [
  {id:'diverge',label:'Divergence',role:'Idea generator',instruction:`${mode.focus} Generate broad, materially distinct directions before judging them.`},
  {id:'cluster',label:'Clusters',role:'Pattern finder',instruction:'Cluster the declared ideas by underlying approach and remove cosmetic duplicates.'},
  {id:'challenge',label:'Challenge',role:'Skeptic',instruction:'Stress-test the strongest clusters for feasibility, novelty, constraints, and failure modes.'},
  {id:'final',label:'Finalists',role:'Selector',instruction:'Rank and develop the strongest surviving directions with useful next steps.',final:true},
], overrides); }
function decision(mode, overrides) { return seqFamily(mode, 'OptionsCriteriaSensitivityRecommend', [
  {id:'options',label:'Options',role:'Options analyst',instruction:`${mode.focus} Identify materially different options and constraints.`},
  {id:'criteria',label:'Criteria',role:'Decision analyst',instruction:'Evaluate the declared options against explicit criteria, costs, risks, and reversibility.'},
  {id:'sensitivity',label:'Sensitivity',role:'Skeptic',instruction:'Test how the recommendation changes when uncertain assumptions or weights change.'},
  {id:'final',label:'Recommendation',role:'Decision maker',instruction:'Recommend the best option, explain the deciding tradeoffs, and state what evidence could change it.',final:true},
], overrides); }
function teach(mode, overrides) { return seqFamily(mode, 'DiagnoseTeachPractice', [
  {id:'diagnose',label:'Learning map',role:'Tutor',instruction:`${mode.focus} Identify prerequisites, likely misconceptions, and the right difficulty.`},
  {id:'teach',label:'Explanation',role:'Teacher',instruction:'Teach with a clear mental model, examples, and progressive depth using only declared inputs.'},
  {id:'final',label:'Practice and recap',role:'Learning coach',instruction:'Provide the requested learning artifact, compact recap, and an active-recall check.',final:true},
], overrides); }
function coding(mode, overrides) { return seqFamily(mode, 'ContractImplementReviewFinalize', [
  {id:'contract',label:'Contract and diagnosis',role:'Software architect',instruction:`${mode.focus} State environment, behavior contract, interfaces, risks, and unknowns.`},
  {id:'implementation',label:'Candidate implementation',role:'Implementer',instruction:'Produce a usable implementation or patch from the declared contract. Never claim execution that did not occur.'},
  {id:'review',label:'Adversarial review',role:'Senior reviewer',instruction:'Review correctness, security, edge cases, compatibility, and test coverage without inventing test results.'},
  {id:'final',label:'Final implementation',role:'Maintainer',instruction:'Produce the corrected final code or plan with tests to run and honest limits.',final:true},
], overrides); }
function hierarchy(mode, overrides) { return seqFamily(mode, 'HierarchyCompress', [
  {id:'hierarchy',label:'Information hierarchy',role:'Editor',instruction:`${mode.focus} Identify essential facts, decisions, actions, and removable detail.`},
  {id:'final',label:'Compressed result',role:'Compression editor',instruction:'Produce the requested concise form without dropping essential qualifiers or decisions.',final:true},
], overrides); }
function debate(mode, overrides) {
  if (mode.id === 'devils-advocate' || mode.id === 'dialectic') return seqFamily(mode, 'DebateGraph', mode.id === 'dialectic' ? [
    {id:'thesis',label:'Thesis',role:'Thesis',instruction:mode.focus},{id:'antithesis',label:'Antithesis',role:'Antithesis',instruction:'Build the strongest opposing framework rather than a list of weak objections.'},{id:'final',label:'Synthesis',role:'Synthesist',instruction:'Resolve compatible insights, preserve irreducible conflict, and produce the final answer.',final:true},
  ] : [
    {id:'position',label:'Initial position',role:'Primary analyst',instruction:mode.focus},{id:'opposition',label:"Devil's advocate",role:"Devil's advocate",instruction:'Build the strongest plausible case against the position and avoid strawmen.'},{id:'final',label:'Assessment',role:'Judge',instruction:'Assess which objections matter, revise the conclusion if needed, and produce the final answer.',final:true},
  ], overrides);
  const slots=[slot('advocate','Advocate','Advocate',overrides),slot('skeptic','Skeptic','Skeptic',overrides),slot('rebuttal','Rebuttal','Rebuttal analyst',overrides),slot('judge','Judge','Judge',overrides)];
  const nodes=[
    model('advocate','Advocate','Advocate',`${mode.focus} Present the strongest affirmative case independently.`,{slotId:'advocate',artifacts:'none'}),
    model('skeptic','Skeptic','Skeptic','Build the strongest independent opposing case. Steelman the affirmative position before attacking it.',{slotId:'skeptic',artifacts:'none'}),
    model('rebuttal','Rebuttal','Rebuttal analyst','Compare the declared advocate and skeptic artifacts directly. Repair valid objections and identify irreducible disagreement. If one participant failed, work only from committed participant artifacts and say what is missing.',{slotId:'rebuttal',joinPolicy:'best-effort'}),
    model('judge','Judge','Judge','Judge only the declared successful cases/rebuttal using explicit reasoning. Preserve valid disagreement and explicitly note a missing participant rather than fabricating it.',{slotId:'judge',final:true,joinPolicy:'best-effort'}),
  ];
  return definition(mode,'DebateGraph',slots,nodes,[edge('advocate','rebuttal'),edge('skeptic','rebuttal'),edge('advocate','judge'),edge('skeptic','judge'),edge('rebuttal','judge')]);
}
function council(mode, overrides) {
  let rs = roles.council; let mapNode = false;
  if(mode.id==='consensus'){rs=roles.consensus;mapNode=true;}
  else if(mode.id==='perspective-panel')rs=roles.perspective;
  else if(mode.id==='strategy-room')rs=roles.strategy;
  const slots=rs.map((role,i)=>slot(`member-${i+1}`,role,role,overrides)); slots.push(slot('chair','Chair','Chair',overrides)); if(mapNode)slots.push(slot('mapper','Consensus mapper','Consensus mapper',overrides));
  const nodes=rs.map((role,i)=>model(`member-${i+1}`,role,role,`${mode.focus} Analyse independently from the original request through your assigned role. Do not imitate other participants.`,{slotId:`member-${i+1}`,artifacts:'none'}));
  const memberIds=nodes.map(n=>n.id); const edges=[];
  if(mapNode){nodes.push(model('map','Consensus map','Consensus mapper','From the declared independent analyses, separate agreement, dispute, unique insights, and unanswered questions.',{slotId:'mapper',joinPolicy:'best-effort'}));for(const id of memberIds)edges.push(edge(id,'map'));nodes.push(model('chair','Synthesis','Chair','Produce the strongest answer from the declared analyses and consensus map without erasing unresolved disagreement.',{slotId:'chair',final:true,joinPolicy:'best-effort'}));for(const id of memberIds)edges.push(edge(id,'chair'));edges.push(edge('map','chair'));}
  else {nodes.push(model('chair',mode.id==='perspective-panel'?'Integrated view':'Council synthesis','Chair','Map agreement, conflict, unique insights, and uncertainty, then produce the strongest combined answer.',{slotId:'chair',final:true,joinPolicy:'best-effort'}));for(const id of memberIds)edges.push(edge(id,'chair'));}
  return definition(mode,'CouncilGraph',slots,nodes,edges);
}
function tournament(mode, overrides) {
  const candidateCount=3;const slots=Array.from({length:candidateCount},(_,i)=>slot(`candidate-${i+1}`,`Candidate ${i+1}`,'Candidate author',overrides));slots.push(slot('evaluator','Evaluator','Evaluator',overrides),slot('finalist','Finalist','Finalist editor',overrides));
  const nodes=Array.from({length:candidateCount},(_,i)=>model(`candidate-${i+1}`,`Candidate ${i+1}`,'Candidate author',`${mode.focus} Produce a materially distinct candidate solution independently.`,{slotId:`candidate-${i+1}`,artifacts:'none'}));const ids=nodes.map(n=>n.id);
  nodes.push(model('score','Rubric evaluation','Evaluator','Score every declared candidate using explicit criteria. Name reusable strengths and defects; do not fabricate a missing candidate.',{slotId:'evaluator',joinPolicy:'best-effort'}));nodes.push(model('winner','Winning synthesis','Finalist editor','Combine the best compatible parts into one final result and explain important tradeoffs.',{slotId:'finalist',final:true,joinPolicy:'best-effort'}));
  return definition(mode,'TournamentGraph',slots,nodes,[...ids.map(id=>edge(id,'score')),...ids.map(id=>edge(id,'winner')),edge('score','winner')]);
}
function redTeam(mode, overrides) {
  const slots=[slot('proposer','Proposer','Proposer',overrides),slot('correctness','Correctness critic','Red team reviewer',overrides),slot('risk','Risk critic','Red team reviewer',overrides),slot('repair','Defender','Defender',overrides),slot('auditor','Auditor','Auditor',overrides)];
  const nodes=[model('proposal','Proposal','Proposer',`${mode.focus} Produce a concrete initial solution.`,{slotId:'proposer',artifacts:'none'}),model('attack-correctness','Correctness attack','Red team reviewer','Attack correctness, logic, edge cases, and requirement compliance.',{slotId:'correctness'}),model('attack-risk','Risk attack','Red team reviewer','Attack security, abuse, operations, compatibility, and other distinct failure surfaces.',{slotId:'risk'}),model('repair','Repair','Defender','Repair every valid declared finding without hiding unresolved weaknesses.',{slotId:'repair'}),model('audit','Final audit','Auditor','Check each declared finding against the repair and produce the final corrected result. Do not claim tests or execution that did not occur.',{slotId:'auditor',final:true})];
  return definition(mode,'RedTeamGraph',slots,nodes,[edge('proposal','attack-correctness'),edge('proposal','attack-risk'),edge('proposal','repair'),edge('attack-correctness','repair'),edge('attack-risk','repair'),edge('attack-correctness','audit'),edge('attack-risk','audit'),edge('repair','audit')]);
}
function researchFamily(mode, overrides) {
  const slots=[slot('framer','Research framer','Research framer',overrides),slot('analyst','Evidence analyst','Evidence analyst',overrides),slot('reviewer','Method reviewer','Method reviewer',overrides),slot('synthesist','Research synthesist','Research synthesist',overrides)];
  const r=researchNode('research');
  const nodes=[
    r,
    model('framing','Research framing','Research framer',`${mode.focus} From the declared Research OS packet, state the answerable subquestions, evidence gaps, and the exact evidence dimensions the synthesis must preserve. Do not invent evidence or fetch anything.`,{slotId:'framer'}),
    model('evidence','Evidence map','Evidence analyst',`${mode.focus} Consume the declared Research OS packet and research framing. Separate direct evidence, contradiction, inference, and missing evidence.`,{slotId:'analyst'}),
    model('comparison','Comparison','Method reviewer','Compare declared evidence, surface disagreement, source independence, and methodological limits. Do not re-fetch sources.',{slotId:'reviewer'}),
    model('final','Synthesis','Research synthesist','Answer from the declared evidence artifacts with precise provenance language and explicit unknowns.',{slotId:'synthesist',final:true}),
  ];
  return definition(mode,'ResearchArtifactSynthesis',slots,nodes,[edge('research','framing'),edge('research','evidence'),edge('framing','evidence'),edge('evidence','comparison'),edge('research','comparison'),edge('research','final'),edge('framing','final'),edge('evidence','final'),edge('comparison','final')],{webPolicy:'inherit'});
}

const BUILDERS = Object.freeze({
  DraftCritiqueRevise:draftCritique,DivergeEvaluateSynthesize:divergeEvaluate,MapAuditCorrect:mapAudit,DiagnoseVariantsFinalize:diagnoseVariants,
  DivergeClusterChallengeRank:brainstorm,OptionsCriteriaSensitivityRecommend:decision,DiagnoseTeachPractice:teach,ContractImplementReviewFinalize:coding,
  HierarchyCompress:hierarchy,DebateGraph:debate,CouncilGraph:council,TournamentGraph:tournament,RedTeamGraph:redTeam,ResearchArtifactSynthesis:researchFamily,
});

export function modeDisposition(modeId) { const item=MODE_WORKFLOW_DISPOSITION[String(modeId)] || null; return item ? clone(item) : null; }
export function isWorkflowMode(modeId) { return modeDisposition(modeId)?.disposition === 'WORKFLOW_V2'; }
export function buildBuiltinWorkflow(modeId, { slotTargets = {} } = {}) {
  const disposition=modeDisposition(modeId); if(!disposition)throw fail('MODE_UNKNOWN',`Unknown mode “${modeId}”.`,404);
  if(disposition.disposition!=='WORKFLOW_V2')return null;
  const mode=getMode(modeId); const builder=BUILDERS[disposition.family]; if(!builder)throw fail('WF_BUILTIN_FAMILY',`Workflow family “${disposition.family}” is not implemented.`,500,{modeId});
  const result=builder(mode,slotTargets||{});
  const modelPasses=result.nodes.filter(node=>node.type==='model').length;
  if(modelPasses<mode.minimumPasses||modelPasses>mode.maximumPasses)throw fail('WF_BUILTIN_PASS_COUNT',`Built-in workflow “${mode.id}” has ${modelPasses} model passes outside its declared ${mode.minimumPasses}–${mode.maximumPasses} range.`,500,{modeId:mode.id,modelPasses});
  return result;
}
export function workflowCatalogue() {
  const catalogue=listModes();
  return { ...catalogue, workflowSchemaVersion:2, modes:catalogue.modes.map(mode=>({ ...mode, disposition:modeDisposition(mode.id)?.disposition||'RESPONSE_PROFILE', graphFamily:modeDisposition(mode.id)?.family||'SingleResponse', workflow:isWorkflowMode(mode.id)?{definition:buildBuiltinWorkflow(mode.id),slots:buildBuiltinWorkflow(mode.id).slots.map(slot=>({id:slot.id,label:slot.label,role:slot.role}))}:null })) };
}
export function validateBuiltinWorkflows() {
  const modes=listModes().modes; const seen=new Set(); let workflowCount=0,profileCount=0;
  for(const mode of modes){const disposition=modeDisposition(mode.id);if(!disposition)throw new Error(`Missing P4 disposition for ${mode.id}`);if(seen.has(mode.id))throw new Error(`Duplicate mode ${mode.id}`);seen.add(mode.id);if(disposition.disposition==='WORKFLOW_V2'){buildBuiltinWorkflow(mode.id);workflowCount++;}else profileCount++;}
  return {modes:modes.length,workflowCount,profileCount,families:new Set(Object.values(MODE_WORKFLOW_DISPOSITION).map(item=>item.family)).size};
}
