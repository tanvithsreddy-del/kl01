import { BROWSER_EXTRACT_EXPRESSION } from './extract.js';
import { authorizeDestination, parseWebUrl } from './policy.js';
import { fail } from '../lib/errors.js';
import { deadlineAfter, remainingMs, beforeDeadline } from './clock.js';

const MAX_REQUESTS=80;
const MAX_TRANSFER_BYTES=8*1024*1024;
const RENDER_TIMEOUT_MS=8_000;

function waitForEvent(cdp,method,{sessionId,signal,timeoutMs=RENDER_TIMEOUT_MS,predicate=()=>true}={}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(fail('WEB_CANCELLED','Web work was stopped.',499));
    const timer=setTimeout(()=>done(reject,fail('WEB_RENDER_TIMEOUT','The page took too long to render.',504)),timeoutMs);
    const handler=(params,eventSession)=>{if(sessionId&&eventSession!==sessionId)return;if(!predicate(params))return;done(resolve,params);};
    const onAbort=()=>done(reject,fail('WEB_CANCELLED','Web work was stopped.',499));
    const done=(fn,value)=>{clearTimeout(timer);cdp.off(method,handler);signal?.removeEventListener('abort',onAbort);fn(value);};
    cdp.on(method,handler);signal?.addEventListener('abort',onAbort,{once:true});
  });
}


function sleep(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted)return reject(fail('WEB_CANCELLED','Web work was stopped.',499));const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);const abort=()=>{clearTimeout(timer);reject(fail('WEB_CANCELLED','Web work was stopped.',499));};signal?.addEventListener('abort',abort,{once:true});});}
async function waitForReadableStable(cdp,sessionId,{signal,timeoutMs,limitPromise}){
  const deadline=deadlineAfter(Math.min(2500,Math.max(250,timeoutMs)));
  const loaded=waitForEvent(cdp,'Page.loadEventFired',{sessionId,signal,timeoutMs:Math.min(1200,timeoutMs)}).catch(()=>null);
  const dom=waitForEvent(cdp,'Page.domContentEventFired',{sessionId,signal,timeoutMs:Math.min(900,timeoutMs)}).catch(()=>null);
  await Promise.race([loaded,dom,sleep(Math.min(700,timeoutMs),signal),limitPromise]);
  let prior=-1,stable=0;
  while(beforeDeadline(deadline)){
    if(signal?.aborted)throw fail('WEB_CANCELLED','Web work was stopped.',499);
    const result=await Promise.race([cdp.send('Runtime.evaluate',{expression:"(()=>({ready:document.readyState,text:(document.body?.innerText||'').length}))()",returnByValue:true,awaitPromise:false,userGesture:false},{sessionId,signal,timeoutMs:500}),limitPromise]);
    const probe=result?.result?.value;
    if(!probe||typeof probe!=='object'||typeof probe.text!=='number')return;
    const length=Math.max(0,Number(probe.text)||0);
    if(length>=120&&Math.abs(length-prior)<=8)stable+=1;else stable=0;
    if((probe.ready==='complete'||probe.ready==='interactive')&&length>=120&&stable>=1)return;
    prior=length;
    await Promise.race([sleep(120,signal),limitPromise]);
  }
}

async function commandIgnoringUnsupported(cdp,method,params,options){
  try{return await cdp.send(method,params,options);}catch(error){if(error?.code==='WEB_CDP_COMMAND')return null;throw error;}
}

