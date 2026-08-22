import { api } from '../api.js';
import { el, clear } from '../components/dom.js';
import { conditionError } from '../condition-error.js';
import { betaBadge } from '../components/beta.js';

export function createWelcomeScreen({ mode = 'first-launch', onContinue }) {
  let root = null;
  let busy = false;
  let error = null;

  async function continueIntoKL01() {
    if (busy) return;
    busy = true;
    error = null;
    render();
    try {
      await api.completeFirstLaunch();
      onContinue();
    } catch (caught) {
      error = conditionError('first-launch', caught?.message || 'KL01 could not finish first-launch setup.');
      busy = false;
      render();
    }
  }

  function render() {
    if (!root) return;
    const returning = mode !== 'first-launch';
    clear(root).append(
      el('main', { class: 'stage-center welcome-stage', 'data-signature-surface': 'welcome' },
        el('div', { class: 'empty-center welcome-center' },
          el('img', { class: 'starburst welcome-mark', src: '/logos/kl01-favicon.svg', alt: '' }),
          betaBadge({ className:'welcome-beta' }),
          el('p', { class: 'eyebrow', text: returning ? 'Welcome back' : 'Welcome to KL01' }),
          el('h1', { text: 'Private AI that runs on your computer.' }),
          el('p', { class: 'welcome-line', text: 'Download a local model, chat normally, and KL01 can research public information automatically when the request needs it.' }),
          el('p', { class: 'beta-welcome-note', text: 'KL01 Pre Beta is entirely unfinished, and every output may be incomplete or wrong. Verify important decisions independently.' }),
          el('p', { class: 'muted', text: 'Research can check public sources when current or external verification is useful. You can change Research strategy later in Settings.' }),
          error ? el('div', { class: 'warning-note', role: 'alert', text: error.message }) : null,
          busy ? el('p', { id: 'welcome-busy-status', class: 'muted', role: 'status', text: 'Opening KL01…' }) : null,
          el('button', {
            class: 'btn primary',
            type: 'button',
            disabled: busy,
            'aria-describedby': busy ? 'welcome-busy-status' : null,
            onClick: continueIntoKL01,
            text: returning ? 'Continue' : 'Get started',
          })))
    );
  }

  return {
    mount(node) { root = node; render(); queueMicrotask(() => root?.querySelector('button')?.focus({ preventScroll: true })); },
    unmount() { root = null; },
  };
}
