// Choose a real chat from the latest server list.  The current route/state can
// legitimately point at a chat that was just deleted.
export function resolveActiveChatId({ requestedId = null, currentId = null, chats = [] } = {}) {
  const available = Array.isArray(chats) ? chats : [];
  const candidates = [requestedId, currentId, available[0]?.id];
  return candidates.find(candidate => candidate && available.some(chat => chat.id === candidate)) || null;
}
