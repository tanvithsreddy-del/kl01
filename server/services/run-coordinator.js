import crypto from 'node:crypto';
import { fail } from '../lib/errors.js';
import { WORK_RUNS_DIR } from '../lib/paths.js';
import { WORK_EVENT_REPLAY_LIMIT, WORK_RUN_RECOVERY_MS } from '../config.js';
import { createRunJournal } from '../research/journal.js';
import { workEvent } from '../research/contracts.js';

const TERMINAL = new Set(['completed','cancelled','failed']);
const TRANSITIONS = Object.freeze({
  created:new Set(['preparing','stopping','failed','cancelled']),
  preparing:new Set(['running','stopping','failed','cancelled']),
  running:new Set(['waiting-for-user','stopping','completed','cancelled','failed','interrupted-resumable']),
  'waiting-for-user':new Set(['running','stopping','cancelled','failed','interrupted-resumable']),
  stopping:new Set(['cancelled','completed','failed','interrupted-resumable']),
  'interrupted-resumable':new Set(['preparing','running','stopping','failed','cancelled']),
  completed:new Set(),cancelled:new Set(),failed:new Set(),
});
function generatedRunId(){return `run-${crypto.randomBytes(12).toString('hex')}`;}
function normalizeRequestedRunId(value){const candidate=String(value||'').trim();return /^run-[a-zA-Z0-9_-]{8,96}$/u.test(candidate)?candidate:generatedRunId();}
function serializable(run){
  if(!run)return null;
  const {controller:_controller,listeners:_listeners,persistChain:_persistChain,...plain}=run;
  return structuredClone(plain);
}

