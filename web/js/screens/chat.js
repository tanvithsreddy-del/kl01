import { api } from '../api.js';
import { resolveActiveChatId } from './chat-selection.js';
import { consumeWorkEvents, consumeRuntimeSource } from '../stream.js';
import { createWorkEventReconciler, mergeSourceWorkDelta } from '../work-events.js';
import { state } from '../state.js';
import { el, clear, cssTime } from '../components/dom.js';
import { sidebar } from '../components/sidebar.js';
import { messageView, updateMessageNode, releaseMessageViewState } from '../components/message.js';
import { composer } from '../components/composer.js';
import { modal, popover } from '../components/modal.js';
import { showOverlay, hideOverlay } from '../components/overlay.js';
import { faviconMotion } from '../favicon.js';
import { privacyIndicator } from '../components/privacy.js';
import { mainNavigation } from '../components/nav.js';
import { conditionError, clearCondition, clearConditions } from '../condition-error.js';
import { readTextAttachments } from '../attachments.js';
import { advancedPanel } from '../components/advanced-panel.js';
import { cloneResponseProfile, DEFAULT_RESPONSE_PROFILE, groundingWarning, reasoningPayload, responseProfileSummary } from '../response-profile.js';
import { downloadDiagnostic } from '../diagnostics.js';
import { betaBadge } from '../components/beta.js';

export const JUMP_DISTANCE = 48;
export function distanceFromBottom(node) { return Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight); }
export function shouldShowJump(node) { return Boolean(node && node.scrollHeight > node.clientHeight && distanceFromBottom(node) > JUMP_DISTANCE); }
export function statusChip(runtime) {
  if (runtime?.status === 'external-ready') return el('span', { class: 'status-chip external', title: `Requests leave this computer for ${runtime.service?.name || 'the selected service'}.`, 'aria-label': `External connection. Requests leave this computer for ${runtime.service?.name || 'the selected service'}.` }, el('span', { class: 'status-dot' }), el('span', { text: 'External' }), el('span', { class: 'muted', text: runtime.service?.name || '' }));
  if (runtime?.status === 'ready') return el('span', { class: 'status-chip', title: 'Local model. Web access is separate and only runs when explicitly used.', 'aria-label': 'Local model.' }, el('span', { class: 'status-dot' }), el('span', { text: 'Local' }));
  if (runtime?.status === 'selected-pending') return el('span', { class: 'status-chip', title: 'Local model selected. KL01 will load it when the next run needs it.', 'aria-label': 'Local model selected for the next run.' }, el('span', { class: 'status-dot' }), el('span', { text: 'Local · next run' }));
  return el('a', { class: 'status-chip status-chip-link', href: '#models', title: 'No model running.', 'aria-label': 'No model running.' }, el('span', { class: 'status-dot muted-dot' }), el('span', { text: 'No model' }));
}
const SUGGESTIONS = [
  'Write a leave application for two days',
  'Turn these Class 12 notes into a revision plan',
  'Draft a polite resignation email',
  'Summarise a ₹4.8 lakh fee breakdown',
];