export async function renderFetch(input,{session,signal=null,timeoutMs=RENDER_TIMEOUT_MS}={}){
  const {url}=parseWebUrl(input); const cdp=session?.cdp; if(!cdp)throw fail('WEB_BROWSER_UNAVAILABLE','Browser rendering is not available.',503);
  const generation=session.generation; let browserContextId=null,targetId=null,sessionId=null; let requests=0,bytes=0,finalUrl=url.href; let unexpectedTargets=0;
  const requestIds=new Set(); let rejectLimit=null; let limitFailure=null; let primaryError=null;
  const limitPromise=new Promise((_,reject)=>{rejectLimit=reject;});
  const triggerLimit=error=>{if(limitFailure)return;limitFailure=error;rejectLimit(error);cdp.send('Page.stopLoading',{}, {sessionId,timeoutMs:500}).catch(()=>{});};
  const onRequest=(_params,eventSession)=>{if(eventSession!==sessionId)return;requests+=1;if(requests>MAX_REQUESTS)triggerLimit(fail('WEB_RENDER_REQUEST_LIMIT','That page made too many network requests to read safely.',413));};
  const onData=(params,eventSession)=>{if(eventSession!==sessionId)return;bytes+=Number(params.encodedDataLength||params.dataLength||0);if(bytes>MAX_TRANSFER_BYTES)triggerLimit(fail('WEB_RENDER_BYTE_LIMIT','That page transferred too much data to read safely.',413));};
  const onResponse=(params,eventSession)=>{if(eventSession!==sessionId)return;if(params?.response?.url)requestIds.add(params.requestId);};
  const onFrame=(params,eventSession)=>{if(eventSession!==sessionId)return;if(!params?.frame?.parentId&&params?.frame?.url)finalUrl=params.frame.url;};
  const onDialog=(_params,eventSession)=>{if(eventSession===sessionId)cdp.send('Page.handleJavaScriptDialog',{accept:false},{sessionId,timeoutMs:500}).catch(()=>{});};
  const onTargetCreated=params=>{const info=params?.targetInfo;if(!info?.targetId||info.targetId===targetId)return;if(browserContextId&&info.browserContextId!==browserContextId)return;unexpectedTargets+=1;cdp.send('Target.closeTarget',{targetId:info.targetId},{timeoutMs:500}).catch(()=>{});};
  try{
    try{browserContextId=(await cdp.send('Target.createBrowserContext',{disposeOnDetach:true},{signal,timeoutMs:2_000})).browserContextId||null;}
    catch(error){throw fail('WEB_BROWSER_POLICY_UNVERIFIED','KL01 could not establish an isolated browser context for this Research page.',503,undefined,error);}
    if(!browserContextId)throw fail('WEB_BROWSER_POLICY_UNVERIFIED','KL01 could not verify an isolated browser context for this Research page.',503);
    const target=await cdp.send('Target.createTarget',{url:'about:blank',browserContextId},{signal,timeoutMs:2_000}); targetId=target.targetId;
    sessionId=(await cdp.send('Target.attachToTarget',{targetId,flatten:true},{signal,timeoutMs:2_000})).sessionId;
    cdp.on('Network.requestWillBeSent',onRequest);cdp.on('Network.dataReceived',onData);cdp.on('Network.responseReceived',onResponse);cdp.on('Page.frameNavigated',onFrame);cdp.on('Page.javascriptDialogOpening',onDialog);cdp.on('Target.targetCreated',onTargetCreated);
    await Promise.all([
      cdp.send('Page.enable',{}, {sessionId,signal,timeoutMs:2_000}),
      cdp.send('Runtime.enable',{}, {sessionId,signal,timeoutMs:2_000}),
      cdp.send('Network.enable',{maxTotalBufferSize:1_000_000,maxResourceBufferSize:500_000}, {sessionId,signal,timeoutMs:2_000}),
    ]);
    await commandIgnoringUnsupported(cdp,'Target.setDiscoverTargets',{discover:true},{signal,timeoutMs:1_000});
    if(browserContextId)await commandIgnoringUnsupported(cdp,'Browser.setDownloadBehavior',{behavior:'deny',browserContextId},{signal,timeoutMs:1_000});
    await commandIgnoringUnsupported(cdp,'Network.setBlockedURLs',{urls:['*.png','*.jpg','*.jpeg','*.gif','*.webp','*.avif','*.mp4','*.webm','*.mp3','*.wav','*.woff','*.woff2','*.ttf','*.otf']},{sessionId,signal,timeoutMs:1_000});
    const nav=await cdp.send('Page.navigate',{url:url.href},{sessionId,signal,timeoutMs:2_000});
    if(nav.errorText)throw fail('WEB_NAVIGATION_FAILED','The browser could not open that page.',502,{errorText:nav.errorText});
    await waitForReadableStable(cdp,sessionId,{signal,timeoutMs,limitPromise});
    if(limitFailure)throw limitFailure;
    const evaluated=await cdp.send('Runtime.evaluate',{expression:BROWSER_EXTRACT_EXPRESSION,returnByValue:true,awaitPromise:false,userGesture:false},{sessionId,signal,timeoutMs:2_000});
    if(evaluated.exceptionDetails)throw fail('WEB_EXTRACT_FAILED','KL01 could not extract readable text from that page.',502);
    const value=evaluated.result?.value||{};
    if(!value||typeof value!=='object')throw fail('WEB_EXTRACT_FAILED','KL01 could not extract readable text from that page.',502);
    const parsed=parseWebUrl(String(value.url||finalUrl));
    await authorizeDestination(parsed.url.href,{...(session?.lookup?{lookup:session.lookup}:{})});
    if(session.generation!==generation)throw fail('WEB_STALE_OPERATION','An older browser operation finished after Web restarted.',409);
    return {mode:'render',url:parsed.url.href,title:String(value.title||'').slice(0,500),text:String(value.text||'').slice(0,1_000_000),links:Array.isArray(value.links)?value.links.slice(0,200):[],truncated:Boolean(value.truncated),requests,bytes,unexpectedTargets,browserContextIsolated:Boolean(browserContextId)};
  }catch(error){
    primaryError=error;
    throw error;
  }finally{
    cdp.off('Network.requestWillBeSent',onRequest);cdp.off('Network.dataReceived',onData);cdp.off('Network.responseReceived',onResponse);cdp.off('Page.frameNavigated',onFrame);cdp.off('Page.javascriptDialogOpening',onDialog);cdp.off('Target.targetCreated',onTargetCreated);
    let cleanupError=null;
    if(targetId){
      try{await cdp.send('Target.closeTarget',{targetId},{timeoutMs:750});}
      catch(error){cleanupError=error;}
    }
    if(browserContextId){
      try{await cdp.send('Target.disposeBrowserContext',{browserContextId},{timeoutMs:750});}
      catch(error){cleanupError=cleanupError||error;}
    }
    if(cleanupError){
      if(primaryError){
        try{Object.defineProperty(primaryError,'webCleanupFailed',{value:true,configurable:true});}catch{}
      }else{
        throw fail('WEB_BROWSER_CLEANUP','KL01 closed the page but could not verify private browser cleanup.',502);
      }
    }
  }
}
