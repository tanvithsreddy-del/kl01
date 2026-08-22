import { fail } from '../lib/errors.js';
import { normalizeCapabilities } from '../services/model-capabilities.js';
import { normalizeReasoningControl } from '../services/model-reasoning.js';
import { memoryNeededForModel } from '../services/machine.js';

export const TARGET_DESCRIPTOR_SCHEMA = 1;
export const TARGET_LEASE_SCHEMA = 1;

function uniq(values=[]){return [...new Set(values.map(v=>String(v||'').trim().toLowerCase()).filter(Boolean))];}
function freeze(value){if(!value||typeof value!=='object'||Object.isFrozen(value))return value;for(const child of Object.values(value))freeze(child);return Object.freeze(value);}

export function localDescriptor({record,catalogueEntry=null,runtimeState=null,reservations=0,machine=null}={}){
  const declared=normalizeCapabilities(catalogueEntry||record||{});
  // P3 runtime contract: this shipped llama.cpp path accepts text messages/text-file envelopes only.
  // Declared model-card capability cannot widen the runtime's real transport capability.
  const runtimeModalities=['text'];
  const inputModalities=declared.inputModalities.filter(v=>runtimeModalities.includes(v));
  const fileTypes=inputModalities.includes('text')?uniq(declared.fileTypes):[];
  const reasoning=normalizeReasoningControl(catalogueEntry||record||{});
  const contextLimit=Number(runtimeState?.modelId===record?.id&&runtimeState?.contextSize||record?.contextSize||catalogueEntry?.contextSize||catalogueEntry?.nativeContextSize||0);
  const estimatedWorkingSetBytes=memoryNeededForModel({...catalogueEntry,...record,contextSize:contextLimit||8192});
  const loaded=Boolean(runtimeState?.modelId===record?.id&&['ready','failed','starting'].includes(runtimeState?.status));
  const healthy=Boolean(runtimeState?.modelId===record?.id&&runtimeState?.status==='ready');
  const verifiedParallel=Boolean(runtimeState?.parallelVerified&&Number(runtimeState?.parallelCapacity||1)>1);
  const loadableNow=machine?.memoryAvailable>0?machine.memoryAvailable>=estimatedWorkingSetBytes:null;
  return freeze({
    schemaVersion:TARGET_DESCRIPTOR_SCHEMA,targetId:`local:${record.id}`,kind:'local',id:record.id,name:record.displayName||catalogueEntry?.name||record.id,model:record.id,
    capabilities:{inputModalities:uniq(inputModalities),fileTypes,structuredOutput:true,tasks:uniq(declared.tasks)},
    reasoning:{supported:Boolean(reasoning.enabled),levels:reasoning.levels||[]},
    context:{limit:contextLimit||0,estimated:false,unknown:!contextLimit},
    runtime:{parallelCapacity:verifiedParallel?Math.max(1,Number(runtimeState.parallelCapacity)):1,parallelVerified:verifiedParallel,transport:'llama.cpp'},
    resources:{estimatedWorkingSetBytes,estimated:true},
    state:{installed:true,pendingRemoval:Boolean(record?.pendingRemoval),loadableNow,loaded,healthy,reservedCount:Math.max(0,Number(reservations||0)),failure:runtimeState?.modelId===record?.id?runtimeState?.failure||null:null},
    source:{licence:record.licence||catalogueEntry?.licence||'unknown',sourceType:record.sourceType||'installed'},
  });
}

export function externalDescriptor({service,reservations=0}={}){
  const contextLimit=Number(service?.contextSize||0);
  return freeze({
    schemaVersion:TARGET_DESCRIPTOR_SCHEMA,targetId:`external:${service.id}`,kind:'external',id:service.id,name:service.name||service.model||service.id,model:service.model,
    capabilities:{inputModalities:['text'],fileTypes:[],structuredOutput:false,tasks:['general']},
    reasoning:{supported:false,levels:[]},
    context:{limit:contextLimit,estimated:true,unknown:!contextLimit},
    runtime:{parallelCapacity:1,parallelVerified:false,transport:'openai-compatible'},
    resources:{estimatedWorkingSetBytes:0,estimated:true},
    state:{installed:true,loadableNow:null,loaded:false,healthy:null,reservedCount:Math.max(0,Number(reservations||0)),failure:null,healthReason:'Not tested in this run'},
    source:{remote:true},
  });
}

export function compatibility(descriptor,requirements={}){
  if(!descriptor)return{ok:false,reasons:[{code:'MODEL_NONE',message:'No AI model is available for this run'}],unknown:[]};
  const reasons=[];const unknown=[];
  if(descriptor?.state?.pendingRemoval)reasons.push({code:'MODEL_UNINSTALL_PENDING',message:`${descriptor.name} is being removed and cannot start new work.`});
  const modalities=uniq(requirements.inputModalities||requirements.modalities||['text']);
  const files=uniq(requirements.fileTypes||[]);
  for(const modality of modalities)if(!descriptor.capabilities.inputModalities.includes(modality))reasons.push({code:'MODEL_CAPABILITY',field:'inputModalities',required:modality,message:`${descriptor.name} cannot handle ${modality} input.`});
  for(const file of files)if(!descriptor.capabilities.fileTypes.includes(file))reasons.push({code:'MODEL_CAPABILITY',field:'fileTypes',required:file,message:`${descriptor.name} cannot handle .${file} files.`});
  if(requirements.structuredOutput===true&&!descriptor.capabilities.structuredOutput)reasons.push({code:'MODEL_CAPABILITY',field:'structuredOutput',message:`${descriptor.name} does not expose constrained structured output.`});
  if(requirements.reasoning===true&&!descriptor.reasoning.supported)reasons.push({code:'MODEL_CAPABILITY',field:'reasoning',message:`${descriptor.name} does not expose the required reasoning control.`});
  const requiredContext=Math.max(0,Number(requirements.contextTokens||requirements.contextSize||0));
  if(requiredContext){if(descriptor.context.unknown)unknown.push({code:'MODEL_CONTEXT_UNKNOWN',required:requiredContext});else if(descriptor.context.limit<requiredContext)reasons.push({code:'MODEL_CONTEXT',required:requiredContext,available:descriptor.context.limit,message:`${descriptor.name} context is too small for this step.`});}
  return{ok:reasons.length===0,reasons,unknown};
}

export function assertCompatible(descriptor,requirements={}){
  const result=compatibility(descriptor,requirements);if(result.ok)return result;
  const first=result.reasons[0]||{};throw fail(first.code||'MODEL_CAPABILITY',first.message||'The selected model cannot handle this step.',409,{targetId:descriptor?.targetId||null,reasons:result.reasons});
}

export function targetLease(input={}){
  const lease={schemaVersion:TARGET_LEASE_SCHEMA,leaseId:String(input.leaseId||''),generation:Number(input.generation||1),targetId:String(input.targetId||''),descriptor:input.descriptor,owner:freeze(structuredClone(input.owner||{})),transport:freeze(structuredClone(input.transport||{})),acquiredAt:input.acquiredAt||new Date().toISOString(),released:false};
  return lease;
}
