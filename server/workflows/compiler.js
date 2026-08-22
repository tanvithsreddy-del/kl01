import { fail } from '../lib/errors.js';
import { normalizeWorkflowDefinitionV2 } from './schema-v2.js';

const RETRY_CODES=Object.freeze(['MODEL_STALL','MODEL_UNAVAILABLE','MODEL_STOPPED','MODEL_CRASH','MODEL_OOM_MID','RUNTIME_EXITED']);
const clone=v=>structuredClone(v);
function mergeRequirements(a={},b={}){return{inputModalities:[...new Set([...(a.inputModalities||['text']),...(b.inputModalities||[])])],fileTypes:[...new Set([...(a.fileTypes||[]),...(b.fileTypes||[])])],structuredOutput:Boolean(a.structuredOutput||b.structuredOutput),reasoning:Boolean(a.reasoning||b.reasoning),contextTokens:Math.max(Number(a.contextTokens||0),Number(b.contextTokens||0))};}
function addEdge(edges,from,to){if(from&&to&&from!==to&&!edges.some(e=>e.from===from&&e.to===to))edges.push({from,to});}

export function compileWorkflowDefinition(input,{webPlan=null,slotTargets={},allowCompatibleFallback=true}={}){
  const definition=normalizeWorkflowDefinitionV2(input);const slots=new Map(definition.slots.map(s=>[s.id,s]));const nodes=definition.nodes.map(n=>clone(n));const edges=definition.edges.map(e=>({...e}));
  const hasResearch=nodes.some(n=>n.type==='research');
  const needsSharedResearch=Boolean(webPlan?.useWeb)&&!hasResearch&&nodes.some(n=>n.type==='model'&&n.contextPolicy?.research!=='none');
  if(needsSharedResearch){
    const researchId='research-shared';
    nodes.unshift({id:researchId,type:'research',label:'Shared research',role:'Research OS',instruction:'Build one verified EvidencePacket shared fairly across workflow participants.',slotId:null,joinPolicy:'all',quorum:null,capabilityRequirements:{inputModalities:['text'],fileTypes:[],structuredOutput:false,reasoning:false,contextTokens:0},webPolicy:{mode:'shared'},contextPolicy:{conversation:'base',artifacts:{mode:'none',nodeIds:[]},research:'none',includeAttachments:true},fallbackPolicy:{allowFallback:true,externalFallbackChain:[]},visibility:'public',final:false,question:null,condition:null,metadata:{injected:true,reason:'shared-web-evidence'}});
    for(const n of nodes)if(n.type==='model'&&n.contextPolicy?.research!=='none')addEdge(edges,researchId,n.id);
  }
  const incoming=new Map(nodes.map(n=>[n.id,[]]));for(const e of edges)incoming.get(e.to)?.push(e.from);
  for(const node of nodes){
    if(node.condition?.sourceNodeId)addEdge(edges,node.condition.sourceNodeId,node.id);
    if(node.contextPolicy?.artifacts?.mode==='explicit')for(const sourceId of node.contextPolicy.artifacts.nodeIds||[])addEdge(edges,sourceId,node.id);
  }
  for(const e of edges){const list=incoming.get(e.to);if(list&&!list.includes(e.from))list.push(e.from);}
  const graphNodes=nodes.map(node=>{
    const slotDef=node.type==='model'?(slots.get(node.slotId)||null):null;
    const override=slotDef?String(slotTargets?.[slotDef.id]||'').trim():'';
    const targetPolicy=node.type==='model'?{
      targetId:override||slotDef?.targetPolicy?.targetId||null,
      allowFallback:Boolean(allowCompatibleFallback)&&node.fallbackPolicy?.allowFallback!==false&&slotDef?.fallbackPolicy?.allowFallback!==false,
      externalFallbackChain:[...new Set([...(node.fallbackPolicy?.externalFallbackChain||[]),...(slotDef?.fallbackPolicy?.externalFallbackChain||[])])],
      slotId:slotDef?.id||null,
      targetMode:override?'explicit':slotDef?.targetPolicy?.mode||'auto',
    }:{};
    return{id:node.id,type:node.type,dependencies:[...new Set(incoming.get(node.id)||[])],joinPolicy:node.joinPolicy,quorum:node.quorum||1,capabilityRequirements:mergeRequirements(slotDef?.capabilityRequirements,node.capabilityRequirements),targetPolicy,failurePolicy:{retries:node.type==='model'?2:0,retryCodes:node.type==='model'?[...RETRY_CODES]:[]},visibility:node.visibility,metadata:{workflowNode:clone(node),slot:slotDef?clone(slotDef):null,final:Boolean(node.final)}};
  });
  return{definition,graph:{version:1,nodes:graphNodes},nodes,edges,finalNodeId:definition.finalNodeId,injectedResearch:needsSharedResearch};
}

export function workflowEstimateFromDefinition(input,{webPlan=null,slotTargets={}}={}){
  const compiled=compileWorkflowDefinition(input,{webPlan,slotTargets});
  const defs=compiled.nodes;return{modeId:compiled.definition.modeId||'custom-workflow',label:compiled.definition.name,passes:defs.filter(n=>n.type==='model').length,interactions:defs.filter(n=>n.type==='ask-user').length,researchNodes:defs.filter(n=>n.type==='research').length,multiAgent:defs.filter(n=>n.type==='model').length>1,stages:compiled.graph.nodes.map(n=>({id:n.id,label:n.metadata.workflowNode?.label||n.id,role:n.metadata.workflowNode?.role||'',type:n.type,final:Boolean(n.metadata.final),targetId:n.targetPolicy?.targetId||null,slotId:n.targetPolicy?.slotId||null,dependencies:[...n.dependencies],joinPolicy:n.joinPolicy,visibility:n.visibility})),definition:clone(compiled.definition)};
}
