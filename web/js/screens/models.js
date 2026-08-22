import { api } from '../api.js';
import { state } from '../state.js';
import { el, clear } from '../components/dom.js';
import { topNav } from '../components/nav.js';
import { modelCard, customModelRow, patchDownloadProgress } from '../components/model-card.js';
import { createDownloadProgressGate } from '../components/download-progress.js';
import { modal } from '../components/modal.js';
import { showOverlay, hideOverlay } from '../components/overlay.js';
import { consumeEventSource, consumeRuntimeSource } from '../stream.js';
import { bytes } from '../format.js';
import { conditionError } from '../condition-error.js';
import { providerMark } from '../components/provider-mark.js';
import {
  DEFAULT_MODEL_BROWSER, sanitizeBrowserState, browseModels, browserFacets,
  machineClassCounts, purposeLabel, purposesFor, inputsFor, fileTypesFor,
} from '../model-browser.js';

const LIVE_DOWNLOAD_STATES = new Set(['downloading', 'waiting', 'checking', 'paused', 'restarting']);
const TERMINAL_DOWNLOAD_STATES = new Set(['completed', 'cancelled', 'failed']);
const BROWSER_STORAGE_KEY = 'kl01-model-browser-v1';

function loadBrowserState() {
  try { return sanitizeBrowserState(JSON.parse(localStorage.getItem(BROWSER_STORAGE_KEY) || '{}')); }
  catch { return { ...DEFAULT_MODEL_BROWSER }; }
}

function persistBrowserState(value) {
  try { localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(value)); } catch {}
}

