import { fail } from '../lib/errors.js';
import { MAX_GENERATION_TOKENS } from '../config.js';
import { createReasoningDeltaRouter } from './model-reasoning.js';
import { recordServiceHealth } from './services.js';

function classifyHttp(status,retryAfter){
  if(status===401)return fail('MODEL_AUTH','The external AI service rejected its credentials; check the connection, then retry.',401);
  if(status===403)return fail('MODEL_FORBIDDEN','The external AI service refused this request; check its access settings, then retry.',403);
  if(status===429)return fail('MODEL_BUSY','The AI is busy right now; wait a moment, then retry this message.',429,retryAfter?{retryAfter}:undefined);
  if(status>=500)return fail('MODEL_UNAVAILABLE','The selected AI stopped before it finished; retry, or choose another AI.',502);
  return fail('MODEL_RESPONSE','The AI service could not finish this request; check the connection, then retry.',502);
}
function endpoint(baseUrl,route){const clean=String(baseUrl||'').replace(/\/$/u,'');return clean.endsWith('/v1')?`${clean}${route.replace(/^\/v1/u,'')}`:`${clean}${route}`;}
// Some GGUF chat templates reject a system message after a user turn. The
// application composes base, profile, caution, and tool instructions
// independently, so enforce one system-first message at the transport edge.
export function normalizeChatMessages(messages=[]){
  const source=Array.isArray(messages)?messages:[];
  const system=source.filter(message=>message?.role==='system'&&String(message.content||'').trim());
  const conversation=source.filter(message=>message?.role!=='system');
  if(!system.length)return conversation;
  const first=system[0];
  return [{...first,role:'system',content:system.map(message=>String(message.content||'').trim()).join('\n\n')},...conversation];
}
function messagesText(messages=[]){return messages.map(item=>`${item.role}: ${typeof item.content==='string'?item.content:JSON.stringify(item.content)}`).join('\n');}
function reportExternal(t,ok,error=null){if(t?.kind!=='external'||!t.serviceId)return;recordServiceHealth(t.serviceId,{ok,code:error?.code||error?.name||null}).catch(()=>{});}

