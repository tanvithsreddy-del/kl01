import { fail } from '../lib/errors.js';

export const NODE_STATES=Object.freeze(['pending','ready','queued-resource','loading-target','running','waiting-user','completed','degraded','failed','cancelled','skipped']);
export const JOIN_POLICIES=Object.freeze(['all','any','quorum','best-effort']);
function cleanId(v){return String(v||'').trim();}
export function normalizeGraph(input={}){
  const nodes=(input.nodes||[]).map(raw=>({id:cleanId(raw.id),type:String(raw.type||'model'),dependencies:[...new Set((raw.dependencies||[]).map(cleanId).filter(Boolean))],joinPolicy:JOIN_POLICIES.includes(raw.joinPolicy)?raw.joinPolicy:'all',quorum:Math.max(1,Number(raw.quorum||1)),capabilityRequirements:structuredClone(raw.capabilityRequirements||{}),targetPolicy:structuredClone(raw.targetPolicy||{}),failurePolicy:structuredClone(raw.failurePolicy||{retries:0}),visibility:raw.visibility||'public',metadata:structuredClone(raw.metadata||{})}));
  return{version:1,runId:input.runId||null,nodes};
}
export function validateGraph(input={}){
  const graph=normalizeGraph(input);if(!graph.nodes.length)throw fail('WF_EMPTY','Workflow has no executable steps.',400);
  const byId=new Map();for(const node of graph.nodes){if(!node.id||byId.has(node.id))throw fail('WF_NODE_ID','Workflow contains a missing or duplicate step identifier.',400,{nodeId:node.id});byId.set(node.id,node);}
  for(const node of graph.nodes)for(const dep of node.dependencies)if(!byId.has(dep))throw fail('WF_JOIN_MISSING','Workflow references a step that does not exist.',400,{nodeId:node.id,dependency:dep});
  const color=new Map(),stack=[];function visit(id){const c=color.get(id)||0;if(c===2)return;if(c===1){const start=stack.indexOf(id);throw fail('WF_CYCLE','Workflow has a dependency loop.',400,{cycle:[...stack.slice(start),id]});}color.set(id,1);stack.push(id);for(const dep of byId.get(id).dependencies)visit(dep);stack.pop();color.set(id,2);}for(const id of byId.keys())visit(id);
  return graph;
}
export function dependencyDecision(node,states){const deps=node.dependencies.map(id=>states.get(id)).filter(Boolean);if(!node.dependencies.length)return{ready:true,failed:false,available:[]};const successes=deps.filter(d=>['completed','degraded'].includes(d.status));const terminal=deps.filter(d=>['completed','degraded','failed','cancelled','skipped'].includes(d.status));if(node.joinPolicy==='any'){if(successes.length)return{ready:true,failed:false,available:successes};if(terminal.length===deps.length)return{ready:false,failed:true,available:[]};return{ready:false,failed:false,available:[]};}if(node.joinPolicy==='quorum'){if(successes.length>=node.quorum)return{ready:true,failed:false,available:successes};if(successes.length+(deps.length-terminal.length)<node.quorum)return{ready:false,failed:true,available:successes};return{ready:false,failed:false,available:successes};}if(node.joinPolicy==='best-effort'){if(terminal.length===deps.length)return{ready:true,failed:false,available:successes};return{ready:false,failed:false,available:successes};}if(deps.some(d=>['failed','cancelled','skipped'].includes(d.status)))return{ready:false,failed:true,available:successes};return{ready:successes.length===deps.length,failed:false,available:successes};}
