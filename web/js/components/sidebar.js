import { el, icon } from './dom.js';
import { betaBadge } from './beta.js';

const MORE = 'M6 12a1.5 1.5 0 1 0 0 .01 M12 12a1.5 1.5 0 1 0 0 .01 M18 12a1.5 1.5 0 1 0 0 .01';
const PIN = 'M9 4h6l-1 5 3 3H7l3-3Z M12 12v8';
const CLOSE = 'M6 6l12 12 M18 6L6 18';
const ACCENT_CLASS = { yellow: 'accent-yellow', pink: 'accent-pink', green: 'accent-green', blue: 'accent-blue', violet: 'accent-violet' };

function snippet(parts) {
  if (!parts) return null;
  return el('span', { class: 'search-snippet' }, parts.before, el('mark', { text: parts.match }), parts.after);
}

export function sidebar({ chats, results = null, query = '', activeId, menuChatId = null, mobileOpen = false, onSelect, onNew, onMenu, onSearch, onClose }) {
  const source = results ?? chats;
  const titleById = new Map(chats.map(chat => [chat.id, chat.title]));
  const rows = source.length
    ? source.map(chat => {
      const accent = Object.hasOwn(ACCENT_CLASS, chat.accent) ? chat.accent : 'violet';
      return el('div', { class: `chat-item accent-${accent} ${chat.id === activeId ? 'active' : ''} ${chat.pinned ? 'pinned' : ''}`, 'data-chat-id': chat.id, 'data-accent': accent },
        el('span', { class: `chat-accent ${ACCENT_CLASS[accent]}`, 'aria-hidden': 'true' }),
        el('button', { class: 'chat-title', type: 'button', title: chat.title, onClick: event => onSelect(chat.id, event.currentTarget) },
          chat.pinned ? el('span', { class: 'chat-pin-mark', title: 'Pinned chat', 'aria-label': 'Pinned chat' }, icon(PIN)) : null,
          el('span', { class: 'search-result-copy' },
            el('span', { text: chat.title }),
            snippet(chat.snippet)),
          chat.branchedFrom ? el('span', { class: 'chat-branch-mark', title: `Branched from ${titleById.get(chat.branchedFrom.chatId) || 'another chat'}`, 'aria-label': `Branched from ${titleById.get(chat.branchedFrom.chatId) || 'another chat'}`, text: '↳' }) : null),
        el('button', {
          class: `icon-btn chat-menu-trigger accent-${accent}` ,
          type: 'button',
          title: 'Chat options',
          'aria-label': `Options for ${chat.title}`,
          'aria-haspopup': 'menu',
          'aria-expanded': String(menuChatId === chat.id),
          onClick: event => onMenu(chat, event.currentTarget),
        }, icon(MORE)));
    })
    : [el('p', { class: query ? 'nothing-found' : 'muted', text: query ? 'Nothing found' : 'Chats will appear here.' })];
  return el('aside', { class: `sidebar ${mobileOpen ? 'mobile-open' : ''}`.trim(), 'aria-label': 'Chats sidebar' },
    el('div', { class: 'sidebar-head' },
      el('span', { class:'sidebar-brand' }, el('img', { src: '/logos/kl01-logo.svg', alt: 'KL01' }), betaBadge()),
      el('button', { class: 'icon-btn sidebar-close', type: 'button', 'aria-label': 'Close chats sidebar', onClick: () => onClose?.() }, icon(CLOSE))),
    el('div', { class: 'new-chat-wrap' },
      el('button', { class: 'btn primary new-chat', type: 'button', onClick: event => onNew(event.currentTarget), text: 'New chat' })),
    el('div', { class: 'chat-search' },
      el('input', { class: 'field', type: 'search', value: query, placeholder: 'Search chats', 'aria-label': 'Search chats', onInput: event => onSearch(event.target.value) })),
    el('div', { class: 'chat-list', 'data-scroll-region': 'chat-list' }, ...rows));
}
