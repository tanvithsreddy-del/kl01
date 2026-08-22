import crypto from 'node:crypto';
import { fail } from '../lib/errors.js';

function clone(v){return structuredClone(v);}
function stopFailure(slot,error){
  if(error?.code==='RUNTIME_STOP_FAILED')return error;
  return fail('RUNTIME_STOP_FAILED','KL01 could not stop an AI process safely. The model is still treated as loaded; retry the action or restart KL01.',507,{runtimeId:slot?.runtimeId||null,targetId:slot?.targetId||null,causeCode:error?.code||error?.name||null},error);
}
export function createRuntimePool({primaryRuntime=null,createRuntime=null}={}){
  const slots=new Map();
  if(primaryRuntime)slots.set('interactive',{runtimeId:'interactive',runtime:primaryRuntime,primary:true,owners:new Set(),targetId:primaryRuntime.getState()?.modelId?`local:${primaryRuntime.getState().modelId}`:null,lastUsedAt:Date.now()});
  function sync(slot){const state=slot.runtime.getState();slot.targetId=state.modelId?`local:${state.modelId}`:null;slot.lastState=state;return state;}
  function list(){return [...slots.values()].map(slot=>{const state=sync(slot);return{runtimeId:slot.runtimeId,primary:slot.primary,targetId:slot.targetId,owners:[...slot.owners],lastUsedAt:slot.lastUsedAt,state,process:slot.runtime.processInfo?.()||null};});}
  function slotForTarget(targetId){return [...slots.values()].find(slot=>{const state=sync(slot);return state.status==='ready'&&slot.targetId===targetId;})||null;}
  function availableStoppedSlot(){return [...slots.values()].find(slot=>slot.owners.size===0&&['stopped','failed'].includes(sync(slot).status))||null;}
  async function makeSlot(){if(!createRuntime)throw fail('RUNTIME_POOL_UNAVAILABLE','KL01 cannot start a second local model process in this runtime build.',409);const runtimeId=`runtime-${crypto.randomBytes(6).toString('hex')}`;const runtime=await createRuntime(runtimeId);const slot={runtimeId,runtime,primary:false,owners:new Set(),targetId:null,lastUsedAt:Date.now()};slots.set(runtimeId,slot);return slot;}
  async function stopSlot(slot){
    const targetId=slot.targetId;
    try{await slot.runtime.stop();}
    catch(error){sync(slot);throw stopFailure(slot,error);}
    const state=sync(slot);
    if(state.status!=='stopped'||slot.targetId){throw stopFailure(slot,fail('RUNTIME_STOP_UNCONFIRMED','The AI process did not report a stopped state.',507,{runtimeId:slot.runtimeId,targetId,state:state.status}));}
    slot.lastUsedAt=Date.now();
    return{runtimeId:slot.runtimeId,targetId};
  }
  async function ensure(targetId,{leaseId,modelId,signal,onEvent=()=>{}}={}){
    if(!String(targetId).startsWith('local:'))throw fail('RUNTIME_TARGET','Only local targets use the local runtime pool.',500,{targetId});
    let slot=slotForTarget(targetId);
    if(slot&&!slot.owners.has(leaseId)){const live=sync(slot);const capacity=live.parallelVerified?Math.max(1,Number(live.parallelCapacity||1)):1;if(slot.owners.size>=capacity)throw fail('MODEL_RESERVED','This model process is at its verified execution capacity.',409,{targetId,runtimeId:slot.runtimeId,capacity});}
    if(!slot){
      slot=availableStoppedSlot();
      if(!slot){
        const idle=[...slots.values()].find(candidate=>candidate.owners.size===0&&sync(candidate).status==='ready');
        if(idle){await stopSlot(idle);slot=idle;}
      }
      if(!slot)slot=await makeSlot();
      if(signal?.aborted)throw signal.reason||fail('CANCELLED','You stopped this work.',499);
      onEvent('node-loading-target',{targetId,runtimeId:slot.runtimeId});
      await slot.runtime.activate(modelId,{persistSelection:false,parallel:1});
      sync(slot);
      if(slot.targetId!==targetId)throw fail('RUNTIME_TARGET_MISMATCH','The local runtime started a different model than requested.',500,{requested:targetId,actual:slot.targetId});
    }
    slot.owners.add(leaseId);slot.lastUsedAt=Date.now();
    const state=sync(slot);
    return{kind:'local',runtimeId:slot.runtimeId,baseUrl:slot.runtime.endpoint(),model:'local',contextSize:Number(state.contextSize||0),contextEstimated:false,contextUnknown:false,parallelCapacity:Number(state.parallelCapacity||1),parallelVerified:Boolean(state.parallelVerified)};
  }
  function release(leaseId){for(const slot of slots.values())if(slot.owners.delete(leaseId)){slot.lastUsedAt=Date.now();return true;}return false;}
  async function unloadTarget(targetId){
    const slot=[...slots.values()].find(candidate=>{sync(candidate);return candidate.targetId===targetId;});
    if(!slot)return{unloaded:false,reason:'not-loaded'};
    if(slot.owners.size)return{unloaded:false,reason:'owned',owners:[...slot.owners]};
    const state=sync(slot);
    if(!['ready','failed'].includes(state.status))return{unloaded:false,reason:state.status};
    const stopped=await stopSlot(slot);
    return{unloaded:true,...stopped};
  }
  async function unloadIdle({excludeTargetIds=[]}={}){
    const blocked=new Set(excludeTargetIds);let count=0;const unloaded=[];const failed=[];
    for(const slot of slots.values()){
      const state=sync(slot);if(slot.owners.size||state.status!=='ready'||blocked.has(slot.targetId))continue;
      try{const stopped=await stopSlot(slot);unloaded.push(stopped);count+=1;}
      catch(error){failed.push({runtimeId:slot.runtimeId,targetId:slot.targetId,code:error?.code||'RUNTIME_STOP_FAILED',message:error?.publicMessage||error?.message||'Model stop failed.'});}
    }
    return{count,unloaded,failed};
  }
  async function stopOwned(leaseIds=[]){
    const ids=new Set(leaseIds);const stopped=[];const failed=[];
    for(const slot of slots.values()){
      const matched=[...slot.owners].filter(id=>ids.has(id));if(!matched.length)continue;
      for(const id of matched)slot.owners.delete(id);
      if(slot.owners.size)continue;
      try{stopped.push(await stopSlot(slot));}
      catch(error){failed.push({runtimeId:slot.runtimeId,targetId:slot.targetId,code:error?.code||'RUNTIME_STOP_FAILED',message:error?.publicMessage||error?.message||'Model stop failed.'});}
    }
    return{stopped,failed};
  }
  async function close(){
    const stopped=[];const failed=[];
    for(const slot of slots.values()){
      try{stopped.push(await stopSlot(slot));}
      catch(error){failed.push({runtimeId:slot.runtimeId,targetId:slot.targetId,code:error?.code||'RUNTIME_STOP_FAILED',message:error?.publicMessage||error?.message||'Model stop failed.'});}
    }
    if(!failed.length)slots.clear();
    return{stopped,failed};
  }
  return{list,slotForTarget,isLoaded:targetId=>Boolean(slotForTarget(targetId)),ensure,release,unloadTarget,unloadIdle,stopOwned,close};
}
