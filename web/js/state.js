const listeners = new Set();
let runtimeSignature = 'null';
let value = { route: 'chat', product: { name:'KL01', stage:'Pre Beta', bugReportEmail:null }, machine: null, catalogue: [], quarantined: [], installed: [], downloads: {}, settings: null, preferences: null, runtime: null, chats: [], activeChat: null, context: null, drafts: {}, busy: false, error: null, pendingActivationId: null, activationError: null, openModelMenuOnChat: false, compressionState: null };
function notify() { for (const listener of listeners) listener(value); }
export const state = {
  get: () => value,
  set(patch) {
    if (Object.hasOwn(patch, 'runtime')) throw new Error('Runtime state must be written through state.setRuntime().');
    value = { ...value, ...patch }; notify(); return value;
  },
  setRuntime(runtime) {
    const signature = JSON.stringify(runtime ?? null);
    if (signature === runtimeSignature) return false;
    runtimeSignature = signature;
    value = { ...value, runtime: runtime ?? null };
    notify();
    return true;
  },
  update(fn) { const next = fn(value); if (next?.runtime !== value.runtime) throw new Error('Runtime state must be written through state.setRuntime().'); value = next; notify(); return value; },
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  draft(chatId) { if (Object.hasOwn(value.drafts, chatId)) return value.drafts[chatId]; return value.activeChat?.id === chatId ? value.activeChat?.draft?.text || '' : ''; },
  setDraft(chatId, text) { value = { ...value, drafts: { ...value.drafts, [chatId]: text } }; notify(); },
  hydrateDraft(chat) { if (!chat?.id) return; value = { ...value, drafts: { ...value.drafts, [chat.id]: chat.draft?.text || '' } }; notify(); },
  clearDraft(chatId) { const next = { ...value.drafts }; delete next[chatId]; value = { ...value, drafts: next }; notify(); },
};
