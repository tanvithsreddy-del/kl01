import * as chats from '../services/chats.js';
import { readJsonBody, sendJson, sendText } from './http.js';

function contentDisposition(filename) {
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const extension = filename.toLowerCase().endsWith('.txt') ? 'txt' : 'md';
  return `attachment; filename="kl01-chat.${extension}"; filename*=UTF-8''${encoded}`;
}

function publicChat(chat) {
  return {
    ...chat,
    draft: chat.draft ? { ...chat.draft, modelContent: undefined, attachmentContents: undefined } : chat.draft,
    messages: (chat.messages || []).map(message => ({ ...message, modelContent: undefined })),
  };
}

export function chatsRoute({ access, flow, snapshots, documents } = {}) {
  return async (request, response, url) => {
    if (url.pathname === '/api/chats/search' && request.method === 'GET') {
      sendJson(response, 200, { results: await chats.searchChats(url.searchParams.get('q') || '') }); return true;
    }
    if (url.pathname === '/api/chats/archived' && request.method === 'GET') {
      sendJson(response, 200, { chats: await chats.listArchivedChats() }); return true;
    }
    if (url.pathname === '/api/chats' && request.method === 'GET') { sendJson(response, 200, { chats: await chats.listChats() }); return true; }
    if (url.pathname === '/api/chats' && request.method === 'POST') { const body = await readJsonBody(request); sendJson(response, 201, await chats.createChat(body.title, { projectId: body.projectId || null })); return true; }

    let match = url.pathname.match(/^\/api\/chats\/([^/]+)\/execution-profile$/);
    if (match && request.method === 'GET') { const chat = await chats.getChat(decodeURIComponent(match[1])); sendJson(response, 200, { executionProfile: chat.executionProfile, nextRunProfile: chat.draft?.executionProfile || null }); return true; }
    if (match && request.method === 'PUT') { sendJson(response, 200, { executionProfile: await chats.saveChatExecutionProfile(decodeURIComponent(match[1]), await readJsonBody(request)) }); return true; }
    if (match && request.method === 'DELETE') { sendJson(response, 200, await chats.clearNextRunExecutionProfile(decodeURIComponent(match[1]))); return true; }

    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/draft$/);
    if (match && request.method === 'GET') { const chat = await chats.getChat(decodeURIComponent(match[1])); sendJson(response, 200, chat.draft || {}); return true; }
    if (match && request.method === 'PUT') { sendJson(response, 200, await chats.saveDraft(decodeURIComponent(match[1]), await readJsonBody(request))); return true; }

    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/branch$/);
    if (match && request.method === 'POST') {
      const body = await readJsonBody(request);
      const branch = await chats.branchChat(decodeURIComponent(match[1]), body.messageId);
      const documentIds = (branch.messages || []).flatMap(message => (message.attachments || []).map(item => item?.documentId).filter(Boolean));
      await documents?.linkChatDocuments?.(branch.id, documentIds);
      sendJson(response, 201, branch); return true;
    }

    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/pin$/);
    if (match && request.method === 'PUT') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await chats.setChatPinned(decodeURIComponent(match[1]), body.pinned !== false));
      return true;
    }

    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/archive$/);
    if (match && request.method === 'POST') {
      const chatId = decodeURIComponent(match[1]);
      await flow?.stop?.(chatId);
      sendJson(response, 200, await chats.archiveChat(chatId));
      return true;
    }

    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/restore$/);
    if (match && request.method === 'POST') {
      sendJson(response, 200, await chats.restoreChat(decodeURIComponent(match[1])));
      return true;
    }

    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/edit$/);
    if (match && request.method === 'POST') {
      const chatId=decodeURIComponent(match[1]);await flow?.cancelForMutation?.(chatId,'edit-message');
      const result = await chats.editLastUserMessage(chatId, decodeURIComponent(match[2]));
      const documentIds = (result.chat?.messages || []).flatMap(message => (message.attachments || []).map(item => item?.documentId).filter(Boolean));
      await documents?.syncChatDocuments?.(chatId, documentIds);
      sendJson(response, 200, result); return true;
    }

    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/retry-workflow$/);
    if (match && request.method === 'POST') {
      sendJson(response, 202, await flow.retryWorkflow(decodeURIComponent(match[1]), decodeURIComponent(match[2]))); return true;
    }

    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/pin$/);
    if (match && request.method === 'PUT') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await chats.pinMessage(decodeURIComponent(match[1]), decodeURIComponent(match[2]), body.pinned !== false));
      return true;
    }

    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/visibility$/);
    if (match && request.method === 'GET') {
      sendJson(response, 200, await access.visibility(decodeURIComponent(match[1]))); return true;
    }

    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/documents$/);
    if (match && request.method === 'GET') {
      const chatId = decodeURIComponent(match[1]);
      await chats.getChat(chatId);
      sendJson(response, 200, await documents?.listChat?.(chatId) || { documents:[] }); return true;
    }

    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/context\/preview$/);
    if (match && request.method === 'POST') {
      const chatId = decodeURIComponent(match[1]);
      const body = await readJsonBody(request);
      sendJson(response, 200, await flow.preview(chatId, body));
      return true;
    }

    match = url.pathname.match(/^\/api\/chats\/([^/]+)\/export$/);
    if (match && request.method === 'GET') {
      const result = await chats.exportChat(decodeURIComponent(match[1]), url.searchParams.get('format') || 'markdown');
      sendText(response, 200, result.body, result.contentType, { 'content-disposition': contentDisposition(result.filename) });
      return true;
    }

    match = url.pathname.match(/^\/api\/chats\/([^/]+)$/);
    if (!match) return false;
    const chatId = decodeURIComponent(match[1]);
    if (request.method === 'GET') { sendJson(response, 200, publicChat(await chats.getChat(chatId))); return true; }
    if (request.method === 'PATCH') { const body = await readJsonBody(request); sendJson(response, 200, await chats.renameChat(chatId, body.title)); return true; }
    if (request.method === 'DELETE') {
      await flow?.stop?.(chatId);
      const result = await chats.deleteChat(chatId);
      await snapshots?.cleanupChat?.(chatId);
      await documents?.detachChat?.(chatId);
      sendJson(response, 200, result); return true;
    }
    return false;
  };
}
