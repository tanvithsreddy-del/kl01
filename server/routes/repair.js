import { readJsonBody, sendJson } from './http.js';

export function repairRoute({ repair }) {
  return async (request, response, url) => {
    let match = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/repair\/anchor$/u);
    if (match && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await repair.anchor(decodeURIComponent(match[1]), decodeURIComponent(match[2]), body.path)); return true;
    }
    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/repair\/preview$/u);
    if (match && request.method === 'POST') {
      sendJson(response, 200, await repair.preview(decodeURIComponent(match[1]), decodeURIComponent(match[2]), await readJsonBody(request))); return true;
    }
    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/repair\/discard$/u);
    if (match && request.method === 'POST') {
      sendJson(response, 200, await repair.discard(decodeURIComponent(match[1]), decodeURIComponent(match[2]))); return true;
    }
    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/repair\/apply$/u);
    if (match && request.method === 'POST') {
      sendJson(response, 200, await repair.apply(decodeURIComponent(match[1]), decodeURIComponent(match[2]))); return true;
    }
    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/repair\/undo$/u);
    if (match && request.method === 'POST') {
      sendJson(response, 200, await repair.undo(decodeURIComponent(match[1]), decodeURIComponent(match[2]))); return true;
    }
    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/repair\/history$/u);
    if (match && request.method === 'GET') {
      sendJson(response, 200, await repair.history(decodeURIComponent(match[1]), decodeURIComponent(match[2]))); return true;
    }
    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/repair\/restore$/u);
    if (match && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await repair.restore(decodeURIComponent(match[1]), decodeURIComponent(match[2]), body.revisionId)); return true;
    }
    return false;
  };
}
