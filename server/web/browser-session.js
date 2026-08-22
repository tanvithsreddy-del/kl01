import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { CdpConnection } from './cdp.js';
import { createSocksGate } from './socks-gate.js';
import { fail } from '../lib/errors.js';
import { BUILD_VERSION } from '../config.js';
import { WEB_BROWSER_PROFILES_DIR } from '../lib/paths.js';

const ENDPOINT_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 3_000;

function sleep(ms, signal) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(fail('WEB_CANCELLED','Web work was stopped.',499));
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},ms);
    const onAbort=()=>{clearTimeout(timer);reject(fail('WEB_CANCELLED','Web work was stopped.',499));};
    signal?.addEventListener('abort',onAbort,{once:true});
  });
}

async function readEndpoint(profileDir, { launchedAt, signal }) {
  const file=path.join(profileDir,'DevToolsActivePort'); const deadline=Date.now()+ENDPOINT_TIMEOUT_MS;
  while(Date.now()<deadline){
    if(signal?.aborted)throw fail('WEB_CANCELLED','Web work was stopped.',499);
    try{
      const [text,stat]=await Promise.all([fs.readFile(file,'utf8'),fs.stat(file)]);
      if(stat.mtimeMs+2000<launchedAt){await sleep(40,signal);continue;}
      const [portLine,wsPath]=text.trim().split(/\r?\n/u); const port=Number(portLine);
      if(!Number.isInteger(port)||port<1024||port>65535||!/^\/devtools\/browser\//u.test(wsPath||'')) throw fail('WEB_CDP_ENDPOINT','Browser returned an invalid debugging endpoint.',502);
      return {port,wsPath,file};
    }catch(error){if(error?.code!=='ENOENT'&&error?.code!=='EBUSY'&&error?.code!=='EPERM')throw error;}
    await sleep(50,signal);
  }
  throw fail('WEB_CDP_ENDPOINT_TIMEOUT','The browser started but did not expose its local control endpoint.',504);
}

function getJsonVersion(port,{signal,timeoutMs=3_000}={}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(fail('WEB_CANCELLED','Web work was stopped.',499));
    let settled=false; const req=http.get({host:'127.0.0.1',port,path:'/json/version',agent:false,headers:{connection:'close'}},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>64*1024){req.destroy();done(reject,fail('WEB_CDP_VERSION_SIZE','Browser control metadata was too large.',502));}else chunks.push(chunk);});
      res.on('end',()=>{if(res.statusCode!==200)return done(reject,fail('WEB_CDP_VERSION_STATUS','Browser control endpoint did not answer correctly.',502));try{done(resolve,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{done(reject,fail('WEB_CDP_VERSION_JSON','Browser control endpoint returned invalid data.',502));}});
    });
    const timer=setTimeout(()=>{req.destroy();done(reject,fail('WEB_CDP_VERSION_TIMEOUT','Browser control endpoint timed out.',504));},timeoutMs);
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);};
    const done=(fn,value)=>{if(settled)return;settled=true;cleanup();fn(value);};
    const onAbort=()=>{req.destroy();done(reject,fail('WEB_CANCELLED','Web work was stopped.',499));};
    signal?.addEventListener('abort',onAbort,{once:true}); req.on('error',error=>done(reject,fail('WEB_CDP_VERSION_FAILED','KL01 could not verify the browser control endpoint.',502,undefined,error)));
  });
}

function containedProfilePath(profileDir) {
  const root = path.resolve(WEB_BROWSER_PROFILES_DIR);
  const candidate = path.resolve(profileDir);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw fail('WEB_PROFILE_PATH', 'KL01 refused a browser profile outside its Web data folder.', 403);
  }
  return candidate;
}

function profilePath(candidate, generation, profileId) {
  const vendor = /^[a-z0-9-]{1,40}$/u.test(String(candidate?.vendor || '')) ? candidate.vendor : 'browser';
  return containedProfilePath(path.join(WEB_BROWSER_PROFILES_DIR, vendor, `g${generation}-${profileId}`));
}

async function stopOwnedChild(child, timeoutMs = STOP_TIMEOUT_MS) {
  if (!child || child.exitCode !== null) return;
  try { child.kill(); } catch {}
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, Math.max(100, timeoutMs))),
  ]);
  if (child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch {}
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 1_000)),
    ]);
  }
}

async function removeOwnedProfile(profileDir, expectedProfileId = null) {
  if (!profileDir) return false;
  let safe;
  try { safe = containedProfilePath(profileDir); } catch { return false; }
  try {
    const marker = JSON.parse(await fs.readFile(path.join(safe, '.kl01-profile.json'), 'utf8'));
    if (marker?.owner !== 'kl01-web' || marker?.schema !== 1 || !marker?.profileId) return false;
    if (expectedProfileId && marker.profileId !== expectedProfileId) return false;
  } catch { return false; }
  await fs.rm(safe, { recursive:true, force:true }).catch(() => {});
  return true;
}

function requiredLaunchArguments(profileDir, gatePort) {
  return [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--proxy-server=socks5://127.0.0.1:${gatePort}`,
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];
}

function browserArgs(profileDir, gatePort) {
  return [
    ...requiredLaunchArguments(profileDir, gatePort),
    '--enable-automation',
    '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-background-networking',
    '--disable-component-update', '--disable-domain-reliability', '--metrics-recording-only',
    '--disable-features=MediaRouter,OptimizationHints,Translate',
    'about:blank',
  ];
}

