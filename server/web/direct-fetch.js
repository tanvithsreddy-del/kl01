import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { authorizeDestination } from './policy.js';
import { extractDocument } from './extract.js';
import { fail } from '../lib/errors.js';
import { USER_AGENT } from '../config.js';
import { deadlineAfter, remainingMs } from './clock.js';
import { connectThroughProxy, parseUpstreamProxy } from './upstream-proxy.js';
import { windowsCurlRequest, windowsSystemLookup } from './windows-native.js';

const DEFAULT_DEADLINE_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_DECODED_BYTES = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_REQUEST_BODY_BYTES = 32 * 1024;
const SAFE_REQUEST_HEADERS = new Set(['accept','accept-language','content-type','referer','user-agent','sec-fetch-dest','sec-fetch-mode','sec-fetch-site','sec-fetch-user']);

function abortError() { return fail('WEB_CANCELLED', 'Web work was stopped.', 499); }
function remaining(deadline) { return remainingMs(deadline); }
function safeRequestHeaders(headers = {}) {
  const out={};
  for(const [rawName,rawValue] of Object.entries(headers||{})){
    const name=String(rawName||'').trim().toLowerCase();
    if(!SAFE_REQUEST_HEADERS.has(name))continue;
    const value=String(rawValue??'').replace(/[\r\n]+/gu,' ').trim();
    if(!value)continue;
    out[name]=value.slice(0,4096);
  }
  return out;
}

function decoderFor(encoding, response) {
  const value = String(encoding || '').toLowerCase().trim();
  if (!value || value === 'identity') return response;
  if (value === 'gzip' || value === 'x-gzip') return response.pipe(zlib.createGunzip());
  if (value === 'deflate') return response.pipe(zlib.createInflate());
  if (value === 'br') return response.pipe(zlib.createBrotliDecompress());
  throw fail('WEB_ENCODING_UNSUPPORTED', 'That page used an unsupported response encoding.', 415);
}

async function proxyConnection(destination, address, upstreamProxy, { signal, deadline }) {
  const timeoutMs = Math.max(100, remaining(deadline));
  const raw = await connectThroughProxy(upstreamProxy, [address], destination.port, { signal, timeoutMs });
  if (destination.url.protocol !== 'https:') return raw;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { raw.destroy(); reject(abortError()); return; }
    const socket = tls.connect({ socket:raw, servername:destination.hostname, rejectUnauthorized:true });
    let settled=false;
    const timer=setTimeout(()=>{socket.destroy();done(reject,fail('WEB_DEADLINE','This page took too long to establish a secure connection.',504));},timeoutMs);
    const done=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.off('secureConnect',ready);socket.off('error',error);fn(value);};
    const abort=()=>{socket.destroy();done(reject,abortError());};
    const ready=()=>{socket.on('error',()=>{});done(resolve,socket);};
    const error=cause=>done(reject,fail('WEB_CONNECT_FAILED','KL01 could not establish a secure connection through the configured proxy.',502,undefined,cause));
    socket.once('secureConnect',ready);socket.once('error',error);signal?.addEventListener('abort',abort,{once:true});
  });
}

