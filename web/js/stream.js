export async function consumeSse(response,onEvent){
  if(!response.ok){let body={};try{body=await response.json();}catch{}const error=new Error(body?.error?.message||'The local server could not finish this request; check that it is running, then retry.');error.payload=body?.error||{};error.status=response.status;throw error;}
  if(!response.body)throw new Error('The local server returned no response; retry the message.');
  const decoder=new TextDecoder();let pending='';let lastId=0;
  for await(const chunk of response.body){pending+=decoder.decode(chunk,{stream:true});let boundary;while((boundary=pending.indexOf('\n\n'))>=0){const block=pending.slice(0,boundary);pending=pending.slice(boundary+2);let event='message';let id=null;const data=[];for(const line of block.split(/\r?\n/u)){if(line.startsWith(':'))continue;if(line.startsWith('event:'))event=line.slice(6).trim();else if(line.startsWith('id:'))id=line.slice(3).trim();else if(line.startsWith('data:'))data.push(line.slice(5).trimStart());}if(!data.length)continue;let value=data.join('\n');try{value=JSON.parse(value);}catch{}if(id!=null&&/^\d+$/u.test(id))lastId=Math.max(lastId,Number(id));await onEvent(event,value,{id,lastId});}}
  return {lastId};
}

export async function consumeWorkEvents({open,snapshot,onEvent,onSnapshot,onConnectionState=null,signal=null,startAfter=0,maxReconnects=Infinity,maxBackoffMs=5000}){
  let after=Math.max(0,Number(startAfter||0));let reconnects=0;let disconnectedSince=null;
  const sleep=ms=>new Promise((resolve,reject)=>{if(signal?.aborted)return resolve();const timer=setTimeout(done,ms);function done(){signal?.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);done();}signal?.addEventListener('abort',abort,{once:true});});
  while(!signal?.aborted){
    try{
      await onConnectionState?.({state:reconnects?'reconnecting':'connecting',reconnects,lastSeq:after,disconnectedSince});
      const response=await open(after);
      await onConnectionState?.({state:'connected',reconnects,lastSeq:after,disconnectedSince});
      const result=await consumeSse(response,async(event,data,meta)=>{
        if(event==='snapshot-required'){const current=await snapshot();after=Number(current?.run?.replay?.lastSeq||data?.lastSeq||after);await onSnapshot?.(current?.run||null);return;}
        const seq=Number(data?.seq||meta?.id||0);if(seq&&seq<=after)return;if(seq&&seq>after+1&&after>0){const current=await snapshot();after=Number(current?.run?.replay?.lastSeq||seq-1);await onSnapshot?.(current?.run||null);return;}if(seq)after=seq;await onEvent(event,data);
      });
      after=Math.max(after,Number(result?.lastId||0));
      const current=await snapshot().catch(()=>null);if(!current?.run||['completed','cancelled','failed'].includes(current.run.state))return{lastSeq:after,run:current?.run||null};
      reconnects+=1;disconnectedSince ||= Date.now();if(Number.isFinite(maxReconnects)&&reconnects>maxReconnects)throw new Error('Live work updates disconnected repeatedly.');
      await onConnectionState?.({state:'reconnecting',reconnects,lastSeq:after,disconnectedSince});
      await sleep(Math.min(maxBackoffMs,150*2**Math.min(reconnects,8)));
    }catch(error){
      if(signal?.aborted)return{lastSeq:after,aborted:true};
      reconnects+=1;disconnectedSince ||= Date.now();
      const current=await snapshot().catch(()=>null);
      if(current?.run&&['completed','cancelled','failed'].includes(current.run.state))return{lastSeq:after,run:current.run};
      if(Number.isFinite(maxReconnects)&&reconnects>maxReconnects)throw error;
      await onConnectionState?.({state:'reconnecting',reconnects,lastSeq:after,disconnectedSince,error:error?.message||String(error)});
      await sleep(Math.min(maxBackoffMs,150*2**Math.min(reconnects,8)));
    }
  }
  return{lastSeq:after,aborted:true};
}

export function consumeEventSource(source,onEvent){
  const progress=event=>{let value=event.data;try{value=JSON.parse(value);}catch{}onEvent('progress',value);};
  const serverError=event=>{if(typeof event.data!=='string'||!event.data)return;let value=event.data;try{value=JSON.parse(value);}catch{}onEvent('error',value);};
  source.addEventListener('progress',progress);
  source.addEventListener('error',serverError);
  return()=>{source.removeEventListener('progress',progress);source.removeEventListener('error',serverError);source.close();};
}

export function consumeRuntimeSource(source,onRuntime,onConnectionState=null){
  const runtime=event=>{let value=event.data;try{value=JSON.parse(value);}catch{return;}onConnectionState?.({state:'connected'});onRuntime(value);};
  const error=()=>onConnectionState?.({state:'reconnecting'});
  source.addEventListener('runtime',runtime);
  source.addEventListener('error',error);
  return()=>{source.removeEventListener('runtime',runtime);source.removeEventListener('error',error);source.close();};
}
