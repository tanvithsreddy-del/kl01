import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { detectBrowsers } from './browser-detect.js';
import { BrowserSession } from './browser-session.js';
import { directFetch } from './direct-fetch.js';
import { renderFetch } from './render-fetch.js';
import { WEB_DATA_ROOT } from '../lib/paths.js';
import { fail } from '../lib/errors.js';

const IDLE_STOP_MS = 60_000;
const NETWORK_LIMIT = 2;
const NETWORK_QUEUE_LIMIT = 8;
const RENDER_LIMIT = 1;

function cancelled() { return fail('WEB_CANCELLED', 'Research network work was stopped.', 499); }

export function createWebService({
  preferences,
  browserSession = null,
  detector = detectBrowsers,
  direct = directFetch,
  parserClient = null,
  renderer = renderFetch,
  dnsLookup = null,
  idleStopMs = IDLE_STOP_MS,
} = {}) {
  if (!preferences) throw new Error('preferences required');

  const session = browserSession || new BrowserSession({
    lookup:dnsLookup,
    proxyProvider:async()=> (await preferences.getAllSettings()).network?.proxy || null,
  });
  const operations = new Map();
  const networkQueue = [];
  const renderQueue = [];
  let activeNetwork = 0;
  let activeRender = 0;
  let detectorCache = null;
  let browserCandidateIndex = 0;
  let idleTimer = null;

  function clearIdle() { clearTimeout(idleTimer); idleTimer = null; }
  function scheduleIdle() {
    clearIdle();
    if (idleStopMs <= 0) return;
    idleTimer = setTimeout(() => session.stop().catch(() => {}), idleStopMs);
    idleTimer.unref?.();
  }

  async function candidates() {
    if (!detectorCache) detectorCache = await detector();
    return detectorCache;
  }

  function operation(kind, fn, parentSignal = null) {
    const id = `web-${crypto.randomBytes(6).toString('hex')}`;
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) controller.abort(parentSignal.reason);
    else parentSignal?.addEventListener('abort', onParentAbort, { once:true });
    const op = { id, kind, controller, promise:null };
    operations.set(id, op);
    clearIdle();
    op.promise = Promise.resolve()
      .then(() => fn({ signal:controller.signal, operationId:id }))
      .then(result => { if (controller.signal.aborted) throw cancelled(); return result; })
      .finally(() => {
        parentSignal?.removeEventListener('abort', onParentAbort);
        operations.delete(id);
        if (!operations.size) scheduleIdle();
      });
    return op.promise;
  }

  function drainNetwork() {
    while (activeNetwork < NETWORK_LIMIT && networkQueue.length) {
      const waiter = networkQueue.shift();
      if (waiter.signal?.aborted) { waiter.reject(cancelled()); continue; }
      activeNetwork += 1;
      waiter.resolve(() => { activeNetwork = Math.max(0, activeNetwork - 1); drainNetwork(); });
    }
  }
  function acquireNetwork(signal) {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (networkQueue.length >= NETWORK_QUEUE_LIMIT && activeNetwork >= NETWORK_LIMIT) return Promise.reject(fail('WEB_QUEUE_FULL','Research is already handling several network requests. Try again when current work finishes.',429));
    return new Promise((resolve,reject)=>{
      const waiter={signal,resolve:null,reject:null};
      const onAbort=()=>{const index=networkQueue.indexOf(waiter);if(index>=0){networkQueue.splice(index,1);reject(cancelled());}};
      waiter.resolve=release=>{signal?.removeEventListener('abort',onAbort);resolve(release);};
      waiter.reject=error=>{signal?.removeEventListener('abort',onAbort);reject(error);};
      signal?.addEventListener('abort',onAbort,{once:true});networkQueue.push(waiter);drainNetwork();
    });
  }
  async function withNetwork(signal, fn) { const release=await acquireNetwork(signal);try{return await fn();}finally{release();} }

  function drainRender() {
    while (activeRender < RENDER_LIMIT && renderQueue.length) {
      const waiter=renderQueue.shift();
      if(waiter.signal?.aborted){waiter.reject(cancelled());continue;}
      activeRender+=1;
      waiter.resolve(()=>{activeRender=Math.max(0,activeRender-1);drainRender();});
    }
  }
  function acquireRender(signal) {
    if(signal?.aborted)return Promise.reject(cancelled());
    return new Promise((resolve,reject)=>{
      const waiter={signal,resolve:null,reject:null};
      const onAbort=()=>{const index=renderQueue.indexOf(waiter);if(index>=0){renderQueue.splice(index,1);reject(cancelled());}};
      waiter.resolve=release=>{signal?.removeEventListener('abort',onAbort);resolve(release);};
      waiter.reject=error=>{signal?.removeEventListener('abort',onAbort);reject(error);};
      signal?.addEventListener('abort',onAbort,{once:true});renderQueue.push(waiter);drainRender();
    });
  }
  async function withRender(signal,fn){const release=await acquireRender(signal);try{return await fn();}finally{release();}}

  async function fetch(url, options = {}) {
    const parentSignal=options.signal||null;
    const all=await preferences.getAllSettings();
    return operation('direct-fetch',({signal})=>withNetwork(signal,()=>direct(url,{...options,signal,...(dnsLookup?{lookup:dnsLookup}:{}),upstreamProxy:all.network?.proxy||null,parserClient})),parentSignal);
  }

  async function render(url, options = {}) {
    const parentSignal=options.signal||null;
    const available=await candidates();
    if(!available.length)throw fail('WEB_BROWSER_NOT_FOUND','No supported installed browser is available for this rendered research page.',503);
    return operation('render-fetch',async({signal})=>{
      let current=null;let lastError=null;
      for(let offset=0;offset<available.length;offset+=1){
        const index=(browserCandidateIndex+offset)%available.length;
        try{current=await session.start(available[index],{signal});browserCandidateIndex=index;break;}
        catch(error){lastError=error;if(signal.aborted||!['WEB_BROWSER_EXITED','WEB_CDP_ENDPOINT_TIMEOUT','WEB_CDP_VERSION_FAILED','WEB_CDP_VERSION_TIMEOUT','WEB_CDP_CONNECT','WEB_CDP_HANDSHAKE','WEB_BROWSER_POLICY_UNVERIFIED'].includes(error?.code))throw error;}
      }
      if(!current)throw lastError||fail('WEB_BROWSER_UNAVAILABLE','No installed browser could start an isolated rendering session.',503);
      try { return await withRender(signal,()=>withNetwork(signal,()=>renderer(url,{...options,session:current,signal}))); }
      catch(error){if(error?.code==='WEB_BROWSER_CLEANUP'||error?.webCleanupFailed===true)await session.stop().catch(()=>{});throw error;}
    },parentSignal);
  }

  function cancel(operationId = null) {
    let count=0;
    for(const [id,op] of operations){if(operationId&&id!==operationId)continue;op.controller.abort();count+=1;}
    return {cancelled:count};
  }

  async function settleActive(){const pending=[...operations.values()].map(op=>op.promise);if(pending.length)await Promise.allSettled(pending);}

  async function clearData() {
    cancel();
    await session.stop().catch(()=>{});
    await settleActive();
    await fs.rm(path.resolve(WEB_DATA_ROOT),{recursive:true,force:true});
    detectorCache=null;
    browserCandidateIndex=0;
    return {cleared:true};
  }

  async function close() {
    clearIdle();
    cancel();
    await settleActive();
    await session.close();
  }

  return Object.freeze({ fetch, render, cancel, clearData, close });
}
