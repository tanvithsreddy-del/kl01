import { spawn } from 'node:child_process';
import { fail } from '../lib/errors.js';

export const PARSER_PROTOCOL_VERSION=1;
const DEFAULT_TIMEOUT_MS=1_500;
const DEFAULT_MAX_INPUT_BYTES=4*1024*1024;
const DEFAULT_MAX_OUTPUT_BYTES=1_200_000;
const MAX_LINKS=200;
const MAX_TEXT=1_000_000;

function cancelError(){return fail('WEB_CANCELLED','Web work was stopped.',499);}
function unavailable(message='The optional page parser is unavailable.',cause=null){return fail('PARSER_HELPER_UNAVAILABLE',message,503,undefined,cause);}
function stalled(message='The optional page parser stopped responding.',cause=null){return fail('PARSER_HELPER_STALL',message,502,undefined,cause);}
function protocol(message='The optional page parser returned an invalid response.',details=undefined,cause=null){return fail('PARSER_HELPER_PROTOCOL',message,502,details,cause);}
function minimalEnv(){
  const keep=['SystemRoot','WINDIR','ComSpec','PATH','TMP','TEMP','TMPDIR'];const out={};
  for(const key of keep)if(process.env[key])out[key]=process.env[key];return out;
}
function validate(result){
  if(!result||typeof result!=='object'||Array.isArray(result))throw protocol();
  if(result.protocol!==PARSER_PROTOCOL_VERSION)throw protocol('The optional page parser uses an incompatible protocol.',{expected:PARSER_PROTOCOL_VERSION,received:result.protocol??null});
  if(typeof result.text!=='string'||result.text.length>MAX_TEXT)throw protocol();
  if(result.title!=null&&(typeof result.title!=='string'||result.title.length>500))throw protocol();
  if(result.encoding!=null&&(typeof result.encoding!=='string'||result.encoding.length>80))throw protocol();
  if(result.truncated!=null&&typeof result.truncated!=='boolean')throw protocol();
  if(!Array.isArray(result.links)||result.links.length>MAX_LINKS)throw protocol();
  const links=[];
  for(const item of result.links){
    if(!item||typeof item!=='object'||typeof item.href!=='string'||item.href.length>4096||typeof(item.text??'')!=='string'||String(item.text??'').length>300)throw protocol();
    let href;try{href=new URL(item.href).href;}catch{throw protocol();}
    if(!/^https?:/iu.test(href))continue;
    links.push({href,text:String(item.text??'').slice(0,300)});
  }
  return{title:String(result.title??'').slice(0,500),text:result.text,links,truncated:Boolean(result.truncated),encoding:String(result.encoding??'').slice(0,80)};
}

export function createParserClient({resolveHelper=async()=>null,timeoutMs=DEFAULT_TIMEOUT_MS,maxInputBytes=DEFAULT_MAX_INPUT_BYTES,maxOutputBytes=DEFAULT_MAX_OUTPUT_BYTES}={}){
  const inputLimit=Math.max(1,Math.min(DEFAULT_MAX_INPUT_BYTES,Number(maxInputBytes)||DEFAULT_MAX_INPUT_BYTES));
  const outputLimit=Math.max(1024,Math.min(DEFAULT_MAX_OUTPUT_BYTES,Number(maxOutputBytes)||DEFAULT_MAX_OUTPUT_BYTES));
  const watchdogMs=Math.max(50,Math.min(10_000,Number(timeoutMs)||DEFAULT_TIMEOUT_MS));
  let circuitBroken=false;
  async function extract(body,{contentType='',url='',signal=null}={}){
    if(signal?.aborted)throw cancelError();
    if(circuitBroken)throw unavailable('The optional page parser is disabled after an earlier parser failure.');
    const bytes=Buffer.isBuffer(body)?body:Buffer.from(String(body??''),'utf8');
    if(bytes.length>inputLimit)throw protocol('The page is too large for the optional parser.',{bytes:bytes.length,maxInputBytes:inputLimit});
    let helper;try{helper=await resolveHelper();}catch(error){throw unavailable('The optional page parser could not be resolved.',error);}
    if(!helper?.command){throw unavailable();}
    const args=Array.isArray(helper.args)?helper.args:[];
    return new Promise((resolve,reject)=>{
      let child;let settled=false;let outputBytes=0;const chunks=[];let stderrBytes=0;
      const finish=(fn,value,{breakCircuit=false}={})=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);if(breakCircuit)circuitBroken=true;fn(value);};
      const kill=()=>{try{child?.kill('SIGKILL');}catch{}};
      const onAbort=()=>{kill();finish(reject,cancelError());};
      const timer=setTimeout(()=>{kill();finish(reject,stalled(),{breakCircuit:true});},watchdogMs);
      try{child=spawn(helper.command,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false,env:minimalEnv()});}
      catch(error){clearTimeout(timer);settled=true;reject(unavailable(undefined,error));return;}
      signal?.addEventListener('abort',onAbort,{once:true});
      child.once('error',error=>finish(reject,unavailable(undefined,error),{breakCircuit:true}));
      child.stdout.on('data',chunk=>{
        if(settled)return;outputBytes+=chunk.length;
        if(outputBytes>outputLimit){kill();finish(reject,protocol('The optional page parser returned too much data.',{maxOutputBytes:outputLimit}),{breakCircuit:true});return;}
        chunks.push(chunk);
      });
      child.stderr.on('data',chunk=>{stderrBytes=Math.min(8192,stderrBytes+chunk.length);});
      child.once('exit',(code,signalName)=>{
        if(settled)return;
        if(code!==0){finish(reject,stalled('The optional page parser exited before producing a valid result.',{code,signal:signalName,stderrBytes}),{breakCircuit:true});return;}
        let parsed;try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch(error){finish(reject,protocol(undefined,undefined,error),{breakCircuit:true});return;}
        try{finish(resolve,validate(parsed));}catch(error){finish(reject,error,{breakCircuit:true});}
      });
      const request={protocol:PARSER_PROTOCOL_VERSION,contentType:String(contentType||'').slice(0,300),url:String(url||'').slice(0,4096),bodyBase64:bytes.toString('base64')};
      try{child.stdin.end(JSON.stringify(request));}catch(error){kill();finish(reject,stalled(undefined,error),{breakCircuit:true});}
    });
  }
  return{extract,status:()=>({protocol:PARSER_PROTOCOL_VERSION,circuitBroken}),reset:()=>{circuitBroken=false;}};
}
