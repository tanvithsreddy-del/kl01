import { el, cssTime } from './dom.js';
import { conditionError } from '../condition-error.js';
import { acceptedFileAttribute, fileTypeLabel } from '../attachments.js';
import { betaNote } from './beta.js';

export const CAPACITY_THRESHOLDS = Object.freeze([70, 85, 100]);
export function capacityThresholdPixel(width, percent) {
  const w = Math.max(0, Number(width) || 0);
  const p = Math.min(100, Math.max(0, Number(percent) || 0));
  return w * p / 100;
}

export function shouldSubmit(event, mode) {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return false;
  if (mode === 'button') return false;
  if (mode === 'ctrl-enter') return event.ctrlKey && !event.shiftKey;
  return !event.shiftKey && !event.ctrlKey && !event.metaKey;
}

function ready(runtime) { return Boolean(runtime && ['ready', 'external-ready'].includes(runtime.status)); }
function attachmentName(item) { return String(item?.name || 'Attached file'); }
function attachmentId(item) { return String(item?.id || item?.clientId || ''); }

export function composer({
  draft,
  context,
  runtime,
  installedCount = 0,
  busy,
  stopping = false,
  busyStartedAt = null,
  error,
  preferences = {},
  instruments = [],
  attachments = [],
  acceptedFileTypes = [],
  attachmentError = null,
  groundingRisk = null,
  onPersistDraft,
  onPreviewDraft,
  onSend,
  onStop,
  onNewChat,
  onCompress,
  onChooseFiles,
  onRemoveAttachment,
}) {
  let currentContext = context || null;
  let currentRuntime = runtime || null;
  let currentInstalledCount = installedCount;
  let currentBusy = Boolean(busy);
  let currentStopping = Boolean(stopping);
  let currentBusyStartedAt = busyStartedAt ? Number(busyStartedAt) : (currentBusy ? Date.now() : null);
  let currentError = error || null;
  let currentAttachments = Array.isArray(attachments) ? [...attachments] : [];
  let currentAcceptedFileTypes = Array.isArray(acceptedFileTypes) ? [...acceptedFileTypes] : [];
  let currentAttachmentError = attachmentError || null;
  let currentGroundingRisk = groundingRisk || null;
  let draftError = null;
  let persistTimer = null;
  let previewTimer = null;
  let elapsedTimer = null;
  const sendingMode = preferences.sending || 'enter';

  const textarea = el('textarea', { class: 'composer-text', 'aria-label': 'Message' });
  textarea.value = String(draft || '');

  const noticeHost = el('div', { class: 'composer-notices' });
  const attachmentHost = el('div', { class: 'composer-attachment-list', 'aria-live': 'polite' });
  const fileInput = el('input', { class: 'composer-file-input', type: 'file', multiple: true, hidden: true });
  const capacityLabel = el('span', { text: 'Conversation length' });
  const capacityMeter = el('div', { class: 'capacity-meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' },
    el('span', { class: 'capacity-fill' }),
    ...CAPACITY_THRESHOLDS.map(percent => el('span', { class: 'capacity-threshold numeric', 'data-capacity-threshold': String(percent), style: `left:${percent}%`, text: String(percent) })));
  const capacityValue = el('span', { class: 'numeric readout' });
  const instrumentCluster = el('div', { class: 'instrument-cluster' }, ...instruments);
  const capacityRow = el('div', { class: 'capacity-line instrument-row' },
    instrumentCluster,
    el('div', { class: 'capacity-instrument readout' }, capacityLabel, capacityMeter, capacityValue));
  const left = el('div', { class: 'composer-left' });
  const right = el('div', { class: 'composer-right' });
  const composerBox = el('div', { class: 'composer' },
    attachmentHost,
    el('div', { class: 'composer-top' }, textarea),
    el('div', { class: 'composer-bottom' }, left, right));
  const dock = el('div', { class: 'composer-dock' }, el('div', { class: 'content-container' }, noticeHost, capacityRow, composerBox));
  let sendControl = null;
  let attachControl = null;

  function placeholder() {
    if (currentRuntime?.status === 'starting') return 'Starting the model…';
    if (!ready(currentRuntime)) return currentInstalledCount ? 'Choose AI to start chatting' : 'Set up AI to start chatting';
    return 'Ask KL01 anything';
  }

  function renderLengthValue() {
    if (!currentContext?.limit) { capacityValue.textContent = '—'; capacityValue.removeAttribute('data-motion-value'); return; }
    if (preferences.conversationLengthAs === 'percentage') {
      capacityValue.textContent = `${Math.round(Math.min(100, Math.max(0, (currentContext.ratio || 0) * 100)))}%`;
      return;
    }
    if (Number.isFinite(currentContext.messagesLeft)) capacityValue.textContent = `≈ ${Math.round(currentContext.messagesLeft)} messages left`;
    else { capacityValue.textContent = '—'; capacityValue.removeAttribute('data-motion-value'); }
  }

  function renderNotices() {
    noticeHost.replaceChildren(betaNote());
    if (currentGroundingRisk) noticeHost.append(el('div', { class:'grounding-risk-banner', role:'alert' }, el('strong', { text:`! ${currentGroundingRisk.title}` }), el('span', { text:currentGroundingRisk.message })));
    if (currentError) noticeHost.append(el('div', { class: 'warning-note', role: 'alert' }, el('strong', { text: currentError.message })));
    if (currentAttachmentError) noticeHost.append(el('div', { class: 'warning-note attachment-warning', role: 'alert', text: String(currentAttachmentError.message || currentAttachmentError) }));
    if (draftError) noticeHost.append(el('div', { class: 'warning-note', role: 'alert', text: 'Draft could not be saved; keep this chat open and type again to retry.' }));
    const full = currentContext?.state === 'full';
    const canCompress = currentContext?.compression?.whenFull !== 'new-chat';
    if (full) {
      noticeHost.append(el('div', { class: 'warning-note compression-offer' },
        el('span', { text: canCompress ? 'This conversation is full. Compress older parts or start a new chat.' : 'This conversation is full. Start a new chat.' }),
        el('div', { class: 'warning-actions' },
          canCompress ? el('button', { class: 'btn primary', type: 'button', onClick: event => onCompress?.(event.currentTarget), text: 'Compress this chat' }) : null,
          el('button', { class: 'btn', type: 'button', onClick: event => onNewChat?.(event.currentTarget), text: 'Start a new chat' }))));
    } else if (currentContext?.compression?.offer && canCompress) {
      noticeHost.append(el('div', { class: 'warning-note compression-offer' },
        el('span', { text: currentContext.note || 'This conversation is getting long.' }),
        el('button', { class: 'nav-chip', type: 'button', onClick: event => onCompress?.(event.currentTarget), text: 'Compress older parts' })));
    } else if (currentContext?.note) noticeHost.append(el('div', { class: 'warning-note', text: currentContext.note }));
  }

  function renderAttachments() {
    attachmentHost.replaceChildren();
    for (const attachment of currentAttachments) {
      attachmentHost.append(el('span', { class: 'attachment-chip', title: `${attachmentName(attachment)} · ${Number(attachment.size || 0).toLocaleString()} bytes` },
        el('span', { class: 'attachment-chip-name', text: attachmentName(attachment) }),
        el('button', {
          class: 'attachment-remove',
          type: 'button',
          disabled: currentBusy,
          'aria-label': `Remove ${attachmentName(attachment)}`,
          onClick: () => onRemoveAttachment?.(attachmentId(attachment)),
          text: '×',
        })));
    }
    attachmentHost.hidden = currentAttachments.length === 0;
  }

  function renderAttachmentControl() {
    if (attachControl) attachControl.remove();
    attachControl = null;
    fileInput.accept = acceptedFileAttribute(currentAcceptedFileTypes);
    const supported = currentAcceptedFileTypes.length > 0;
    if (!supported) return;
    const label = currentAcceptedFileTypes.map(fileTypeLabel).join(', ');
    attachControl = el('button', {
      class: 'nav-chip attach-file-control',
      type: 'button',
      disabled: currentBusy || !ready(currentRuntime),
      title: `Attach supported local text or code files: ${label}. Images, audio, and video are not accepted.`,
      'aria-label': `Attach text files. Supported types: ${label}`,
      onClick: () => fileInput.click(),
      text: 'Attach text',
    });
    left.append(fileInput, attachControl);
  }

  function renderCapacity() {
    const ratio = currentContext?.ratio || 0;
    const value = Math.min(100, Math.round(ratio * 100));
    capacityMeter.className = `capacity-meter ${currentContext?.state || ''}`;
    capacityMeter.style.setProperty('--capacity', `${value}%`);
    capacityMeter.setAttribute('aria-valuenow', String(value));
    renderLengthValue();
  }

  function scheduleElapsed(stopButton) {
    clearTimeout(elapsedTimer); elapsedTimer = null;
    if (!currentBusy || !currentBusyStartedAt || !stopButton) return;
    const threshold = cssTime('--kl01-wait-elapsed');
    const tick = cssTime('--kl01-elapsed-tick');
    if (!(threshold > 0) || !(tick > 0)) return;
    const update = () => {
      if (!currentBusy || !stopButton.isConnected || !currentBusyStartedAt) return;
      const elapsedMs = Math.max(0, Date.now() - currentBusyStartedAt);
      if (elapsedMs < threshold) {
        elapsedTimer = setTimeout(update, Math.max(0, threshold - elapsedMs));
        return;
      }
      stopButton.classList.add('long-wait');
      let value = stopButton.querySelector('.elapsed-value');
      if (!value) { value = el('span', { class: 'elapsed-value numeric readout', 'aria-label': 'Elapsed time' }); stopButton.append(value); }
      value.textContent = `${Math.floor(elapsedMs / 1000)}s`;
      elapsedTimer = setTimeout(update, tick);
    };
    update();
  }

  function updateSend() {
    const isReady = ready(currentRuntime);
    const full = currentContext?.state === 'full';
    const hasInput = Boolean(textarea.value.trim() || currentAttachments.length);
    const disabled = !isReady || full || !hasInput;
    textarea.disabled = !isReady;
    composerBox.classList.toggle('not-ready', !isReady);
    capacityRow.hidden = !isReady;
    textarea.placeholder = placeholder();
    textarea.setAttribute('aria-label', isReady ? 'Message' : `${placeholder()}. Message field disabled until AI is ready.`);
    if (sendControl) sendControl.remove();
    const stoppable = currentBusy;
    const label = !isReady ? 'Send disabled until AI is ready' : full ? 'Send disabled because this conversation is full' : !hasInput ? 'Send disabled: no message or attachment.' : 'Send message';
    sendControl = stoppable
      ? el('button', {
          class: 'btn danger stop-control',
          type: 'button',
          disabled: currentStopping,
          'aria-live': 'polite',
          'aria-label': currentStopping ? 'Stopping response' : 'Stop response',
          onClick: onStop,
        }, el('span', { text: currentStopping ? 'Stopping…' : 'Stop' }))
      : el('button', { class: 'btn primary', type: 'button', 'aria-label': label, disabled, onClick: () => onSend?.(textarea.value, currentAttachments), text: 'Send' });
    right.append(sendControl);
    renderAttachmentControl();
    if (currentBusy) scheduleElapsed(sendControl); else { clearTimeout(elapsedTimer); elapsedTimer = null; }
  }

  function applyContext(next) {
    currentContext = next || currentContext;
    renderNotices();
    renderCapacity();
    updateSend();
  }

  async function persistNow() {
    clearTimeout(persistTimer); persistTimer = null;
    try {
      await onPersistDraft?.(textarea.value);
      if (draftError) { draftError = null; renderNotices(); }
    } catch (caught) {
      draftError = conditionError('draft-save', 'Draft was not saved.', { cause: caught?.message || '' });
      renderNotices();
      throw caught;
    }
  }

  function scheduleWork() {
    clearTimeout(persistTimer);
    clearTimeout(previewTimer);
    const delay = cssTime('--kl01-draft-debounce');
    persistTimer = setTimeout(() => { persistNow().catch(() => {}); }, delay);
    previewTimer = setTimeout(async () => {
      previewTimer = null;
      try {
        const next = await onPreviewDraft?.(textarea.value, currentAttachments);
        if (next) applyContext(next);
      } catch {}
    }, delay);
  }

  fileInput.addEventListener('change', async event => {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (!files.length) return;
    await onChooseFiles?.(files);
  });
  textarea.addEventListener('input', () => { updateSend(); scheduleWork(); });
  textarea.addEventListener('keydown', event => {
    if (!shouldSubmit(event, sendingMode)) return;
    event.preventDefault();
    const hasInput = Boolean(textarea.value.trim() || currentAttachments.length);
    if (!currentBusy && ready(currentRuntime) && currentContext?.state !== 'full' && hasInput) onSend?.(textarea.value, currentAttachments);
  });

  dock.getDraft = () => textarea.value;
  dock.getAttachments = () => [...currentAttachments];
  dock.flushDraft = persistNow;
  dock.setDraft = value => { textarea.value = String(value || ''); updateSend(); };
  dock.setAttachments = (nextAttachments = [], nextError = null) => {
    currentAttachments = Array.isArray(nextAttachments) ? [...nextAttachments] : [];
    currentAttachmentError = nextError || null;
    renderAttachments();
    renderNotices();
    updateSend();
  };
  dock.setAttachmentSupport = nextTypes => {
    currentAcceptedFileTypes = Array.isArray(nextTypes) ? [...nextTypes] : [];
    renderAttachmentControl();
  };
  dock.setInstruments = nextInstruments => { instrumentCluster.replaceChildren(...(Array.isArray(nextInstruments) ? nextInstruments.filter(Boolean) : [])); };
  dock.setRuntime = (nextRuntime, nextInstalledCount = currentInstalledCount) => {
    currentRuntime = nextRuntime;
    currentInstalledCount = nextInstalledCount;
    updateSend();
  };
  dock.setBusy = (nextBusy, startedAt = null, nextStopping = false) => { currentBusy = Boolean(nextBusy); currentStopping = currentBusy && Boolean(nextStopping); currentBusyStartedAt = currentBusy ? Number(startedAt || currentBusyStartedAt || Date.now()) : null; updateSend(); renderAttachments(); };
  dock.setError = nextError => { currentError = nextError || null; renderNotices(); };
  dock.setGroundingRisk = nextRisk => { currentGroundingRisk = nextRisk || null; renderNotices(); };
  dock.setContext = applyContext;
  dock.destroy = () => { clearTimeout(persistTimer); clearTimeout(previewTimer); clearTimeout(elapsedTimer); };

  renderAttachments();
  renderNotices();
  renderCapacity();
  updateSend();
  return dock;
}
