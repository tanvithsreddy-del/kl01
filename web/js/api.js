let localConnectionLost = false;
function connectionEvent(type, detail = {}) {
  try { globalThis.dispatchEvent?.(new CustomEvent(type, { detail })); } catch {}
}
function markConnectionLost(error) {
  if (!localConnectionLost) { localConnectionLost = true; connectionEvent('kl01:connection-lost', { message:error?.message || 'Local server unavailable.' }); }
}
function markConnectionRestored() {
  if (localConnectionLost) { localConnectionLost = false; connectionEvent('kl01:connection-restored'); }
}
const GET_RETRY_MS = [0, 120, 320, 750];
async function request(path, options = {}) {
  const { retryNetwork = false, ...fetchOptions } = options;
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  const retry = !fetchOptions.signal && (method === 'GET' || retryNetwork === true);
  const waits = retry ? GET_RETRY_MS : [0];
  let lastNetworkError = null;
  for (let attempt = 0; attempt < waits.length; attempt += 1) {
    if (waits[attempt]) await new Promise(resolve => setTimeout(resolve, waits[attempt]));
    try {
      const response = await fetch(path, { ...fetchOptions, headers: { ...(fetchOptions.body ? { 'content-type': 'application/json' } : {}), ...(fetchOptions.headers || {}) } });
      if (!response.ok) {
        markConnectionRestored();
        let body = {};
        try { body = await response.json(); } catch {}
        const error = new Error(body?.error?.message || 'KL01 could not finish this request. Try again.');
        error.payload = body?.error || {};
        error.status = response.status;
        throw error;
      }
      try {
        const body = response.status === 204 ? null : await response.json();
        markConnectionRestored();
        return body;
      } catch (error) {
        if (fetchOptions.signal?.aborted) throw error;
        lastNetworkError = error;
        markConnectionLost(error);
        if (!retry || attempt === waits.length - 1) throw error;
      }
    } catch (error) {
      if (error?.status) throw error;
      if (fetchOptions.signal?.aborted) throw error;
      lastNetworkError = error;
      markConnectionLost(error);
      if (!retry || attempt === waits.length - 1) throw error;
    }
  }
  throw lastNetworkError || new Error('The local server is unavailable.');
}

