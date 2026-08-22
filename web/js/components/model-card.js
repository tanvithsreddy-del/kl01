import { el } from './dom.js';
import { bytes } from '../format.js';
import { progressPercent } from './download-progress.js';
import { purposeLabel, purposesFor, inputsFor, fileTypesFor } from '../model-browser.js';
import { providerMark } from './provider-mark.js';

const ACTIVE_DOWNLOAD_STATES = new Set(['downloading', 'waiting', 'checking', 'paused', 'restarting']);

function nextTry(job) {
  if (!job?.nextAttemptAt) return 30;
  return Math.max(1, Math.ceil((new Date(job.nextAttemptAt).getTime() - Date.now()) / 1000));
}

export const progress = progressPercent;

function downloadState(job, entry, controls) {
  if (!job || job.state === 'idle' || job.state === 'completed' || job.state === 'cancelled') return null;
  const meter = el('div', { class: 'progress readout', 'data-download-progress': 'meter', style: `--progress:${progress(job)}%`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(progress(job)), 'aria-label': `Download progress for ${entry.name}` }, el('span'));
  if (job.state === 'checking') return el('div', { class: 'transfer-card state-crossfade' }, el('strong', { text: 'Checking the download' }));
  if (job.state === 'waiting') {
    const retry = el('span', { 'data-download-progress': 'retry', text: String(nextTry(job)) });
    return el('div', { class: 'transfer-card state-crossfade', 'data-download-state': job.state },
      meter,
      el('p', { class: 'meta muted numeric' }, 'Waiting for connection. Next try in ', retry, ' seconds.'),
      el('div', { class: 'status-actions' }, el('button', { class: 'btn', type: 'button', onClick: controls.onCancel, text: 'Cancel' })));
  }
  if (job.state === 'paused') return el('div', { class: 'transfer-card state-crossfade' },
    meter,
    el('p', { class: 'meta muted numeric', text: `Paused at ${bytes(job.bytesReceived)} of ${bytes(job.totalBytes)}` }),
    el('div', { class: 'status-actions' },
      el('button', { class: 'btn blue', type: 'button', onClick: controls.onResume, text: 'Resume' }),
      el('button', { class: 'btn', type: 'button', onClick: controls.onCancel, text: 'Cancel' })));
  if (job.state === 'failed') return el('div', { class: 'transfer-card failure-card state-crossfade' },
    el('p', { text: 'The download could not finish; select Try again.' }),
    el('button', { class: 'btn blue', type: 'button', onClick: controls.onResume, text: 'Try again' }));
  if (job.state === 'restarting') return el('div', { class: 'transfer-card state-crossfade' },
    el('p', { class: 'meta muted numeric', text: 'The download needs to restart; wait for it to begin again, or select Cancel.' }),
    el('button', { class: 'btn', type: 'button', onClick: controls.onCancel, text: 'Cancel' }));
  return el('div', { class: 'transfer-card state-crossfade' },
    meter,
    el('div', { class: 'transfer-stats readout numeric' },
      el('span', { 'data-download-progress': 'bytes', text: `${bytes(job.bytesReceived)} of ${bytes(job.totalBytes)}` }),
      el('span', { 'data-download-progress': 'speed', text: job.speed ? `${bytes(job.speed)}/s` : 'Starting' })),
    el('div', { class: 'status-actions' },
      el('button', { class: 'btn', type: 'button', onClick: controls.onPause, text: 'Pause' }),
      el('button', { class: 'btn', type: 'button', onClick: controls.onCancel, text: 'Cancel' })));
}

export function patchDownloadProgress(modelNode, job) {
  if (!modelNode || !job) return false;
  const meter = modelNode.querySelector?.('[data-download-progress="meter"]');
  const bytesNode = modelNode.querySelector?.('[data-download-progress="bytes"]');
  const speedNode = modelNode.querySelector?.('[data-download-progress="speed"]');
  const retryNode = modelNode.querySelector?.('[data-download-progress="retry"]');
  if (!meter) return false;
  const value = progress(job);
  meter.style.setProperty('--progress', `${value}%`);
  meter.setAttribute('aria-valuenow', String(value));
  if (job.state === 'waiting' && retryNode) {
    retryNode.textContent = String(Math.max(1, Math.ceil(nextTry(job))));
    return true;
  }
  if (!bytesNode || !speedNode || job.state !== 'downloading') return false;
  bytesNode.textContent = `${bytes(job.bytesReceived)} of ${bytes(job.totalBytes)}`;
  if (job.speed) speedNode.textContent = `${bytes(job.speed)}/s`;
  else { speedNode.textContent = 'Starting'; speedNode.removeAttribute('data-motion-value'); }
  return true;
}