export function createInferenceService({targetManager,stallMs=45_000}){
  if(!targetManager)throw new Error('targetManager required');
  const controllers=new Map();let activeCount=0,maxActiveObserved=0;
  function selected(lease,owner=null){return targetManager.assertLease(lease,owner);}
  function requestTarget(lease,owner=null){const valid=selected(lease,owner);const t=valid.transport;return{...t,producer:{kind:valid.descriptor.kind,id:valid.descriptor.id,name:valid.descriptor.name,model:valid.descriptor.model},descriptor:valid.descriptor};}
  async function describeTarget({lease=null}={}){if(lease)return requestTarget(lease).producer;const descriptor=await targetManager.preference();return descriptor?{kind:descriptor.kind,id:descriptor.id,name:descriptor.name,model:descriptor.model,targetId:descriptor.targetId}:null;}
  async function contextLimit({lease=null}={}){const descriptor=lease?requestTarget(lease).descriptor:await targetManager.preference();if(!descriptor)return{limit:0,estimated:true,unknown:true};return{limit:Number(descriptor.context.limit||0),estimated:Boolean(descriptor.context.estimated),unknown:Boolean(descriptor.context.unknown)};}
  async function countInputTokens(messages,{lease=null}={}){
    const normalizedMessages=normalizeChatMessages(messages);const text=messagesText(normalizedMessages);
    if(!lease)return{count:Math.max(1,Math.ceil(text.length/4)),estimated:true};
    const t=requestTarget(lease);const body={model:t.model,messages:normalizedMessages};
    try{const response=await fetch(endpoint(t.baseUrl,'/v1/chat/completions/input_tokens'),{method:'POST',headers:t.headers,body:JSON.stringify(body)});if(response.ok){const data=await response.json();if(Number.isFinite(data.input_tokens))return{count:data.input_tokens,estimated:Boolean(t.contextEstimated)};}}catch{}
    try{const response=await fetch(endpoint(t.baseUrl,'/tokenize'),{method:'POST',headers:t.headers,body:JSON.stringify({content:text,add_special:true})});if(response.ok){const data=await response.json();if(Array.isArray(data.tokens))return{count:data.tokens.length,estimated:Boolean(t.contextEstimated)};}else if(t.kind==='local')throw classifyHttp(response.status,response.headers.get('retry-after'));}catch(error){if(t.kind==='local'&&error?.code)throw error;}
    return{count:Math.max(1,Math.ceil(text.length/4)),estimated:true};
  }
  function ownController(lease,outerSignal){const key=lease.leaseId;if(controllers.has(key))throw fail('INFERENCE_OWNER_COLLISION','Execution scheduling conflict · work queued safely.',409,{leaseId:key});const controller=new AbortController();controllers.set(key,{controller,owner:lease.owner});const abort=()=>controller.abort(outerSignal?.reason);if(outerSignal?.aborted)abort();else outerSignal?.addEventListener?.('abort',abort,{once:true});activeCount+=1;maxActiveObserved=Math.max(maxActiveObserved,activeCount);return{key,controller,cleanup:()=>{outerSignal?.removeEventListener?.('abort',abort);controllers.delete(key);activeCount-=1;}};}

  function classifyRuntimeFailure(error,lease){
    if(error?.code)return error;
    const message=String(error?.message||'');
    if(/out of memory|oom|allocat(?:e|ion)|bad_alloc|insufficient memory/i.test(message))return fail('MODEL_OOM_MID','The selected model ran out of memory during this step.',502,{targetId:lease?.targetId||null},error);
    const state=targetManager.runtimeState?.(lease);
    if(state&&['failed','stopped'].includes(state.status)&&state.failure)return fail('MODEL_CRASH','The selected model process stopped during this step.',502,{targetId:lease?.targetId||null,runtimeFailure:state.failure},error);
    return error;
  }

  async function streamCompletion({lease,owner=null,messages,onDelta,onReasoning=async()=>{},reasoning=null,sampling=null,signal,maxTokens=MAX_GENERATION_TOKENS}){
    const t=requestTarget(lease,owner);const ctl=ownController(lease,signal);let progressTimer=null;
    const armProgressWatchdog=()=>{clearTimeout(progressTimer);progressTimer=setTimeout(()=>ctl.controller.abort(fail('MODEL_STALL','Model stopped responding · restarting this step',504)),Math.max(1,Number(stallMs)||45_000));progressTimer.unref?.();};
    try{
      const body={model:t.model,messages:normalizeChatMessages(messages),stream:true,max_tokens:Math.max(1,Math.min(MAX_GENERATION_TOKENS,Number(maxTokens||MAX_GENERATION_TOKENS)))};
      if(t.kind==='local'&&reasoning?.supported){body.reasoning_format='deepseek';body.thinking_budget_tokens=Number(reasoning.budgetTokens||0);body.chat_template_kwargs={enable_thinking:Boolean(reasoning.enabled)};}
      if(sampling&&typeof sampling==='object'){if(Number.isFinite(sampling.temperature))body.temperature=Math.min(2,Math.max(0,Number(sampling.temperature)));if(Number.isFinite(sampling.topP))body.top_p=Math.min(1,Math.max(.01,Number(sampling.topP)));if(Number.isFinite(sampling.topK))body.top_k=Math.min(200,Math.max(0,Math.round(Number(sampling.topK))));if(Number.isFinite(sampling.minP))body.min_p=Math.min(1,Math.max(0,Number(sampling.minP)));if(Number.isFinite(sampling.repeatPenalty))body.repeat_penalty=Math.min(2,Math.max(.5,Number(sampling.repeatPenalty)));if(Number.isFinite(sampling.seed))body.seed=Math.max(-1,Math.min(2147483647,Math.round(Number(sampling.seed))));}
      const response=await fetch(endpoint(t.baseUrl,'/v1/chat/completions'),{method:'POST',headers:{...t.headers,accept:'text/event-stream'},body:JSON.stringify(body),signal:ctl.controller.signal});if(!response.ok){const err=classifyHttp(response.status,response.headers.get('retry-after'));reportExternal(t,false,err);throw err;}reportExternal(t,true);if(!response.body)throw fail('EMPTY_STREAM','The selected AI returned no response; retry this message.',502);
      let received=false;armProgressWatchdog();const decoder=new TextDecoder();const router=createReasoningDeltaRouter({startsInReasoning:Boolean(reasoning?.startsInReasoning),onReasoning,onContent:onDelta});let pending='';
      for await(const chunk of response.body){pending+=decoder.decode(chunk,{stream:true});let boundary;while((boundary=pending.indexOf('\n\n'))>=0){const block=pending.slice(0,boundary);pending=pending.slice(boundary+2);const raw=block.split(/\r?\n/u).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!raw)continue;if(raw==='[DONE]'){await router.flush();return{completed:true};}let parsed;try{parsed=JSON.parse(raw);}catch(error){throw fail('MALFORMED_STREAM','KL01 could not read the response; retry the message.',502,undefined,error);}const choice=parsed?.choices?.[0]||{},delta=choice.delta||{};const r=delta.reasoning_content??delta.reasoning??choice.message?.reasoning_content??parsed?.reasoning_content??'';const c=delta.content??choice.message?.content??parsed?.content??'';if(r||c){received=true;armProgressWatchdog();await router.push({reasoning:String(r||''),content:String(c||'')});}}}
      await router.flush();return{completed:true};
    }catch(error){if(ctl.controller.signal.aborted||error?.name==='AbortError'){const reason=ctl.controller.signal.reason;if(reason?.code==='MODEL_STALL'){reportExternal(t,false,reason);throw reason;}throw fail('CANCELLED','You stopped this operation before the AI finished; retry when ready.',499);}const normalized=classifyRuntimeFailure(error,lease);reportExternal(t,false,normalized);throw normalized;}finally{clearTimeout(progressTimer);ctl.cleanup();}
  }
  async function completeStructured({lease,owner=null,messages,schema=null,signal=null,maxTokens=MAX_GENERATION_TOKENS}){
    messages=normalizeChatMessages(messages);
    const t=requestTarget(lease,owner);const ctl=ownController(lease,signal);let progressTimer=null;
    const armProgressWatchdog=()=>{clearTimeout(progressTimer);progressTimer=setTimeout(()=>ctl.controller.abort(fail('MODEL_STALL','Model stopped responding · restarting this step',504)),Math.max(1,Number(stallMs)||45_000));progressTimer.unref?.();};
    try{const body={model:t.model,messages,stream:false,max_tokens:Math.max(1,Math.min(MAX_GENERATION_TOKENS,Number(maxTokens||MAX_GENERATION_TOKENS)))};if(schema&&t.kind==='local')body.json_schema=schema;let response;armProgressWatchdog();try{response=await fetch(endpoint(t.baseUrl,'/v1/chat/completions'),{method:'POST',headers:t.headers,body:JSON.stringify(body),signal:ctl.controller.signal});}catch(error){if(ctl.controller.signal.aborted||error?.name==='AbortError'){const reason=ctl.controller.signal.reason;if(reason?.code==='MODEL_STALL'){reportExternal(t,false,reason);throw reason;}throw fail('CANCELLED','You stopped this operation before the AI finished; retry when ready.',499);}const normalized=classifyRuntimeFailure(error,lease);reportExternal(t,false,normalized);throw normalized;}if(!response.ok){const err=classifyHttp(response.status,response.headers.get('retry-after'));reportExternal(t,false,err);throw err;}reportExternal(t,true);const contentType=String(response.headers.get('content-type')||'').toLowerCase();let text='';if(contentType.includes('text/event-stream')){if(!response.body)throw fail('EMPTY_RESPONSE','The selected AI returned no response; retry this operation.',502);const decoder=new TextDecoder();let pending='';for await(const chunk of response.body){pending+=decoder.decode(chunk,{stream:true});let boundary;while((boundary=pending.indexOf('\n\n'))>=0){const block=pending.slice(0,boundary);pending=pending.slice(boundary+2);const raw=block.split(/\r?\n/u).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!raw||raw==='[DONE]')continue;let parsed;try{parsed=JSON.parse(raw);}catch(error){throw fail('MALFORMED_STREAM','KL01 could not read the response; retry the operation.',502,undefined,error);}const delta=String(parsed?.choices?.[0]?.delta?.content??parsed?.choices?.[0]?.message?.content??parsed?.content??'');if(delta){text+=delta;armProgressWatchdog();}}}}else{let data;try{data=await response.json();}catch(error){throw fail('MALFORMED_RESPONSE','KL01 could not read the response; retry the operation.',502,undefined,error);}text=String(data?.choices?.[0]?.message?.content??data?.content??'');}return{text,constrained:Boolean(schema&&t.kind==='local'),producer:t.producer};}finally{clearTimeout(progressTimer);ctl.cleanup();}
  }
  function stopOwner(match){let stopped=0;for(const {controller,owner} of controllers.values()){if(match(owner)){controller.abort(fail('CANCELLED','You stopped this work.',499));stopped+=1;}}return stopped;}
  return{streamCompletion,completeStructured,countInputTokens,contextLimit,describeTarget,stop:chatId=>stopOwner(owner=>owner?.chatId===chatId),stopRun:runId=>stopOwner(owner=>owner?.runId===runId),diagnostics:()=>({activeCount,maxActiveObserved,activeOwners:[...controllers.values()].map(v=>v.owner)})};
}
