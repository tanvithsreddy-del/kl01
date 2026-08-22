import { SSE_HEARTBEAT_MS } from '../config.js';
export function openSse(response){
  response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Content-Type-Options':'nosniff'});
  response.write(': connected\n\n');let closed=false;
  const heartbeat=setInterval(()=>{if(!closed&&!response.destroyed)response.write(': heartbeat\n\n');},SSE_HEARTBEAT_MS);heartbeat.unref?.();
  const send=(event,data,{id=null}={})=>{if(closed||response.destroyed)return false;if(id!=null)response.write(`id: ${String(id)}\n`);response.write(`event: ${event}\n`);const payload=typeof data==='string'?data:JSON.stringify(data);for(const line of payload.split(/\r?\n/u))response.write(`data: ${line}\n`);response.write('\n');return true;};
  const close=()=>{if(closed)return;closed=true;clearInterval(heartbeat);if(!response.destroyed&&!response.writableEnded)response.end();};
  response.once('close',()=>{closed=true;clearInterval(heartbeat);});return{send,close,get closed(){return closed;}};
}
