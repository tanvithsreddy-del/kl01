import { readJsonBody, sendJson } from './http.js';
import { workflowCatalogue, isWorkflowMode } from '../workflows/builtins.js';
import { workflowEstimate } from '../workflows/runner.js';
import { workflowSchemaDescription } from '../workflows/schema-v2.js';
import { preflightWorkflow } from '../workflows/preflight.js';

export function modesRoute({targetManager=null,governor=null,preferences=null}={}) {
  return async (request,response,url)=>{
    if(url.pathname==='/api/modes'&&request.method==='GET'){sendJson(response,200,{...workflowCatalogue(),workflowSchema:workflowSchemaDescription()});return true;}
    if(url.pathname==='/api/modes/estimate'&&request.method==='POST'){const body=await readJsonBody(request);const modeId=body.modeId||'standard';if(!body.workflow&&!isWorkflowMode(modeId)){sendJson(response,200,{modeId,label:modeId,passes:1,interactions:0,multiAgent:false,execution:'sequential',stages:[]});return true;}sendJson(response,200,workflowEstimate(modeId,{},body.workflow||null,{webPlan:body.webPlan||null,slotTargets:body.slotTargets||{}}));return true;}
    if(url.pathname==='/api/workflows/preflight'&&request.method==='POST'){const body=await readJsonBody(request);const settings=await preferences?.getAllSettings?.()||{};sendJson(response,200,await preflightWorkflow({modeId:body.modeId||'standard',workflow:body.workflow||null,slotTargets:body.slotTargets||{},webPlan:body.webPlan||null,targetManager,governor,allowCompatibleFallback:settings.execution?.allowCompatibleFallback!==false}));return true;}
    return false;
  };
}
