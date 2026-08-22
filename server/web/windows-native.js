import { spawn as nodeSpawn } from 'node:child_process';
import net from 'node:net';
import { fail } from '../lib/errors.js';
import { USER_AGENT } from '../config.js';

const MAX_STDERR_BYTES = 16 * 1024;
const HEADER_SLACK_BYTES = 96 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

function abortError() { return fail('WEB_CANCELLED', 'Web work was stopped.', 499); }
function cleanHeaderValue(value) { return String(value ?? '').replace(/[\r\n]+/gu, ' ').trim(); }
const SAFE_REQUEST_HEADERS = new Set(['accept','accept-language','content-type','referer','user-agent','sec-fetch-dest','sec-fetch-mode','sec-fetch-site','sec-fetch-user']);
function curlAddress(address) { return Number(address?.family) === 6 ? `[${address.address}]` : String(address?.address || ''); }

function curlFailure(code, stderr = '', cause = undefined) {
  const details = { nativeTransport:'windows-curl', curlExitCode:Number(code) || 0, stderr:String(stderr || '').slice(0,512) };
  if (Number(code) === 6) return fail('WEB_DNS_FAILED', 'Windows could not resolve that public web address.', 502, details, cause);
  if (Number(code) === 28) return fail('WEB_DEADLINE', 'The public web request timed out.', 504, details, cause);
  if ([35,51,58,60,77,80,82,83,90,91].includes(Number(code))) return fail('WEB_TLS_FAILED', 'Windows could not establish a trusted secure connection to that page.', 502, details, cause);
  return fail('WEB_CONNECT_FAILED', 'Windows could not connect to that public web page.', 502, details, cause);
}

export function parseHeaderBlock(buffer, { maxHeaderBytes = MAX_HEADER_BYTES } = {}) {
  let offset = 0;
  let status = 0;
  let headers = {};
  while (offset < buffer.length) {
    const marker = buffer.indexOf('\r\n\r\n', offset, 'latin1');
    if (marker < 0) throw fail('WEB_NATIVE_PROTOCOL', 'Windows returned an invalid web response.', 502);
    if (marker + 4 - offset > maxHeaderBytes) throw fail('WEB_NATIVE_PROTOCOL', 'Windows returned response headers that were too large.', 502);
    const block = buffer.subarray(offset, marker).toString('latin1');
    const lines = block.split('\r\n');
    const match = lines[0]?.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/u);
    if (!match) throw fail('WEB_NATIVE_PROTOCOL', 'Windows returned an invalid web response.', 502);
    status = Number(match[1]);
    headers = {};
    for (const line of lines.slice(1)) {
      const index = line.indexOf(':');
      if (index <= 0) continue;
      const key = line.slice(0,index).trim().toLowerCase();
      const value = line.slice(index+1).trim();
      if (!key) continue;
      headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
    }
    offset = marker + 4;
    if (status >= 100 && status < 200 && status !== 101) continue;
    return { status, headers, body:buffer.subarray(offset) };
  }
  throw fail('WEB_NATIVE_PROTOCOL', 'Windows returned an incomplete web response.', 502);
}

