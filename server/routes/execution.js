import { sendJson } from './http.js';
export function executionRoute({targetManager,governor,runtimePool}){
  return async(request,response,url)=>{
    if(request.method==='GET'&&url.pathname==='/api/execution/targets'){sendJson(response,200,{targets:await targetManager.descriptors()});return true;}
    if(request.method==='GET'&&url.pathname==='/api/execution/state'){sendJson(response,200,{...(await targetManager.snapshot()),runtimePool:runtimePool.list(),resources:await governor.detailedSnapshot()});return true;}
    return false;
  };
}