export function createRunCoordinator({ retentionMs=10*60*1000, recoveryMs=WORK_RUN_RECOVERY_MS, replayLimit=WORK_EVENT_REPLAY_LIMIT, journal=createRunJournal({directory:WORK_RUNS_DIR,retentionMs:recoveryMs}) }={}){
  const runs=new Map(); const activeByChat=new Map();
  function cleanup(){const threshold=Date.now()-retentionMs;for(const [id,run] of runs){if(TERMINAL.has(run.state)&&Number(run.terminalAt||0)<threshold)runs.delete(id);}}
  function baseRun(input){const now=Date.now();return {runId:input.runId,chatId:input.chatId,modeId:input.modeId||'standard',profileSnapshot:input.profileSnapshot?structuredClone(input.profileSnapshot):null,state:input.state||'created',generation:Number(input.generation||1),sequence:Number(input.sequence||input.lastSeq||0),currentStageId:input.currentStageId||'answer',userMessageId:input.userMessageId||null,assistantMessageId:input.assistantMessageId||null,startedAt:Number(input.startedAt||now),updatedAt:Number(input.updatedAt||now),terminalAt:input.terminalAt||null,stopReason:input.stopReason||null,error:input.error||null,originHash:input.originHash||null,requestFingerprint:input.requestFingerprint||null,committedArtifactIds:Array.isArray(input.committedArtifactIds)?[...input.committedArtifactIds]:[],nodeSnapshots:input.nodeSnapshots&&typeof input.nodeSnapshots==='object'?structuredClone(input.nodeSnapshots):{},fallbacks:Array.isArray(input.fallbacks)?structuredClone(input.fallbacks):[],degradations:Array.isArray(input.degradations)?structuredClone(input.degradations):[],cleanupState:input.cleanupState||'active',events:Array.isArray(input.events)?input.events.slice(-replayLimit):[],controller:new AbortController(),listeners:new Set(),persistChain:Promise.resolve(),journalError:null};}
  function journalSnapshot(run){return {...serializable(run),lastSeq:run.sequence,events:run.events.slice(-Math.min(replayLimit,200)),createdAt:new Date(run.startedAt).toISOString()};}
  function schedulePersist(run){if(TERMINAL.has(run.state))return Promise.resolve();run.persistChain=run.persistChain.then(()=>journal.write(journalSnapshot(run))).catch(error=>{const wrapped=error?.code==='RUN_JOURNAL_WRITE'?error:fail('RUN_JOURNAL_WRITE','KL01 could not checkpoint this work safely. The run was stopped to avoid losing or corrupting research.',507,{runId:run.runId,causeCode:error?.code||error?.name||null},error);run.journalError=wrapped;if(!run.controller.signal.aborted)run.controller.abort(wrapped);throw wrapped;});return run.persistChain;}
  async function flush(runId){const run=get(runId);if(!run)return null;await schedulePersist(run);return serializable(run);}
  async function init(){
    const recovered=await journal.recover();
    for(const item of recovered){if(!item?.runId||['corrupt','expired','completed','cancelled','failed'].includes(item.status||item.state))continue;const run=baseRun({...item,state:'interrupted-resumable',generation:Number(item.generation||1)+1,events:[]});runs.set(run.runId,run);if(run.chatId)activeByChat.set(run.chatId,run.runId);await schedulePersist(run).catch(()=>{});}
    return recovered;
  }
  function create({runId:requestedRunId,chatId,modeId='standard',profileSnapshot=null,originHash=null,requestFingerprint=null}){cleanup();const existingId=activeByChat.get(chatId);if(existingId){const existing=runs.get(existingId);if(existing&&!TERMINAL.has(existing.state)&&existing.state!=='interrupted-resumable')throw fail('CHAT_BUSY','This chat is already receiving a response; stop it before sending another message.',409,{runId:existing.runId});if(existing?.state==='interrupted-resumable')throw fail('CHAT_RUN_RECOVERABLE','This chat has interrupted work that can be resumed or discarded first.',409,{runId:existing.runId});activeByChat.delete(chatId);}const runId=normalizeRequestedRunId(requestedRunId);if(runs.has(runId))throw fail('RUN_ID_CONFLICT','This response identifier is already in use; retry the message.',409);const run=baseRun({runId,chatId,modeId,profileSnapshot,originHash,requestFingerprint});runs.set(runId,run);activeByChat.set(chatId,runId);schedulePersist(run).catch(()=>{});return run;}
  function get(runId){return runs.get(String(runId||''))||null;}
  function activeForChat(chatId){const run=get(activeByChat.get(chatId));return run&&!TERMINAL.has(run.state)?run:null;}
  function transition(runId,nextState,patch={}){const run=get(runId);if(!run)throw fail('RUN_NOT_FOUND','This response is no longer active.',404);if(run.state===nextState)return run;if(!TRANSITIONS[run.state]?.has(nextState))throw fail('RUN_TRANSITION',`The response cannot move from ${run.state} to ${nextState}.`,409,{runId,from:run.state,to:nextState});run.state=nextState;Object.assign(run,patch);run.updatedAt=Date.now();if(TERMINAL.has(nextState)){run.terminalAt=run.updatedAt;if(activeByChat.get(run.chatId)===run.runId)activeByChat.delete(run.chatId);}else schedulePersist(run).catch(()=>{});return run;}
  function attach(runId,patch={}){const run=get(runId);if(!run)throw fail('RUN_NOT_FOUND','This response is no longer active.',404);Object.assign(run,patch,{updatedAt:Date.now()});schedulePersist(run).catch(()=>{});return run;}
  function publish(runId,type,publicPayload={},meta={}){
    const run=get(runId);if(!run)return null;
    const expectedGeneration=meta.generation==null?null:Number(meta.generation);
    if(expectedGeneration!=null&&expectedGeneration!==Number(run.generation))return null;
    const stopped=run.state==='stopping'||TERMINAL.has(run.state);
    const allowedStopped=new Set(['run-stopping','node-cancelled','resource-released','cancelled','error','done']);
    if(stopped&&!allowedStopped.has(type))return null;
    run.sequence+=1;run.updatedAt=Date.now();const elapsed=Math.max(0,run.updatedAt-run.startedAt);
    const event=workEvent({seq:run.sequence,runId:run.runId,generation:run.generation,nodeId:meta.nodeId||meta.stageId||run.currentStageId||null,attemptId:meta.attemptId||null,artifactId:meta.artifactId||null,type,timestamp:new Date(run.updatedAt).toISOString(),elapsedActiveMs:elapsed,elapsedWaitingMs:0,tokenDelta:meta.tokenDelta,tokenTotal:meta.tokenTotal,tokenExact:meta.tokenExact,targetRef:meta.targetRef,sourceRef:meta.sourceRef,state:meta.state||run.state,fallback:meta.fallback,degradation:meta.degradation,publicPayload});
    run.events.push(event);if(run.events.length>replayLimit)run.events.splice(0,run.events.length-replayLimit);for(const listener of [...run.listeners]){try{listener(event);}catch{}}schedulePersist(run).catch(()=>{});return event;
  }
  function replay(runId,after=0){const run=get(runId);if(!run)throw fail('RUN_NOT_FOUND','This response is no longer available.',404);const seq=Math.max(0,Number(after||0));const earliest=run.events[0]?.seq||Math.max(1,run.sequence+1);const gap=seq>0&&seq<earliest-1;return {gap,earliest,lastSeq:run.sequence,events:gap?[]:run.events.filter(event=>event.seq>seq)};}
  function subscribe(runId,listener){const run=get(runId);if(!run)throw fail('RUN_NOT_FOUND','This response is no longer available.',404);run.listeners.add(listener);return ()=>run.listeners.delete(listener);}
  function snapshot(runId){const run=get(runId);if(!run)return null;return {...serializable(run),events:undefined,replay:{earliestSeq:run.events[0]?.seq||null,lastSeq:run.sequence,count:run.events.length}};}
  function requestStop({runId=null,chatId=null,reason='user'}={}){const explicit=Boolean(String(runId||'').trim());const run=explicit?get(runId):(chatId?activeForChat(chatId):null);if(!run)return{status:'not-found',runId:runId||null,chatId:chatId||null};if(TERMINAL.has(run.state))return{status:'already-finished',runId:run.runId,chatId:run.chatId,state:run.state};if(run.state!=='stopping')transition(run.runId,'stopping',{stopReason:reason});if(!run.controller.signal.aborted)run.controller.abort(fail('CANCELLED','You stopped this work.',499));publish(run.runId,'run-stopping',{reason},{state:'stopping'});return{status:'stopping',runId:run.runId,chatId:run.chatId,state:run.state};}
  function stopAll(reason='shutdown'){let stopped=0,preserved=0;for(const run of runs.values()){if(TERMINAL.has(run.state))continue;if(reason==='shutdown'&&run.state==='interrupted-resumable'){preserved+=1;continue;}requestStop({runId:run.runId,reason});stopped+=1;}return{stopped,preserved};}
  async function commitArtifact(runId,artifact){const run=get(runId);if(!run)throw fail('RUN_NOT_FOUND','This response is no longer active.',404);try{await journal.writeArtifact(runId,artifact);}catch(error){run.journalError=error;if(!run.controller.signal.aborted)run.controller.abort(error);throw error;}if(!run.committedArtifactIds.includes(artifact.artifactId))run.committedArtifactIds.push(artifact.artifactId);await flush(runId);return artifact;}
  async function artifact(runId,artifactId){return journal.readArtifact(runId,artifactId);}
  async function artifacts(runId){return journal.listArtifacts(runId);}
  async function finalize(runId,state){const run=get(runId);if(!run)return null;if(!TERMINAL.has(run.state))transition(runId,state);run.cleanupState='cleanup-pending';run.updatedAt=Date.now();await run.persistChain.catch(()=>{});try{await journal.write(journalSnapshot(run));}catch(error){run.journalError=error;run.error=run.error||{code:'RUN_CLEANUP_FAIL',message:error?.publicMessage||error?.message||'Temporary work cleanup is pending.'};return{status:'cleanup-pending',runId,error:run.error};}try{await journal.remove(runId);run.cleanupState='clean';return{status:'clean',runId};}catch(error){run.cleanupState='cleanup-pending';run.error=run.error||{code:'RUN_CLEANUP_FAIL',message:error?.publicMessage||error?.message||'Temporary work cleanup is pending.'};try{await journal.write(journalSnapshot(run));}catch{}return{status:'cleanup-pending',runId,error:run.error};}}
  return {init,create,get,activeForChat,transition,attach,publish,replay,subscribe,snapshot,requestStop,stopAll,flush,commitArtifact,artifact,artifacts,finalize,isTerminal:state=>TERMINAL.has(state),journal};
}
