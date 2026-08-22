import { el } from './dom.js';

function focusableWithin(panel) {
  return [...panel.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')];
}

function bindFocusTrap(panel, close) {
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = focusableWithin(panel);
    if (!focusable.length) { event.preventDefault(); panel.focus(); return; }
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}

export function modal({ title, description, descriptionClass = '', content, primaryLabel, onPrimary, onClose, primaryDisabled = false, primaryDisabledReason = '' }) {
  const previousFocus = document.activeElement;
  const close = () => {
    onClose?.();
    queueMicrotask(() => previousFocus?.isConnected && previousFocus.focus?.());
  };
  const titleId = `modal-title-${Math.random().toString(36).slice(2, 9)}`;
  const reasonId = `modal-primary-reason-${Math.random().toString(36).slice(2, 9)}`;
  const disabledReason = el('p', { id: reasonId, class: 'disabled-reason muted dialog-disabled-reason', text: primaryDisabledReason || 'Complete the required information to continue.' });
  disabledReason.hidden = !primaryDisabled;
  const primary = primaryLabel ? el('button', {
    class: 'btn primary', type: 'button', disabled: primaryDisabled, onClick: onPrimary, text: primaryLabel,
    'aria-describedby': primaryDisabled ? reasonId : null,
    'aria-label': primaryDisabled ? `${primaryLabel}. Disabled: ${disabledReason.textContent}` : primaryLabel,
  }) : null;
  const actions = el('div', { class: 'dialog-actions' },
    el('button', { class: 'btn', type: 'button', onClick: close, text: primaryLabel ? 'Cancel' : 'Close' }),
    primary);
  const footer = el('div', { class: 'dialog-footer' }, primaryLabel ? disabledReason : null, actions);
  const panel = el('section', { class: 'dialog card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    el('div', { class: 'modal-head' },
      el('div', {}, el('h2', { id: titleId, text: title }), description ? el('p', { class: `muted ${descriptionClass}`.trim(), text: description }) : null),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onClick: close, text: '×' })),
    el('div', { class: 'dialog-body', 'data-dialog-scroll-region': '' }, content),
    footer);
  const overlay = el('div', { class: 'dialog-backdrop', onClick: event => { if (event.target === overlay) close(); } }, panel);
  bindFocusTrap(panel, close);
  overlay.setPrimaryDisabled = (value, reason = primaryDisabledReason) => {
    if (!primary) return;
    const disabled = Boolean(value);
    primary.disabled = disabled;
    disabledReason.textContent = reason || 'Complete the required information to continue.';
    disabledReason.hidden = !disabled;
    if (disabled) { primary.setAttribute('aria-describedby', reasonId); primary.setAttribute('aria-label', `${primaryLabel}. Disabled: ${disabledReason.textContent}`); }
    else { primary.removeAttribute('aria-describedby'); primary.setAttribute('aria-label', primaryLabel || 'Continue'); }
  };
  overlay.primaryButton = primary;
  queueMicrotask(() => {
    if (previousFocus?.getBoundingClientRect && panel.isConnected) {
      const trigger = previousFocus.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      panel.style.setProperty('--kl01-origin-x', `${trigger.left + trigger.width / 2 - bounds.left}px`);
      panel.style.setProperty('--kl01-origin-y', `${trigger.top + trigger.height / 2 - bounds.top}px`);
    }
    (panel.querySelector('.dialog-body input,.dialog-body textarea,.dialog-body select,.dialog-body button:not(:disabled)') || panel.querySelector('button:not(:disabled)') || panel).focus?.();
  });
  return overlay;
}

export function popover({ content, label = 'Menu', onClose, trigger = null }) {
  const previousFocus = trigger || document.activeElement;
  const close = () => {
    onClose?.();
    queueMicrotask(() => previousFocus?.isConnected && previousFocus.focus?.());
  };
  const panel = el('section', { class: `popover-panel ${trigger ? 'anchored-popover' : ''}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-label': label, tabindex: '-1' }, content);
  const backdrop = el('div', { class: 'popover-backdrop', onClick: event => { if (event.target === backdrop) close(); } }, panel);
  bindFocusTrap(panel, close);
  queueMicrotask(() => {
    if (previousFocus?.getBoundingClientRect && panel.isConnected) {
      const source = previousFocus.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      panel.style.setProperty('--kl01-origin-x', `${source.left + source.width / 2 - bounds.left}px`);
      panel.style.setProperty('--kl01-origin-y', `${source.top + source.height / 2 - bounds.top}px`);
      if (trigger) {
        const viewportWidth = document.documentElement.clientWidth || window.innerWidth || 1440;
        const viewportHeight = document.documentElement.clientHeight || window.innerHeight || 900;
        const margin = 12;
        const gap = 8;
        const left = Math.max(margin, Math.min(source.right - bounds.width, viewportWidth - bounds.width - margin));
        let top = source.bottom + gap;
        if (top + bounds.height > viewportHeight - margin) top = source.top - bounds.height - gap;
        top = Math.max(margin, Math.min(top, viewportHeight - bounds.height - margin));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
      }
    }
    const target = panel.querySelector('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])') || panel;
    target.focus?.();
  });
  return backdrop;
}