async function verifyBrowserPolicy(cdp, profileDir, gatePort, signal) {
  let result;
  try { result = await cdp.send('Browser.getBrowserCommandLine', {}, { signal, timeoutMs:3_000 }); }
  catch (error) { throw fail('WEB_BROWSER_POLICY_UNVERIFIED', 'The browser started, but KL01 could not verify its safe Web networking controls.', 503, undefined, error); }
  const reported = new Set(Array.isArray(result?.arguments) ? result.arguments.map(String) : []);
  const missing = requiredLaunchArguments(profileDir, gatePort).filter(argument => !reported.has(argument));
  if (missing.length) throw fail('WEB_BROWSER_POLICY_UNVERIFIED', 'The browser did not confirm all required Web isolation controls.', 503, { controls: missing.map(value => value.split('=')[0]) });
}

export class BrowserSession {
  constructor({ lookup=null,onUnexpectedExit=null,proxyProvider=null }={}){this.lookup=lookup;this.onUnexpectedExit=onUnexpectedExit;this.proxyProvider=proxyProvider;this.generation=0;this.current=null;this.starting=null;}
  status(){
    const c=this.current;
    return c?{running:true,generation:c.generation,browser:{id:c.candidate.id,vendor:c.candidate.vendor,name:c.candidate.name},startedAt:c.startedAt}:{running:false,generation:this.generation};
  }
  async start(candidate,{signal=null}={}){
    if(this.current?.candidate?.id===candidate?.id&&!this.current.cdp?.closed)return this.current;
    if(this.starting)return this.starting;
    this.starting=this.#start(candidate,{signal}).finally(()=>{this.starting=null;});
    return this.starting;
  }
  async #start(candidate,{signal}){
    if(!candidate?.path)throw fail('WEB_BROWSER_MISSING','No isolated renderer candidate is available for this Research page.',400);
    await this.stop().catch(()=>{});
    const generation=++this.generation; const controller=new AbortController();
    const relay=()=>controller.abort(); signal?.addEventListener('abort',relay,{once:true});
    let gate=null,child=null,profileDir=null,profileId=null,cdp=null;
    try{
      const upstreamProxy=await this.proxyProvider?.();
      if(controller.signal.aborted)throw fail('WEB_CANCELLED','Web work was stopped.',499);
      gate=await createSocksGate({lookup:this.lookup,signal:controller.signal,upstreamProxy});
      profileId=crypto.randomBytes(12).toString('hex');
      profileDir=profilePath(candidate,generation,profileId); await fs.mkdir(profileDir,{recursive:true,mode:0o700});
      await fs.writeFile(path.join(profileDir,'.kl01-profile.json'),`${JSON.stringify({owner:'kl01-web',schema:1,profileId,version:BUILD_VERSION,generation,createdAt:new Date().toISOString()},null,2)}\n`,{mode:0o600});
      const launchedAt=Date.now();
      child=spawn(candidate.path,browserArgs(profileDir,gate.port),{shell:false,windowsHide:true,stdio:'ignore',detached:false});
      const earlyExit=new Promise((_,reject)=>child.once('exit',(code,childSignal)=>reject(fail('WEB_BROWSER_EXITED','The selected browser closed before Web finished starting.',502,{code,signal:childSignal}))));
      const endpoint=await Promise.race([readEndpoint(profileDir,{launchedAt,signal:controller.signal}),earlyExit]);
      const version=await getJsonVersion(endpoint.port,{signal:controller.signal});
      const wsUrl=new URL(String(version.webSocketDebuggerUrl||''));
      if(wsUrl.protocol!=='ws:'||!['127.0.0.1','localhost'].includes(wsUrl.hostname)||Number(wsUrl.port)!==endpoint.port||wsUrl.pathname!==endpoint.wsPath) throw fail('WEB_CDP_ENDPOINT_MISMATCH','KL01 refused an unexpected browser control endpoint.',403);
      cdp=await CdpConnection.connect(`ws://127.0.0.1:${endpoint.port}${endpoint.wsPath}`,{signal:controller.signal,timeoutMs:5_000});
      await cdp.send('Browser.getVersion',{}, {signal:controller.signal,timeoutMs:3_000});
      await verifyBrowserPolicy(cdp,profileDir,gate.port,controller.signal);
      const current={generation,candidate,gate,child,profileDir,profileId,cdp,controller,lookup:this.lookup,startedAt:new Date().toISOString(),version};
      child.once('exit',(code,childSignal)=>{if(this.current?.generation===generation){this.current=null;try{cdp.close();}catch{} gate.close().catch(()=>{});removeOwnedProfile(profileDir,profileId).catch(()=>{});try{this.onUnexpectedExit?.({generation,code,signal:childSignal,browserId:candidate.id});}catch{}}});
      this.current=current; return current;
    }catch(error){controller.abort();try{cdp?.close();}catch{}await gate?.close().catch(()=>{});await stopOwnedChild(child);await removeOwnedProfile(profileDir,profileId);throw error;}
    finally{signal?.removeEventListener('abort',relay);}
  }
  async stop(){
    const current=this.current; if(!current)return; this.current=null; ++this.generation; current.controller.abort();
    try{current.cdp.close();}catch{}
    await current.gate.close().catch(()=>{});
    await stopOwnedChild(current.child);
    await removeOwnedProfile(current.profileDir,current.profileId);
  }
  async close(){await this.stop();}
}

export { browserArgs };
