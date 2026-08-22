import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fail } from '../lib/errors.js';
import { inspectMachine } from '../services/machine.js';

function ownerKey(owner={}){return `${owner.runId||'run'}:${owner.nodeId||'node'}:${owner.attemptId||'attempt'}`;}
export function createResourceGovernor({runtimePool,machineSampler=inspectMachine,processRegistry=null}={}){
  const reservations=new Map();
  const emitter=new EventEmitter();
  let telemetryEstimated=false;let changeVersion=0;let allocationTail=Promise.resolve();
  const reservedForTarget=targetId=>[...reservations.values()].filter(r=>r.targetId===targetId&&!r.released);
  const activeReservations=()=>[...reservations.values()].filter(r=>!r.released);
  const pendingLoadBytes=()=>activeReservations().reduce((sum,r)=>sum+Math.max(0,Number(r.loadReservationBytes||0)),0);
  const changed=()=>{changeVersion+=1;emitter.emit('changed',changeVersion);};
  async function withAllocationLock(work){
    const previous=allocationTail;let release;allocationTail=new Promise(resolve=>{release=resolve;});
    await previous;try{return await work();}finally{release();}
  }
  async function sample(){
    try{
      const machine=await machineSampler();
      if(!(Number(machine?.memoryAvailable)>0))throw new Error('memory unavailable');
      telemetryEstimated=false;
      return{...machine,estimated:false};
    }catch{
      telemetryEstimated=true;
      return{memoryTotal:0,memoryAvailable:0,diskAvailable:0,cores:1,processor:'Unknown',estimated:true};
    }
  }
  function snapshot(machine=null,processes=null){
    return{version:1,reservations:activeReservations().map(r=>({leaseId:r.leaseId,targetId:r.targetId,owner:r.owner,estimatedBytes:r.estimatedBytes,loadReservationBytes:r.loadReservationBytes||0,acquiredAt:r.acquiredAt,confirmedAt:r.confirmedAt||null})),telemetryEstimated,machine:machine?structuredClone(machine):null,processes:processes?structuredClone(processes):null};
  }
  async function detailedSnapshot(){
    const [machine,processes]=await Promise.all([sample(),processRegistry?.snapshot?.()||Promise.resolve([])]);
    return snapshot(machine,processes);
  }
  function waitChange(signal,since=changeVersion){
    if(changeVersion!==since)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{emitter.off('changed',done);signal?.removeEventListener?.('abort',abort);};
      const done=()=>{cleanup();resolve();};
      const abort=()=>{cleanup();reject(signal.reason||fail('CANCELLED','You stopped this work.',499));};
      emitter.once('changed',done);
      if(changeVersion!==since)done();else if(signal?.aborted)abort();else signal?.addEventListener?.('abort',abort,{once:true});
    });
  }
  async function acquire({descriptor,owner,signal,onEvent=()=>{},queue=true}={}){
    if(!descriptor)throw fail('MODEL_NONE','No AI model is available for this run.',409);
    const capacity=Math.max(1,Number(descriptor.runtime?.parallelVerified?descriptor.runtime.parallelCapacity:1));
    const key=ownerKey(owner);
    while(true){
      if(signal?.aborted)throw signal.reason||fail('CANCELLED','You stopped this work.',499);
      const decision=await withAllocationLock(async()=>{
        if(signal?.aborted)throw signal.reason||fail('CANCELLED','You stopped this work.',499);
        const current=reservedForTarget(descriptor.targetId);
        if(current.some(r=>ownerKey(r.owner)===key))throw fail('INFERENCE_OWNER_COLLISION','This execution attempt already owns a target lease.',409,{targetId:descriptor.targetId,owner});
        if(current.length>=capacity)return{wait:true,code:'MODEL_RESERVED',message:'Waiting for model resources',version:changeVersion};
        let machine=await sample();
        const loaded=descriptor.kind==='external'||runtimePool?.isLoaded(descriptor.targetId);
        const need=loaded?0:Math.max(0,Number(descriptor.resources?.estimatedWorkingSetBytes||0));
        let effectiveAvailable=Math.max(0,Number(machine.memoryAvailable||0)-pendingLoadBytes());
        if(machine.estimated&&need>0&&activeReservations().some(r=>r.targetId!==descriptor.targetId&&Number(r.loadReservationBytes||0)>0))return{wait:true,code:'MODEL_TELEMETRY_FAIL',message:'≈ resource estimate · waiting to load safely',version:changeVersion,estimated:true};
        if(!machine.estimated&&need>0&&effectiveAvailable<need){
          const freed=await runtimePool?.unloadIdle({excludeTargetIds:[descriptor.targetId]});
          if(freed?.count){
            onEvent('resource-snapshot',{code:'MODEL_UNLOAD_IDLE',message:'Freeing memory from an idle model',unloaded:freed.unloaded});
            machine=await sample();effectiveAvailable=Math.max(0,Number(machine.memoryAvailable||0)-pendingLoadBytes());
          }
        }
        if(!machine.estimated&&need>0&&effectiveAvailable<need){
          if(queue&&activeReservations().length)return{wait:true,code:'MODEL_OOM_PRE',message:'Not enough memory for requested setup · waiting for active work',version:changeVersion};
          throw fail('MODEL_OOM_PRE','Not enough memory for the requested model setup.',409,{targetId:descriptor.targetId,neededBytes:need,availableBytes:effectiveAvailable});
        }
        const leaseId=`lease-${crypto.randomBytes(10).toString('hex')}`;
        const reservation={leaseId,targetId:descriptor.targetId,owner:structuredClone(owner||{}),estimatedBytes:need,loadReservationBytes:need,acquiredAt:new Date().toISOString(),released:false};
        reservations.set(leaseId,reservation);changed();
        return{reservation:{...reservation,machine,snapshot:snapshot(machine)}};
      });
      if(decision.reservation)return decision.reservation;
      if(!queue){
        if(decision.code==='MODEL_TELEMETRY_FAIL')throw fail('MODEL_TELEMETRY_FAIL','Resource telemetry is unavailable; KL01 is conservatively serializing model loads.',409,{targetId:descriptor.targetId,estimated:true});
        if(decision.code==='MODEL_OOM_PRE')throw fail('MODEL_OOM_PRE','Not enough memory for the requested model setup.',409,{targetId:descriptor.targetId});
        throw fail('MODEL_RESERVED','This model is owned by another active run.',409,{targetId:descriptor.targetId});
      }
      onEvent('node-queued-resource',{code:decision.code,targetId:descriptor.targetId,message:decision.message});
      await waitChange(signal,decision.version);
    }
  }
  async function confirmLoaded(leaseId){
    const r=reservations.get(String(leaseId||''));
    if(!r||r.released)throw fail('TARGET_LEASE_STALE','Execution target changed · reacquiring safely.',409,{leaseId});
    r.loadReservationBytes=0;r.confirmedAt=new Date().toISOString();
    const detailed=await detailedSnapshot();changed();return detailed;
  }
  function assertOwner(leaseId,owner){
    const r=reservations.get(String(leaseId||''));
    if(!r||r.released)throw fail('TARGET_LEASE_STALE','Execution target changed · reacquiring safely.',409,{leaseId});
    if(owner&&ownerKey(r.owner)!==ownerKey(owner))throw fail('INFERENCE_OWNER_COLLISION','Execution scheduling conflict · work queued safely.',409,{leaseId,expected:r.owner,received:owner});
    return r;
  }
  function release(leaseId){const r=reservations.get(String(leaseId||''));if(!r||r.released)return false;r.released=true;r.releasedAt=new Date().toISOString();changed();return true;}
  function reservationCount(targetId){return reservedForTarget(targetId).length;}
  function subscribe(listener){emitter.on('changed',listener);return()=>emitter.off('changed',listener);}
  return{acquire,confirmLoaded,release,assertOwner,reservationCount,snapshot,detailedSnapshot,sample,activeReservations,subscribe,telemetryEstimated:()=>telemetryEstimated};
}
