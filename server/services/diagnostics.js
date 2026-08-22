import os from 'node:os';
import { PRODUCT_NAME, PRODUCT_STAGE } from '../config.js';
import * as chats from './chats.js';

const safeString=(value,max=160)=>String(value??'').replace(/[\u0000-\u001f\u007f]/gu,' ').trim().slice(0,max);
const safeId=value=>safeString(value,180).replace(/[^a-zA-Z0-9._:/@+-]/gu,'-');
const safeCode=value=>safeString(value,96).replace(/[^A-Z0-9_.:-]/giu,'_');
const time=value=>{const parsed=Date.parse(String(value||''));return Number.isFinite(parsed)?new Date(parsed).toISOString():null;};
const finite=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;

function targetRef(value){const id=safeId(value);return id||null;}
function safeFallback(item={}){
  return {
    requestedTargetId:targetRef(item.requestedTargetId),
    selectedTargetId:targetRef(item.selectedTargetId||item.targetId),
    reasonCode:safeCode(item.reasonCode||item.code||item.reason)||null,
    at:time(item.at||item.createdAt||item.timestamp),
  };
}
function safeExecution(execution={},includeDeveloperDetail=false){
  const events=Array.isArray(execution.events)?execution.events:[];
  return {
    requestedTargetId:targetRef(execution.requestedTargetId),
    activeTargetId:targetRef(execution.activeTargetId),
    effectiveMode:safeCode(execution.effectiveMode||'sequential'),
    fallbackPath:(execution.fallbacks||[]).map(safeFallback),
    live:execution.live?{type:safeCode(execution.live.type),stageId:includeDeveloperDetail?safeId(execution.live.stageId):null,elapsedMs:Math.max(0,finite(execution.live.elapsedMs))}:null,
    events:events.slice(-60).map(event=>({
      type:safeCode(event.type),
      code:safeCode(event.code)||null,
      at:time(event.at),
      targetId:includeDeveloperDetail?targetRef(event.targetId):null,
      stageId:includeDeveloperDetail?safeId(event.stageId):null,
    })),
  };
}
function safeAttempt(attempt={},includeDeveloperDetail=false){
  return {
    number:Math.max(0,Math.floor(finite(attempt.number))),
    status:safeCode(attempt.status),
    startedAt:time(attempt.startedAt),
    completedAt:time(attempt.completedAt),
    failureCode:safeCode(attempt.failureCode)||null,
    targetId:includeDeveloperDetail?targetRef(attempt.targetId):null,
  };
}
function safeWorkflow(workflow={},includeDeveloperDetail=false){
  const stages=Array.isArray(workflow.stages)?workflow.stages:[];
  return {
    definitionVersion:finite(workflow.definitionVersion||workflow.version||2,2),
    modeId:safeId(workflow.modeId),
    family:safeCode(workflow.family)||null,
    status:safeCode(workflow.status),
    effectiveExecution:safeCode(workflow.effectiveExecution),
    maxConcurrent:Math.max(0,Math.floor(finite(workflow.maxConcurrent))),
    startedAt:time(workflow.startedAt),
    completedAt:time(workflow.completedAt),
    stages:stages.map(stage=>({
      id:includeDeveloperDetail?safeId(stage.id):null,
      type:safeCode(stage.type),
      status:safeCode(stage.status),
      final:Boolean(stage.final),
      startedAt:time(stage.startedAt),
      completedAt:time(stage.completedAt),
      requestedTargetId:includeDeveloperDetail?targetRef(stage.requestedTargetId):null,
      targetId:includeDeveloperDetail?targetRef(stage.target?.targetId):null,
      errorCode:safeCode(stage.error?.code)||null,
      attempts:(stage.attempts||[]).map(attempt=>safeAttempt(attempt,includeDeveloperDetail)),
      context:stage.contextUsage?{
        usedTokens:Math.max(0,finite(stage.contextUsage.usedTokens)),
        estimated:Boolean(stage.contextUsage.estimated),
        outputReserve:Math.max(0,finite(stage.contextUsage.outputReserve)),
        contextLimit:stage.contextUsage.contextLimit==null?null:Math.max(0,finite(stage.contextUsage.contextLimit)),
        artifactCount:Array.isArray(stage.contextUsage.includedArtifactIds)?stage.contextUsage.includedArtifactIds.length:0,
      }:null,
      outputTokens:Math.max(0,finite(stage.outputTokens)),
      outputTokensEstimated:Boolean(stage.outputTokensEstimated),
      committed:Boolean(stage.artifactId),
    })),
  };
}
function safeResearch(work={}){
  if(!work||work.kind!=='research')return null;
  return {
    status:safeCode(work.status),stage:safeCode(work.stage),
    startedAt:time(work.startedAt),completedAt:time(work.completedAt),
    queries:Math.max(0,finite(work.metrics?.queries||work.queryCount)),
    pagesRead:Math.max(0,finite(work.metrics?.pagesRead||work.pagesRead)),
    pagesUsed:Math.max(0,finite(work.metrics?.pagesUsed||work.pagesUsed)),
    claims:Math.max(0,finite(work.metrics?.claims||work.claimCount)),
    supportedClaims:Math.max(0,finite(work.metrics?.supportedClaims||work.supportedClaimCount)),
    verificationStatus:safeCode(work.verification?.status)||null,
    degradation:Array.isArray(work.degradation)?work.degradation.map(item=>safeCode(item?.code||item)).filter(Boolean):[],
  };
}
function safeMessage(message,includeDeveloperDetail){
  if(!message)return null;
  return {
    messageId:includeDeveloperDetail?safeId(message.id):null,
    runId:includeDeveloperDetail?safeId(message.runId):null,
    status:safeCode(message.status),
    errorCode:safeCode(message.error?.code)||null,
    hasAttachments:Boolean(Array.isArray(message.attachments)&&message.attachments.length),
    attachmentCount:Array.isArray(message.attachments)?message.attachments.length:0,
    execution:safeExecution(message.execution||{},includeDeveloperDetail),
    workflow:message.workflow?safeWorkflow(message.workflow,includeDeveloperDetail):null,
    research:safeResearch(message.work),
    metrics:message.metrics?{
      timeToFirstWordMs:Math.max(0,finite(message.metrics.timeToFirstWordMs)),
      wordsPerSecond:Math.max(0,finite(message.metrics.wordsPerSecond)),
      wordCount:Math.max(0,finite(message.metrics.wordCount)),
    }:null,
  };
}
function safeRun(run,includeDeveloperDetail){
  if(!run)return null;
  return {
    runId:includeDeveloperDetail?safeId(run.runId):null,
    state:safeCode(run.state),modeId:safeId(run.modeId),generation:Math.max(0,finite(run.generation)),sequence:Math.max(0,finite(run.sequence)),
    startedAt:time(run.startedAt),updatedAt:time(run.updatedAt),
    currentStageId:includeDeveloperDetail?safeId(run.currentStageId):null,
    fallbackPath:(run.fallbacks||[]).map(safeFallback),
    replay:run.replay?{earliestSeq:finite(run.replay.earliestSeq),lastSeq:finite(run.replay.lastSeq),count:finite(run.replay.count)}:null,
  };
}
function safeTarget(descriptor={},includeDeveloperDetail=false){
  const state=descriptor.state||{};
  const runtime=descriptor.runtime||{};
  // TargetDescriptor v1 owns availability/health/reservations under `state`.
  // Keep legacy fallbacks only so diagnostics can still inspect older saved or
  // test descriptors during the K-series transition.
  const installed=state.installed ?? descriptor.availability?.installed;
  const loadableNow=state.loadableNow ?? descriptor.availability?.loadableNow;
  const loaded=state.loaded ?? runtime.loaded;
  const healthy=state.healthy ?? descriptor.health?.healthy;
  const reserved=state.reservedCount ?? runtime.reservationCount ?? runtime.reserved;
  return {
    targetId:includeDeveloperDetail?targetRef(descriptor.targetId):null,
    kind:safeCode(descriptor.kind),
    installed:Boolean(installed),
    loadableNow:loadableNow==null?null:Boolean(loadableNow),
    loaded:Boolean(loaded),
    healthy:healthy===true?true:healthy===false?false:null,
    reserved:Math.max(0,finite(reserved)),
    parallelVerified:Boolean(runtime.parallelVerified),
    parallelCapacity:Math.max(1,finite(runtime.parallelCapacity,1)),
    inputModalities:[...(descriptor.capabilities?.inputModalities||[])].map(safeCode),
    fileTypes:[...(descriptor.capabilities?.fileTypes||[])].map(value=>safeCode(value).toLowerCase()),
  };
}
function safeSettings(settings={}){
  return {
    revision:Math.max(0,finite(settings.revision)),
    research:{strategy:safeCode(settings.research?.strategy)},
    execution:{allowCompatibleFallback:settings.execution?.allowCompatibleFallback!==false},
    network:{
      proxyConfigured:Boolean(settings.network?.proxy),
      discoveryEndpointConfigured:Boolean(settings.network?.discoveryEndpoint),
    },
    diagnostics:{includeDeveloperDetail:Boolean(settings.diagnostics?.includeDeveloperDetail)},
  };
}

