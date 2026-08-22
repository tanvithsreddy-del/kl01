import { el, cssTime } from './dom.js';

const HOST_ID = 'kl01-overlay-root';
let activeOwner = null;
let returnTarget = null;
let returnFingerprint = null;

function fingerprint(node) {
  if (!node || node.nodeType !== 1) return null;
  return {
    id: node.id || '',
    aria: node.getAttribute?.('aria-label') || '',
    text: String(node.textContent || '').trim(),
    tag: String(node.tagName || '').toLowerCase(),
    type: node.getAttribute?.('type') || '',
  };
}

function findReturnTarget(owner, saved) {
  if (!owner || !saved) return null;
  if (saved.id) {
    const byId = owner.querySelector?.(`#${saved.id}`);
    if (byId) return byId;
  }
  const candidates = Array.from(owner.querySelectorAll?.('button,input,textarea,select,a,summary,[tabindex]') || []);
  if (saved.aria) {
    const byAria = candidates.find(node => node.getAttribute?.('aria-label') === saved.aria);
    if (byAria) return byAria;
  }
  if (saved.text) {
    const byText = candidates.find(node => String(node.tagName || '').toLowerCase() === saved.tag && String(node.textContent || '').trim() === saved.text && (!saved.type || node.getAttribute?.('type') === saved.type));
    if (byText) return byText;
  }
  return null;
}

export function overlayRoot() {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = el('div', { id: HOST_ID, class: 'overlay-root', 'data-overlay-root': '', hidden: true, 'aria-live': 'off' });
    document.body.append(host);
  }
  return host;
}


function spawnExitGhost(host) {
  const live = host?.firstElementChild;
  if (!live?.cloneNode || typeof document === 'undefined') return;
  const ghost = el('div', { class: 'overlay-exit-ghost', 'aria-hidden': 'true' }, live.cloneNode(true));
  document.body.append(ghost);
  setTimeout(() => ghost.remove(), cssTime('--kl01-weight-atom'));
}

function setUnderlay(owner, blocked) {
  if (!owner) return;
  if (blocked) {
    owner.setAttribute('inert', '');
    owner.setAttribute('aria-hidden', 'true');
  } else {
    owner.removeAttribute('inert');
    owner.removeAttribute('aria-hidden');
  }
}

export function showOverlay(owner, node, { trigger = null } = {}) {
  const host = overlayRoot();
  if (!node) {
    hideOverlay(owner);
    return host;
  }
  if (activeOwner && activeOwner !== owner) setUnderlay(activeOwner, false);
  if (activeOwner !== owner || !returnTarget) {
    returnTarget = trigger || document.activeElement || null;
    returnFingerprint = fingerprint(returnTarget);
  } else if (trigger) {
    returnTarget = trigger;
    returnFingerprint = fingerprint(trigger);
  }
  activeOwner = owner;
  setUnderlay(owner, true);
  host.hidden = false;
  host.replaceChildren(node);
  return host;
}

export function hideOverlay(owner, { restoreFocus = true } = {}) {
  const host = overlayRoot();
  if (activeOwner && owner && activeOwner !== owner) return;
  const targetOwner = activeOwner || owner;
  spawnExitGhost(host);
  host.replaceChildren();
  host.hidden = true;
  setUnderlay(targetOwner, false);
  const direct = returnTarget;
  const saved = returnFingerprint;
  activeOwner = null;
  returnTarget = null;
  returnFingerprint = null;
  if (restoreFocus) queueMicrotask(() => {
    const target = direct?.isConnected ? direct : findReturnTarget(targetOwner, saved);
    target?.focus?.();
  });
}

export function overlayState() {
  const host = overlayRoot();
  return { active: !host.hidden && host.children.length > 0, owner: activeOwner, host };
}