async function downloadRequest(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error('File export failed; try again.');
  return { blob: await response.blob(), filename: (response.headers.get('content-disposition') || '').match(/filename="?([^";]+)"?/)?.[1] || 'kl01-chat.txt' };
}
export const api = {
  health: () => request('/api/health'),
  machine: () => request('/api/machine'),
  models: () => request('/api/models'),
  installed: () => request('/api/models/installed'),
  runtime: () => request('/api/runtime'),
  modes: () => request('/api/modes'),
  modeEstimate: (modeId, settings = {}, workflow = null) => request('/api/modes/estimate', { method: 'POST', body: JSON.stringify({ modeId, settings, workflow }) }),
  workflowPreflight: value => request('/api/workflows/preflight', { method: 'POST', body: JSON.stringify(value || {}) }),
  recipes: () => request('/api/recipes'),
  createRecipe: value => request('/api/recipes', { method: 'POST', body: JSON.stringify(value) }),
  updateRecipe: (id, value) => request(`/api/recipes/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(value) }),
  deleteRecipe: id => request(`/api/recipes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  importRecipe: value => request('/api/recipes/import', { method: 'POST', body: JSON.stringify(value) }),
  runInput: (runId, value) => request(`/api/runs/${encodeURIComponent(runId)}/input`, { method: 'POST', body: JSON.stringify(value) }),
  preferences: () => request('/api/settings'),
  diagnostics: ({chatId=null,messageId=null,developerDetail=null}={}) => { const params=new URLSearchParams(); if(chatId)params.set('chatId',chatId); if(messageId)params.set('messageId',messageId); if(developerDetail!=null)params.set('developerDetail',String(Boolean(developerDetail))); const query=params.toString(); return request(`/api/diagnostics${query?`?${query}`:''}`); },
  savePreferences: value => request('/api/settings', { method: 'PUT', body: JSON.stringify(value) }),
  completeFirstLaunch: () => request('/api/settings', { method: 'PUT', body: JSON.stringify({ firstLaunchComplete: true }) }),
  activateModel: (id, chatId = null) => request(`/api/models/${encodeURIComponent(id)}/activate`, { method: 'POST', body: JSON.stringify(chatId ? { chatId } : {}) }),
  downloadModel: id => request(`/api/models/${encodeURIComponent(id)}/download`, { method: 'POST' }),
  pauseDownload: id => request(`/api/models/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
  resumeDownload: id => request(`/api/models/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  cancelDownload: id => request(`/api/models/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  removeModel: id => request(`/api/models/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  sideload: path => request('/api/models/sideload', { method: 'POST', body: JSON.stringify({ path }) }),
  chats: () => request('/api/chats'),
  chat: id => request(`/api/chats/${encodeURIComponent(id)}`),
  searchChats: q => request(`/api/chats/search?q=${encodeURIComponent(q)}`),
  createChat: title => request('/api/chats', { method: 'POST', body: JSON.stringify({ title }) }),
  archivedChats: () => request('/api/chats/archived'),
  pinChat: (id, pinned) => request(`/api/chats/${encodeURIComponent(id)}/pin`, { method: 'PUT', body: JSON.stringify({ pinned }) }),
  archiveChat: id => request(`/api/chats/${encodeURIComponent(id)}/archive`, { method: 'POST' }),
  restoreChat: id => request(`/api/chats/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  renameChat: (id, title) => request(`/api/chats/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteChat: id => request(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  chatExecutionProfile: id => request(`/api/chats/${encodeURIComponent(id)}/execution-profile`),
  saveChatExecutionProfile: (id, value) => request(`/api/chats/${encodeURIComponent(id)}/execution-profile`, { method: 'PUT', body: JSON.stringify(value || {}) }),
  clearNextRunExecutionProfile: id => request(`/api/chats/${encodeURIComponent(id)}/execution-profile`, { method: 'DELETE' }),
  draft: id => request(`/api/chats/${encodeURIComponent(id)}/draft`),
  saveDraft: (id, value) => request(`/api/chats/${encodeURIComponent(id)}/draft`, { method: 'PUT', body: JSON.stringify(value), retryNetwork: true }),
  previewContext: (id, value) => request(`/api/chats/${encodeURIComponent(id)}/context/preview`, { method: 'POST', body: JSON.stringify(value) }),
  branchChat: (id, messageId) => request(`/api/chats/${encodeURIComponent(id)}/branch`, { method: 'POST', body: JSON.stringify({ messageId }) }),
  editLastUser: (id, messageId) => request(`/api/chats/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/edit`, { method: 'POST' }),
  retryWorkflow: (id, messageId) => request(`/api/chats/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/retry-workflow`, { method: 'POST', body: '{}' }),
  pinMessage: (id, messageId, pinned) => request(`/api/chats/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/pin`, { method: 'PUT', body: JSON.stringify({ pinned }) }),
  exportChat: (id, format) => downloadRequest(`/api/chats/${encodeURIComponent(id)}/export?format=${encodeURIComponent(format)}`),
  context: id => request(`/api/chats/${encodeURIComponent(id)}/context`),
  visibility: id => request(`/api/chats/${encodeURIComponent(id)}/visibility`),
  compressionState: id => request(`/api/chats/${encodeURIComponent(id)}/compression`),
  compressionReview: id => request(`/api/chats/${encodeURIComponent(id)}/compression/review`, { method: 'POST' }),
  compressionCancelReview: (id, reviewId) => request(`/api/chats/${encodeURIComponent(id)}/compression/review/${encodeURIComponent(reviewId)}`, { method: 'DELETE' }),
  compressionPreview: (id, value) => request(`/api/chats/${encodeURIComponent(id)}/compression/preview`, { method: 'POST', body: JSON.stringify(value) }),
  compressionApply: (id, value) => request(`/api/chats/${encodeURIComponent(id)}/compression/apply`, { method: 'POST', body: JSON.stringify(value) }),
  compressionAuto: id => request(`/api/chats/${encodeURIComponent(id)}/compression/auto`, { method: 'POST' }),
  compressionUndo: id => request(`/api/chats/${encodeURIComponent(id)}/compression/undo`, { method: 'POST' }),
  stop: (id, runId = null, reason = 'user') => request(`/api/chats/${encodeURIComponent(id)}/stop`, { method: 'POST', body: JSON.stringify({ runId, reason }) }),
  activeRun: id => request(`/api/chats/${encodeURIComponent(id)}/run`),
  createMessageRun: (id, payload) => request(`/api/chats/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify(payload), retryNetwork: true }),
  runSnapshot: runId => request(`/api/runs/${encodeURIComponent(runId)}`),
  openRunEvents: (runId, after = 0) => fetch(`/api/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(after)}`, { headers: { accept: 'text/event-stream' } }),
  stopRun: (runId, reason = 'user') => request(`/api/runs/${encodeURIComponent(runId)}/stop`, { method:'POST', body:JSON.stringify({reason}) }),
  resumeRun: runId => request(`/api/runs/${encodeURIComponent(runId)}/resume`, { method:'POST', body:'{}' }),
  discardRun: runId => request(`/api/runs/${encodeURIComponent(runId)}/discard`, { method:'POST', body:'{}' }),
  repairAnchor: (id, messageId, path) => request(`/api/chats/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/repair/anchor`, { method: 'POST', body: JSON.stringify({ path }) }),
  repairPreview: (id, messageId, value) => request(`/api/chats/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/repair/preview`, { method: 'POST', body: JSON.stringify(value) }),
  repairDiscard: (id, messageId) => request(`/api/chats/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/repair/discard`, { method: 'POST' }),
  repairApply: (id, messageId) => request(`/api/chats/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/repair/apply`, { method: 'POST' }),
  repairUndo: (id, messageId) => request(`/api/chats/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/repair/undo`, { method: 'POST' }),
  repairHistory: (id, messageId) => request(`/api/chats/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/repair/history`),
  repairRestore: (id, messageId, revisionId) => request(`/api/chats/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/repair/restore`, { method: 'POST', body: JSON.stringify({ revisionId }) }),
  services: () => request('/api/services'),
  saveService: value => request('/api/services', { method: 'POST', body: JSON.stringify(value) }),
  activateService: (id, chatId = null) => request(`/api/services/${encodeURIComponent(id)}/activate`, { method: 'POST', body: JSON.stringify(chatId ? { chatId } : {}) }),
  removeService: id => request(`/api/services/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  stopRuntime: () => request('/api/runtime/stop', { method: 'POST' }),
  restartRuntime: () => request('/api/runtime/restart', { method: 'POST' }),
};
api.downloadStatus = id => request(`/api/models/${encodeURIComponent(id)}/download`);
api.openDownloadEvents = id => new EventSource(`/api/models/${encodeURIComponent(id)}/download/events`);
api.openRuntimeEvents = () => new EventSource('/api/runtime/events');
