import { readJsonBody, sendJson } from './http.js';

export function compressionRoute({ compression }) {
  return async (request, response, url) => {
    let match = url.pathname.match(/^\/api\/chats\/([^/]+)\/compression\/review$/);
    if (match && request.method === 'POST') {
      sendJson(response, 200, await compression.createReview(decodeURIComponent(match[1])));
      return true;
    }
    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/compression\/review\/([^/]+)$/);
    if (match && request.method === 'DELETE') {
      sendJson(response, 200, compression.cancelReview(decodeURIComponent(match[1]), decodeURIComponent(match[2])));
      return true;
    }
    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/compression\/preview$/);
    if (match && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await compression.previewRange(decodeURIComponent(match[1]), body.reviewId, body.rangeId, { unlockProtected: Boolean(body.unlockProtected) }));
      return true;
    }
    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/compression\/apply$/);
    if (match && request.method === 'POST') {
      sendJson(response, 200, await compression.apply(decodeURIComponent(match[1]), await readJsonBody(request)));
      return true;
    }
    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/compression\/auto$/);
    if (match && request.method === 'POST') {
      sendJson(response, 200, await compression.autoCompress(decodeURIComponent(match[1])));
      return true;
    }
    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/compression\/undo$/);
    if (match && request.method === 'POST') {
      sendJson(response, 200, await compression.undo(decodeURIComponent(match[1])));
      return true;
    }
    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/compression$/);
    if (match && request.method === 'GET') {
      sendJson(response, 200, await compression.state(decodeURIComponent(match[1])));
      return true;
    }
    return false;
  };
}