function capital(value) {
  const text = String(value || '');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

export function createModelsScreen({ onRoute }) {
  let root;
  let advancedOpen = false;
  let sideloadOpen = false;
  let sideloadPath = '';
  let sideloadError = null;
  let removeModelId = null;
  let removeModelError = null;
  let removeModelBusy = false;
  let detailModelId = null;
  let licenceModelId = null;
  let firstRender = true;
  let focusModelId = null;
  let browser = loadBrowserState();
  let restoreControl = null;
  const completedHandoffs = new Set();
  const downloadSubscriptions = new Map();
  const downloadGates = new Map();
  const downloadStarts = new Set();
  const downloadCommands = new Set();
  let sideloadDialogNode = null;
  let overlayTrigger = null;
  let runtimeEventsCleanup = null;
  let targetRefreshTimer = null;
  let restartBusy = false;
  let restartError = null;

  function scrollNode() { return root?.querySelector('[data-scroll-region="models"]') || null; }
  function routeAway(route) { onRoute(route); }
  function ensureShell() {
    let node = scrollNode();
    if (node || !root) return node;
    node = el('main', { class: 'setup-main page-scroll', 'data-scroll-region': 'models' });
    clear(root).append(el('div', { class: 'setup-shell' }, topNav('models', routeAway), node));
    return node;
  }
  function rerender(fn = render) { fn(); }

  function setBrowser(patch, { focus = null } = {}) {
    browser = sanitizeBrowserState({ ...browser, ...patch });
    persistBrowserState(browser);
    restoreControl = focus;
    rerender();
  }

  async function load() {
    state.set({ busy: true, error: null });
    try {
      const [catalogue, installed, runtime] = await Promise.all([api.models(), api.installed(), api.runtime()]);
      const statusPairs = await Promise.all(catalogue.entries.map(async entry => [entry.id, await api.downloadStatus(entry.id)]));
      const downloads = Object.fromEntries(statusPairs);
      state.set({ machine: catalogue.machine, catalogue: catalogue.entries, quarantined: catalogue.quarantined, installed: installed.models, executionTargets:installed.targets||[], executionResources:installed.resources||null, settings: installed.settings, downloads, busy: false });
      state.setRuntime(runtime);
      document.documentElement.dataset.theme = installed.settings?.appearance?.theme || 'dark';
      document.documentElement.dataset.textSize = installed.settings?.appearance?.textSize || 'default';
      for (const [id, job] of statusPairs) {
        downloadGates.set(id, createDownloadProgressGate(next => applyDownload(id, next), job));
        if (LIVE_DOWNLOAD_STATES.has(job.state)) watchDownload(id);
      }
      render();
      requestAnimationFrame(() => {
        if (focusModelId) {
          root.querySelector(`[data-model-id="${CSS.escape(focusModelId)}"] button`)?.focus();
          focusModelId = null;
        } else if (restoreControl) {
          const target = root.querySelector(`[data-browser-control="${restoreControl}"]`);
          target?.focus({ preventScroll: true });
          if (restoreControl === 'search' && target?.setSelectionRange) target.setSelectionRange(target.value.length, target.value.length);
          restoreControl = null;
        } else if (firstRender) {
          root.querySelector('h1')?.focus({ preventScroll: true });
          firstRender = false;
        }
      });
    } catch {
      state.set({ busy: false, error: conditionError('models-load', 'Models did not load.') });
      render();
    }
  }

  function modelContext(snapshot = state.get()) {
    const installedIds = new Set(snapshot.installed.map(model => model.id));
    const liveDownloadIds = new Set(Object.entries(snapshot.downloads || {}).filter(([, job]) => LIVE_DOWNLOAD_STATES.has(job?.state)).map(([id]) => id));
    const selectedId=snapshot.runtime?.selectedTarget?.kind==='local'?snapshot.runtime.selectedTarget.id:(snapshot.settings?.activeModelId||null);
    const targetById=new Map((snapshot.executionTargets||[]).filter(t=>t.kind==='local').map(t=>[t.id,t]));
    return { installedIds, liveDownloadIds, selectedId, targetById };
  }

  function entryNode(entry, snapshot = state.get(), { promoted = false, pulse = false } = {}) {
    const context = modelContext(snapshot);
    return modelCard({
      entry,
      installed: context.installedIds.has(entry.id),
      active: entry.id === context.selectedId && Boolean(context.targetById.get(entry.id)?.state?.loaded),
      selected: entry.id === context.selectedId,
      target: context.targetById.get(entry.id) || null,
      job: snapshot.downloads?.[entry.id],
      promoted,
      pulse,
      onDownload: download,
      onUse: useModel,
      onRemove: (id, trigger) => { overlayTrigger = trigger || document.activeElement; removeModelId = id; removeModelError = null; renderModelsOverlay(); },
      onPause: pause,
      onResume: resume,
      onCancel: cancel,
      onSideload: trigger => { overlayTrigger = trigger || document.activeElement; advancedOpen = true; sideloadOpen = true; render(); },
      onMoreInfo: (id, trigger) => { overlayTrigger = trigger || document.activeElement; detailModelId = id; renderModelsOverlay(); },
    });
  }

  function replaceEntry(id) {
    const snapshot = state.get();
    const entry = snapshot.catalogue.find(item => item.id === id);
    if (!entry || !root) return false;
    const current = root.querySelector(`[data-model-id="${CSS.escape(id)}"]`);
    if (!current) return false;
    current.replaceWith(entryNode(entry, snapshot));
    return true;
  }

  function applyDownload(id, job) {
    const downloads = state.get().downloads || {};
    const previous = downloads[id];
    state.set({ downloads: { ...downloads, [id]: job } });
    const node = root?.querySelector(`[data-model-id="${CSS.escape(id)}"]`);
    if (previous?.state === job.state && ['downloading', 'waiting'].includes(job.state) && patchDownloadProgress(node, job)) return;
    if (browser.availability === 'downloading') rerender();
    else if (!replaceEntry(id)) rerender();
  }

  function setDownload(id, job) {
    let gate = downloadGates.get(id);
    if (!gate) {
      gate = createDownloadProgressGate(next => applyDownload(id, next), state.get().downloads?.[id] || null);
      downloadGates.set(id, gate);
    }
    return gate(job);
  }

  function watchDownload(id) {
    if (downloadSubscriptions.has(id)) return;
    const close = consumeEventSource(api.openDownloadEvents(id), (_event, job) => {
      if (!job || typeof job !== 'object') return;
      setDownload(id, job);
      if (TERMINAL_DOWNLOAD_STATES.has(job.state)) {
        downloadSubscriptions.get(id)?.();
        downloadSubscriptions.delete(id);
        if (job.state === 'completed') void completeDownloadHandoff(id);
      }
    });
    downloadSubscriptions.set(id, close);
  }

  async function activateAndOpenChat(id, { waitUntilReady = false } = {}) {
    state.set({ pendingActivationId: id, activationError: null });
    try {
      const runtime = await api.activateModel(id);
      state.setRuntime(runtime);
      state.set({ pendingActivationId: null, activationError: null });
      routeAway('chat');
      return runtime;
    } catch (error) {
      state.set({ pendingActivationId: null, activationError: conditionError('runtime-model-ready', error.payload?.message || error.message || 'Model did not start.', error.payload || {}) });
      if (!waitUntilReady) routeAway('chat');
      else await load({ preserveScroll: true });
      return null;
    }
  }

  async function completeDownloadHandoff(id) {
    if (completedHandoffs.has(id)) return;
    completedHandoffs.add(id);
    focusModelId = id;
    try { await activateAndOpenChat(id, { waitUntilReady: true }); }
    finally { completedHandoffs.delete(id); }
  }

  async function useModel(id) { await activateAndOpenChat(id); }

  async function startDownload(id) {
    if (downloadStarts.has(id)) return;
    const entry = state.get().catalogue.find(item => item.id === id);
    downloadStarts.add(id);
    const previous = state.get().downloads?.[id] || { id, bytesReceived: 0, totalBytes: entry?.size || 0, speed: 0 };
    setDownload(id, { ...previous, id, state: 'downloading', speed: 0 });
    try { const job = await api.downloadModel(id); setDownload(id, job); watchDownload(id); }
    catch (error) { setDownload(id, { id, state: 'failed', bytesReceived: 0, totalBytes: previous.totalBytes || 0, speed: 0, error: error.payload || { message: error.message } }); }
    finally { downloadStarts.delete(id); }
  }

  async function download(id, trigger = null) {
    if (downloadStarts.has(id)) return;
    const entry = state.get().catalogue.find(item => item.id === id);
    if (entry?.licenceAcceptanceRequired) {
      licenceModelId = id;
      overlayTrigger = trigger;
      renderModelsOverlay();
      return;
    }
    await startDownload(id);
  }

  async function runDownloadCommand(id, kind, action) {
    const key = `${kind}:${id}`;
    if (downloadCommands.has(key)) return;
    downloadCommands.add(key);
    try { return await action(); } finally { downloadCommands.delete(key); }
  }

  async function pause(id) { return runDownloadCommand(id, 'pause', async () => { try { setDownload(id, await api.pauseDownload(id)); } catch (error) { setDownload(id, { ...state.get().downloads[id], state: 'failed', error: error.payload || { message: error.message } }); } }); }
  async function resume(id) { return runDownloadCommand(id, 'resume', async () => { try { const job = await api.resumeDownload(id); setDownload(id, job); watchDownload(id); } catch (error) { setDownload(id, { ...state.get().downloads[id], state: 'failed', error: error.payload || { message: error.message } }); } }); }
  async function cancel(id) { return runDownloadCommand(id, 'cancel', async () => { try { setDownload(id, await api.cancelDownload(id)); } catch (error) { setDownload(id, { ...state.get().downloads[id], state: 'failed', error: error.payload || { message: error.message } }); } }); }

  async function sideload() {
    if (!sideloadPath.trim()) return;
    sideloadError = null;
    try { await api.sideload(sideloadPath.trim()); sideloadOpen = false; sideloadPath = ''; await load({ preserveScroll: true }); }
    catch { sideloadError = conditionError('model-sideload', 'AI file was not added.'); renderModelsOverlay(); }
  }

  async function removeModel() {
    if (!removeModelId || removeModelBusy) return;
    removeModelBusy = true;
    removeModelError = null;
    renderModelsOverlay();
    try {
      const removedId = removeModelId;
      await api.removeModel(removedId);
      removeModelId = null;
      removeModelError = null;
      await load({ preserveScroll: true });
    } catch (caught) {
      removeModelError = conditionError('model-remove', caught?.message || 'Model was not removed.');
      state.set({ error: removeModelError });
      renderModelsOverlay();
    } finally {
      removeModelBusy = false;
      renderModelsOverlay();
    }
  }

  function sideloadDialog() {
    if (!sideloadOpen) return null;
    sideloadDialogNode = modal({
      title: 'Add an AI file',
      description: 'Choose a GGUF file already on this computer. The file is checked before it is added.',
      content: el('div', { class: 'config-form' },
        sideloadError ? el('div', { class: 'warning-note', role: 'alert', text: sideloadError.message }) : null,
        el('label', { class: 'label' }, el('span', { text: 'AI file' }), el('input', { class: 'field', value: sideloadPath, onInput: event => { sideloadPath = event.target.value; sideloadDialogNode?.setPrimaryDisabled?.(!sideloadPath.trim()); }, placeholder: 'Choose or paste the GGUF file location' })),
        el('p', { class: 'warning-note', text: 'Add only model files from a source you trust.' })),
      primaryLabel: 'Add AI',
      primaryDisabled: !sideloadPath.trim(),
      primaryDisabledReason: 'Enter the AI file location.',
      onPrimary: sideload,
      onClose: () => { sideloadOpen = false; sideloadError = null; renderModelsOverlay(); },
    });
    return sideloadDialogNode;
  }

  function removeDialog() {
    if (!removeModelId) return null;
    const model = state.get().installed.find(item => item.id === removeModelId);
    return modal({
      title: 'Remove this model',
      description: model ? `${model.displayName} will be removed and ${bytes(model.size)} will be freed. Chats are not changed.` : 'This model will be removed. Chats are not changed.',
      descriptionClass: model ? 'numeric' : '',
      content: removeModelError ? el('div', { class: 'warning-note', role: 'alert', text: removeModelError.message || 'Model was not removed.' }) : null,
      primaryLabel: removeModelBusy ? 'Removing…' : 'Remove',
      primaryDisabled: removeModelBusy,
      primaryDisabledReason: 'The model is being removed.',
      onPrimary: removeModel,
      onClose: () => { if (removeModelBusy) return; removeModelId = null; removeModelError = null; renderModelsOverlay(); },
    });
  }

  function detailRow(label, value, className = '') {
    return el('div', { class: `model-detail-row ${className}`.trim() }, el('dt', { text: label }), el('dd', { text: value || 'Unknown' }));
  }

  const CRITERIA_LABELS = Object.freeze({
    chat: 'Chat', writing: 'Writing', summarisation: 'Summaries', reasoning: 'Reasoning',
    coding: 'Coding', multilingual: 'Multilingual', longDocuments: 'Long documents',
  });

  function criteriaPanel(entry) {
    const criteria = Object.entries(entry.capabilityCriteria || {});
    if (!criteria.length) return null;
    const scores = criteria.map(([key, value]) => el('div', { class: 'capability-score' },
      el('span', { text: CRITERIA_LABELS[key] || capital(key) }),
      el('strong', { class: `rating-${value}`, text: String(value).replace('-', ' ') })));
    return el('section', { class: 'capability-criteria', 'aria-label': 'Fixed capability criteria' },
      el('div', { class: 'capability-criteria-heading' },
        el('h3', { text: 'Fixed capability profile' }),
        el('p', { class: 'muted', text: 'These labels describe the model. Quick, Balanced and Powerful describe how it fits this computer.' })),
      el('div', { class: 'capability-criteria-grid' }, ...scores));
  }

  function licenceDialog() {
    if (!licenceModelId) return null;
    const entry = state.get().catalogue.find(item => item.id === licenceModelId);
    if (!entry) { licenceModelId = null; return null; }
    const content = el('div', { class: 'model-licence-dialog' },
      el('p', { text: `${entry.name} is distributed under ${entry.licence || 'upstream model terms'}. These terms govern the model weights; they are separate from KL01's application notice.` }),
      entry.licenceUrl ? el('a', { class: 'model-licence-link', href: entry.licenceUrl, target: '_blank', rel: 'noreferrer', text: 'Open the upstream licence terms' }) : null,
      el('p', { class: 'muted', text: 'By continuing, you confirm that you reviewed and accept the upstream terms that apply to this model download.' }),
      el('div', { class: 'status-actions' },
        el('button', { class: 'btn', type: 'button', onClick: () => { licenceModelId = null; renderModelsOverlay(); }, text: 'Cancel' }),
        el('button', { class: 'btn blue', type: 'button', onClick: async () => { const id = licenceModelId; licenceModelId = null; renderModelsOverlay(); await startDownload(id); }, text: 'Accept terms and download' })));
    return modal({
      title: 'Model licence',
      description: `${entry.name} · ${entry.licence || 'Upstream terms'}`,
      content,
      onClose: () => { licenceModelId = null; renderModelsOverlay(); },
    });
  }

  function detailDialog() {
    if (!detailModelId) return null;
    const snapshot = state.get();
    const entry = snapshot.catalogue.find(item => item.id === detailModelId) || snapshot.installed.find(item => item.id === detailModelId);
    if (!entry) { detailModelId = null; return null; }
    const inputs = inputsFor(entry);
    const fileTypes = fileTypesFor(entry);
    const purposes = purposesFor(entry).map(purposeLabel);
    const nativeContext = Number(entry.nativeContextSize || entry.contextSize || 0);
    const target=(snapshot.executionTargets||[]).find(item=>item.kind==='local'&&item.id===entry.id)||null;
    const selectedId=snapshot.runtime?.selectedTarget?.kind==='local'?snapshot.runtime.selectedTarget.id:(snapshot.settings?.activeModelId||null);
    const stateInfo=target?.state||{};
    const healthLabel=stateInfo.healthy===true?'Healthy':stateInfo.healthy===false?'Unhealthy':'Not currently loaded/tested';
    const loadLabel=stateInfo.loaded?'Loaded':stateInfo.loadableNow===true?'Not loaded · loadable now':stateInfo.loadableNow===false?'Not loaded · memory tight':'Not loaded · availability estimated';
    const parallelLabel=target?.runtime?.parallelVerified?`Verified parallel ×${target.runtime.parallelCapacity}`:'Sequential unless separate model processes are available';
    const content = el('div', { class: 'model-details' },
      el('div', { class: 'model-details-hero' },
        providerMark(entry, { className: 'provider-logo detail-logo logo-box' }),
        el('div', {}, el('strong', { text: entry.family || entry.name || entry.displayName }), el('p', { class: 'muted', text: entry.description || 'Added from this computer.' }))),
      el('dl', { class: 'model-detail-list' },
        detailRow('Selected', entry.id===selectedId?'Yes · preference for the next run':'No'),
        detailRow('Runtime state', loadLabel),
        detailRow('Runtime health', healthLabel),
        detailRow('Active reservations', Number(stateInfo.reservedCount||0)?`${stateInfo.reservedCount} active run${stateInfo.reservedCount===1?'':'s'}`:'None'),
        detailRow('Execution capacity', parallelLabel),
        stateInfo.pendingRemoval?detailRow('Removal', 'Pending · no new runs can reserve this model'):null,
        detailRow('Computer fit', entry.machineFit?.label || 'Custom local model'),
        detailRow('Why', entry.machineFit?.reason || 'KL01 has not profiled this manually added model.'),
        detailRow('Provider', entry.providerName || 'Local file'),
        detailRow('Download size', bytes(entry.size || 0), 'numeric'),
        detailRow('Estimated memory', entry.machineFit?.memoryNeededBytes ? bytes(entry.machineFit.memoryNeededBytes) : 'Measured when launched', 'numeric'),
        detailRow('Quantization', entry.quantization || 'Unknown'),
        detailRow('Configured context', `${Number(entry.contextSize || 0).toLocaleString()} tokens`, 'numeric'),
        detailRow('Model-family maximum', nativeContext ? `${nativeContext.toLocaleString()} tokens` : 'Unknown', 'numeric'),
        detailRow('Primary type', purposeLabel(entry.primaryType || 'general')),
        detailRow('Purposes', purposes.join(', ') || 'General'),
        detailRow('Best for', entry.bestFor?.join(', ') || 'General local use'),
        detailRow('Not ideal for', entry.notIdealFor?.join(', ') || 'Tasks beyond the model size'),
        detailRow('Native inputs', inputs.map(capital).join(', ') || 'Text'),
        detailRow('Files KL01 can extract', fileTypes.length ? fileTypes.map(item => `.${item}`).join(', ') : 'None'),
        detailRow('Licence', entry.licence || 'Unknown')),
      entry.licenceUrl ? el('a', { class: 'model-licence-link', href: entry.licenceUrl, target: '_blank', rel: 'noreferrer', text: 'View model licence terms' }) : null,
      criteriaPanel(entry),
      el('p', { class: 'warning-note', text: entry.limitations || 'This build sends text only. File support means KL01 extracts local text and includes it in the conversation.' }));
    return modal({
      title: entry.name || entry.displayName || 'Model details',
      description: `${entry.providerName || 'Local file'} · ${entry.machineFit?.label || 'Local model'}`,
      content,
      onClose: () => { detailModelId = null; renderModelsOverlay(); },
    });
  }

  function renderModelsOverlay() {
    if (!root) return;
    const node = sideloadDialog() || removeDialog() || licenceDialog() || detailDialog();
    if (node) showOverlay(root, node, { trigger: overlayTrigger });
    else { hideOverlay(root); overlayTrigger = null; }
  }

  function selectControl({ label, control, value, options, onChange }) {
    const select = el('select', { class: 'field browser-select', 'aria-label': label, 'data-browser-control': control, onChange: event => onChange(event.target.value) },
      ...options.map(option => el('option', { value: option.value, text: option.label, disabled: option.disabled })));
    select.value = value;
    return el('label', { class: 'model-filter-field' }, el('span', { class: 'label', text: label }), select);
  }

  function filterChip(label, value, count) {
    const active = browser.machineClass === value;
    return el('button', {
      class: `nav-chip browser-chip machine-filter-${value} ${active ? 'active' : ''}`, 
      type: 'button',
      'aria-pressed': String(active),
      disabled: value !== 'all' && count === 0,
      onClick: () => setBrowser({ machineClass: value }, { focus: `class-${value}` }),
      'data-browser-control': `class-${value}`,
      text: `${label} ${count}`,
    });
  }

  function modelTypeGuide() {
    const cards = [
      ['quick', 'Quick', 'Small, responsive models for short chat, rewriting and simple tasks. This tag changes with the computer.'],
      ['balanced', 'Balanced', 'The sensible default: useful quality without consuming most of the machine. This tag changes with the computer.'],
      ['powerful', 'Powerful', 'The strongest models that still fit safely. They usually download more and answer more slowly.'],
      ['reasoning', 'Reasoning', 'Fixed specialist type for maths, logic and deliberate multi-step analysis.'],
      ['coding', 'Coding', 'Fixed specialist type for generating, explaining, editing and debugging code.'],
      ['long-context', 'Long context', 'Fixed specialist type for larger documents. More context still uses more memory at runtime.'],
    ];
    const guideCards = cards.map(([type, title, description]) => el('article', { class: `model-type-card type-${type}` },
      el('span', { class: `type-swatch type-${type}`, 'aria-hidden': 'true' }),
      el('div', {}, el('h3', { text: title }), el('p', { class: 'muted', text: description }))));
    return el('details', { class: 'model-type-guide card' },
      el('summary', { class: 'model-type-guide-summary' },
        el('span', {}, el('strong', { id: 'model-type-guide-title', text: 'What each model type means' }), el('span', { class: 'muted', text: 'Quick, Balanced and Powerful are relative to this computer.' })),
        el('span', { class: 'model-type-guide-action', text: 'See guide' })),
      el('div', { class: 'model-type-guide-body' },
        el('p', { class: 'muted', text: 'Computer-fit colours are dynamic. Specialist capability colours are fixed for each model.' }),
        el('div', { class: 'model-type-guide-grid' }, ...guideCards)));
  }

  function renderBrowser(snapshot, visible, context) {
    const facets = browserFacets(snapshot.catalogue);
    if (browser.provider !== 'all' && !facets.providers.some(item => item.id === browser.provider)) browser.provider = 'all';
    if (browser.purpose !== 'all' && !facets.purposes.includes(browser.purpose)) browser.purpose = 'all';
    if (browser.input !== 'all' && !facets.inputs.includes(browser.input)) browser.input = 'all';
    if (browser.fileType !== 'all' && !facets.fileTypes.includes(browser.fileType)) browser.fileType = 'all';
    const counts = machineClassCounts(snapshot.catalogue, browser, context);
    const search = el('input', {
      class: 'field model-search-field',
      type: 'search',
      value: browser.query,
      placeholder: 'Search models, providers, tasks or file types',
      'aria-label': 'Search models',
      'data-browser-control': 'search',
      onInput: event => setBrowser({ query: event.target.value }, { focus: 'search' }),
    });
    const primary = el('div', { class: 'model-browser-primary' },
      search,
      el('div', { class: 'model-class-filters', role: 'group', 'aria-label': 'Performance on this computer' },
        filterChip('All', 'all', counts.all),
        filterChip('Quick', 'quick', counts.quick),
        filterChip('Balanced', 'balanced', counts.balanced),
        filterChip('Powerful', 'powerful', counts.powerful)));
    const availabilityOptions = [
      { value: 'all', label: 'All availability' },
      { value: 'runs-now', label: 'Runs now' },
      { value: 'installed', label: 'On this computer' },
      { value: 'downloading', label: 'Downloading' },
    ];
    const sortOptions = [
      { value: 'quickest', label: 'Quickest on this computer' },
      { value: 'powerful', label: 'Most powerful that fits' },
      { value: 'installed', label: 'Installed first' },
      { value: 'smallest', label: 'Smallest download' },
      { value: 'context', label: 'Largest context' },
      { value: 'type', label: 'Model type' },
      { value: 'provider', label: 'Provider A–Z' },
      { value: 'name', label: 'Name A–Z' },
    ];
    const advanced = el('details', { class: 'model-filter-panel card' },
      el('summary', { text: 'Filters and sorting' }),
      el('div', { class: 'model-filter-grid' },
        selectControl({ label: 'Availability', control: 'availability', value: browser.availability, options: availabilityOptions, onChange: value => setBrowser({ availability: value }, { focus: 'availability' }) }),
        selectControl({ label: 'Provider', control: 'provider', value: browser.provider, options: [{ value: 'all', label: 'All providers' }, ...facets.providers.map(item => ({ value: item.id, label: item.name }))], onChange: value => setBrowser({ provider: value }, { focus: 'provider' }) }),
        selectControl({ label: 'Purpose', control: 'purpose', value: browser.purpose, options: [{ value: 'all', label: 'All purposes' }, ...facets.purposes.map(item => ({ value: item, label: purposeLabel(item) }))], onChange: value => setBrowser({ purpose: value }, { focus: 'purpose' }) }),
        selectControl({ label: 'Input', control: 'input', value: browser.input, options: [{ value: 'all', label: 'All inputs' }, ...facets.inputs.map(item => ({ value: item, label: capital(item) }))], onChange: value => setBrowser({ input: value }, { focus: 'input' }) }),
        selectControl({ label: 'File type', control: 'file-type', value: browser.fileType, options: [{ value: 'all', label: 'All supported files' }, ...facets.fileTypes.map(item => ({ value: item, label: `.${item}` }))], onChange: value => setBrowser({ fileType: value }, { focus: 'file-type' }) }),
        selectControl({ label: 'Sort by', control: 'sort', value: browser.sort, options: sortOptions, onChange: value => setBrowser({ sort: value }, { focus: 'sort' }) })),
      el('div', { class: 'model-filter-footer' },
        el('span', { class: 'muted numeric', text: `${visible.length} of ${snapshot.catalogue.length} models shown` }),
        el('button', { class: 'nav-chip', type: 'button', onClick: () => setBrowser({ ...DEFAULT_MODEL_BROWSER }), text: 'Reset filters' })));
    return el('section', { class: 'model-browser', 'aria-label': 'Browse local models' }, primary, advanced);
  }

  async function refreshExecutionState(){
    try{const [installed,runtime]=await Promise.all([api.installed(),api.runtime()]);state.set({installed:installed.models,executionTargets:installed.targets||[],executionResources:installed.resources||null,settings:installed.settings});state.setRuntime(runtime);if(root)render();}catch{}
  }
  function startRuntimeEvents(){if(runtimeEventsCleanup||!root)return;try{runtimeEventsCleanup=consumeRuntimeSource(api.openRuntimeEvents(),()=>{clearTimeout(targetRefreshTimer);targetRefreshTimer=setTimeout(()=>{targetRefreshTimer=null;refreshExecutionState();},80);targetRefreshTimer.unref?.();},status=>{if(status?.state==='reconnecting')api.health().catch(()=>{});});}catch{api.health().catch(()=>{});}}

  function runtimeRecovery(snapshot) {
    const runtime = snapshot.runtime || {};
    const target = runtime.selectedTarget;
    if (target?.kind !== 'local') return null;
    const canRestart = ['ready', 'failed', 'stopped', 'selected-pending'].includes(runtime.status);
    const description = runtime.status === 'failed'
      ? (runtime.failure?.message || 'The local AI stopped responding.')
      : runtime.status === 'ready'
        ? 'Restart it if generation becomes stuck or the process needs recovery.'
        : 'The selected local AI is not running yet.';
    return el('section', { class: `status-panel card ${runtime.status === 'failed' ? 'error' : ''}`, role: runtime.status === 'failed' ? 'alert' : 'status' },
      el('div', { class: 'status-copy' },
        el('strong', { text: `Local AI · ${target.name || target.id}` }),
        el('span', { class: 'muted', text: description }),
        restartError ? el('span', { class: 'error-text', role: 'alert', text: restartError }) : null),
      el('div', { class: 'status-actions' },
        el('button', {
          class: runtime.status === 'failed' ? 'btn primary' : 'btn',
          type: 'button',
          disabled: restartBusy || !canRestart,
          'aria-busy': String(restartBusy),
          onClick: async () => {
            if (restartBusy) return;
            restartBusy = true;
            restartError = null;
            render();
            try {
              state.setRuntime(await api.restartRuntime());
              await refreshExecutionState();
            } catch (error) {
              const failure = conditionError('runtime-model-ready', error.payload?.message || error.message || 'The local AI could not restart.', error.payload || {});
              restartError = failure.message;
              state.set({ activationError: failure });
              render();
            } finally {
              restartBusy = false;
              render();
            }
          },
          text: restartBusy ? 'Restarting…' : 'Restart AI',
        })));
  }

  function render() {
    if (!root) return;
    const snapshot = state.get();
    const context = modelContext(snapshot);
    const visible = browseModels(snapshot.catalogue, browser, context);
    const catalogueIds = new Set(snapshot.catalogue.map(entry => entry.id));
    const customInstalled = snapshot.installed.filter(model => !catalogueIds.has(model.id));
    const storageUsed = snapshot.installed.reduce((sum, model) => sum + Number(model.size || 0), 0);
    const hiddenDownloads = [...context.liveDownloadIds].filter(id => !visible.some(entry => entry.id === id));
    const content = el('div', { class: 'content-container', 'data-content-container': 'models', 'data-signature-surface': 'models' },
      el('div', { class: 'setup-heading' },
        el('div', { class: 'setup-heading-copy' },
          el('h1', { tabindex: '-1', text: 'Models' }),
          el('p', { class: 'muted', text: 'Find a model that fits this computer and the work you want to do.' }),
          el('p', { class: 'muted', text: 'Downloads use network. Local chat and text-file extraction do not.' }))),
      runtimeRecovery(snapshot),
      snapshot.error ? el('section', { class: 'status-panel card error', role: 'alert' }, el('span', { text: snapshot.error.message })) : null,
      storageUsed > 10 * 1000 ** 3 ? el('section', { class: 'storage-notice' },
        el('p', { class: 'numeric readout', text: `Models are using ${bytes(storageUsed)} on this computer.` }),
        el('div', { class: 'installed-model-list' }, ...snapshot.installed.map(model => el('div', { class: 'settings-row card' },
          el('span', { class: 'numeric readout', text: `${model.displayName} · ${bytes(model.size)}` }),
          el('button', { class: 'nav-chip', type: 'button', onClick: event => { overlayTrigger = event.currentTarget; removeModelId = model.id; removeModelError = null; renderModelsOverlay(); }, text: 'Remove' }))))) : null,
      renderBrowser(snapshot, visible, context),
      modelTypeGuide(),
      hiddenDownloads.length ? el('section', { class: 'hidden-downloads card', role: 'status' },
        el('strong', { text: `${hiddenDownloads.length} download${hiddenDownloads.length === 1 ? '' : 's'} hidden by filters` }),
        el('button', { class: 'nav-chip', type: 'button', onClick: () => setBrowser({ availability: 'downloading', machineClass: 'all', query: '' }), text: 'Show downloads' })) : null,
      visible.length
        ? el('div', { class: 'model-browser-grid catalogue-list', 'data-model-results': '' }, ...visible.map(entry => entryNode(entry, snapshot)))
        : el('section', { class: 'empty-model-results card' },
          el('h2', { text: 'No models match these filters' }),
          el('p', { class: 'muted', text: 'Clear the search or reset the filters. Downloads continue even when their cards are hidden.' }),
          el('button', { class: 'btn primary', type: 'button', onClick: () => setBrowser({ ...DEFAULT_MODEL_BROWSER }), text: 'Reset filters' })),
      el('section', { class: 'advanced-card card' },
        el('div', {},
          el('h3', { text: 'Advanced' }),
          advancedOpen ? el('p', { class: 'muted', text: 'Connect an external AI service or add a trusted GGUF file already on this computer.' }) : el('p', { class: 'muted', text: 'External connections and manually added model files.' })),
        el('div', { class: 'status-actions' },
          advancedOpen ? el('button', { class: 'btn blue', type: 'button', onClick: () => routeAway('settings'), text: 'External AI services' }) : null,
          advancedOpen ? el('button', { class: 'btn blue', type: 'button', onClick: event => { overlayTrigger = event.currentTarget; sideloadOpen = true; renderModelsOverlay(); }, text: 'Add an AI file' }) : null,
          el('button', { class: 'nav-chip', type: 'button', 'data-advanced-toggle': '', 'aria-expanded': String(advancedOpen), onClick: () => { advancedOpen = !advancedOpen; rerender(); requestAnimationFrame(() => root?.querySelector('[data-advanced-toggle]')?.focus()); }, text: advancedOpen ? 'Hide Advanced' : 'Advanced' }))),
      advancedOpen && customInstalled.length ? el('div', { class: 'model-browser-grid catalogue-list' }, ...customInstalled.map(model => customModelRow({
        model,
        active: model.id === context.selectedId && Boolean(context.targetById.get(model.id)?.state?.loaded),
        selected: model.id === context.selectedId,
        target: context.targetById.get(model.id) || null,
        onRemove: (id, trigger) => { overlayTrigger = trigger || document.activeElement; removeModelId = id; removeModelError = null; renderModelsOverlay(); },
        onMoreInfo: (id, trigger) => { overlayTrigger = trigger || document.activeElement; detailModelId = id; renderModelsOverlay(); },
      }))) : null,
      snapshot.runtime?.status === 'failed' ? el('p', { class: 'warning-note', text: 'The selected AI could not start; open Chat and select Try again.' }) : null);
    const node = ensureShell();
    if (!node) return;
    clear(node).append(content);
    renderModelsOverlay();
    requestAnimationFrame(() => {
      if (!restoreControl) return;
      const target = root?.querySelector(`[data-browser-control="${restoreControl}"]`);
      target?.focus({ preventScroll: true });
      if (restoreControl === 'search' && target?.setSelectionRange) target.setSelectionRange(target.value.length, target.value.length);
      restoreControl = null;
    });
  }

  return {
    mount(node) { root = node; ensureShell(); load().then(()=>startRuntimeEvents()); },
    unmount() {
      runtimeEventsCleanup?.();runtimeEventsCleanup=null;clearTimeout(targetRefreshTimer);targetRefreshTimer=null;
      for (const close of downloadSubscriptions.values()) close();
      downloadSubscriptions.clear();
      downloadGates.clear();
      downloadStarts.clear();
      downloadCommands.clear();
      completedHandoffs.clear();
      sideloadDialogNode = null;
      if (root) hideOverlay(root, { restoreFocus: false });
      root = null;
    },
  };
}
