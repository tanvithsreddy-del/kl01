import crypto from 'node:crypto';
import { fail, publicError } from '../lib/errors.js';
import { validateGraph, dependencyDecision } from './graph.js';
import { createCancellationTree } from './cancellation.js';

const terminal=new Set(['completed','degraded','failed','cancelled','skipped']);
const now=()=>new Date().toISOString();
function clone(v){return structuredClone(v);}
export function createExecutionScheduler({targetManager=null}={}){
  async function run({graph:rawGraph,runId,generation=1,signal=null,executeNode,commitArtifact=async a=>a,onFallback=async()=>{},onEvent=()=>{},onSnapshot=async()=>{},initialArtifacts={}}={}){
    const graph=validateGraph({...rawGraph,runId});const tree=createCancellationTree({signal,label:runId});
    const states=new Map(graph.nodes.map(n=>{const recovered=initialArtifacts instanceof Map?initialArtifacts.get(n.id):initialArtifacts?.[n.id];return[n.id,{id:n.id,status:recovered?'completed':'pending',attempts:recovered?[{attemptId:'recovered',number:0,status:'completed',startedAt:recovered.createdAt||null,completedAt:recovered.createdAt||null,recovered:true}]:[],startedAt:recovered?.createdAt||null,completedAt:recovered?.createdAt||null,target:recovered?.payload?.target||null,artifact:recovered?clone(recovered):null,error:null,failure:null,dependencies:[...n.dependencies]}];}));
    const running=new Map();let effectiveExecution='sequential';let maxConcurrent=0;let activeWork=0;let degradedToSequential=false;const potentialParallel=graph.nodes.filter(n=>!n.dependencies.length).length>1;
    const snapshot=()=>({version:1,runId,generation,effectiveExecution,degradedToSequential,nodes:Object.fromEntries([...states].map(([id,v])=>[id,clone(v)]))});
    const emit=(type,node,payload={},meta={})=>onEvent(type,{runId,nodeId:node?.id||null,state:node?.status||null,...payload},{nodeId:node?.id||null,attemptId:meta.attemptId||null,targetRef:meta.targetRef||node?.target?.targetId||null,state:node?.status||null,degradation:meta.degradation||null});
    async function publishSnapshot(){await onSnapshot(snapshot());}
    async function execute(def,state){
      const attemptNo=state.attempts.length+1;const attemptId=`attempt-${crypto.randomBytes(8).toString('hex')}`;const attempt={attemptId,number:attemptNo,status:'running',startedAt:now(),completedAt:null,error:null,targetId:null};state.attempts.push(attempt);state.status='ready';emit('node-ready',state,{attempt:attemptNo},{attemptId});await publishSnapshot();
      const child=tree.child(`${def.id}:${attemptId}`);let lease=null;
      try{
        const requiresTarget=def.type==='model';state.status=def.type==='ask-user'?'waiting-user':requiresTarget?'loading-target':'running';if(requiresTarget)emit('node-loading-target',state,{attempt:attemptNo},{attemptId});await publishSnapshot();
        if(requiresTarget&&targetManager){
          const priorRuntimeFailures=state.attempts.slice(0,-1).filter(a=>['MODEL_OOM_MID','MODEL_CRASH','RUNTIME_EXITED'].includes(a.failureCode||a.error?.code));const avoidTargetIds=priorRuntimeFailures.length>=2&&priorRuntimeFailures.at(-1)?.error?.targetId?[priorRuntimeFailures.at(-1).error.targetId]:[];
          lease=await targetManager.acquire({targetId:def.targetPolicy?.targetId||null,requirements:def.capabilityRequirements||{},owner:{runId,nodeId:def.id,attemptId,generation},signal:child.signal,allowFallback:def.targetPolicy?.allowFallback!==false,externalFallbackChain:def.targetPolicy?.externalFallbackChain||[],avoidTargetIds,onEvent:(type,payload)=>{if(type==='node-queued-resource'){state.status='queued-resource';if(potentialParallel&&activeWork>0){degradedToSequential=true;emit('execution-mode',state,{mode:'degraded-to-sequential',reason:payload?.code||'resource-pressure'},{attemptId,degradation:{code:'WF_PARALLEL_TO_SEQ'}});}emit(type,state,payload,{attemptId});}else emit(type,state,payload,{attemptId,targetRef:payload?.targetId});},onFallback:record=>onFallback(record,{node:def,attemptId})});
          state.target={targetId:lease.targetId,name:lease.descriptor.name,kind:lease.descriptor.kind};attempt.targetId=lease.targetId;
        }
        state.status=def.type==='ask-user'?'waiting-user':'running';state.startedAt=state.startedAt||now();emit('node-started',state,{attempt:attemptNo,target:state.target},{attemptId,targetRef:lease?.targetId});await publishSnapshot();
        const deps=Object.fromEntries(def.dependencies.map(id=>[id,clone(states.get(id))]));
        activeWork+=1;maxConcurrent=Math.max(maxConcurrent,activeWork);if(maxConcurrent>1){effectiveExecution='parallel';emit('execution-mode',state,{mode:'parallel',width:maxConcurrent},{attemptId});}
        let result;try{result=await executeNode({node:def,state:clone(state),dependencies:deps,lease,signal:child.signal,attemptId,generation});}finally{activeWork=Math.max(0,activeWork-1);}
        if(child.signal.aborted)throw child.signal.reason||fail('CANCELLED','You stopped this step.',499);
        if(result?.skipped){state.status='skipped';state.completedAt=now();attempt.status='skipped';attempt.completedAt=state.completedAt;emit('node-skipped',state,{attempt:attemptNo,reason:result.reason||'condition'},{attemptId});await publishSnapshot();return;}
        if(result?.artifact){const committed=await commitArtifact(result.artifact,{node:def,attemptId});state.artifact=clone(committed);}
        state.status=result?.degraded?'degraded':'completed';state.completedAt=now();attempt.status=state.status;attempt.completedAt=state.completedAt;emit(state.status==='degraded'?'node-degraded':'node-completed',state,{attempt:attemptNo,artifactId:state.artifact?.artifactId||null,result:result?.publicResult||null},{attemptId,artifactId:state.artifact?.artifactId||null});await publishSnapshot();
      }catch(error){
        const cancelled=child.signal.aborted||error?.code==='CANCELLED';attempt.status=cancelled?'cancelled':'failed';attempt.completedAt=now();attempt.failureCode=cancelled?'CANCELLED':(error?.code||'UNKNOWN');attempt.error=cancelled?null:publicError(error);if(lease?.targetId)attempt.error={...(attempt.error||{}),targetId:lease.targetId};state.error=attempt.error;state.failure=cancelled?null:{code:error?.code||'UNKNOWN',message:error?.publicMessage||error?.message||'This workflow step failed.',status:Number(error?.status||500),details:error?.details?clone(error.details):undefined};
        const retries=Math.max(0,Number(def.failurePolicy?.retries||0));const retryCodes=Array.isArray(def.failurePolicy?.retryCodes)?new Set(def.failurePolicy.retryCodes):null;const retryable=!retryCodes||retryCodes.has(error?.code||'UNKNOWN');if(!cancelled&&retryable&&attemptNo<=retries){if(lease){targetManager?.release?.(lease);lease=null;}child.dispose();state.status='pending';emit('node-retrying',state,{attempt:attemptNo,error:attempt.error},{attemptId});await publishSnapshot();return execute(def,state);}
        state.status=cancelled?'cancelled':'failed';state.completedAt=now();emit(cancelled?'node-cancelled':'node-failed',state,{attempt:attemptNo,error:attempt.error},{attemptId});await publishSnapshot();
      }finally{if(lease)targetManager?.release?.(lease);child.dispose();}
    }
    try{
      while(true){
        if(tree.signal.aborted){for(const state of states.values())if(!terminal.has(state.status)&&!running.has(state.id)){state.status='cancelled';state.completedAt=now();emit('node-cancelled',state,{});}break;}
        let launched=0;
        for(const def of graph.nodes){const state=states.get(def.id);if(state.status!=='pending'||running.has(def.id))continue;const decision=dependencyDecision(def,states);if(decision.failed){state.status='skipped';state.completedAt=now();state.error={code:'WF_JOIN_MISSING',message:'Required dependency output is unavailable.'};state.failure={code:'WF_JOIN_MISSING',message:'Required dependency output is unavailable.',status:409,details:{nodeId:def.id}};emit('node-skipped',state,{reason:'dependency-policy'});await publishSnapshot();continue;}if(!decision.ready)continue;
          const task=execute(def,state).finally(()=>running.delete(def.id));running.set(def.id,task);launched+=1;
        }
        if(!running.size){const unfinished=[...states.values()].filter(s=>!terminal.has(s.status));if(!unfinished.length)break;throw fail('WF_JOIN_MISSING','Workflow cannot make progress because required artifacts are missing.',409,{nodes:unfinished.map(s=>s.id)});}
        if(!launched)await Promise.race([...running.values()]);else await Promise.resolve();
      }
      await Promise.allSettled([...running.values()]);
      if(maxConcurrent<=1)effectiveExecution=degradedToSequential&&potentialParallel?'degraded-to-sequential':'sequential';
      return{snapshot:snapshot(),states,artifacts:[...states.values()].map(s=>s.artifact).filter(Boolean),effectiveExecution,maxConcurrent};
    }finally{tree.abort(tree.signal.reason);tree.close();}
  }
  return{run};
}
