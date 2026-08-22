import { el } from './dom.js';
import { state } from '../state.js';

export function privacyState(snapshot = state.get()) {
  const runtime = snapshot?.runtime || { status: 'stopped' };
  if (snapshot?.pendingExternalService) return {
    kind:'external', label:'External connection', compact:'External · Network',
    detail:`Network target: ${snapshot.pendingExternalService}.`,
  };
  if (runtime.status === 'external-ready') {
    const name = runtime.service?.name || 'the selected service';
    return { kind:'external', label:`External · ${name}`, compact:'External · Network', detail:`Network target: ${name}.` };
  }
  if (runtime.status === 'ready' || runtime.status === 'starting') {
    const starting = runtime.status === 'starting';
    return {
      kind:'local',
      label:starting ? 'Local · Starting' : 'Local',
      compact:starting ? 'Local · Starting' : 'Local',
      detail:'The selected AI and chat stay on this computer. Research may contact public pages only for a run that uses Research.',
    };
  }
  return {
    kind:'idle', label:'No model', compact:'No model',
    detail:'No AI model is currently active. Research does not run in the background.',
  };
}

export function privacyIndicator(snapshot = state.get(), { compact = false } = {}) {
  const status = privacyState(snapshot);
  const text = compact ? status.compact : `${status.label} · ${status.detail}`;
  return el('div', { class:`privacy-indicator ${status.kind}`, 'data-permanent-privacy':'', 'data-privacy-state':status.kind, role:'status', 'aria-label':text, title:status.detail },
    el('span', { class:'privacy-mark', 'aria-hidden':'true' }),
    el('span', { class:'privacy-label', text:compact ? status.compact : status.label }),
    compact ? null : el('span', { class:'privacy-detail', text:status.detail }));
}
