import { readJsonBody, sendJson } from './http.js';
export function servicesRoute({ selection }) {
  return async (request, response, url) => {
    if (url.pathname === '/api/services' && request.method === 'GET') {
      sendJson(response, 200, await selection.list());
      return true;
    }
    if (url.pathname === '/api/services' && request.method === 'POST') {
      sendJson(response, 201, await selection.save(await readJsonBody(request)));
      return true;
    }
    let match = url.pathname.match(/^\/api\/services\/([^/]+)\/activate$/);
    if (match && request.method === 'POST') {
      const body = await readJsonBody(request).catch(() => ({}));
      sendJson(response, 200, await selection.activateExternal(decodeURIComponent(match[1]), body.chatId || null));
      return true;
    }
    match = url.pathname.match(/^\/api\/services\/([^/]+)$/);
    if (match && request.method === 'DELETE') {
      sendJson(response, 200, await selection.remove(decodeURIComponent(match[1])));
      return true;
    }
    return false;
  };
}
