import { readJsonBody, sendJson } from './http.js';
import { openSse } from '../lib/sse.js';

export function modelsRoute({ models, selection, targetManager = null, governor = null }) {
  return async (request, response, url) => {
    if (request.method === 'GET' && url.pathname === '/api/models') {
      sendJson(response, 200, await models.catalogue()); return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/models/installed') {
      const installed=await models.installedState();const targets=targetManager?await targetManager.descriptors():[];const resources=governor?await governor.detailedSnapshot():null;sendJson(response, 200, { ...installed, targets, resources }); return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/models/sideload') {
      const body = await readJsonBody(request);
      sendJson(response, 201, await models.sideload(body.path));
      return true;
    }
    let match = url.pathname.match(/^\/api\/models\/([^/]+)\/(activate|download|pause|resume|cancel)$/);
    if (match && request.method === 'POST') {
      const id = decodeURIComponent(match[1]);
      const action = match[2];
      let result;
      if (action === 'activate') {
        const body = await readJsonBody(request).catch(() => ({}));
        result = await selection.activateLocal(id, body.chatId || null);
      } else {
        result = await models.act(id, action);
      }
      sendJson(response, action === 'download' || action === 'resume' ? 202 : 200, result);
      return true;
    }
    match = url.pathname.match(/^\/api\/models\/([^/]+)\/download$/);
    if (match && request.method === 'GET') { sendJson(response, 200, models.getDownload(decodeURIComponent(match[1]))); return true; }
    match = url.pathname.match(/^\/api\/models\/([^/]+)\/download\/events$/);
    if (match && request.method === 'GET') {
      const id = decodeURIComponent(match[1]);
      const sse = openSse(response);
      const unsubscribe = models.subscribeDownload(id, value => sse.send('progress', value));
      response.once('close', unsubscribe);
      return true;
    }
    match = url.pathname.match(/^\/api\/models\/([^/]+)$/);
    if (match && request.method === 'DELETE') { sendJson(response, 200, await models.uninstall(decodeURIComponent(match[1]))); return true; }
    return false;
  };
}
