import { fail } from '../lib/errors.js';
import * as services from '../services/services.js';
import { targetLease, compatibility } from './target-descriptor.js';
import { fallbackCandidates, fallbackRecord } from './fallback.js';
import { USER_AGENT } from '../config.js';

function ownerGeneration(owner={}){return Math.max(1,Number(owner.generation||1));}
export function createTargetManager({registry,governor,runtimePool}={}){
  const leases=new Map();
  async function transportFor(descriptor,reservation,{signal,onEvent}={}){
    if(descriptor.kind==='external'){
      const service=await services.getService(descriptor.id);const headers={'content-type':'application/json','user-agent':USER_AGENT};if(service.apiKey)headers.authorization=`Bearer ${service.apiKey}`;
      return{kind:'external',serviceId:service.id,baseUrl:service.baseUrl,model:service.model,headers,contextSize:Number(service.contextSize||0),contextEstimated:true,contextUnknown:!Number(service.contextSize||0),parallelCapacity:1,parallelVerified:false};
    }
    return runtimePool.ensure(descriptor.targetId,{leaseId:reservation.leaseId,modelId:descriptor.id,signal,onEvent});
  }
  async function attempt(descriptor,{requirements,owner,signal,onEvent,queue=true}={}){
    const fit=compatibility(descriptor,requirements);if(!fit.ok){const first=fit.reasons[0];throw fail(first?.code||'MODEL_CAPABILITY',first?.message||'Selected model cannot handle this step.',409,{targetId:descriptor.targetId,reasons:fit.reasons});}
    const reservation=await governor.acquire({descriptor,owner,signal,onEvent,queue});
    try{
      const transport=await transportFor(descriptor,reservation,{signal,onEvent});
      const resourceState=await governor.confirmLoaded?.(reservation.leaseId);if(resourceState)onEvent('resource-snapshot',{code:'MODEL_LOAD_CONFIRMED',targetId:descriptor.targetId,message:'Model resources confirmed after load',resources:resourceState});
      const lease=targetLease({leaseId:reservation.leaseId,generation:ownerGeneration(owner),targetId:descriptor.targetId,descriptor,owner,transport});
      leases.set(lease.leaseId,lease);onEvent('target-pinned',{targetId:descriptor.targetId,leaseId:lease.leaseId,owner});return lease;
    }catch(error){governor.release(reservation.leaseId);runtimePool?.release?.(reservation.leaseId);throw error;}
  }
  async function acquire({targetId=null,requirements={},owner={},signal,onEvent=()=>{},allowFallback=true,externalFallbackChain=[],onFallback=async()=>{},avoidTargetIds=[]}={}){
    const avoided=new Set((avoidTargetIds||[]).map(String));let requested=null;let firstError=null;let requestedMissing=false;
    if(targetId){
      try{requested=await registry.get(targetId);}
      catch(error){
        if(!allowFallback||error?.code!=='WORKFLOW_TARGET_MISSING')throw error;
        const raw=String(targetId);const split=raw.indexOf(':');const kind=split>0?raw.slice(0,split):'unknown';const id=split>0?raw.slice(split+1):raw;
        requested={targetId:raw,kind,id,name:'Requested model',resources:{estimatedWorkingSetBytes:0,estimated:true}};firstError=error;requestedMissing=true;
        onEvent('target-failed',{targetId:raw,code:error.code,message:'Requested model is no longer available · checking compatible fallback'});
      }
    }else requested=await registry.preference();
    if(!requested)throw fail('MODEL_NONE','No AI model is available for this run.',409);
    if(!firstError&&avoided.has(requested.targetId))firstError=fail('MODEL_OOM_MID','Requested target previously failed during this node; seeking compatible fallback.',409,{targetId:requested.targetId});
    for(let retry=0;retry<2&&!requestedMissing&&!avoided.has(requested.targetId);retry++){
      try{return await attempt(requested,{requirements,owner,signal,onEvent,queue:true});}
      catch(error){firstError=error;if(['MODEL_CAPABILITY','MODEL_CONTEXT','CANCELLED','MODEL_RESERVED'].includes(error?.code)||retry===1)break;onEvent('target-failed',{targetId:requested.targetId,code:error?.code||'MODEL_LOAD_FAIL',message:'Selected model failed to start · retrying after cleanup'});await runtimePool?.unloadIdle?.({excludeTargetIds:[requested.targetId]});}
    }
    if(!allowFallback)throw firstError;
    const all=await registry.descriptors();const candidates=fallbackCandidates({requested,descriptors:all.filter(d=>!avoided.has(d.targetId)),requirements,externalChain:externalFallbackChain});
    for(const candidate of candidates){
      try{
        const lease=await attempt(candidate,{requirements,owner,signal,onEvent,queue:true});
        const record=fallbackRecord({requested,selected:candidate,reason:firstError,owner});
        try { await onFallback(record); onEvent('target-fallback',{...record}); }
        catch (error) { release(lease); throw error; }
        return lease;
      }catch(error){if(error?.code==='CANCELLED')throw error;}
    }
    throw fail(firstError?.code==='MODEL_CAPABILITY'?'MODEL_CAPABILITY':'MODEL_FALLBACK_NONE','No compatible installed model can complete this step.',409,{requestedTargetId:requested.targetId,required:requirements,cause:firstError?.code||null});
  }
  function assertLease(lease,owner=null){if(!lease||!leases.has(lease.leaseId)||lease.released)throw fail('TARGET_LEASE_STALE','Execution target changed · reacquiring safely.',409,{leaseId:lease?.leaseId||null});governor.assertOwner(lease.leaseId,owner||lease.owner);if(Number(lease.generation)!==ownerGeneration(owner||lease.owner))throw fail('TARGET_LEASE_STALE','Execution target changed · reacquiring safely.',409,{leaseId:lease.leaseId});return lease;}
  function release(lease){if(!lease||lease.released)return false;lease.released=true;lease.releasedAt=new Date().toISOString();leases.delete(lease.leaseId);runtimePool?.release?.(lease.leaseId);governor.release(lease.leaseId);return true;}
  async function withLease(options,work){const lease=await acquire(options);try{return await work(lease);}finally{release(lease);}}
  async function snapshot(){return{targets:await registry.descriptors(),resources:governor.snapshot(),leases:[...leases.values()].map(l=>({leaseId:l.leaseId,targetId:l.targetId,owner:l.owner,acquiredAt:l.acquiredAt}))};}
  function runtimeState(lease){if(!lease||lease.descriptor?.kind!=='local')return null;return runtimePool?.list?.().find(slot=>slot.runtimeId===lease.transport?.runtimeId)?.state||null;}
  return{acquire,release,withLease,assertLease,runtimeState,snapshot,preference:()=>registry.preference(),descriptors:()=>registry.descriptors()};
}