async function onePinnedRequest(destination, address, { signal, deadline, maxBytes, headers = {}, upstreamProxy = null, method = 'GET', body = null }) {
  if (signal?.aborted) throw abortError();
  const { url, hostname, port } = destination;
  const parsedProxy = upstreamProxy ? parseUpstreamProxy(upstreamProxy) : null;
  const connectedSocket = parsedProxy ? await proxyConnection(destination, address, parsedProxy, { signal, deadline }) : null;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { connectedSocket?.destroy(); return reject(abortError()); }
    let settled = false; let req;
    const finish = (fn, value) => { if (settled) return; settled = true; signal?.removeEventListener('abort', onAbort); fn(value); };
    const onAbort = () => { req?.destroy(); finish(reject, abortError()); };
    signal?.addEventListener('abort', onAbort, { once:true });
    const transport = url.protocol === 'https:' ? https : http;
    const timeout = remaining(deadline);
    if (!timeout) return finish(reject, fail('WEB_DEADLINE', 'This page took too long to respond.', 504));
    const requestBody = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
    if (requestBody && requestBody.length > MAX_REQUEST_BODY_BYTES) return finish(reject, fail('WEB_REQUEST_BODY_LIMIT', 'That Web request body is too large.', 413));
    const requestHeaders={ 'user-agent':USER_AGENT, accept:'text/html,text/plain,application/xhtml+xml,application/json;q=0.8,*/*;q=0.2', 'accept-encoding':'gzip, deflate, br', connection:'close', ...safeRequestHeaders(headers) };
    delete requestHeaders.host; delete requestHeaders.Host; delete requestHeaders['transfer-encoding']; delete requestHeaders['Transfer-Encoding'];
    if (requestBody) requestHeaders['content-length']=String(requestBody.length); else { delete requestHeaders['content-length']; delete requestHeaders['Content-Length']; }
    req = transport.request({
      protocol:url.protocol, hostname, port, method, path:`${url.pathname}${url.search}`,
      servername:url.protocol === 'https:' ? hostname : undefined,
      ...(connectedSocket ? { createConnection: () => connectedSocket } : { lookup: (_host, _options, callback) => callback(null, address.address, address.family) }),
      maxHeaderSize:MAX_HEADER_BYTES,
      headers:requestHeaders,
      agent:false,
    }, response => {
      let stream;
      try { stream = decoderFor(response.headers['content-encoding'], response); }
      catch (error) { response.destroy(); finish(reject, error); return; }
      const chunks=[]; let size=0;
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          stream.destroy(); response.destroy(); req.destroy();
          finish(reject, fail('WEB_BODY_LIMIT', 'That page is too large for Web to read safely.', 413));
          return;
        }
        chunks.push(chunk);
      });
      stream.once('error', error => finish(reject, signal?.aborted ? abortError() : fail('WEB_RESPONSE_FAILED', 'The page connection ended before KL01 could read it.', 502, undefined, error)));
      stream.once('end', () => finish(resolve, { status:Number(response.statusCode || 0), headers:response.headers, body:Buffer.concat(chunks), bytes:size }));
    });
    req.once('error', error => finish(reject, signal?.aborted ? abortError() : fail('WEB_CONNECT_FAILED', 'KL01 could not connect to that public web page.', 502, undefined, error)));
    req.setTimeout(timeout, () => { req.destroy(); finish(reject, fail('WEB_DEADLINE', 'This page took too long to respond.', 504)); });
    if (requestBody) req.end(requestBody); else req.end();
  });
}


async function oneRequest(destination, options) {
  let lastError = null;
  for (const address of destination.addresses) {
    try { return await onePinnedRequest(destination, address, options); }
    catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw error;
      if (!['WEB_CONNECT_FAILED','WEB_RESPONSE_FAILED'].includes(error?.code)) throw error;
      if (remaining(options.deadline) <= 0) throw error;
    }
  }
  throw lastError || fail('WEB_CONNECT_FAILED', 'KL01 could not connect to that public web page.', 502);
}

async function platformRequest(destination, options) {
  // Windows often permits the OS curl transport even when a downloaded node.exe
  // is denied raw outbound sockets by firewall/VPN policy. Prefer that genuinely
  // independent path, while preserving pinned-IP and redirect re-authorization.
  if (process.platform === 'win32' && !options.upstreamProxy) {
    let nativeError = null;
    for (const address of destination.addresses) {
      try { return await windowsCurlRequest(destination, address, options); }
      catch (error) {
        nativeError = error;
        if (options.signal?.aborted) throw error;
        if (!['WEB_CONNECT_FAILED','WEB_DNS_FAILED','WEB_DEADLINE','WEB_TLS_FAILED','WEB_NATIVE_TRANSPORT_UNAVAILABLE','WEB_RESPONSE_FAILED'].includes(error?.code)) throw error;
        if (remaining(options.deadline) <= 100) break;
      }
    }
    try { return await oneRequest(destination, options); }
    catch (nodeError) {
      if (!nativeError) throw nodeError;
      throw fail('WEB_TRANSPORT_FAILED', 'KL01 could not connect to that public web page through either Windows or Node networking.', 502, {
        transportAttempts:[
          { id:'windows-curl', code:nativeError?.code || 'FAILED', cause:nativeError?.cause?.code || null, curlExitCode:nativeError?.details?.curlExitCode ?? null },
          { id:'node', code:nodeError?.code || 'FAILED', cause:nodeError?.cause?.code || null },
        ],
      }, nodeError);
    }
  }
  return oneRequest(destination, options);
}

async function extractResponse(body, { contentType='', url='', parserClient=null, signal=null } = {}) {
  if (signal?.aborted) throw abortError();
  if (!parserClient?.extract) return extractDocument(body, { contentType, url });
  try {
    const parsed=await parserClient.extract(body,{contentType,url,signal});
    if (signal?.aborted) throw abortError();
    return { ...parsed, parser:{ mode:'helper', degraded:null } };
  } catch (error) {
    if (signal?.aborted || error?.code==='WEB_CANCELLED') throw abortError();
    if (!['PARSER_HELPER_UNAVAILABLE','PARSER_HELPER_STALL','PARSER_HELPER_PROTOCOL'].includes(error?.code)) throw error;
    try { return { ...extractDocument(body, { contentType, url }), parser:{ mode:'builtin', degraded:{ code:error.code } } }; }
    catch (fallbackError) {
      fallbackError.details={ ...(fallbackError.details||{}), parserDegraded:error.code };
      throw fallbackError;
    }
  }
}

