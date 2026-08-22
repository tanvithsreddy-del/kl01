import { sendJson } from './http.js';
import { openSse } from '../lib/sse.js';

export function runtimeRoute({ runtime, selection }) {
  return async (request,response,url) => {
    if (request.method === 'GET' && url.pathname === '/api/runtime') {
      sendJson(response,200,{ ...(await selection.runtimeState()), binaryPresent: await runtime.binaryPresent() });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/runtime/events') {
      const stream = openSse(response);
      let closed = false;
      const send = next => { if (!closed) stream.send('runtime', next); };
      const unsubscribe = selection.subscribe(send);
      const initial = await selection.runtimeState();
      send(initial);
      request.once('close', () => { closed = true; unsubscribe(); stream.close(); });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/runtime/stop') {
      sendJson(response,200,await selection.stop());
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/runtime/restart') {
      sendJson(response,200,await selection.restartLocal());
      return true;
    }
    return false;
  };
}
