import { EventEmitter } from 'node:events';
import { connectWebSocket } from './ws.js';
import { fail } from '../lib/errors.js';

export class CdpConnection extends EventEmitter {
  constructor(ws, { commandTimeoutMs = 5_000 } = {}) {
    super(); this.ws=ws; this.commandTimeoutMs=commandTimeoutMs; this.nextId=1; this.pending=new Map(); this.closed=false;
    ws.on('message', text => this.#message(text));
    ws.on('close', () => this.#close(fail('WEB_CDP_CLOSED','The browser debugging connection closed.',502)));
    ws.on('error', error => this.#close(fail('WEB_CDP_FAILED','The browser debugging connection failed.',502,undefined,error)));
  }
  static async connect(url, options={}) { return new CdpConnection(await connectWebSocket(url,options),options); }
  #message(text) {
    let message; try { message=JSON.parse(text); } catch { return this.#close(fail('WEB_CDP_PROTOCOL','Browser sent invalid debugging data.',502)); }
    if(message.id){
      const pending=this.pending.get(message.id); if(!pending)return;
      this.pending.delete(message.id); clearTimeout(pending.timer); pending.signal?.removeEventListener('abort',pending.onAbort);
      if(message.error) pending.reject(fail('WEB_CDP_COMMAND',`Browser command failed: ${message.error.message || 'unknown error'}.`,502,{method:pending.method,code:message.error.code}));
      else pending.resolve(message.result || {});
      return;
    }
    if(message.method) this.emit('event',message); this.emit(message.method,message.params || {},message.sessionId || null);
  }
  #close(error){ if(this.closed)return; this.closed=true; for(const [id,pending] of this.pending){clearTimeout(pending.timer);pending.signal?.removeEventListener('abort',pending.onAbort);pending.reject(error);this.pending.delete(id);} this.emit('closed',error); }
  send(method, params={}, { sessionId=null, signal=null, timeoutMs=this.commandTimeoutMs }={}) {
    if(this.closed) return Promise.reject(fail('WEB_CDP_CLOSED','The browser debugging connection is closed.',502));
    if(signal?.aborted) return Promise.reject(fail('WEB_CANCELLED','Web work was stopped.',499));
    const id=this.nextId++; const payload={id,method,params,...(sessionId?{sessionId}:{})};
    return new Promise((resolve,reject)=>{
      const onAbort=()=>{const current=this.pending.get(id);if(!current)return;this.pending.delete(id);clearTimeout(current.timer);reject(fail('WEB_CANCELLED','Web work was stopped.',499));};
      const timer=setTimeout(()=>{if(!this.pending.has(id))return;this.pending.delete(id);signal?.removeEventListener('abort',onAbort);reject(fail('WEB_CDP_TIMEOUT',`Browser command ${method} timed out.`,504));},Math.max(50,timeoutMs));
      this.pending.set(id,{resolve,reject,timer,signal,onAbort,method}); signal?.addEventListener('abort',onAbort,{once:true});
      try{this.ws.sendText(JSON.stringify(payload));}catch(error){this.pending.delete(id);clearTimeout(timer);signal?.removeEventListener('abort',onAbort);reject(error);}
    });
  }
  close(){ if(this.closed)return; this.closed=true; this.ws.close(); for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(fail('WEB_CDP_CLOSED','Browser debugging connection closed.',502));} this.pending.clear(); }
}