export async function windowsCurlRequest(destination, address, {
  signal = null,
  deadline,
  maxBytes,
  headers = {},
  method = 'GET',
  body = null,
  spawnImpl = nodeSpawn,
  now = () => performance.now(),
  executable = 'curl.exe',
} = {}) {
  if (signal?.aborted) throw abortError();
  const rawRemaining = Math.floor(Number(deadline) - now());
  if (!Number.isFinite(rawRemaining) || rawRemaining <= 0) throw fail('WEB_DEADLINE', 'This page took too long to respond.', 504);
  const remaining = Math.max(100, rawRemaining);
  const requestBody = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
  const url = destination?.url;
  const hostname = String(destination?.hostname || url?.hostname || '');
  const port = Number(destination?.port || (url?.protocol === 'https:' ? 443 : 80));
  const ip = curlAddress(address);
  if (!url || !hostname || !ip || !net.isIP(String(address?.address || ''))) throw fail('WEB_NATIVE_PROTOCOL', 'Windows native Web transport received an invalid destination.', 500);

  const timeoutSeconds = Math.max(0.1, remaining / 1000).toFixed(3);
  const args = [
    '--silent','--show-error','--include','--http1.1',
    '--max-time', timeoutSeconds,
    '--connect-timeout', Math.min(3, Math.max(0.1, remaining / 1000)).toFixed(3),
    '--noproxy','*',
    '--resolve', `${hostname}:${port}:${ip}`,
    '--request', String(method || 'GET').toUpperCase(),
  ];
  const mergedHeaders = {
    'user-agent':USER_AGENT,
    accept:'text/html,text/plain,application/xhtml+xml,application/json;q=0.8,*/*;q=0.2',
    ...headers,
  };
  for (const [keyRaw,valueRaw] of Object.entries(mergedHeaders)) {
    const key=String(keyRaw || '').trim();
    const value=cleanHeaderValue(valueRaw);
    if (!key || !SAFE_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    args.push('--header', `${key}: ${value}`);
  }
  args.push('--header','Accept-Encoding: identity','--header','Connection: close');
  if (requestBody) args.push('--data-binary','@-');
  args.push(url.href);

  return new Promise((resolve,reject) => {
    let child;
    try { child = spawnImpl(executable,args,{ windowsHide:true, stdio:['pipe','pipe','pipe'] }); }
    catch (cause) { reject(fail('WEB_NATIVE_TRANSPORT_UNAVAILABLE','Windows native Web transport is unavailable.',503,{nativeTransport:'windows-curl'},cause)); return; }
    let settled=false; const stdout=[]; const stderr=[]; let outBytes=0; let errBytes=0;
    const maxOutput=Math.max(1024,Number(maxBytes)||0)+HEADER_SLACK_BYTES;
    const timer=setTimeout(()=>{ child.kill?.(); done(reject,fail('WEB_DEADLINE','The public web request timed out.',504,{nativeTransport:'windows-curl'})); },remaining+250);
    const done=(fn,value)=>{ if(settled)return; settled=true; clearTimeout(timer); signal?.removeEventListener('abort',onAbort); fn(value); };
    const onAbort=()=>{ child.kill?.(); done(reject,abortError()); };
    signal?.addEventListener('abort',onAbort,{once:true});
    child.once('error',cause=>done(reject,fail('WEB_NATIVE_TRANSPORT_UNAVAILABLE','Windows native Web transport is unavailable.',503,{nativeTransport:'windows-curl'},cause)));
    child.stdout?.on('data',chunk=>{
      outBytes+=chunk.length;
      if(outBytes>maxOutput){child.kill?.();done(reject,fail('WEB_BODY_LIMIT','That page is too large for Web to read safely.',413,{nativeTransport:'windows-curl'}));return;}
      stdout.push(chunk);
    });
    child.stderr?.on('data',chunk=>{ if(errBytes>=MAX_STDERR_BYTES)return; const take=chunk.subarray(0,MAX_STDERR_BYTES-errBytes); errBytes+=take.length; stderr.push(take); });
    child.once('close',code=>{
      if(settled)return;
      const stderrText=Buffer.concat(stderr).toString('utf8');
      if(Number(code)!==0){ done(reject,curlFailure(code,stderrText)); return; }
      try {
        const parsed=parseHeaderBlock(Buffer.concat(stdout));
        if(parsed.body.length>Number(maxBytes)){done(reject,fail('WEB_BODY_LIMIT','That page is too large for Web to read safely.',413,{nativeTransport:'windows-curl'}));return;}
        done(resolve,{status:parsed.status,headers:parsed.headers,body:parsed.body,bytes:parsed.body.length,nativeTransport:'windows-curl'});
      } catch(error) { done(reject,error); }
    });
    if(requestBody) child.stdin?.end(requestBody); else child.stdin?.end();
  });
}

export async function windowsSystemLookup(hostname, { spawnImpl = nodeSpawn, signal = null, timeoutMs = 2500 } = {}) {
  if (signal?.aborted) throw abortError();
  const script = '$ErrorActionPreference="Stop";[System.Net.Dns]::GetHostAddresses($env:KL01_WEB_HOST)|ForEach-Object{$_.IPAddressToString}';
  return new Promise((resolve,reject)=>{
    let child;
    try { child=spawnImpl('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,KL01_WEB_HOST:String(hostname)}}); }
    catch(cause){reject(fail('WEB_DNS_FAILED','Windows could not resolve that public web address.',502,{nativeResolver:'powershell'},cause));return;}
    let settled=false;const chunks=[];let size=0;
    const timer=setTimeout(()=>{child.kill?.();done(reject,fail('WEB_DNS_FAILED','Windows could not resolve that public web address.',502,{nativeResolver:'powershell'}));},timeoutMs);
    const done=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);fn(value);};
    const abort=()=>{child.kill?.();done(reject,abortError());};signal?.addEventListener('abort',abort,{once:true});
    child.once('error',cause=>done(reject,fail('WEB_DNS_FAILED','Windows could not resolve that public web address.',502,{nativeResolver:'powershell'},cause)));
    child.stdout?.on('data',chunk=>{size+=chunk.length;if(size<=8192)chunks.push(chunk);});
    child.once('close',code=>{
      if(Number(code)!==0){done(reject,fail('WEB_DNS_FAILED','Windows could not resolve that public web address.',502,{nativeResolver:'powershell',exitCode:Number(code)||0}));return;}
      const seen=new Set();const addresses=[];
      for(const raw of Buffer.concat(chunks).toString('utf8').split(/\r?\n/u)){
        const address=raw.trim();const family=net.isIP(address);if(!family||seen.has(`${family}:${address}`))continue;seen.add(`${family}:${address}`);addresses.push({address,family});
      }
      if(!addresses.length){done(reject,fail('WEB_DNS_EMPTY','That web address did not resolve to a usable public destination.',502,{nativeResolver:'powershell'}));return;}
      done(resolve,addresses);
    });
  });
}
