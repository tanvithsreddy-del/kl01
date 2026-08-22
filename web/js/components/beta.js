import { el } from './dom.js';

const BETA_TITLE = 'KL01 Pre Beta is entirely unfinished. Every feature and output may change, fail, or be wrong; verify important work independently.';

export function betaBadge({ label = 'PRE BETA', className = '' } = {}) {
  return el('span', { class:`beta-badge ${className}`.trim(), title:BETA_TITLE, 'aria-label':BETA_TITLE, text:label });
}

export function betaNote() {
  return el('div', { class:'beta-app-note' },
    betaBadge(),
    el('span', { text:'The entire KL01 Pre Beta app is unfinished. Verify important decisions independently.' }));
}
