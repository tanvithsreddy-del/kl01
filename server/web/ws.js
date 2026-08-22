import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fail } from '../lib/errors.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

function expectedAccept(key) { return crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64'); }
function abortError() { return fail('WEB_CANCELLED', 'Web work was stopped.', 499); }

function frame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let header;
  if (body.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  else if (body.length <= 0xffff) { header = Buffer.alloc(4); header[0]=0x80|opcode; header[1]=0x80|126; header.writeUInt16BE(body.length,2); }
  else { header = Buffer.alloc(10); header[0]=0x80|opcode; header[1]=0x80|127; header.writeBigUInt64BE(BigInt(body.length),2); }
  const masked = Buffer.alloc(body.length);
  for (let i=0;i<body.length;i+=1) masked[i]=body[i]^mask[i%4];
  return Buffer.concat([header,mask,masked]);
}

function parseHeaders(raw) {
  const lines=raw.split('\r\n');
  const status=lines.shift() || '';
  const headers={};
  for (const line of lines) {
    const index=line.indexOf(':'); if(index<0) continue;
    headers[line.slice(0,index).trim().toLowerCase()]=line.slice(index+1).trim();
  }
  return {status,headers};
}

export class TinyWebSocket extends EventEmitter {
  constructor(socket, { maxMessageBytes = MAX_MESSAGE_BYTES } = {}) {
    super(); this.socket=socket; this.maxMessageBytes=maxMessageBytes; this.buffer=Buffer.alloc(0); this.fragments=[]; this.fragmentOpcode=null; this.closed=false;
    socket.on('data', chunk => { this.buffer=Buffer.concat([this.buffer,chunk]); this.#drain(); });
    socket.on('error', error => { if(this.listenerCount('error')) this.emit('error', error); else { this.closed=true; } });
    socket.on('close', () => { if(!this.closed){this.closed=true;this.emit('close');} });
  }
  sendText(text) { if(this.closed) throw new Error('websocket closed'); this.socket.write(frame(1,Buffer.from(String(text)))); }
  pong(payload) { if(!this.closed) this.socket.write(frame(10,payload)); }
  close(code=1000, reason='') {
    if(this.closed) return; this.closed=true;
    const reasonBytes=Buffer.from(String(reason)).subarray(0,123); const payload=Buffer.alloc(2+reasonBytes.length); payload.writeUInt16BE(code,0); reasonBytes.copy(payload,2);
    try { this.socket.write(frame(8,payload)); } catch {}
    this.socket.end();
  }
  destroy() { this.closed=true; this.socket.destroy(); }
  #drain() {
    while (this.buffer.length >= 2) {
      const b0=this.buffer[0], b1=this.buffer[1]; const fin=Boolean(b0&0x80); const opcode=b0&0x0f; const masked=Boolean(b1&0x80);
      let length=b1&0x7f, offset=2;
      if(length===126){ if(this.buffer.length<4)return; length=this.buffer.readUInt16BE(2); offset=4; }
      else if(length===127){ if(this.buffer.length<10)return; const n=this.buffer.readBigUInt64BE(2); if(n>BigInt(this.maxMessageBytes)) return this.#fatal(1009,'message too large'); length=Number(n); offset=10; }
      const maskBytes=masked?4:0;
      if(length>this.maxMessageBytes) return this.#fatal(1009,'message too large');
      if(this.buffer.length<offset+maskBytes+length)return;
      let payload=this.buffer.subarray(offset+maskBytes,offset+maskBytes+length); this.buffer=this.buffer.subarray(offset+maskBytes+length);
      if(masked){ const mask=this.buffer.subarray(0,0); /* server masking is invalid; handled below */ void mask; return this.#fatal(1002,'masked server frame'); }
      if(opcode===8){ if(!this.closed){this.closed=true;try{this.socket.write(frame(8,payload));}catch{} this.socket.end();this.emit('close');} return; }
      if(opcode===9){ this.pong(payload); continue; }
      if(opcode===10) continue;
      if(opcode===0){ if(this.fragmentOpcode===null)return this.#fatal(1002,'unexpected continuation'); this.fragments.push(payload); }
      else if(opcode===1||opcode===2){ if(this.fragmentOpcode!==null)return this.#fatal(1002,'nested fragment'); this.fragmentOpcode=opcode; this.fragments=[payload]; }
      else return this.#fatal(1002,'unsupported opcode');
      const total=this.fragments.reduce((sum,item)=>sum+item.length,0); if(total>this.maxMessageBytes)return this.#fatal(1009,'message too large');
      if(fin){ const message=Buffer.concat(this.fragments); const type=this.fragmentOpcode; this.fragmentOpcode=null; this.fragments=[]; if(type===1)this.emit('message',message.toString('utf8')); else this.emit('binary',message); }
    }
  }
  #fatal(code, reason){ const error=new Error(reason); if(this.listenerCount('error'))this.emit('error',error); this.close(code,reason); }
}

export async function connectWebSocket(input, { signal = null, timeoutMs = 5_000, maxMessageBytes = MAX_MESSAGE_BYTES } = {}) {
  const url=new URL(input);
  if(!['ws:','wss:'].includes(url.protocol)) throw fail('WEB_CDP_URL','Browser returned an invalid debugging endpoint.',502);
  if(!['127.0.0.1','localhost','::1','[::1]'].includes(url.hostname)) throw fail('WEB_CDP_REMOTE','KL01 refused a non-local browser debugging endpoint.',403);
  if(signal?.aborted) throw abortError();
  const key=crypto.randomBytes(16).toString('base64'); const port=Number(url.port || (url.protocol==='wss:'?443:80));
  const socket= url.protocol==='wss:' ? tls.connect({host:'127.0.0.1',port,servername:'localhost'}) : net.connect({host:'127.0.0.1',port});
  return await new Promise((resolve,reject)=>{
    let settled=false, buffer=Buffer.alloc(0); const timer=setTimeout(()=>done(reject,fail('WEB_CDP_TIMEOUT','Browser debugging handshake timed out.',504)),timeoutMs);
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);socket.off('error',onError);socket.off('data',onData);};
    const done=(fn,value)=>{if(settled)return;settled=true;cleanup();fn(value);};
    const onAbort=()=>{socket.destroy();done(reject,abortError());};
    const onError=error=>done(reject,fail('WEB_CDP_CONNECT','KL01 could not connect to its browser debugging endpoint.',502,undefined,error));
    const onData=chunk=>{
      buffer=Buffer.concat([buffer,chunk]); if(buffer.length>64*1024){socket.destroy();return done(reject,fail('WEB_CDP_HEADERS','Browser debugging handshake was too large.',502));}
      const index=buffer.indexOf('\r\n\r\n'); if(index<0)return;
      const {status,headers}=parseHeaders(buffer.subarray(0,index).toString('latin1'));
      if(!/^HTTP\/1\.[01] 101\b/u.test(status) || String(headers.upgrade||'').toLowerCase()!=='websocket' || String(headers.connection||'').toLowerCase().split(/\s*,\s*/u).indexOf('upgrade')<0 || headers['sec-websocket-accept']!==expectedAccept(key)) {
        socket.destroy(); return done(reject,fail('WEB_CDP_HANDSHAKE','Browser debugging handshake was rejected.',502));
      }
      const rest=buffer.subarray(index+4); socket.off('data',onData); const ws=new TinyWebSocket(socket,{maxMessageBytes}); if(rest.length) socket.emit('data',rest); done(resolve,ws);
    };
    signal?.addEventListener('abort',onAbort,{once:true});socket.once('error',onError);socket.on('data',onData);
    socket.once('connect',()=>{
      // RFC6455 Origin is optional for non-browser clients. Omitting it avoids
      // weakening Chromium with --remote-allow-origins just to control our own
      // loopback DevTools endpoint.
      const request=[`GET ${url.pathname}${url.search} HTTP/1.1`,`Host: 127.0.0.1:${port}`,'Upgrade: websocket','Connection: Upgrade',`Sec-WebSocket-Key: ${key}`,'Sec-WebSocket-Version: 13','',''].join('\r\n');
      socket.write(request);
    });
  });
}