export function createChatScreen({ onRoute, initialChatId = null }) {
  let root;
  let error = null;
  let dialog = null;
  let runtimeEventsCleanup = null;
  let activationStateCleanup = null;
  let activationStateSignature = '';
  let searchTimer = null;
  let sidebarPatchTimer = null;
  let draftTimer = null;
  let searchQuery = '';
  let searchResults = null;
  let detached = false;
  let firstLoad = true;
  let modelMenuOpen = Boolean(state.get().openModelMenuOnChat);
  let lineageOpen = false;
  let overlayTrigger = null;
  let focusModelMenuOnLoad = modelMenuOpen;
  if (modelMenuOpen) state.set({ openModelMenuOnChat: false });
  let contextPreviewTimer = null;
  const stageDeltaBuffers = new Map();
  const STAGE_RENDER_INTERVAL_MS = 250;

  function stageDeltaKey(runId, messageId, stageId) { return `${runId || ''}:${messageId || ''}:${stageId || ''}`; }
  function clearStageDeltaBuffer(key) {
    const pending = stageDeltaBuffers.get(key);
    if (pending?.timer) clearTimeout(pending.timer);
    stageDeltaBuffers.delete(key);
  }
  function clearStageDeltaRun(runId) {
    const prefix = `${runId || ''}:`;
    for (const [key, pending] of stageDeltaBuffers.entries()) {
      if (!key.startsWith(prefix)) continue;
      if (pending?.timer) clearTimeout(pending.timer);
      stageDeltaBuffers.delete(key);
    }
  }
  function flushStageDelta(key) {
    const pending = stageDeltaBuffers.get(key);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    stageDeltaBuffers.delete(key);
    const currentChat = state.get().activeChat;
    if (!currentChat || currentChat.id !== pending.chatId) return;
    const current = currentChat.messages.find(message => message.id === pending.messageId);
    if (!current?.workflow) return;
    const workflow = structuredClone(current.workflow);
    const stage = workflow.stages?.find(item => item.id === pending.stageId);
    if (!stage) return;
    stage.status = 'running';
    stage.content = `${stage.content || ''}${pending.delta}`;
    if (pending.outputTokens != null) {
      stage.outputTokens = Number(pending.outputTokens || 0);
      stage.outputTokensEstimated = Boolean(pending.outputTokensEstimated);
    }
    workflow.currentStageId = stage.id;
    workflow.status = 'running';
    updateOne(pending.chatId, { ...current, workflow, status:'streaming' });
  }
  function queueStageDelta({ chatId, runId, messageId, stageId, delta, outputTokens, outputTokensEstimated }) {
    const key = stageDeltaKey(runId, messageId, stageId);
    let pending = stageDeltaBuffers.get(key);
    if (!pending) {
      pending = { chatId, runId, messageId, stageId, delta:'', outputTokens:null, outputTokensEstimated:false, timer:null };
      stageDeltaBuffers.set(key, pending);
    }
    pending.delta += String(delta || '');
    if (outputTokens != null) {
      pending.outputTokens = Number(outputTokens || 0);
      pending.outputTokensEstimated = Boolean(outputTokensEstimated);
    }
    if (!pending.timer) pending.timer = setTimeout(() => flushStageDelta(key), STAGE_RENDER_INTERVAL_MS);
  }
  let transcriptMode = 'full';
  let compressionReview = null;
  let lastCompressionRecovery = null;
  let compressionBusy = false;
  let visibilityState = null;
  let chatMenu = null;
  let automaticCompressionNotice = false;
  const autoCompressionAttempted = new Set();
  const compressionSelections = new Map();
  const busyChats = new Set();
  const busyStartedAt = new Map();
  const activeRuns = new Map();
  const runStreams = new Map();
  const workEventReconciler = createWorkEventReconciler({ maxHz:4 });
  const stoppingChats = new Set();
  const deletingChats = new Set();
  const seenMessageIds = new Set();
  const scrollPositions = JSON.parse(localStorage.getItem('kl01-scroll-positions') || '{}');
  let repairEditor = null;
  let repairHistory = null;
  const repairBusyMessages = new Set();
  const pendingAttachments = new Map();
  const attachmentErrors = new Map();
  const pendingSendRetries = new Map();
  let advancedOpen = false;
  let mobileSidebarOpen = false;
  function profileForChat(chatId = state.get().activeChat?.id) {
    const chat = state.get().activeChat;
    if (!chatId || chat?.id !== chatId) return cloneResponseProfile(DEFAULT_RESPONSE_PROFILE);
    return cloneResponseProfile(chat.draft?.executionProfile || chat.executionProfile || DEFAULT_RESPONSE_PROFILE);
  }
  async function saveProfileForChat(chatId, profile) {
    if (!chatId) return null;
    const normalized = cloneResponseProfile(profile);
    const saved = await api.saveDraft(chatId, { executionProfile: normalized });
    const snapshot = state.get();
    if (snapshot.activeChat?.id === chatId) state.set({ activeChat: { ...snapshot.activeChat, draft: { ...(snapshot.activeChat.draft || {}), executionProfile: saved.executionProfile || normalized } } });
    return saved.executionProfile || normalized;
  }
  async function saveChatDefaultProfile(chatId, profile) {
    if (!chatId) return null;
    const result = await api.saveChatExecutionProfile(chatId, cloneResponseProfile(profile));
    const snapshot = state.get();
    if (snapshot.activeChat?.id === chatId) state.set({ activeChat: { ...snapshot.activeChat, executionProfile: result.executionProfile } });
    return result.executionProfile;
  }
  async function resetNextRunProfile(chatId) {
    if (!chatId) return null;
    const result = await api.clearNextRunExecutionProfile(chatId);
    const snapshot = state.get();
    if (snapshot.activeChat?.id === chatId) state.set({ activeChat: { ...snapshot.activeChat, draft: { ...(snapshot.activeChat.draft || {}), executionProfile: null } } });
    return result.chatExecutionProfile || snapshot.activeChat?.executionProfile || DEFAULT_RESPONSE_PROFILE;
  }
  async function migrateLegacyAdvancedProfiles(chatSummaries = []) {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem('kl01-advanced-profiles') || '{}'); } catch {}
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || !Object.keys(stored).length) return { migrated:0, deferred:0 };
    const known = new Set((chatSummaries || []).map(item => String(item?.id || '')).filter(Boolean));
    let migrated = 0; let deferred = 0;
    for (const [chatId, legacy] of Object.entries(stored)) {
      if (!known.has(chatId)) { delete stored[chatId]; continue; }
      try {
        await api.saveChatExecutionProfile(chatId, cloneResponseProfile(legacy));
        delete stored[chatId]; migrated += 1;
      } catch { deferred += 1; }
    }
    try {
      if (Object.keys(stored).length) localStorage.setItem('kl01-advanced-profiles', JSON.stringify(stored));
      else localStorage.removeItem('kl01-advanced-profiles');
    } catch {}
    return { migrated, deferred };
  }


  function scroller() { return root?.querySelector('.conversation') || null; }
  function isReady(runtime) { return Boolean(runtime && ['ready', 'external-ready', 'selected-pending'].includes(runtime.status)); }
  function effectiveRuntime(snapshot = state.get()) {
    const runtime = snapshot.runtime || { status: 'stopped' };
    const pendingId = snapshot.pendingActivationId;
    if (!pendingId) return runtime;
    if (runtime.status === 'ready' && runtime.modelId === pendingId) return runtime;
    if (runtime.status === 'external-ready' && runtime.service?.id === pendingId) return runtime;
    if (runtime.status === 'selected-pending' && runtime.selectedTarget?.id === pendingId) return runtime;
    if (snapshot.activationError || runtime.status === 'failed') {
      return { ...runtime, status: 'failed', modelId: pendingId, failure: snapshot.activationError || runtime.failure || { message: 'The selected AI could not start; select Try again.' } };
    }
    return { ...runtime, status: 'starting', modelId: pendingId, failure: null };
  }
  function preferences() { return state.get().preferences?.chat || {}; }
  function attachmentsFor(chatId = state.get().activeChat?.id) {
    return chatId ? [...(pendingAttachments.get(chatId) || [])] : [];
  }
  function activeLocalModel(snapshot = state.get()) {
    const runtime = effectiveRuntime(snapshot);
    if (!['ready','selected-pending'].includes(runtime?.status)) return null;
    return (snapshot.installed || []).find(model => model.id === runtime.modelId) || null;
  }
  function acceptedFileTypes(snapshot = state.get()) {
    return [...(activeLocalModel(snapshot)?.capabilities?.fileTypes || [])];
  }
  function reasoningSupported(snapshot = state.get()) {
    return Boolean(activeLocalModel(snapshot)?.reasoningControl?.enabled);
  }
  function currentExecutionProfile(snapshot = state.get()) {
    return profileForChat(snapshot.activeChat?.id);
  }
  function setAdvanced(open, trigger = null) {
    advancedOpen = Boolean(open);
    if (advancedOpen) {
      modelMenuOpen = false;
      lineageOpen = false;
      chatMenu = null;
      dialog = null;
      overlayTrigger = trigger || overlayTrigger || document.activeElement;
    }
    render();
  }
  function advancedInstrument(snapshot = state.get()) {
    const profile = currentExecutionProfile(snapshot);
    const summary = responseProfileSummary(profile, { reasoningSupported: reasoningSupported(snapshot) });
    return el('button', {
      class: `advanced-trigger ${summary === 'Thorough' ? '' : 'active'}`.trim(),
      type: 'button',
      'aria-haspopup': 'dialog',
      'aria-expanded': String(advancedOpen),
      onClick: event => setAdvanced(!advancedOpen, event.currentTarget),
    }, el('span', { text: 'Effort' }), el('span', { class: 'advanced-trigger-summary', text: summary }));
  }
  function quickExecutionControls(snapshot = state.get()) {
    const chat = snapshot.activeChat;
    const current = cloneResponseProfile(currentExecutionProfile(snapshot));
    const effort = el('select', { class:'quick-execution-select', 'aria-label':'Thinking effort' },
      el('option', { value:'0', text:'Instant' }),
      el('option', { value:'1', text:'Quick' }),
      el('option', { value:'2', text:'Thorough' }),
      el('option', { value:'3', text:'Deep' }));
    effort.value = String(current.effort);
    const web = el('select', { class:'quick-execution-select', 'aria-label':'Web search' },
      el('option', { value:'off', text:'Web: Off' }),
      el('option', { value:'auto', text:'Web: Auto' }),
      el('option', { value:'force', text:'Web: On' }));
    web.value = current.research.mode;
    const apply = async () => {
      if (!chat?.id) return;
      const next = cloneResponseProfile(currentExecutionProfile(state.get()));
      next.effort = Math.max(0, Math.min(3, Number(effort.value) || 0));
      next.response.thinking = ['off','quick','standard','deep'][next.effort];
      next.research.mode = web.value;
      await saveProfileForChat(chat.id, next);
      refreshContextPreview().catch(() => {});
      render();
    };
    effort.addEventListener('change', () => { apply().catch(() => {}); });
    web.addEventListener('change', () => { apply().catch(() => {}); });
    return el('div', { class:'quick-execution-controls', 'aria-label':'Response controls' }, effort, web);
  }
  function composerInstruments(snapshot = state.get()) {
    return [modelChip(effectiveRuntime(snapshot)), quickExecutionControls(snapshot), privacyIndicator(snapshot, { compact: true })].filter(Boolean);
  }
  function attachmentMetadata(items = []) {
    return items.map(item => ({
      id: item.id || item.clientId,
      name: item.name,
      extension: item.extension,
      type: item.type,
      size: item.size,
      kind: item.kind || 'text',
    }));
  }
  async function chooseAttachments(files) {
    const chat = state.get().activeChat;
    if (!chat) return;
    try {
      const existing = attachmentsFor(chat.id);
      const added = await readTextAttachments(files, acceptedFileTypes());
      const combined = [...existing, ...added];
      if (combined.length > 4) throw new Error('Attach no more than 4 files to one message.');
      const total = combined.reduce((sum, item) => sum + Number(item.size || 0), 0);
      if (total > 2 * 1024 * 1024) throw new Error('The attached files are too large together; keep the total under 2 MB.');
      pendingAttachments.set(chat.id, combined);
      attachmentErrors.delete(chat.id);
      const dock = root?.querySelector('.composer-dock');
      dock?.setAttachments?.(combined, null);
      await refreshContextPreview(null, combined);
    } catch (caught) {
      attachmentErrors.set(chat.id, caught);
      root?.querySelector('.composer-dock')?.setAttachments?.(attachmentsFor(chat.id), caught);
    }
  }
  function removeAttachment(attachmentId) {
    const chat = state.get().activeChat;
    if (!chat) return;
    const next = attachmentsFor(chat.id).filter(item => (item.id || item.clientId) !== attachmentId);
    pendingAttachments.set(chat.id, next);
    attachmentErrors.delete(chat.id);
    root?.querySelector('.composer-dock')?.setAttachments?.(next, null);
    refreshContextPreview(null, next).catch(() => {});
  }
  function saveScroll(chatId, top) {
    if (!chatId || preferences().rememberScroll === false) return;
    scrollPositions[chatId] = top;
    localStorage.setItem('kl01-scroll-positions', JSON.stringify(scrollPositions));
  }
  function syncJump() {
    const node = scroller();
    const button = root?.querySelector('.jump-latest');
    detached = Boolean(node && shouldShowJump(node));
    if (button) button.hidden = !detached;
  }
  function bindScroll() {
    const node = scroller();
    if (!node || node.dataset.bound === 'true') return;
    node.dataset.bound = 'true';
    node.addEventListener('scroll', () => {
      const chatId = state.get().activeChat?.id;
      saveScroll(chatId, node.scrollTop);
      syncJump();
    }, { passive: true });
  }
  function jumpLatest() {
    const node = scroller();
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    saveScroll(state.get().activeChat?.id, node.scrollTop);
    syncJump();
  }
  function settleScroll(chatId, restoreSaved = false, focusComposer = false, defaultToLatest = false) {
    requestAnimationFrame(() => {
      bindScroll();
      const node = scroller();
      if (node && preferences().rememberScroll !== false) {
        const saved = Number(scrollPositions[chatId]);
        if (restoreSaved && Number.isFinite(saved)) node.scrollTop = saved;
        else if (defaultToLatest && !Number.isFinite(saved)) node.scrollTop = node.scrollHeight;
      }
      syncJump();
      if (focusComposer) {
        const input = root?.querySelector('.composer-text:not(:disabled)');
        try { input?.focus({ preventScroll: true }); } catch { input?.focus(); }
      }
    });
  }

  function currentComposerDraft(chatId = state.get().activeChat?.id) {
    if (!chatId) return '';
    const dock = root?.querySelector('.composer-dock');
    return typeof dock?.getDraft === 'function' ? dock.getDraft() : state.draft(chatId);
  }

  function scheduleDraftSave() {
    clearTimeout(draftTimer);
    clearTimeout(contextPreviewTimer);
    draftTimer = setTimeout(() => flushDraft().catch(() => {}), cssTime('--kl01-draft-debounce'));
    contextPreviewTimer = setTimeout(() => refreshContextPreview().catch(() => {}), cssTime('--kl01-draft-debounce'));
  }

  async function persistDraftText(text) {
    const chat = state.get().activeChat;
    if (!chat) return;
    state.setDraft(chat.id, text);
    await api.saveDraft(chat.id, { text });
  }

  async function refreshContextPreview(textOverride = null, attachmentsOverride = null) {
    const chat = state.get().activeChat;
    const runtime = effectiveRuntime(state.get());
    if (!chat || !isReady(runtime)) return null;
    const text = textOverride === null ? currentComposerDraft(chat.id) : String(textOverride);
    const files = attachmentsOverride === null ? attachmentsFor(chat.id) : [...(attachmentsOverride || [])];
    if (!text.trim() && files.length === 0) {
      const context = await api.context(chat.id).catch(() => state.get().context);
      state.set({ context });
      return context;
    }
    try {
      const context = await api.previewContext(chat.id, { text, attachments: files, profile: currentExecutionProfile(state.get()) });
      error = null;
      state.set({ context });
      return context;
    } catch (caught) {
      error = conditionError('context-preview', 'Conversation length could not be updated.');
      if (caught.payload?.usage) { state.set({ context: caught.payload.usage }); return caught.payload.usage; }
      root?.querySelector('.composer-dock')?.setError?.(error);
      return state.get().context;
    }
  }

  async function flushDraft() {
    clearTimeout(draftTimer); draftTimer = null;
    const chat = state.get().activeChat;
    if (!chat) return;
    const text = currentComposerDraft(chat.id);
    state.setDraft(chat.id, text);
    await api.saveDraft(chat.id, { text });
  }
  async function flushDraftBeforeLeaving() {
    try {
      await flushDraft();
      error = clearCondition(error, 'draft-save');
      return true;
    } catch (caught) {
      error = conditionError('draft-save', caught?.message || 'Draft could not be saved. Staying in this chat so your text is not lost.');
      render();
      return false;
    }
  }
  async function routeAfterDraft(route, id = null) {
    if (!(await flushDraftBeforeLeaving())) return false;
    onRoute(route, id);
    return true;
  }
  async function performSelect(id) {
    if (!(await flushDraftBeforeLeaving())) return;
    searchQuery = ''; searchResults = null;
    transcriptMode = 'full'; compressionReview = null; compressionSelections.clear();
    history.replaceState(null, '', `#chat/${encodeURIComponent(id)}`);
    await load(id, { restoreScroll: preferences().rememberScroll !== false });
  }
  async function performCreate(trigger = null) {
    if (!(await flushDraftBeforeLeaving())) return;
    const chat = await api.createChat('New chat');
    state.setDraft(chat.id, '');
    searchQuery = ''; searchResults = null;
    transcriptMode = 'full'; compressionReview = null; compressionSelections.clear();
    history.replaceState(null, '', `#chat/${encodeURIComponent(chat.id)}`);
    await load(chat.id, { focusComposer: true });
  }
  async function select(id) { return performSelect(id); }
  async function create(trigger = null) { return performCreate(trigger); }
  async function rename(chat, title) {
    if (!title.trim()) return;
    try {
      await api.renameChat(chat.id, title.trim());
      dialog = null;
      error = clearCondition(error, 'chat-rename');
      await load(chat.id, { preservePosition: true });
      await refreshSearchResults();
    } catch (caught) {
      error = conditionError('chat-rename', caught?.message || 'Chat was not renamed.');
      render();
    }
  }
  async function remove(chat) {
    if (deletingChats.has(chat.id)) return;
    deletingChats.add(chat.id);
    try {
      await api.deleteChat(chat.id);
      state.clearDraft(chat.id);
      delete scrollPositions[chat.id];
      localStorage.setItem('kl01-scroll-positions', JSON.stringify(scrollPositions));
      dialog = null;
      error = clearCondition(error, 'chat-delete');
      const remaining = state.get().chats.filter(item => item.id !== chat.id);
      await load(remaining[0]?.id || null);
      await refreshSearchResults();
    } catch (caught) {
      error = conditionError('chat-delete', caught?.message || 'Chat was not deleted.');
      render();
    } finally { deletingChats.delete(chat.id); }
  }
  async function setChatPinned(chat) {
    try {
      chatMenu = null;
      await api.pinChat(chat.id, !chat.pinned);
      await load(state.get().activeChat?.id || chat.id, { preservePosition: true });
      await refreshSearchResults();
    } catch { error = conditionError('chat-pin-write', 'Chat pin change failed.'); render(); }
  }

  async function archive(chat) {
    try {
      const activeId = state.get().activeChat?.id || null;
      const wasActive = activeId === chat.id;
      chatMenu = null;
      if (wasActive && !(await flushDraftBeforeLeaving())) return;
      await api.archiveChat(chat.id);
      const remaining = state.get().chats.filter(item => item.id !== chat.id);
      const nextId = wasActive ? (remaining[0]?.id || null) : (activeId || remaining[0]?.id || null);
      await load(nextId, { restoreScroll: !wasActive && preferences().rememberScroll !== false });
      await refreshSearchResults();
    } catch { error = conditionError('chat-archive', 'Chat was not archived.'); render(); }
  }

  async function branch(message) {
    const chat = state.get().activeChat;
    if (!chat) return;
    if (!(await flushDraftBeforeLeaving())) return;
    const created = await api.branchChat(chat.id, message.id);
    await select(created.id);
  }
  async function editFromHere(message) {
    const chat = state.get().activeChat;
    if (!chat || message.role !== 'user') return;
    try {
      if (!(await flushDraftBeforeLeaving())) return;
      const created = await api.branchChat(chat.id, message.id);
      const branched = await api.chat(created.id);
      const copiedUser = [...(branched.messages || [])].reverse().find(item => item.role === 'user');
      if (!copiedUser) throw new Error('The branched message could not be restored.');
      await api.editLastUser(created.id, copiedUser.id);
      mobileSidebarOpen = false;
      history.replaceState(null, '', `#chat/${encodeURIComponent(created.id)}`);
      await load(created.id, { focusComposer: true });
    } catch (caught) {
      error = conditionError('message-edit-from-here', caught?.message || 'This message could not be edited from here.');
      render();
    }
  }
  async function edit(message) {
    const chat = state.get().activeChat;
    if (!chat) return;
    try {
      const result = await api.editLastUser(chat.id, message.id);
      const draft = result?.draft || {};
      if (draft.executionProfile) await saveProfileForChat(chat.id, draft.executionProfile);
      pendingAttachments.set(chat.id, Array.isArray(draft.attachmentContents) ? draft.attachmentContents : []);
      if (Array.isArray(draft.warnings) && draft.warnings.length) attachmentErrors.set(chat.id, new Error(draft.warnings.join(' ')));
      else attachmentErrors.delete(chat.id);
      state.setDraft(chat.id, String(draft.text || ''));
      error = clearCondition(error, 'message-edit');
      await load(chat.id, { preservePosition: true, focusComposer: true });
    } catch (caught) {
      error = conditionError('message-edit', caught?.message || 'This message could not be edited.');
      render();
    }
  }

  async function pin(message) {
    const chat = state.get().activeChat;
    if (!chat) return;
    try { await api.pinMessage(chat.id, message.id, !message.pinned); await load(chat.id, { preservePosition: true }); }
    catch { error = conditionError('pin-write', 'Pin change failed.'); render(); }
  }

  async function openCompression(trigger = null) {
    const chat = state.get().activeChat;
    if (!chat || compressionBusy) return;
    overlayTrigger = trigger || document.activeElement; modelMenuOpen = false; lineageOpen = false;
    compressionBusy = true; error = null; lastCompressionRecovery = null; render();
    try {
      compressionReview = await api.compressionReview(chat.id);
      compressionSelections.clear();
      for (const range of compressionReview.ranges) compressionSelections.set(range.rangeId, { operation: range.defaultOperation || 'keep', unlockedProtected: false });
      dialog = { type: 'compression' };
    } catch { error = conditionError('compression-review', 'Compression review did not load.'); }
    finally { compressionBusy = false; render(); }
  }

  async function previewCompression(rangeId) {
    const chat = state.get().activeChat;
    const selection = compressionSelections.get(rangeId);
    if (!chat || !compressionReview || !selection || compressionBusy) return;
    compressionBusy = true; render();
    try {
      const updated = await api.compressionPreview(chat.id, { reviewId: compressionReview.reviewId, rangeId, unlockProtected: Boolean(selection.unlockedProtected) });
      compressionReview = { ...compressionReview, ranges: compressionReview.ranges.map(range => range.rangeId === rangeId ? updated : range) };
      if (updated.tooLarge) {
        compressionSelections.set(rangeId, { ...selection, operation: 'keep' });
        error = conditionError('compression-summary-size', 'This turn cannot be summarised in one pass.');
      } else error = null;
    } catch { error = conditionError('compression-summary-preview', 'Summary preview failed.'); compressionSelections.set(rangeId, { ...selection, operation: 'keep' }); }
    finally { compressionBusy = false; render(); }
  }

  function setCompressionOperation(range, operation) {
    const selection = compressionSelections.get(range.rangeId) || { operation: 'keep', unlockedProtected: false };
    if (range.protected && !selection.unlockedProtected && operation !== 'keep') return;
    compressionSelections.set(range.rangeId, { ...selection, operation });
    if (operation === 'summarise' && !range.summary) { previewCompression(range.rangeId); return; }
    render();
  }

  function unlockCompressionRange(range) {
    const selection = compressionSelections.get(range.rangeId) || { operation: 'keep', unlockedProtected: false };
    compressionSelections.set(range.rangeId, { ...selection, unlockedProtected: !selection.unlockedProtected, operation: !selection.unlockedProtected ? selection.operation : 'keep' });
    render();
  }

  async function applyCompression() {
    const chat = state.get().activeChat;
    if (!chat || !compressionReview || compressionBusy) return;
    compressionBusy = true; render();
    try {
      const operations = compressionReview.ranges.map(range => ({ rangeId: range.rangeId, ...(compressionSelections.get(range.rangeId) || { operation: 'keep', unlockedProtected: false }) }));
      const result = await api.compressionApply(chat.id, { reviewId: compressionReview.reviewId, operations, mode: 'manual' });
      state.set({ compressionState: { activeSnapshotId: result.snapshot.id, active: result.snapshot, lineage: result.lineage, view: result.view } });
      compressionReview = null; compressionSelections.clear(); dialog = null; transcriptMode = 'active'; error = null;
      await load(chat.id, { preservePosition: true });
    } catch { error = conditionError('compression-apply', 'Chat was not shortened.'); render(); }
    finally { compressionBusy = false; }
  }

  async function undoCompression() {
    const chat = state.get().activeChat;
    if (!chat || compressionBusy) return;
    compressionBusy = true; render();
    try { await api.compressionUndo(chat.id); transcriptMode = 'active'; automaticCompressionNotice = false; await load(chat.id, { preservePosition: true }); }
    catch { error = conditionError('compression-undo', 'Compression undo failed.'); render(); }
    finally { compressionBusy = false; }
  }

  async function showVisibility(trigger = null) {
    const chat = state.get().activeChat;
    if (!chat) return;
    overlayTrigger = trigger || document.activeElement; modelMenuOpen = false; lineageOpen = false;
    try { visibilityState = await api.visibility(chat.id); dialog = { type: 'visibility' }; error = null; render(); }
    catch { error = conditionError('visibility-load', 'Visibility details did not load.'); render(); }
  }

  async function exportFile(chat, format) {
    const result = await api.exportChat(chat.id, format);
    const url = URL.createObjectURL(result.blob);
    const link = el('a', { href: url, download: result.filename });
    document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url); dialog = null; render();
  }

  function openChatMenu(item, trigger) {
    chatMenu = { chat: item, trigger: trigger || document.activeElement };
    overlayTrigger = chatMenu.trigger;
    modelMenuOpen = false; lineageOpen = false; dialog = null;
    render();
  }

  function openChatDialog(type, item, trigger = null) {
    chatMenu = null;
    overlayTrigger = trigger || overlayTrigger || document.activeElement;
    modelMenuOpen = false; lineageOpen = false;
    dialog = { type, chat: item };
    render();
  }

  function sidebarProps(snapshot = state.get()) {
    const chat = snapshot.activeChat;
    return {
      chats: snapshot.chats, results: searchResults, query: searchQuery, activeId: chat?.id, menuChatId: chatMenu?.chat?.id || null, mobileOpen: mobileSidebarOpen,
      onSelect: async (...args) => { mobileSidebarOpen = false; return select(...args); },
      onNew: async (...args) => { mobileSidebarOpen = false; return create(...args); },
      onMenu: openChatMenu, onSearch: search, onClose: () => { mobileSidebarOpen = false; render(); },
    };
  }

  function chatMenuOverlay() {
    if (!chatMenu?.chat) return null;
    const item = chatMenu.chat;
    const liveTrigger = root?.querySelector(`[data-chat-id="${CSS.escape(item.id)}"] .chat-menu-trigger`) || chatMenu.trigger;
    chatMenu.trigger = liveTrigger;
    overlayTrigger = liveTrigger;
    const close = () => { chatMenu = null; render(); };
    const action = (label, run, extraClass = '') => el('button', { class: `chat-menu-item ${extraClass}`.trim(), role: 'menuitem', type: 'button', onClick: run, text: label });
    const accent = ['pink','yellow','green','blue','violet'].includes(item.accent) ? item.accent : 'violet';
    const menu = el('div', { class: `chat-action-menu accent-${accent}`, 'data-accent': accent, role: 'menu', 'aria-label': `Options for ${item.title}` },
      action(item.pinned ? 'Unpin' : 'Pin', () => setChatPinned(item)),
      action('Rename', () => openChatDialog('rename', item, liveTrigger)),
      action('Archive', () => archive(item)),
      action('Export', () => openChatDialog('export', item, liveTrigger)),
      el('div', { class: 'chat-menu-divider', role: 'separator' }),
      action('Delete', () => openChatDialog('delete', item, liveTrigger), 'danger'));
    return popover({ content: menu, label: `Options for ${item.title}`, trigger: liveTrigger, onClose: close });
  }

  function preserveSidebarIndicator() {}

  function patchSidebar() {
    const current = root?.querySelector('.sidebar');
    if (!current) return;
    clearTimeout(sidebarPatchTimer); sidebarPatchTimer = null;
    const replacement = sidebar(sidebarProps());
    const input = current.querySelector('.chat-search input');
    const selectionStart = input?.selectionStart ?? searchQuery.length;
    const wasFocused = input === document.activeElement;
    current.replaceWith(replacement);
    const next = replacement.querySelector('.chat-search input');
    if (wasFocused && next) {
      try { next.focus({ preventScroll: true }); } catch { next.focus(); }
      next.setSelectionRange(selectionStart, selectionStart);
    }
  }

  async function refreshSearchResults() {
    const requested = searchQuery.normalize('NFC').trim();
    if (!requested) { searchResults = null; patchSidebar(); return; }
    try {
      const result = await api.searchChats(requested);
      if (searchQuery.normalize('NFC').trim() !== requested) return;
      searchResults = result.results || result;
    } catch {
      if (searchQuery.normalize('NFC').trim() !== requested) return;
      searchResults = [];
    }
    patchSidebar();
  }

  function search(value) {
    searchQuery = value;
    clearTimeout(searchTimer);
    if (!value.trim()) { searchResults = null; patchSidebar(); return; }
    searchTimer = setTimeout(() => refreshSearchResults().catch(() => {}), cssTime('--kl01-search-debounce'));
  }

  function stopRuntimeEvents() { if (runtimeEventsCleanup) runtimeEventsCleanup(); runtimeEventsCleanup = null; }

  function startActivationStateWatch() {
    if (activationStateCleanup) return;
    const signature = snapshot => JSON.stringify([snapshot.pendingActivationId || null, snapshot.activationError || null]);
    activationStateSignature = signature(state.get());
    activationStateCleanup = state.subscribe(snapshot => {
      const next = signature(snapshot);
      if (next === activationStateSignature) return;
      activationStateSignature = next;
      if (root) syncRuntimeParts();
    });
  }

  function startRuntimeEvents() {
    if (runtimeEventsCleanup || !root) return;
    try {
      const source = api.openRuntimeEvents();
      runtimeEventsCleanup = consumeRuntimeSource(source, runtime => {
        const changed = state.setRuntime(runtime);
        if (!root) return;
        const pendingId = state.get().pendingActivationId;
        const activationMatches = pendingId && ((runtime.status === 'ready' && runtime.modelId === pendingId) || (runtime.status === 'external-ready' && runtime.service?.id === pendingId) || (runtime.status === 'selected-pending' && runtime.selectedTarget?.id === pendingId));
        if (activationMatches) {
          state.set({ pendingActivationId: null, activationError: null });
          error = clearCondition(error, 'runtime-model-ready');
        } else if (pendingId && runtime.status === 'failed') {
          const runtimeError = conditionError('runtime-model-ready', 'Model did not start.', runtime.failure || {});
          state.set({ activationError: runtimeError });
          error = runtimeError;
        }
        if (changed || activationMatches || runtime.status === 'failed') syncRuntimeParts();
        if (activationMatches) requestAnimationFrame(() => { const input = root?.querySelector('.composer-text:not(:disabled)'); try { input?.focus({ preventScroll: true }); } catch { input?.focus(); } });
      }, status => { if (status?.state === 'reconnecting') api.health().catch(() => {}); });
    } catch {}
  }

  async function load(id = initialChatId, { focusComposer = false, preservePosition = false, restoreScroll = false } = {}) {
    let chats, runtime, serviceState, preferenceState, installedState;
    try {
      [{ chats }, runtime, serviceState, preferenceState, installedState] = await Promise.all([api.chats(), api.runtime(), api.services(), api.preferences(), api.installed()]);
      await migrateLegacyAdvancedProfiles(chats);
      error = clearCondition(error, 'chat-bootstrap');
    } catch {
      error = conditionError('chat-bootstrap', 'Chat list did not load.');
      render();
      return;
    }

    let active = resolveActiveChatId({ requestedId: id, currentId: state.get().activeChat?.id, chats });
    if (!active) {
      try { const created = await api.createChat('New chat'); active = created.id; chats.unshift(created); }
      catch { error = conditionError('chat-create', 'New chat was not created.'); render(); return; }
    }

    document.documentElement.dataset.textSize = preferenceState.appearance.textSize;
    state.setRuntime(runtime);
    let chat;
    try {
      const [publicChat, fullDraft] = await Promise.all([api.chat(active), api.draft(active)]);
      chat = { ...publicChat, draft: { ...(publicChat.draft || {}), ...(fullDraft || {}) } };
      if (Array.isArray(fullDraft?.attachmentContents)) pendingAttachments.set(active, fullDraft.attachmentContents);
      else if (!pendingAttachments.has(active)) pendingAttachments.set(active, []);
      if (fullDraft?.executionProfile) await saveProfileForChat(active, fullDraft.executionProfile);
      if (Array.isArray(fullDraft?.warnings) && fullDraft.warnings.length) attachmentErrors.set(active, new Error(fullDraft.warnings.join(' ')));
      error = clearCondition(error, 'chat-load');
    } catch {
      error = conditionError('chat-load', 'Chat did not load.', { chatId: active, retry: true });
      state.set({ chats, installed: installedState.models, services: serviceState.services || [], settings: installedState.settings, preferences: preferenceState });
      render();
      startRuntimeEvents();
      return;
    }

    const loadRuntime = state.get().pendingActivationId && !isReady(runtime) ? { ...runtime, status: 'starting', modelId: state.get().pendingActivationId } : runtime;
    let context = isReady(loadRuntime) ? await api.context(active).catch(() => null) : null;
    if (context?.state === 'full' && preferenceState.conversation?.whenFull === 'auto' && !autoCompressionAttempted.has(active)) {
      autoCompressionAttempted.add(active);
      try {
        await api.compressionAuto(active);
        context = await api.context(active).catch(() => context);
        automaticCompressionNotice = true;
        transcriptMode = 'active';
        error = clearCondition(error, 'compression-auto');
      } catch (caught) {
        if (caught.payload?.code && caught.payload.code !== 'COMPRESSION_NO_SAFE_RANGE') error = conditionError('compression-auto', 'Automatic compression failed.');
      }
    }
    const compressionState = await api.compressionState(active).catch(() => ({ activeSnapshotId: null, active: null, lineage: [], view: { activeSnapshotId: null, mode: 'full', items: [] } }));
    if (repairEditor && !(chat.messages || []).some(message => message.id === repairEditor.messageId)) repairEditor = null;
    if (repairHistory && !(chat.messages || []).some(message => message.id === repairHistory.messageId)) repairHistory = null;
    const activationReady = Boolean(state.get().pendingActivationId && isReady(runtime));
    if (activationReady) error = clearCondition(error, 'runtime-model-ready');
    error = clearConditions(error, ['chat-load', 'chat-bootstrap', 'chat-create']);
    state.set({ chats, activeChat: chat, context, installed: installedState.models, services: serviceState.services || [], activeService: runtime.status === 'external-ready' ? runtime.service : null, settings: installedState.settings, preferences: preferenceState, compressionState, ...(activationReady ? { pendingActivationId: null, activationError: null } : {}) });
    state.hydrateDraft(chat);
    const authoritativeRun = await api.activeRun(active).catch(() => ({ run:null }));
    if (authoritativeRun?.run && !['completed','cancelled','failed'].includes(authoritativeRun.run.state)) {
      const recoveredRun=authoritativeRun.run;
      const recoveredMessage=(chat.messages||[]).find(message=>message.role==='assistant'&&message.runId===recoveredRun.runId)||null;
      const plainInterrupted=recoveredRun.state==='interrupted-resumable'&&recoveredMessage&&!recoveredMessage.workflow&&recoveredMessage.work?.kind!=='research';
      if(plainInterrupted){
        try{
          await api.resumeRun(recoveredRun.runId);
          const refreshed=await api.chat(active);chat={...refreshed,draft:chat.draft};state.set({activeChat:chat});
          error=clearCondition(error,'run-auto-resume');
        }catch(caught){
          await api.discardRun(recoveredRun.runId).catch(()=>{});
          const refreshed=await api.chat(active).catch(()=>null);if(refreshed){chat={...refreshed,draft:chat.draft};state.set({activeChat:chat});}
          error=conditionError('run-auto-resume',caught?.message||'The interrupted response could not be reconstructed safely. Its partial output was preserved; send the message again.');
        }
      }
      const latestRun=await api.activeRun(active).catch(()=>({run:null}));
      if(latestRun?.run&&!['completed','cancelled','failed'].includes(latestRun.run.state)){
        activeRuns.set(active, latestRun.run.runId); busyChats.add(active); if (!busyStartedAt.has(active)) busyStartedAt.set(active, Number(latestRun.run.startedAt || Date.now()));
        attachRunEvents(active, latestRun.run.runId, { startAfter:0 }).catch(() => {});
      }else if(plainInterrupted){
        const refreshed=await api.chat(active).catch(()=>null);if(refreshed){chat={...refreshed,draft:chat.draft};state.set({activeChat:chat});}
      }
    }
    const defaultToLatest = firstLoad && (chat.messages || []).length > 0;
    if (firstLoad) { for (const message of chat.messages) seenMessageIds.add(message.id); firstLoad = false; }
    render();
    if (focusModelMenuOnLoad) { requestAnimationFrame(() => document.querySelector('#kl01-overlay-root .model-menu [role="menuitem"]')?.focus()); focusModelMenuOnLoad = false; }
    else if (!isReady(loadRuntime) && loadRuntime.status !== 'starting' && installedState.models.length === 0) requestAnimationFrame(() => root?.querySelector('.empty-center button')?.focus());
    settleScroll(active, restoreScroll || preservePosition, focusComposer || activationReady || (chat.messages.length === 0 && isReady(loadRuntime)), defaultToLatest);
    startRuntimeEvents();
  }

  function repairFailure(caught, fallback = 'Section repair failed.') {
    error = conditionError('section-repair', caught?.message || fallback);
    render();
  }

  async function selectRepair(message, path) {
    const chat = state.get().activeChat;
    if (!chat || repairBusyMessages.has(message.id)) return;
    repairBusyMessages.add(message.id); render();
    try {
      const anchor = await api.repairAnchor(chat.id, message.id, path);
      repairEditor = { messageId: message.id, anchor: anchor.anchor || anchor };
      repairHistory = null;
      error = clearCondition(error, 'section-repair');
      render();
    } catch (caught) { repairFailure(caught, 'This section cannot be repaired.'); }
    finally { repairBusyMessages.delete(message.id); render(); }
  }

  async function previewRepair(message, anchor, operation, extra = {}) {
    const chat = state.get().activeChat;
    if (!chat || !anchor || repairBusyMessages.has(message.id)) return;
    repairBusyMessages.add(message.id); render();
    try {
      const payload = { anchor, operation };
      if (operation === 'fix' || operation === 'change-tone') payload.instruction = String(extra.instruction || '');
      const result = await api.repairPreview(chat.id, message.id, payload);
      repairEditor = null; repairHistory = null; error = clearCondition(error, 'section-repair');
      updateOne(chat.id, result.message);
    } catch (caught) { repairFailure(caught); }
    finally { repairBusyMessages.delete(message.id); render(); }
  }

  async function discardRepair(message) {
    const chat = state.get().activeChat;
    if (!chat || repairBusyMessages.has(message.id)) return;
    repairBusyMessages.add(message.id); render();
    try { const result = await api.repairDiscard(chat.id, message.id); repairEditor = null; error = clearCondition(error, 'section-repair'); updateOne(chat.id, result.message); }
    catch (caught) { repairFailure(caught, 'Repair preview was not discarded.'); }
    finally { repairBusyMessages.delete(message.id); render(); }
  }

  async function applyRepair(message) {
    const chat = state.get().activeChat;
    if (!chat || repairBusyMessages.has(message.id)) return;
    repairBusyMessages.add(message.id); render();
    try {
      const applied = await api.repairApply(chat.id, message.id);
      repairEditor = null; repairHistory = null; error = clearCondition(error, 'section-repair');
      updateOne(chat.id, applied.message);
    } catch (caught) { repairFailure(caught, 'Repair was not applied.'); }
    finally { repairBusyMessages.delete(message.id); render(); }
  }

  async function undoRepair(message) {
    const chat = state.get().activeChat;
    if (!chat || repairBusyMessages.has(message.id)) return;
    repairBusyMessages.add(message.id); render();
    try { const result = await api.repairUndo(chat.id, message.id); repairHistory = null; error = clearCondition(error, 'section-repair'); updateOne(chat.id, result.message); }
    catch (caught) { repairFailure(caught, 'Repair was not undone.'); }
    finally { repairBusyMessages.delete(message.id); render(); }
  }

  async function showRepairHistory(message) {
    const chat = state.get().activeChat;
    if (!chat || repairBusyMessages.has(message.id)) return;
    try { repairHistory = { messageId: message.id, ...(await api.repairHistory(chat.id, message.id)) }; error = clearCondition(error, 'section-repair'); render(); }
    catch (caught) { repairFailure(caught, 'Revision history did not load.'); }
  }

  async function restoreRepair(message, revisionId) {
    const chat = state.get().activeChat;
    if (!chat || repairBusyMessages.has(message.id)) return;
    repairBusyMessages.add(message.id); render();
    try {
      const result = await api.repairRestore(chat.id, message.id, revisionId);
      const history = await api.repairHistory(chat.id, message.id);
      repairHistory = { messageId: message.id, ...history };
      error = clearCondition(error, 'section-repair'); updateOne(chat.id, result.message);
    } catch (caught) { repairFailure(caught, 'Revision was not restored.'); }
    finally { repairBusyMessages.delete(message.id); render(); }
  }

  async function reuseSetup(message) {
    const chat = state.get().activeChat;
    if (!chat || !message?.executionProfile) return;
    const index = (chat.messages || []).findIndex(item => item.id === message.id);
    const precedingUser = index > 0
      ? [...chat.messages.slice(0, index)].reverse().find(item => item.role === 'user')
      : null;
    await saveProfileForChat(chat.id, cloneResponseProfile(message.executionProfile));
    if (precedingUser) {
      const prompt = String(precedingUser.content || '');
      state.setDraft(chat.id, prompt);
      root?.querySelector('.composer-dock')?.setDraft?.(prompt);
      scheduleDraftSave();
    }
    pendingAttachments.set(chat.id, []);
    attachmentErrors.delete(chat.id);
    advancedOpen = false;
    render();
    requestAnimationFrame(() => { const input = root?.querySelector('.composer-text:not(:disabled)'); try { input?.focus({ preventScroll: true }); } catch { input?.focus(); } });
  }


  async function exportMessageDiagnostic(message){
    const chat=state.get().activeChat;if(!chat||!message?.id)return;
    const report=await api.diagnostics({chatId:chat.id,messageId:message.id});
    downloadDiagnostic(report,{filename:`kl01-run-diagnostic-${String(message.runId||message.id).replace(/[^a-zA-Z0-9._-]/gu,'-')}.json`});
  }

  function messageOptions(message, animate = false) {
    const chat = state.get().activeChat;
    const lastUser = [...(chat?.messages || [])].reverse().find(item => item.role === 'user');
    const repairable = message.role === 'assistant' && ['complete','completed','cancelled','failed'].includes(message.status);
    return {
      animate, accent: chat?.accent || 'violet', showTimes: Boolean(preferences().showMessageTimes), showReplySpeed: Boolean(preferences().showReplySpeed),
      lastUserId: lastUser?.id, onBranch: branch, onPin: pin, onEdit: edit, onEditFromHere: editFromHere, onRestart: restartModel,
      onReuseSetup: message.role === 'assistant' && message.executionProfile ? reuseSetup : null,
      onResumeRun: resumeInterruptedRun, onDiscardRun: discardInterruptedRun, onRetryWorkflow: retryWorkflowRun, onExportDiagnostic: exportMessageDiagnostic,
      onRepairSelect: repairable && !repairBusyMessages.has(message.id) ? selectRepair : null, onRepairPreview: previewRepair, onRepairDiscard: discardRepair, onRepairApply: applyRepair,
      onRepairUndo: undoRepair, onRepairHistory: showRepairHistory, onRepairRestore: restoreRepair, repairEditor, repairHistory,
      repairBusy: repairBusyMessages.has(message.id),
    };
  }

  function updateOne(chatId, message, { followAnswer = false } = {}) {
    const current = state.get().activeChat;
    if (!current || current.id !== chatId) return;
    const messages = current.messages.map(item => item.id === message.id ? message : item);
    state.set({ activeChat: { ...current, messages } });
    const transcript = scroller();
    const pinnedToBottom = Boolean(transcript && distanceFromBottom(transcript) <= 20);
    const container = root?.querySelector('.conversation-inner');
    if (!container || !updateMessageNode(container, message, messageOptions(message, false))) { render(); return; }
    if (followAnswer && pinnedToBottom && transcript) { transcript.scrollTop = transcript.scrollHeight; saveScroll(chatId, transcript.scrollTop); }
    syncJump();
  }

  function appendOptimisticUser(chat, text, attachments = []) {
    const container = root?.querySelector('.conversation-inner');
    if (!container) return null;
    const id = `optimistic-${chat.id}-${Date.now()}`;
    const content = String(text || '').trim() || 'Review the attached file or files.';
    const node = messageView({ id, role: 'user', content, attachments: attachmentMetadata(attachments), status: 'completed', pinned: false, createdAt: new Date().toISOString() }, { animate: true });
    node.setAttribute('data-optimistic', 'true');
    if (!(chat.messages || []).length) container.replaceChildren(node);
    else container.append(node);
    syncJump();
    return node;
  }

  function newRunId() {
    const value = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `run-${String(value).replace(/[^a-zA-Z0-9_-]/gu, '')}`;
  }

  async function submitWorkflowInput(forcedValue = null) {
    const current = dialog;
    if (!current || current.type !== 'workflow-input' || current.busy) return;
    const selected = String((forcedValue ?? current.selected) || '').trim();
    const value = selected === 'Other' ? String(current.other || '').trim() : selected;
    if (!value) { current.failure = 'Choose an option, enter an answer, or select Skip.'; render(); return; }
    current.busy = true; current.failure = null; render();
    try {
      await api.runInput(current.runId, { stageId: current.stageId, value });
      dialog = null;
      error = clearCondition(error, 'workflow-input');
      render();
    } catch (caught) {
      current.busy = false;
      current.failure = caught?.message || 'This answer was not accepted; try again or stop the run.';
      error = conditionError('workflow-input', current.failure);
      render();
    }
  }

  async function handleRunEvent(chatId, runId, event, envelope) {
    if (envelope?.runId && envelope.runId !== runId) return;
    const data = envelope?.publicPayload && typeof envelope.publicPayload === 'object' ? envelope.publicPayload : (envelope || {});
    const active = state.get().activeChat;
    if (event === 'run-started') {
      stoppingChats.delete(chatId);
      if (active?.id === chatId) root?.querySelector('.composer-dock')?.setBusy?.(true, busyStartedAt.get(chatId), false);
    }
    if (!active || active.id !== chatId) return;
    if (event === 'source-work-delta' && data.sourceWork && data.messageId) {
      const current = active.messages.find(message => message.id === data.messageId);
      if (current?.work?.kind === 'research') {
        const work = mergeSourceWorkDelta(current.work, data.sourceWork);
        if (work !== current.work) updateOne(chatId, { ...current, work });
      }
    } else if (data.work && data.messageId) {
      const current = active.messages.find(message => message.id === data.messageId);
      if (current) {
        const terminalWork = ['completed','partial','failed','cancelled'].includes(data.work.status);
        updateOne(chatId, { ...current, ...(data.web ? { web:data.web } : {}), work:data.work, status:terminalWork && current.content ? current.status : 'streaming' });
      }
    } else if (['web-started','web-progress','web-completed','web-failed'].includes(event)) {
      const current = active.messages.find(message => message.id === data.messageId);
      if (current && data.web) updateOne(chatId, { ...current, web:data.web, status:'streaming' });
    }
    if (['target-pinned','target-failed','target-fallback','node-queued-resource','resource-snapshot','execution-mode','node-loading-target','node-retrying','heartbeat'].includes(event) && data.messageId) {
      const current=active.messages.find(message=>message.id===data.messageId);
      if(current){const execution=structuredClone(current.execution||{version:1,effectiveMode:'sequential',fallbacks:[],events:[]});
        if(event==='target-pinned'){execution.activeTargetId=data.targetId||execution.activeTargetId||null;execution.live={type:event,stageId:data.stageId||envelope?.nodeId||'answer',label:(data.stageId||envelope?.nodeId||'answer')==='answer'?'Generating response':`Running ${data.stageId||envelope?.nodeId||'workflow step'}`,elapsedMs:Number(data.elapsedMs||0)};}
        if(event==='target-fallback'){execution.activeTargetId=data.selectedTargetId||data.targetId||execution.activeTargetId||null;execution.fallbacks=[...(execution.fallbacks||[]),structuredClone(data)];}
        if(event==='execution-mode')execution.effectiveMode=data.mode||execution.effectiveMode;
        if(['heartbeat','node-queued-resource','node-loading-target','node-retrying'].includes(event))execution.live={type:event,stageId:data.stageId||envelope?.nodeId||null,label:data.message||data.label||'Still working',elapsedMs:Number(data.elapsedMs||0)};
        execution.events=[...(execution.events||[]),{type:event,stageId:data.stageId||envelope?.nodeId||null,at:envelope?.timestamp||new Date().toISOString(),code:data.code||data.reason||null,message:data.message||data.label||null,targetId:data.targetId||data.selectedTargetId||null}].slice(-40);
        updateOne(chatId,{...current,execution,status:'streaming'});
      }
    }
    if (event === 'stage-started' || event === 'stage-completed') {
      if (event === 'stage-completed') clearStageDeltaBuffer(stageDeltaKey(runId, data.messageId, data.stageId || envelope?.nodeId));
      const current = active.messages.find(message => message.id === data.messageId);
      if (current && data.workflow) updateOne(chatId, { ...current, workflow:data.workflow, status:'streaming' });
    }
    if (event === 'clarification-request') {
      dialog = { type:'workflow-input', runId, stageId:data.stage?.id || data.stageId, question:data.question || {}, workflow:data.workflow || null, selected:'', other:'', busy:false, failure:null };
      overlayTrigger = root?.querySelector('.composer-dock') || overlayTrigger; render();
    }
    if (event === 'stage-delta') {
      queueStageDelta({ chatId, runId, messageId:data.messageId, stageId:data.stageId || envelope?.nodeId, delta:data.delta, outputTokens:data.outputTokens, outputTokensEstimated:data.outputTokensEstimated });
    }
    if(event==='reasoning-completed'){const current=active.messages.find(message=>message.id===data.messageId);if(current)updateOne(chatId,{...current,reasoningElapsedMs:Number(data.reasoningElapsedMs||0),status:'streaming'});}
    if(event==='reasoning-delta'){const current=active.messages.find(message=>message.id===data.messageId);if(current)updateOne(chatId,{...current,reasoning:`${current.reasoning||''}${data.delta||''}`,status:'streaming'});}
    if(event==='content-replaced'){const current=active.messages.find(message=>message.id===data.messageId);if(current)updateOne(chatId,{...current,content:String(data.content||''),status:'streaming'},{followAnswer:true});}
    if(event==='delta'){const current=active.messages.find(message=>message.id===data.messageId);if(current)updateOne(chatId,{...current,content:`${current.content||''}${data.delta||''}`,status:'streaming'},{followAnswer:true});}
    if(['done','cancelled','error'].includes(event)){
      clearStageDeltaRun(runId);
      if(data.message){updateOne(chatId,data.message);if(dialog?.type==='workflow-input'&&dialog.runId===runId)dialog=null;}
    }
  }

  async function attachRunEvents(chatId, runId, { startAfter = 0 } = {}) {
    if (!chatId || !runId) return null;
    if (runStreams.has(runId)) return runStreams.get(runId).promise;
    activeRuns.set(chatId,runId); busyChats.add(chatId); if(!busyStartedAt.has(chatId))busyStartedAt.set(chatId,Date.now());
    const controller=new AbortController();
    const promise=consumeWorkEvents({
      open:after=>api.openRunEvents(runId,after),
      snapshot:()=>api.runSnapshot(runId),
      startAfter,
      signal:controller.signal,
      onConnectionState:async connection=>{
        const current=state.get().activeChat;if(current?.id!==chatId)return;
        const message=current.messages?.find(item=>item.runId===runId);if(!message)return;
        const execution=structuredClone(message.execution||{version:1,effectiveMode:'sequential',fallbacks:[],events:[]});
        if(connection?.state==='reconnecting'){execution.live={type:'connection-reconnecting',stageId:execution.live?.stageId||null,label:'Connection interrupted · reconnecting automatically',elapsedMs:connection.disconnectedSince?Math.max(0,Date.now()-Number(connection.disconnectedSince)):0};updateOne(chatId,{...message,execution,status:'streaming'});}
        else if(connection?.state==='connected'&&connection?.reconnects){execution.live={type:'connection-restored',stageId:execution.live?.stageId||null,label:'Reconnected · synchronizing live work',elapsedMs:0};updateOne(chatId,{...message,execution,status:'streaming'});}
      },
      onSnapshot:async run=>{
        if(!run)return;
        const current=state.get().activeChat;
        if(current?.id!==chatId)return;
        const fresh=await api.chat(chatId).catch(()=>null);
        if(!fresh)return;
        const researchWork=run.nodeSnapshots?.research || run.publicSnapshot?.research || null;
        const messageId=run.assistantMessageId || run.messageId || researchWork?.messageId || null;
        const message=messageId?fresh.messages?.find(item=>item.id===messageId):null;
        if(message){if(researchWork)message.work=researchWork;if(run.nodeSnapshots?.workflow)message.workflow=structuredClone(run.nodeSnapshots.workflow);if(run.nodeSnapshots?.execution)message.execution=structuredClone(run.nodeSnapshots.execution);if(!['completed','cancelled','failed'].includes(run.state))message.status='streaming';}
        state.set({activeChat:fresh});render();
      },
      onEvent:(event,envelope)=>workEventReconciler.accept(event,envelope,()=>handleRunEvent(chatId,runId,event,envelope)),
    }).then(async result=>{
      const run=result?.run || (await api.runSnapshot(runId).catch(()=>null))?.run || null;
      if(!run || ['completed','cancelled','failed'].includes(run.state)){
        if(activeRuns.get(chatId)===runId){activeRuns.delete(chatId);busyChats.delete(chatId);stoppingChats.delete(chatId);busyStartedAt.delete(chatId);}
        if(state.get().activeChat?.id===chatId)await load(chatId,{preservePosition:true,focusComposer:true});
      }
      return result;
    }).catch(async caught=>{
      const run=(await api.runSnapshot(runId).catch(()=>null))?.run;
      if(run && !['completed','cancelled','failed'].includes(run.state)){
        if(state.get().activeChat?.id===chatId){error=conditionError('run-events','Live work updates are temporarily unavailable. The run is still continuing and this chat will resynchronize automatically when the local connection returns.');render();}
        return {run,lastSeq:startAfter,detached:true};
      }
      throw caught;
    }).finally(()=>runStreams.delete(runId));
    runStreams.set(runId,{controller,promise});
    return promise;
  }

  async function send(textOverride = null, attachmentsOverride = null) {
    const chat=state.get().activeChat;if(!chat||busyChats.has(chat.id))return;
    const draft=textOverride===null?currentComposerDraft(chat.id):String(textOverride);
    const files=attachmentsOverride===null?attachmentsFor(chat.id):[...(attachmentsOverride||[])];
    if(!draft.trim()&&files.length===0)return;
    const sendProfile=cloneResponseProfile(currentExecutionProfile(state.get()));
    const approvedDraft=draft;
    const reasoning=reasoningPayload(sendProfile,{reasoningSupported:reasoningSupported(state.get())});
    const replaySignature=JSON.stringify({text:approvedDraft,attachments:files,profile:sendProfile,reasoning});
    const retry=pendingSendRetries.get(chat.id);
    const requestedRunId=retry?.signature===replaySignature?retry.runId:newRunId();
    const payload={runId:requestedRunId,text:approvedDraft,attachments:files,profile:sendProfile,reasoning};
    const composerDock=root?.querySelector('.composer-dock');
    // Clear only the optimistic browser presentation. The durable server draft is cleared atomically
    // when addUserMessage commits, so an unaccepted send never destroys the saved draft.
    composerDock?.setDraft?.('');state.clearDraft(chat.id);
    busyChats.add(chat.id);stoppingChats.delete(chat.id);activeRuns.set(chat.id,requestedRunId);busyStartedAt.set(chat.id,Date.now());error=null;faviconMotion.start();render();appendOptimisticUser(chat,approvedDraft,files);
    let accepted=false;
    try{
      const created=await api.createMessageRun(chat.id,payload);
      accepted=true;pendingSendRetries.delete(chat.id);
      const runId=created.runId||requestedRunId;if(runId!==requestedRunId){activeRuns.set(chat.id,runId);}
      pendingAttachments.delete(chat.id);attachmentErrors.delete(chat.id);state.clearDraft(chat.id);
      const persisted=await api.chat(chat.id);if(state.get().activeChat?.id===chat.id){state.set({activeChat:persisted});render();syncJump();}
      if(['completed','cancelled','failed'].includes(String(created.state||''))){
        activeRuns.delete(chat.id);busyChats.delete(chat.id);stoppingChats.delete(chat.id);busyStartedAt.delete(chat.id);
      } else await attachRunEvents(chat.id,runId);
    }catch(caught){
      const known=activeRuns.get(chat.id)||requestedRunId;
      const snapshot=known?(await api.runSnapshot(known).catch(()=>null))?.run:null;
      if(snapshot){
        accepted=true;pendingSendRetries.delete(chat.id);pendingAttachments.delete(chat.id);attachmentErrors.delete(chat.id);state.clearDraft(chat.id);
        if(!['completed','cancelled','failed'].includes(snapshot.state)){
          if(activeRuns.get(chat.id)!==snapshot.runId)activeRuns.set(chat.id,snapshot.runId);
          await attachRunEvents(chat.id,snapshot.runId).catch(()=>{});
        } else {
          activeRuns.delete(chat.id);busyChats.delete(chat.id);stoppingChats.delete(chat.id);busyStartedAt.delete(chat.id);
        }
      } else {
        pendingSendRetries.set(chat.id,{runId:requestedRunId,signature:replaySignature});
        state.setDraft(chat.id,approvedDraft);pendingAttachments.set(chat.id,files);
        composerDock?.setDraft?.(approvedDraft);composerDock?.setAttachments?.(files,attachmentErrors.get(chat.id)||null);
        error=conditionError('message-send',caught?.message||'The local connection interrupted this send. Your draft is preserved and retrying it will reuse the same response identifier.');
        activeRuns.delete(chat.id);busyChats.delete(chat.id);stoppingChats.delete(chat.id);busyStartedAt.delete(chat.id);render();
      }
    }finally{
      faviconMotion.stop();
      if(state.get().activeChat?.id===chat.id&&!busyChats.has(chat.id)){
        if(accepted)await load(chat.id,{preservePosition:true,focusComposer:true});
        else root?.querySelector('.composer-text:not(:disabled)')?.focus?.({preventScroll:true});
      }
    }
  }

  async function stop() {
    const chat = state.get().activeChat;
    const runId = chat ? activeRuns.get(chat.id) : null;
    if (!chat || (!busyChats.has(chat.id) && !waitingMessage(chat))) return;
    if (stoppingChats.has(chat.id)) return;
    stoppingChats.add(chat.id);
    root?.querySelector('.composer-dock')?.setBusy?.(true, busyStartedAt.get(chat.id), true);
    try {
      const result = runId ? await api.stopRun(runId, 'user') : await api.stop(chat.id, null, 'user');
      error = clearCondition(error, 'run-stop');
      if (['already-finished', 'not-found'].includes(result.status)) {
        activeRuns.delete(chat.id);
        busyChats.delete(chat.id);
        stoppingChats.delete(chat.id);
        busyStartedAt.delete(chat.id);
        await load(chat.id, { preservePosition: true, focusComposer: true });
      }
    } catch {
      stoppingChats.delete(chat.id);
      error = conditionError('run-stop', 'Run did not stop; select Stop to try again.');
      root?.querySelector('.composer-dock')?.setBusy?.(true, busyStartedAt.get(chat.id), false);
      render();
    }
  }
  async function resumeInterruptedRun(message) {
    const chat=state.get().activeChat;const runId=message?.runId;if(!chat||!runId)return;
    busyChats.add(chat.id);activeRuns.set(chat.id,runId);if(!busyStartedAt.has(chat.id))busyStartedAt.set(chat.id,Date.now());error=null;render();
    try { await api.resumeRun(runId); error=clearCondition(error,'run-resume'); if(!runStreams.has(runId))attachRunEvents(chat.id,runId).catch(()=>{}); }
    catch(caught){error=conditionError('run-resume',caught?.message||'Interrupted research could not be resumed safely.');render();}
  }
  async function discardInterruptedRun(message) {
    const chat=state.get().activeChat;const runId=message?.runId;if(!chat||!runId)return;
    try { await api.discardRun(runId); activeRuns.delete(chat.id);busyChats.delete(chat.id);busyStartedAt.delete(chat.id);error=clearCondition(error,'run-resume');await load(chat.id,{preservePosition:true,focusComposer:true}); }
    catch(caught){error=conditionError('run-resume',caught?.message||'Interrupted research could not be discarded.');render();}
  }

  async function retryWorkflowRun(message) {
    const chat=state.get().activeChat;
    if(!chat||!message?.id||busyChats.has(chat.id))return;
    busyChats.add(chat.id);stoppingChats.delete(chat.id);busyStartedAt.set(chat.id,Date.now());error=null;faviconMotion.start();render();
    let runId=null;
    try {
      const created=await api.retryWorkflow(chat.id,message.id);runId=created?.runId||null;
      if(!runId)throw new Error('Workflow retry did not return a run identifier.');
      activeRuns.set(chat.id,runId);
      const persisted=await api.chat(chat.id);if(state.get().activeChat?.id===chat.id){state.set({activeChat:persisted});render();syncJump();}
      await attachRunEvents(chat.id,runId);
      error=clearCondition(error,'workflow-retry');
    } catch(caught) {
      const snapshot=runId?(await api.runSnapshot(runId).catch(()=>null))?.run:null;
      if(!snapshot||['completed','cancelled','failed'].includes(snapshot.state)){
        if(activeRuns.get(chat.id)===runId)activeRuns.delete(chat.id);
        busyChats.delete(chat.id);stoppingChats.delete(chat.id);busyStartedAt.delete(chat.id);
      }
      error=conditionError('workflow-retry',caught?.message||'Workflow retry could not be started safely.');render();
    } finally {
      faviconMotion.stop();
      if(state.get().activeChat?.id===chat.id&&!busyChats.has(chat.id))await load(chat.id,{preservePosition:true,focusComposer:true});
    }
  }

  async function restartModel() {
    const runtime = state.get().runtime;
    const id = runtime?.modelId || state.get().pendingActivationId || state.get().settings?.activeModelId;
    if (!id) return;
    state.set({ pendingActivationId: id, activationError: null });
    syncRuntimeParts();
    try { await api.activateModel(id, state.get().activeChat?.id || null); }
    catch (caught) {
      error = conditionError('runtime-model-ready', 'Model did not start.');
      state.set({ activationError: error });
      syncRuntimeParts();
    }
  }


  async function switchModel(kind, id) {
    const chat = state.get().activeChat;
    if (!chat || busyChats.has(chat.id)) return;
    if (!(await flushDraftBeforeLeaving())) return;
    modelMenuOpen = false; error = null;
    hideOverlay(root, { restoreFocus: false });
    const externalName = kind === 'external' ? state.get().services?.find(service => service.id === id)?.name || 'the selected service' : null;
    const queuedFiles = attachmentsFor(chat.id);
    if (queuedFiles.length) {
      const targetTypes = kind === 'local'
        ? new Set((state.get().installed || []).find(model => model.id === id)?.capabilities?.fileTypes || [])
        : new Set();
      const incompatible = queuedFiles.filter(item => !targetTypes.has(String(item.extension || '').toLowerCase()));
      if (incompatible.length) {
        const removedIds=new Set(incompatible.map(item=>item.id||item.clientId));
        const kept=queuedFiles.filter(item=>!removedIds.has(item.id||item.clientId));
        pendingAttachments.set(chat.id,kept);
        const names=incompatible.map(item=>item.name).join(', ');
        attachmentErrors.set(chat.id, new Error(kind === 'external'
          ? `Removed ${names} because external services do not advertise file support in this build. No attachment content was sent.`
          : `Removed ${names} because the selected model does not support those file types. Compatible attachments were kept.`));
      }
    }
    state.set({ pendingActivationId: id, pendingExternalService: externalName });
    render();
    try {
      if (kind === 'external') await api.activateService(id, chat.id);
      else await api.activateModel(id, chat.id);
      state.set({ pendingExternalService: null });
      await load(chat.id, { preservePosition: true, focusComposer: true });
    } catch { error = conditionError('model-switch', 'Model switch failed.'); state.set({ pendingExternalService: null }); await load(chat.id, { preservePosition: true }); }
  }

  function setModelMenu(open, trigger = null) {
    modelMenuOpen = Boolean(open);
    if (modelMenuOpen) {
      lineageOpen = false;
      advancedOpen = false;
      chatMenu = null;
      dialog = null;
      overlayTrigger = trigger || overlayTrigger || document.activeElement;
    }
    render();
  }

  function modelMenuOverlay(runtime, installed, services) {
    if (!modelMenuOpen) return null;
    const external = runtime?.status === 'external-ready';
    const pendingLocal = runtime?.status === 'selected-pending';
    const activeId = external ? runtime.service?.id : pendingLocal ? runtime.selectedTarget?.id || runtime.modelId : runtime?.modelId;
    const items = [
      ...installed.map(model => ({ kind: 'local', id: model.id, label: model.displayName, active: !external && model.id === activeId })),
      ...services.map(service => ({ kind: 'external', id: service.id, label: `${service.name} · External`, active: external && service.id === activeId })),
    ];
    const menuKey = event => {
      const buttons = [...event.currentTarget.querySelectorAll('[role="menuitem"]')];
      const current = buttons.indexOf(document.activeElement);
      if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (current + 1 + buttons.length) % buttons.length : (current - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    const menu = el('div', { class: 'model-menu card', role: 'menu', 'aria-label': 'Choose AI', onKeydown: menuKey },
      ...items.map(item => el('button', { class: `model-menu-item ${item.active ? 'active' : ''}`, role: 'menuitem', type: 'button', onClick: () => switchModel(item.kind, item.id) }, el('span', { text: item.label }), item.active ? el('span', { class: 'pill green', text: 'In use' }) : null)),
      el('div', { class: 'model-menu-divider', role: 'separator' }),
      el('button', { class: 'model-menu-item', role: 'menuitem', type: 'button', onClick: async () => { modelMenuOpen = false; hideOverlay(root, { restoreFocus: false }); await routeAfterDraft('models'); }, text: 'Get more models' }));
    return popover({
      content: menu,
      label: 'Choose AI',
      trigger: overlayTrigger,
      onClose: () => { modelMenuOpen = false; render(); },
    });
  }

  function modelChip(runtime) {
    const external = runtime?.status === 'external-ready';
    const pending = runtime?.status === 'selected-pending';
    const starting = runtime?.status === 'starting';
    const selectedName=runtime?.selectedTarget?.name || runtime?.modelName || runtime?.modelId;
    const name = starting ? 'Starting…' : external ? runtime.service?.name : pending ? `${selectedName || 'Selected model'} · next run` : runtime?.status === 'ready' ? (runtime.modelName || runtime.modelId) : 'No model running';
    const privacy = external ? `External · Network target: ${runtime.service?.name || 'selected service'}.` : pending ? 'Local model selected for the next run. Current active work keeps its pinned model.' : runtime?.status === 'ready' ? 'Local inference. Research may use the web when enabled.' : 'No model running. No network requests.';
    const local=runtime?.status === 'ready'||pending;
    const chip = el('button', { class: `model-chip ${external ? 'external' : local ? 'local' : ''} ${pending?'pending-target':''}`.trim(), type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': String(modelMenuOpen), 'aria-label': `${name}. ${privacy}`, title: privacy, onClick: event => { overlayTrigger = event.currentTarget; setModelMenu(!modelMenuOpen, event.currentTarget); } },
      el('span', { class: `status-dot ${external || local ? '' : 'muted-dot'}`, 'aria-hidden': 'true' }),
      el('span', { text: name }), el('span', { class: 'model-chevron', 'aria-hidden': 'true', text: '⌄' }));
    return el('div', { class: 'model-chip-wrap' }, chip);
  }


  function advancedOverlay(snapshot = state.get()) {
    if (!advancedOpen) return null;
    const chat = snapshot.activeChat;
    const close = () => { advancedOpen = false; render(); };
    const content = advancedPanel({
      profile: currentExecutionProfile(snapshot),
      reasoningSupported: reasoningSupported(snapshot),
      onApply: async profile => {
        if (chat?.id) await saveProfileForChat(chat.id, profile);
        advancedOpen = false;
        refreshContextPreview().catch(() => {});
        render();
      },
      onSetChatDefault: async profile => {
        if (!chat?.id) return;
        await saveChatDefaultProfile(chat.id, profile);
        await resetNextRunProfile(chat.id);
        refreshContextPreview().catch(() => {});
        render();
      },
      onResetNextRun: async () => {
        if (!chat?.id) return;
        await resetNextRunProfile(chat.id);
        refreshContextPreview().catch(() => {});
        render();
      },
      hasNextRunOverride: Boolean(chat?.draft?.executionProfile),
      onClose: close,
    });
    return popover({ content, label: 'Advanced response controls', trigger: overlayTrigger, onClose: close });
  }



  function chatLoadFailure() {
    return el('div', { class: 'empty-chat' },
      el('div', { class: 'empty-center' },
        el('h1', { text: 'Chat did not load.' }),
        el('button', { class: 'btn primary', type: 'button', onClick: () => load(error?.chatId || initialChatId, { focusComposer: true }), text: 'Retry' })));
  }

  function emptyState(chat, runtime, installedCount) {
    if (runtime?.status === 'starting') return el('div', { class: 'empty-chat' }, el('div', { class: 'empty-center' }, el('span', { class: 'assistant-mark thinking' }, el('img', { src: '/logos/kl01-favicon.svg', alt: 'KL01' })), el('p', { class: 'muted', text: 'Starting the model…' })));
    if (runtime?.status === 'failed') return el('div', { class: 'empty-chat' }, el('div', { class: 'empty-center' }, el('p', { text: 'The selected AI could not start; select Try again.' }), el('button', { class: 'btn primary', type: 'button', onClick: restartModel, text: 'Try again' })));
    if (!isReady(runtime) && installedCount === 0) return el('div', { class: 'empty-chat' }, el('div', { class: 'empty-center' }, el('img', { class: 'starburst s48', src: '/logos/kl01-favicon.svg', alt: '' }), el('h1', { text: 'Set up AI to start chatting' }), el('p', { class: 'muted', text: 'KL01 needs AI on this computer before it can reply.' }), el('button', { class: 'btn primary', type: 'button', onClick: () => routeAfterDraft('models'), text: 'Set up AI' })));
    if (!isReady(runtime)) return el('div', { class: 'empty-chat' }, el('div', { class: 'empty-center' }, el('img', { class: 'starburst s48', src: '/logos/kl01-favicon.svg', alt: '' }), el('h1', { text: 'Choose AI to start chatting' }), el('button', { class: 'btn primary', type: 'button', onClick: event => { overlayTrigger = event.currentTarget; setModelMenu(true, event.currentTarget); }, text: 'Choose AI' })));
    return el('div', { class: 'empty-chat' }, el('div', { class: 'empty-center' }, el('img', { class: 'starburst s48', src: '/logos/kl01-favicon.svg', alt: '' }), el('h1', { text: 'What do you want to make?' }), el('div', { class: 'prompt-cards' }, ...SUGGESTIONS.map((text, index) => {
      const button = el('button', { class: 'prompt-card suggestion-enter', type: 'button', onClick: () => { state.setDraft(chat.id, text); scheduleDraftSave(); render(); requestAnimationFrame(() => root?.querySelector('.composer-text')?.focus()); }, text });
      button.style.setProperty('--kl01-list-delay-step', String(Math.min(index, 5)));
      return button;
    }))));
  }

  function composerElement(snapshot = state.get()) {
    const chat = snapshot.activeChat;
    const busy = chat ? busyChats.has(chat.id) : false;
    return composer({
      draft: chat ? state.draft(chat.id) : '',
      context: snapshot.context,
      runtime: effectiveRuntime(snapshot),
      installedCount: snapshot.installed?.length || 0,
      busy, stopping: chat ? stoppingChats.has(chat.id) : false, busyStartedAt: chat ? busyStartedAt.get(chat.id) || null : null, error, preferences: preferences(),
      instruments: composerInstruments(snapshot),
      attachments: chat ? attachmentsFor(chat.id) : [],
      acceptedFileTypes: acceptedFileTypes(snapshot),
      attachmentError: chat ? attachmentErrors.get(chat.id) || null : null,
      groundingRisk: groundingWarning(currentExecutionProfile(snapshot)),
      onPersistDraft: persistDraftText,
      onPreviewDraft: refreshContextPreview,
      onChooseFiles: chooseAttachments,
      onRemoveAttachment: removeAttachment,
      onSend: send, onStop: stop, onNewChat: create, onCompress: openCompression,
    });
  }

  function syncRuntimeParts() {
    if (!root) return;
    const snapshot = state.get();
    const chat = snapshot.activeChat;
    const runtime = effectiveRuntime(snapshot);
    const previousChip = root.querySelector('.model-chip-wrap');
    if (previousChip) previousChip.replaceWith(modelChip(runtime));
    for (const indicator of root.querySelectorAll('[data-permanent-privacy]')) indicator.replaceWith(privacyIndicator(snapshot, { compact: true }));
    const currentComposer = root.querySelector('.composer-dock');
    if (currentComposer?.setRuntime) {
      currentComposer.setRuntime(runtime, snapshot.installed?.length || 0);
      currentComposer.setBusy?.(Boolean(chat && busyChats.has(chat.id)), chat ? busyStartedAt.get(chat.id) || null : null, Boolean(chat && stoppingChats.has(chat.id)));
      currentComposer.setInstruments?.(composerInstruments(snapshot));
      currentComposer.setContext?.(snapshot.context);
      currentComposer.setError?.(error);
      currentComposer.setGroundingRisk?.(groundingWarning(currentExecutionProfile(snapshot)));
      currentComposer.setAttachmentSupport?.(acceptedFileTypes(snapshot));
      currentComposer.setAttachments?.(chat ? attachmentsFor(chat.id) : [], chat ? attachmentErrors.get(chat.id) || null : null);
    } else if (currentComposer) currentComposer.replaceWith(composerElement(snapshot));
    if (!(chat?.messages || []).length) {
      const inner = root.querySelector('.conversation-inner');
      if (inner) inner.replaceChildren(emptyState(chat, runtime, snapshot.installed?.length || 0));
    }
    bindScroll();
    syncJump();
  }

  function transcriptNodes(chat) {
    const all = chat?.messages || [];
    const compressionState = state.get().compressionState;
    if (transcriptMode !== 'active' || !compressionState?.activeSnapshotId) {
      return all.map(message => { const animate = !seenMessageIds.has(message.id); seenMessageIds.add(message.id); return messageView(message, messageOptions(message, animate)); });
    }
    const byId = new Map(all.map(message => [message.id, message]));
    const out = [];
    for (const item of compressionState.view?.items || []) {
      if (item.kind === 'summary') {
        out.push(el('article', { class: 'compression-summary card' },
          el('div', { class: 'compression-summary-head' }, el('span', { class: 'pill compression-condensed-badge', text: 'Condensed' }), el('span', { class: 'muted numeric', text: `${item.messageIds.length} earlier turn${item.messageIds.length === 1 ? '' : 's'}` })),
          el('pre', { class: 'compression-summary-text', text: item.summary || '' })));
        continue;
      }
      const message = byId.get(item.messageId);
      if (message) out.push(messageView(message, messageOptions(message, false)));
    }
    return out;
  }

  function compressionControls() {
    const compressionState = state.get().compressionState;
    const active = Boolean(compressionState?.activeSnapshotId);
    const lineage = compressionState?.lineage || [];
    return el('div', { class: 'context-controls' },
      active ? el('div', { class: 'segmented transcript-toggle', role: 'group', 'aria-label': 'Transcript view' },
        el('button', { class: `theme-option ${transcriptMode === 'active' ? 'active' : ''}`, type: 'button', 'aria-pressed': String(transcriptMode === 'active'), onClick: () => { transcriptMode = 'active'; render(); }, text: 'Active context' }),
        el('button', { class: `theme-option ${transcriptMode === 'full' ? 'active' : ''}`, type: 'button', 'aria-pressed': String(transcriptMode === 'full'), onClick: () => { transcriptMode = 'full'; render(); }, text: 'Full original' })) : null,
      active ? el('button', { class: 'nav-chip', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': String(lineageOpen), onClick: event => { overlayTrigger = event.currentTarget; lineageOpen = !lineageOpen; modelMenuOpen = false; chatMenu = null; dialog = null; render(); }, text: 'Compression history' }) : null,
      active ? el('button', { class: 'nav-chip', type: 'button', disabled: compressionBusy, 'aria-label': compressionBusy ? 'Undo compression disabled while compression is running' : 'Undo compression', onClick: undoCompression, text: 'Undo compression' }) : null,
      el('button', { class: 'nav-chip', type: 'button', disabled: compressionBusy, 'aria-label': compressionBusy ? 'Shorten this chat disabled while compression is running' : 'Shorten this chat', onClick: event => openCompression(event.currentTarget), text: 'Shorten this chat' }),
      el('button', { class: 'nav-chip', type: 'button', onClick: event => showVisibility(event.currentTarget), text: 'What KL01 can see' }),
      compressionBusy ? el('span', { class: 'disabled-reason muted', text: 'Compression is running.' }) : null);
  }

  function lineageOverlay() {
    if (!lineageOpen) return null;
    const lineage = state.get().compressionState?.lineage || [];
    const content = el('div', { class: 'snapshot-lineage-list' },
      ...(lineage.length ? lineage.map((snapshot, index) =>
        el('div', { class: 'snapshot-lineage-item' },
          el('strong', { text: index === 0 ? 'Active snapshot' : `Earlier snapshot ${index}` }),
          el('span', { class: 'muted numeric', text: `${snapshot.mode === 'automatic' ? 'Automatic' : 'Reviewed'} · ${new Date(snapshot.createdAt).toLocaleString()}` }),
          el('span', { class: 'muted numeric', text: `${(snapshot.operations || []).length} recorded operation${(snapshot.operations || []).length === 1 ? '' : 's'}` })))
        : [el('p', { class: 'muted', text: 'No compression snapshots yet.' })]));
    return popover({
      content,
      label: 'Compression history',
      trigger: overlayTrigger,
      onClose: () => { lineageOpen = false; render(); },
    });
  }

  function recoveryCount() {
    if (!compressionReview) return 0;
    let recovered = 0;
    for (const range of compressionReview.ranges) {
      const op = compressionSelections.get(range.rangeId)?.operation || 'keep';
      recovered += Number(range.recovery?.[op] || 0);
    }
    return Math.max(0, Math.floor(recovered / Math.max(1, compressionReview.averageTurnTokens || 1)));
  }

  function recoveryReadout() {
    const current = recoveryCount();
    lastCompressionRecovery = current;
    return el('strong', { class: 'numeric', text: `about ${current} more messages` });
  }

  function rangeOriginal(range) {
    const byId = new Map((state.get().activeChat?.messages || []).map(message => [message.id, message]));
    return range.messageIds.map(id => {
      const message = byId.get(id);
      return message ? `${message.role === 'user' ? 'You' : 'KL01'}:\n${message.content || ''}` : '';
    }).filter(Boolean).join('\n\n');
  }

  async function closeCompressionReview() {
    const chat = state.get().activeChat;
    const reviewId = compressionReview?.reviewId;
    if (!chat || !reviewId || compressionBusy) { dialog = null; compressionReview = null; compressionSelections.clear(); render(); return; }
    compressionBusy = true; render();
    try {
      await api.compressionCancelReview(chat.id, reviewId);
      compressionReview = null; compressionSelections.clear(); dialog = null; error = clearCondition(error, 'compression-cancel');
    } catch { error = conditionError('compression-cancel', 'Compression review did not close; select Close again.'); }
    finally { compressionBusy = false; render(); }
  }

  function compressionDialog() {
    if (!compressionReview) return modal({ title: 'Compression', description: 'Preparing a review…', content: el('p', { class: 'muted', text: 'Measuring older turns and preparing summaries.' }), primaryLabel: 'Apply compression', primaryDisabled: true, primaryDisabledReason: 'The compression review is still being prepared.', onPrimary: () => {}, onClose: closeCompressionReview });
    const ranges = compressionReview.ranges.map(range => {
      const selection = compressionSelections.get(range.rangeId) || { operation: 'keep', unlockedProtected: false };
      const locked = range.protected && !selection.unlockedProtected;
      const turnRows = range.turns.map(turn => el('div', { class: 'compression-turn' },
        el('div', { class: 'compression-turn-copy' }, el('strong', { text: turn.role === 'user' ? 'You' : 'KL01' }), el('span', { class: 'muted', text: turn.preview || '(empty)' })),
        el('div', { class: 'compression-weight readout', title: `${Math.round((turn.share || 0) * 100)}% of conversation length`, style: `--turn-share:${Math.max(2, Math.round((turn.share || 0) * 100))}%` }, el('span'))));
      const preview = selection.operation === 'summarise' && range.summary
        ? el('div', { class: 'compression-preview' },
            el('div', { class: 'compression-preview-pane' }, el('strong', { text: 'Original' }), el('pre', { text: rangeOriginal(range) })),
            el('div', { class: 'compression-preview-pane' }, el('strong', { text: 'Proposed summary' }), el('pre', { text: range.summary }), el('p', { class: 'muted', text: 'The summary uses only exact excerpts from this range.' })))
        : null;
      return el('section', { class: `compression-range card ${range.protected ? 'protected' : ''}` },
        el('div', { class: 'compression-range-head' },
          el('div', {}, el('strong', { class: 'numeric', text: `${range.turns.length} turn${range.turns.length === 1 ? '' : 's'}` }), range.protected ? el('span', { class: 'pill compression-protected-badge', text: locked ? 'Protected · locked' : 'Protected · unlocked' }) : null),
          el('div', { class: 'compression-range-actions' },
            range.protected ? el('button', { class: 'nav-chip', type: 'button', onClick: () => unlockCompressionRange(range), text: locked ? 'Unlock' : 'Lock' }) : null,
            el('select', { class: 'field compact-field', value: selection.operation, disabled: locked || compressionBusy, 'aria-label': locked ? `Compression operation disabled because this range is protected: ${range.protectedReasons.join(', ')}` : compressionBusy ? 'Compression operation disabled while compression is running' : 'Compression operation', onChange: event => setCompressionOperation(range, event.target.value) },
              el('option', { value: 'summarise', selected: selection.operation === 'summarise', text: 'Summarise' }),
              el('option', { value: 'keep', selected: selection.operation === 'keep', text: 'Keep' }),
              el('option', { value: 'drop', selected: selection.operation === 'drop', text: 'Drop' })))),
        range.protected ? el('p', { class: 'muted', text: range.protectedReasons.join(' · ') }) : null,
        el('div', { class: 'compression-turns' }, ...turnRows),
        range.tooLarge ? el('p', { class: 'warning-note', text: range.summaryMessage }) : null,
        preview);
    });
    return modal({
      title: 'Compress this conversation',
      description: 'Choose what is sent to the model. Original transcript is unchanged.',
      content: el('div', { class: 'compression-review' },
        el('div', { class: 'compression-recovery readout' }, recoveryReadout(), el('span', { class: 'muted', text: 'estimated room recovered' })),
        el('p', { class: 'muted', text: 'Keep sends a range unchanged. Summarise sends the reviewed condensed version. Drop omits the range. Transcript is unchanged.' }),
        el('p', { class: 'muted', text: 'Protected content starts locked: code blocks, pinned messages, edited messages and the most recent exchange.' }),
        ...ranges),
      primaryLabel: compressionBusy ? 'Working…' : 'Apply compression',
      primaryDisabled: compressionBusy,
      primaryDisabledReason: 'Compression is already being applied.',
      onPrimary: applyCompression,
      onClose: closeCompressionReview,
    });
  }

  function visibilityDialog() {
    const visible = visibilityState;
    if (!visible) return null;
    return modal({
      title: 'What the model can see right now',
      description: 'The current conversation and any active compressed context.',
      content: el('div', { class: 'visibility-view' },
        el('section', { class: 'visibility-section' }, el('h3', { text: 'This conversation' }),
          ...(visible.conversation.length ? visible.conversation.map(item => el('div', { class: 'visibility-item card' }, el('strong', { text: item.role === 'user' ? 'You' : item.role === 'assistant' ? 'KL01' : 'Compressed context' }), el('p', { text: item.content })) ) : [el('p', { class: 'muted', text: 'Nothing yet.' })]))),
      primaryLabel: 'Done', onPrimary: () => { dialog = null; visibilityState = null; render(); }, onClose: () => { dialog = null; visibilityState = null; render(); },
    });
  }

  function workflowInputDialog() {
    const current = dialog;
    if (!current || current.type !== 'workflow-input') return null;
    const question = current.question || {};
    const options = [...(question.options || [])];
    if (question.allowOther !== false) options.push('Other');
    if (question.allowSkip !== false) options.push('Skip');
    const selectedValue = current.selected === 'Other' ? String(current.other || '').trim() : current.selected;
    const content = el('div', { class: 'workflow-input-content' },
      el('p', { class: 'muted', text: 'The workflow is paused here. Completed stages are preserved and no later model pass starts until you answer.' }),
      el('section', { class: 'workflow-input-question card' },
        el('strong', { text: question.prompt || 'Choose an option' }),
        el('div', { class: 'workflow-input-options' }, ...options.map(option => el('label', { class: 'workflow-input-option' },
          el('input', { type: 'radio', name: `workflow-${current.stageId}`, value: option, checked: current.selected === option, onChange: () => { current.selected = option; render(); } }),
          el('span', { text: option })))),
        current.selected === 'Other' ? el('input', { class: 'field', placeholder: 'Your answer', value: current.other, onInput: event => { current.other = event.target.value; } }) : null),
      current.failure ? el('p', { class: 'status-error', text: current.failure }) : null);
    return modal({
      title: current.workflow?.label || 'Workflow needs your input',
      description: `Paused at ${current.workflow?.stages?.find(stage => stage.id === current.stageId)?.label || 'an interactive stage'}.`,
      content,
      primaryLabel: current.busy ? 'Submitting…' : 'Continue workflow',
      primaryDisabled: current.busy || !String(selectedValue || '').trim(),
      primaryDisabledReason: current.busy ? 'This answer is being submitted.' : 'Choose an option or enter an answer.',
      onPrimary: () => submitWorkflowInput(),
      onClose: question.allowSkip !== false ? () => submitWorkflowInput('Skipped by user') : () => {},
    });
  }

  function renderDialog() {
    if (!dialog) return null;
    if (dialog.type === 'compression') return compressionDialog();
    if (dialog.type === 'visibility') return visibilityDialog();
    if (dialog.type === 'workflow-input') return workflowInputDialog();
    if (dialog.type === 'rename') {
      let value = dialog.chat.title; let node = null;
      const reason = el('p', { class: 'muted', text: 'Enter a chat name.' }); reason.hidden = Boolean(value.trim());
      const input = el('input', { class: 'field', value, onInput: event => { value = event.target.value; const invalid = !value.trim(); node?.setPrimaryDisabled?.(invalid); reason.hidden = !invalid; } });
      node = modal({ title: 'Rename chat', description: 'The chat content stays unchanged.', content: el('div', { class: 'config-form' }, el('label', { class: 'label' }, el('span', { text: 'Chat name' }), input), reason), primaryLabel: 'Rename', primaryDisabled: !value.trim(), primaryDisabledReason: 'Enter a chat name.', onPrimary: () => rename(dialog.chat, value), onClose: () => { dialog = null; render(); } });
      return node;
    }
    if (dialog.type === 'export') return modal({ title: 'Export chat', description: dialog.chat.title, content: el('div', { class: 'status-actions' }, el('button', { class: 'btn blue', type: 'button', onClick: () => exportFile(dialog.chat, 'markdown'), text: 'Markdown' }), el('button', { class: 'btn', type: 'button', onClick: () => exportFile(dialog.chat, 'text'), text: 'Plain text' })), onClose: () => { dialog = null; render(); } });
    return modal({ title: 'Delete this chat', description: `“${dialog.chat.title}” and its messages will be deleted.`, content: el('p', { class: 'muted', text: 'This cannot be undone.' }), primaryLabel: 'Delete chat', onPrimary: () => remove(dialog.chat), onClose: () => { dialog = null; render(); } });
  }

  function renderChatOverlay() {
    if (!root) return;
    const s = state.get();
    const node = renderDialog() || chatMenuOverlay() || advancedOverlay(s) || modelMenuOverlay(effectiveRuntime(s), s.installed || [], s.services || []) || lineageOverlay();
    if (node) showOverlay(root, node, { trigger: overlayTrigger });
    else hideOverlay(root);
  }

  function render() {
    if (!root) return;
    const s = state.get();
    const chat = s.activeChat;
    const busy = chat ? busyChats.has(chat.id) : false;
    const chatLoadFailed = error?.condition === 'chat-load';
    const nodes = !chatLoadFailed && chat?.messages?.length ? transcriptNodes(chat) : [];
    const messageNodes = chatLoadFailed ? [chatLoadFailure()] : nodes.length ? nodes : [emptyState(chat, effectiveRuntime(s), s.installed?.length || 0)];
    const snapshotActive = Boolean(s.compressionState?.activeSnapshotId);
    clear(root).append(
      el('div', { class: `app-shell ${mobileSidebarOpen ? 'sidebar-open' : ''}`.trim() },
        sidebar(sidebarProps(s)),
        el('button', { class: 'sidebar-scrim', type: 'button', 'aria-label': 'Close chats sidebar', hidden: !mobileSidebarOpen, onClick: () => { mobileSidebarOpen = false; render(); } }),
        el('main', { class: 'main-chat', 'data-signature-surface': chat?.messages?.length ? 'live-conversation' : 'empty-chat' },
          el('header', { class: 'chat-top global-header' },
            el('button', { class: 'icon-btn mobile-sidebar-trigger', type: 'button', 'aria-label': 'Open chats sidebar', 'aria-expanded': String(mobileSidebarOpen), onClick: () => { mobileSidebarOpen = true; render(); }, text: '☰' }),
            el('div', { class: 'chat-top-title' }, el('span', { class:'chat-title-line' }, el('h3', { text: chat?.title || 'New chat' }), betaBadge())),
            el('span', { class: 'global-header-spacer', 'aria-hidden': 'true' }),
            el('span', { class: 'chat-privacy-promise' }, privacyIndicator(s, { compact: true })),
            mainNavigation('chat', (route, id) => { if (route === 'chat') onRoute(route, id); else routeAfterDraft(route, id); })),
          chat?.messages?.length ? el('div', { class: 'chat-context-strip' }, el('div', { class: 'content-container context-strip-inner' },
            automaticCompressionNotice ? el('span', { class: 'compression-applied-note', text: 'Older parts were compressed automatically. Review or undo it here.' }) : null,
            snapshotActive && transcriptMode === 'active' ? el('span', { class: 'muted', text: 'Regular messages are kept verbatim. “Condensed” cards are summaries.' }) : null,
            compressionControls())) : null,
          el('div', { class: 'chat-stage' },
            el('section', { class: 'conversation', 'data-scroll-region': 'transcript', 'aria-live': 'polite', 'aria-busy': String(busy) }, el('div', { class: 'conversation-inner' }, ...messageNodes)),
            el('button', { class: 'btn primary jump-latest', type: 'button', hidden: true, onClick: jumpLatest, text: 'Jump to latest' })),
          chatLoadFailed ? null : composerElement(s))));
    renderChatOverlay();
    bindScroll();
    syncJump();
  }

  return {
    mount(node) { root = node; startActivationStateWatch(); load(); },
    unmount() { root?.querySelector('.composer-dock')?.destroy?.(); flushDraft().catch(() => {}); stopRuntimeEvents(); activationStateCleanup?.(); activationStateCleanup = null; clearTimeout(searchTimer); clearTimeout(sidebarPatchTimer); clearTimeout(draftTimer); clearTimeout(contextPreviewTimer); deletingChats.clear(); for (const stream of runStreams.values()) stream.controller.abort(); runStreams.clear(); workEventReconciler.destroy(); activeRuns.clear(); stoppingChats.clear(); busyStartedAt.clear(); faviconMotion.stop(); releaseMessageViewState(root); hideOverlay(root, { restoreFocus: false }); root = null; },
  };
}
