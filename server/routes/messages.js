import { readJsonBody, sendJson } from './http.js';
import { openSse } from '../lib/sse.js';
import { publicError, normalizeError } from '../lib/errors.js';

function terminal(state){return ['completed','cancelled','failed'].includes(String(state||''));}

export function messagesRoute({ flow }) {
  return async (request,response,url) => {
    let match=url.pathname.match(/^\/api\/chats\/([^/]+)\/messages$/u);
    if(match&&request.method==='POST'){
      const chatId=decodeURIComponent(match[1]);
      try{
        const result=await flow.submit(chatId,await readJsonBody(request));
        sendJson(response,202,result);
      }catch(error){sendJson(response,normalizeError(error).status||500,{error:publicError(error)});}
      return true;
    }
    match=url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/u);
    if(match&&request.method==='GET'){
      const runId=decodeURIComponent(match[1]);
      const after=Math.max(0,Number(url.searchParams.get('after')||request.headers['last-event-id']||0));
      const snapshot=flow.runSnapshot(runId);
      if(!snapshot){sendJson(response,404,{error:{code:'RUN_NOT_FOUND',message:'This work run is no longer available.'}});return true;}
      const sse=openSse(response);
      const replay=flow.replay(runId,after);
      if(replay.gap)sse.send('snapshot-required',{runId,after,earliest:replay.earliest,lastSeq:replay.lastSeq},{id:replay.lastSeq});
      else for(const event of replay.events)sse.send(event.type,event,{id:event.seq});
      if(terminal(snapshot.state)){sse.close();return true;}
      const unsubscribe=flow.subscribe(runId,event=>{
        sse.send(event.type,event,{id:event.seq});
        if(terminal(event.state)||['done','cancelled','error'].includes(event.type)){unsubscribe();sse.close();}
      });
      response.once('close',()=>unsubscribe());
      return true;
    }
    match=url.pathname.match(/^\/api\/runs\/([^/]+)$/u);
    if(match&&request.method==='GET'){
      const run=flow.runSnapshot(decodeURIComponent(match[1]));
      if(!run){sendJson(response,404,{error:{code:'RUN_NOT_FOUND',message:'This work run is no longer available.'}});return true;}
      sendJson(response,200,{run});return true;
    }
    match=url.pathname.match(/^\/api\/runs\/([^/]+)\/resume$/u);
    if(match&&request.method==='POST'){
      const runId=decodeURIComponent(match[1]);try{sendJson(response,202,await flow.resume(runId));}catch(error){sendJson(response,normalizeError(error).status||500,{error:publicError(error)});}return true;
    }
    match=url.pathname.match(/^\/api\/runs\/([^/]+)\/discard$/u);
    if(match&&request.method==='POST'){
      const runId=decodeURIComponent(match[1]);try{sendJson(response,200,await flow.discard(runId));}catch(error){sendJson(response,normalizeError(error).status||500,{error:publicError(error)});}return true;
    }
    match=url.pathname.match(/^\/api\/runs\/([^/]+)\/stop$/u);
    if(match&&request.method==='POST'){
      const body=await readJsonBody(request);const runId=decodeURIComponent(match[1]);
      sendJson(response,200,await flow.stop(null,runId,body.reason||'user'));return true;
    }
    match=url.pathname.match(/^\/api\/chats\/([^/]+)\/context\/preview$/u);
    if(match&&request.method==='POST'){sendJson(response,200,await flow.preview(decodeURIComponent(match[1]),await readJsonBody(request)));return true;}
    match=url.pathname.match(/^\/api\/chats\/([^/]+)\/stop$/u);
    if(match&&request.method==='POST'){const body=await readJsonBody(request);const result=await flow.stop(decodeURIComponent(match[1]),body.runId||null,body.reason||'user');sendJson(response,200,{...result,stopped:['stopping','cancelled'].includes(result.status)});return true;}
    match=url.pathname.match(/^\/api\/chats\/([^/]+)\/run$/u);
    if(match&&request.method==='GET'){sendJson(response,200,{run:flow.activeRun(decodeURIComponent(match[1]))});return true;}
    match=url.pathname.match(/^\/api\/runs\/([^/]+)\/input$/u);
    if(match&&request.method==='POST'){sendJson(response,200,flow.provideInput(decodeURIComponent(match[1]),await readJsonBody(request)));return true;}
    match=url.pathname.match(/^\/api\/chats\/([^/]+)\/context$/u);
    if(match&&request.method==='GET'){sendJson(response,200,await flow.measureChat(decodeURIComponent(match[1])));return true;}
    return false;
  };
}
