import { el } from './dom.js';
import { privacyIndicator } from './privacy.js';
import { betaBadge } from './beta.js';

const LABELS = { models: 'Models', chat: 'Chats', settings: 'Settings' };
const ROUTES = ['chat', 'models', 'settings'];

export function mainNavigation(active, onRoute) {
  return el('nav', { class: 'main-navigation', 'aria-label': 'Main navigation' },
    ...ROUTES.map(route => el('button', {
      class: `nav-chip ${active === route ? 'active' : ''}`,
      type: 'button',
      'aria-current': active === route ? 'page' : null,
      'aria-label': LABELS[route],
      onClick: () => onRoute(route),
      text: LABELS[route],
    })));
}

export function topNav(active, onRoute) {
  return el('header', { class: 'setup-top global-header' },
    el('span', { class:'global-brand' }, el('img', { class: 'brand-logo', src: '/logos/kl01-logo.svg', alt: 'KL01' }), betaBadge()),
    el('span', { class: 'global-header-spacer', 'aria-hidden': 'true' }),
    privacyIndicator(undefined, { compact: true }),
    mainNavigation(active, onRoute));
}
