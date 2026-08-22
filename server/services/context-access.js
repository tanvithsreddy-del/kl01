import * as chats from './chats.js';
import { compose } from './prompts.js';

function baseSystemMessage() {
  const prompt = compose('chat-base');
  return { role:'system', content:prompt.system };
}
function eligible(message, excluded) {
  return ['user','assistant'].includes(message.role) && message.status !== 'failed' && message.status !== 'waiting-for-user' && !excluded.has(String(message.id));
}
function modelMessage(message) { return { role: message.role, content: message.content || '' }; }
function originalMessages(chat, excluded) { return (chat.messages || []).filter(message => eligible(message, excluded)).map(modelMessage); }

export function createContextAccessService({ snapshots }) {
  async function scopedConversation(chat, contextProfile = {}, excludeMessageIds = []) {
    const excluded = new Set((excludeMessageIds || []).map(String));
    const scope = String(contextProfile?.scope || 'compressed');
    if (scope === 'none') return { messages: [], snapshot: null, scope };
    if (scope === 'full-original') return { messages: originalMessages(chat, excluded), snapshot: null, scope };
    if (scope === 'pinned') return { messages: (chat.messages || []).filter(message => message.pinned && eligible(message, excluded)).map(modelMessage), snapshot: null, scope };
    if (scope === 'selected') {
      const selected = new Set((contextProfile?.selectedMessageIds || []).map(String));
      return { messages: (chat.messages || []).filter(message => selected.has(String(message.id)) && eligible(message, excluded)).map(modelMessage), snapshot: null, scope };
    }
    const packed = await snapshots.modelMessages(chat, { excludeMessageIds });
    if (scope === 'recent') {
      const count = Math.max(2, Math.min(100, Math.round(Number(contextProfile?.recentMessages || 12))));
      return { messages: packed.messages.slice(-count), snapshot: packed.snapshot, scope };
    }
    return { messages: packed.messages, snapshot: packed.snapshot, scope: 'compressed' };
  }

  async function assembleModelRequest(chatId, { pendingText = '', excludeMessageIds = [], systemMessages = [], contextProfile = null } = {}) {
    const chat = await chats.getChat(chatId);
    const scoped = await scopedConversation(chat, contextProfile || {}, excludeMessageIds);
    const extraSystem = Array.isArray(systemMessages)
      ? systemMessages.filter(message => message && message.role === 'system' && String(message.content || '').trim())
      : [];
    const messages = [
      baseSystemMessage(),
      ...extraSystem,
      ...scoped.messages,
      ...(pendingText ? [{ role: 'user', content: pendingText }] : []),
    ];
    return {
      chat,
      messages,
      snapshotId: scoped.snapshot?.id || null,
      contextScope: scoped.scope,
      includedConversationMessages: scoped.messages.length,
      systemPrefixCount: 1 + extraSystem.length,
    };
  }

  async function visibility(chatId, contextProfile = null) {
    const assembled = await assembleModelRequest(chatId, { contextProfile });
    const view = await snapshots.transcriptView(assembled.chat);
    return {
      chat: { id: assembled.chat.id, title: assembled.chat.title, projectId: assembled.chat.projectId || null },
      snapshot: view,
      contextScope: assembled.contextScope,
      conversation: assembled.messages.slice(assembled.systemPrefixCount).map(message => ({ role: message.role, content: message.content })),
    };
  }

  return { assembleModelRequest, visibility };
}