export function availabilityReason(entry, { installed = false, target = null } = {}) {
  const availability = entry.availability || {};
  if(target?.state?.pendingRemoval)return 'Removal is pending; new work cannot reserve this model.';
  if(target?.state?.failure?.message)return target.state.failure.message;
  if (availability.engineBlocked) return installed
    ? 'The local AI engine is unavailable; repair the engine before using this model.'
    : 'Automatic local-model setup is unavailable; add a trusted GGUF file instead.';
  if (!installed && availability.spaceBlocked) return `Downloading needs ${bytes(availability.neededBytes)} of free space; ${bytes(availability.freeBytes)} is available.`;
  if (availability.memoryBlocked) return `Running needs about ${bytes(availability.memoryNeededBytes)} available memory; ${bytes(availability.memoryAvailableBytes)} is available now.`;
  return entry.machineFit?.reason || null;
}

function quietRemove(entry, onRemove) {
  return el('button', { class: 'nav-chip', type: 'button', onClick: event => onRemove(entry.id, event.currentTarget), text: 'Remove' });
}

function installedActions(entry, active, onUse, onRemove, { selected=false, target=null } = {}) {
  if (target?.state?.pendingRemoval) return el('div',{class:'model-row-actions'},el('span',{class:'pill',text:'Removal pending'}));
  if (active) return el('div', { class: 'model-row-actions' }, el('span', { class: 'pill green', text: target?.state?.reservedCount ? `In use · ${target.state.reservedCount} run${target.state.reservedCount===1?'':'s'}` : 'In use' }), quietRemove(entry, onRemove));
  if (selected) return el('div',{class:'model-row-actions'},el('span',{class:'pill green',text:'Selected · next run'}),quietRemove(entry,onRemove));
  const canRun = entry.availability?.canRun !== false && target?.state?.pendingRemoval !== true;
  return el('div', { class: 'model-row-actions ready-actions' },
    el('button', {
      class: 'btn primary', type: 'button', disabled: !canRun,
      'aria-label': canRun ? `Use ${entry.name}` : `Use disabled. ${availabilityReason(entry, { installed: true, target })}`,
      onClick: event => onUse(entry.id, event.currentTarget), text: 'Use this model',
    }),
    quietRemove(entry, onRemove));
}

function primaryAction({ entry, installed, active, selected=false, target=null, job, onDownload, onUse, onRemove, onSideload }) {
  if (installed) return installedActions(entry, active, onUse, onRemove, {selected,target});
  if (entry.availability?.engineBlocked) return el('button', { class: 'btn blue', type: 'button', onClick: event => onSideload(event.currentTarget), text: 'Add an AI file' });
  if (!entry.availability?.canDownload) return el('button', { class: 'btn', type: 'button', disabled: true, 'aria-label': `Download disabled. ${availabilityReason(entry)}`, text: 'Download' });
  return el('button', {
    class: 'btn blue', type: 'button',
    disabled: ACTIVE_DOWNLOAD_STATES.has(job?.state),
    onClick: event => onDownload(entry.id, event.currentTarget), text: 'Download',
  });
}

function capabilityBadges(entry) {
  const primaryType = entry.primaryType || purposesFor(entry)[0] || 'general';
  const tasks = purposesFor(entry).filter(item => item !== primaryType && item !== 'long-context').slice(0, 2);
  const inputs = inputsFor(entry).filter(item => item !== 'text');
  const files = fileTypesFor(entry);
  return [
    el('span', { class: `pill capability-pill primary-type type-${primaryType}`, text: purposeLabel(primaryType) }),
    ...tasks.map(task => el('span', { class: `pill capability-pill type-${task}`, text: purposeLabel(task) })),
    ...inputs.slice(0, 2).map(input => el('span', { class: `pill media-pill input-${input}`, text: `${input[0].toUpperCase()}${input.slice(1)} input` })),
    files.length ? el('span', { class: 'pill file-pill', text: 'Text files' }) : null,
    Number(entry.nativeContextSize || 0) >= 65_536 ? el('span', { class: 'pill context-pill type-long-context', text: 'Long context' }) : null,
  ];
}