async function requestWithinDeadline(requester,destination,options){
  const remainingNow=Math.max(0,remaining(options.deadline));
  if(!remainingNow)throw fail('WEB_DEADLINE','This page took too long to respond.',504);
  const controller=new AbortController();
  const parent=options.signal||null;
  const relay=()=>controller.abort(parent?.reason||abortError());
  if(parent?.aborted)relay();else parent?.addEventListener('abort',relay,{once:true});
  let timer=null;
  const deadlineError=fail('WEB_DEADLINE','This page took too long to respond.',504);
  try{
    return await Promise.race([
      Promise.resolve().then(()=>requester(destination,{...options,signal:controller.signal})),
      new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort(deadlineError);reject(deadlineError);},remainingNow);timer.unref?.();}),
    ]);
  }finally{if(timer)clearTimeout(timer);parent?.removeEventListener('abort',relay);}
}

async function authorized(input, lookup) {
  try { return await authorizeDestination(input, { ...(lookup ? { lookup } : {}) }); }
  catch (error) {
    if (process.platform !== 'win32' || lookup || !['WEB_DNS_FAILED','WEB_DNS_EMPTY'].includes(error?.code)) throw error;
    return authorizeDestination(input, { lookup: host => windowsSystemLookup(host) });
  }
}

export async function directFetch(input, { signal = null, deadlineMs = DEFAULT_DEADLINE_MS, maxBytes = MAX_DECODED_BYTES, lookup, upstreamProxy = null, requester = platformRequest, method = 'GET', body = null, headers = {}, parserClient = null } = {}) {
  const deadline = deadlineAfter(Math.max(100, Math.min(30_000, Number(deadlineMs) || DEFAULT_DEADLINE_MS)));
  let current = String(input || '');
  let currentMethod=String(method || 'GET').toUpperCase();
  if (!['GET','POST'].includes(currentMethod)) throw fail('WEB_METHOD_BLOCKED', 'Web supports only safe reads and bounded search-form submissions.', 405);
  let currentBody=body;
  let currentHeaders=safeRequestHeaders(headers);
  const redirects=[];
  const seenUrls=new Set();
  for (let hop=0; hop<=MAX_REDIRECTS; hop += 1) {
    if (signal?.aborted) throw abortError();
    const destination = await authorized(current, lookup);
    const currentKey=destination.url.href;
    if(seenUrls.has(currentKey))throw fail('WEB_REDIRECT_LOOP','That page is stuck in a redirect loop.',508,{url:currentKey,redirects:redirects.slice(-6)});
    seenUrls.add(currentKey);
    const response = await requestWithinDeadline(requester,destination,{ signal, deadline, maxBytes, upstreamProxy, method:currentMethod, body:currentBody, headers:currentHeaders });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.location;
      if (!location) throw fail('WEB_REDIRECT_INVALID', 'That page returned an invalid redirect.', 502);
      if (hop >= MAX_REDIRECTS) throw fail('WEB_REDIRECT_LIMIT', 'That page redirected too many times.', 508);
      const next = new URL(location, destination.url).href;
      if(seenUrls.has(next))throw fail('WEB_REDIRECT_LOOP','That page is stuck in a redirect loop.',508,{from:destination.url.href,to:next,status:response.status,redirects:redirects.slice(-6)});
      redirects.push({ from:destination.url.href, to:next, status:response.status });
      if (response.status===303 || ([301,302].includes(response.status) && currentMethod==='POST')) {
        currentMethod='GET'; currentBody=null; currentHeaders={...currentHeaders};
        delete currentHeaders['content-type']; delete currentHeaders['Content-Type']; delete currentHeaders['content-length']; delete currentHeaders['Content-Length'];
      }
      if(new URL(next).origin!==destination.url.origin){delete currentHeaders.referer;delete currentHeaders['sec-fetch-site'];}
      current = next; continue;
    }
    if (response.status < 200 || response.status >= 300) throw fail('WEB_HTTP_STATUS', `That page returned HTTP ${response.status}.`, 502, { status:response.status, retryAfter:response.headers['retry-after'] || null });
    const finalUrl = destination.url.href;
    const contentType = String(response.headers['content-type'] || '');
    let extracted;
    try { extracted = await extractResponse(response.body, { contentType, url:finalUrl, parserClient, signal }); }
    catch (error) {
      if (error?.code) throw fail(error.code, error.publicMessage || 'That page did not contain readable text.', error.status || 415, error.details);
      throw error;
    }
    return { mode:'direct', url:finalUrl, status:response.status, contentType, bytes:response.bytes, redirects, ...extracted };
  }
  throw fail('WEB_REDIRECT_LIMIT', 'That page redirected too many times.', 508);
}