export function assertDiagnosticSafe(report){
  const text=JSON.stringify(report);
  const forbiddenKeys=/"(?:apiKey|authorization|cookie|headers|prompt|content|modelContent|attachmentContents|pageBody|rawBody|manualPath|upstreamProxy|baseUrl|query|url)"\s*:/iu;
  if(forbiddenKeys.test(text))throw new Error('Diagnostic schema contains a forbidden private field.');
  return report;
}

export async function buildDiagnosticReport({preferences,targetManager,governor,flow,chatId=null,messageId=null,includeDeveloperDetail=null}={}){
  const settings=await preferences.getAllSettings();
  const detail=includeDeveloperDetail==null?Boolean(settings.diagnostics?.includeDeveloperDetail):Boolean(includeDeveloperDetail);
  const descriptors=await targetManager.descriptors();
  const resources=await governor.detailedSnapshot();
  let message=null,run=null;
  if(chatId&&messageId){const chat=await chats.getChat(chatId);message=chat.messages.find(item=>item.id===messageId)||null;if(message?.runId)run=flow.runSnapshot(message.runId);}
  const report={
    schemaVersion:1,generatedAt:new Date().toISOString(),product:PRODUCT_NAME,stage:PRODUCT_STAGE,developerDetail:detail,
    platform:{os:process.platform,arch:process.arch,node:process.version,cpuCount:os.cpus()?.length||null},
    settings:safeSettings(settings),
    execution:{targets:descriptors.map(item=>safeTarget(item,detail)),resources:{estimated:Boolean(resources.machine?.estimated),memoryTotal:Math.max(0,finite(resources.machine?.memoryTotal)),memoryAvailable:Math.max(0,finite(resources.machine?.memoryAvailable)),reservationCount:Array.isArray(resources.reservations)?resources.reservations.length:0,processCount:Array.isArray(resources.processes)?resources.processes.length:0}},
    ...(message?{message:safeMessage(message,detail)}:{}),
    ...(run?{run:safeRun(run,detail)}:{}),
  };
  return assertDiagnosticSafe(report);
}