function runtimeStateBadges(target, selected=false){
  if(!target)return[];
  const state=target.state||{};const out=[];
  if(selected)out.push(el('span',{class:'pill green',text:'Selected'}));
  if(state.loaded)out.push(el('span',{class:'pill',text:state.healthy?'Loaded · healthy':'Loaded'}));
  else if(state.loadableNow===true)out.push(el('span',{class:'pill',text:'Loadable now'}));
  else if(state.loadableNow===false)out.push(el('span',{class:'pill',text:'Memory tight'}));
  if(Number(state.reservedCount||0)>0)out.push(el('span',{class:'pill',text:`Reserved ×${state.reservedCount}`}));
  if(state.pendingRemoval)out.push(el('span',{class:'pill',text:'Removal pending'}));
  if(target.runtime?.parallelVerified)out.push(el('span',{class:'pill',text:`Parallel ×${target.runtime.parallelCapacity}`}));
  else out.push(el('span',{class:'pill',text:'Sequential runtime'}));
  return out;
}

function modelLine(entry) {
  return [
    bytes(entry.size),
    entry.quantization && entry.quantization !== 'unknown' ? entry.quantization : null,
    `${Number(entry.contextSize || 0).toLocaleString()} configured tokens`,
    entry.licence || 'unknown licence',
  ].filter(Boolean).join(' · ');
}

export function modelCard({ entry, installed, active, selected = false, target = null, job, onDownload, onUse, onRemove, onPause, onResume, onCancel, onSideload, onMoreInfo, promoted = false, pulse = false }) {
  const unavailable = installed ? (!entry.availability?.canRun || target?.state?.pendingRemoval === true) : !entry.availability?.canDownload || !entry.availability?.canRun;
  const transfer = downloadState(job, entry, { onPause: () => onPause(entry.id), onResume: () => onResume(entry.id), onCancel: () => onCancel(entry.id) });
  const action = primaryAction({ entry, installed, active, selected, target, job, onDownload, onUse, onRemove, onSideload });
  const machineClass = entry.machineFit?.class || 'unknown';
  return el('article', {
    class: `catalogue-model-card model-row card ${active ? 'active is-active' : ''} ${installed ? 'is-installed' : ''} ${unavailable ? 'is-unavailable' : ''} ${promoted ? 'ready-promoted' : ''} ${pulse ? 'ready-flourish' : ''}`.trim(),
    'data-model-id': entry.id,
    'data-provider': entry.providerId || 'unknown',
    'data-machine-class': machineClass,
    'data-primary-type': entry.primaryType || 'general',
  },
  el('div', { class: 'model-card-identity' },
    providerMark(entry),
    el('div', { class: 'model-card-title' },
      el('div', { class: 'model-card-name-line' }, el('h3', { text: entry.name })),
      el('p', { class: 'provider-name muted', text: entry.providerName || 'Unknown provider' }))),
  el('div', { class: 'model-row-copy' },
    el('p', { class: 'model-description', text: entry.description }),
    el('div', { class: 'model-tags', 'aria-label': 'Model capabilities' },
      el('span', { class: `pill machine-pill machine-${machineClass}`, text: entry.machineFit?.label || 'Compatibility unknown' }),
      ...capabilityBadges(entry),
      ...(installed ? runtimeStateBadges(target, selected) : [])),
    entry.bestFor?.length ? el('p', { class: 'model-best-for muted', text: `Best for: ${entry.bestFor.slice(0, 3).join(' · ')}` }) : null,
    el('span', { class: 'meta numeric model-spec-line', text: modelLine(entry) }),
    unavailable ? el('p', { class: 'disabled-reason meta', text: availabilityReason(entry, { installed, target }) }) : null,
    transfer),
  el('div', { class: 'model-card-actions' },
    el('button', { class: 'nav-chip', type: 'button', onClick: event => onMoreInfo(entry.id, event.currentTarget), text: 'More info' }),
    transfer ? null : action));
}

export const namedModelRow = modelCard;

export function customModelRow({ model, active, selected = false, target = null, onRemove, onMoreInfo = null }) {
  return el('article', { class: `catalogue-model-card model-row card ${active ? 'active is-active' : ''} is-installed`, 'data-model-id': model.id },
    el('div', { class: 'model-card-identity' },
      providerMark({ providerName: 'Local file' }),
      el('div', { class: 'model-card-title' }, el('h3', { text: model.displayName }), el('p', { class: 'muted', text: 'Local file' }))),
    el('div', { class: 'model-row-copy' },
      el('p', { text: 'Added from this computer.' }),
      el('div', { class: 'model-tags' }, el('span', { class: 'pill file-pill', text: 'Text files' }), ...runtimeStateBadges(target,selected)),
      el('span', { class: 'meta numeric', text: `${bytes(model.size)} · ${model.licence || 'unknown'}` })),
    el('div', { class: 'model-card-actions' },
      onMoreInfo ? el('button', { class: 'nav-chip', type: 'button', onClick: event => onMoreInfo(model.id, event.currentTarget), text: 'More info' }) : null,
      installedActions(model, active, () => {}, onRemove,{selected,target})));
}
