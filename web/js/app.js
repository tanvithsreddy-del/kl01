import { api } from './api.js';
import { createModelsScreen } from './screens/models.js';
import { createChatScreen } from './screens/chat.js';
import { createSettingsScreen } from './screens/settings.js';
import { createWelcomeScreen } from './screens/welcome.js';
import { state } from './state.js';

export function decideInitialView(preferences, installedState) {
  const models = Array.isArray(installedState?.models) ? installedState.models : [];
  const activeModelId = installedState?.settings?.activeModelId || null;
  if (models.length === 0 && !preferences?.firstLaunchComplete) return { screen: 'welcome', mode: 'first-launch' };
  if (models.length === 0) return { screen: 'chat', mode: 'locked-no-model' };
  if (activeModelId) return { screen: 'chat', mode: 'starting-last-active' };
  return { screen: 'chat', mode: 'locked-no-active' };
}

const appRoot = typeof document !== 'undefined' ? document.querySelector('#app') : null;
const root = appRoot?.querySelector('#kl01-content-root') || appRoot;
let current = null;
let welcomeMode = null;
let mounting = false;
let remountRequested = false;
let requestVersion = 0;

let recoveryLoop = null;
function connectionBanner() {
  let node = document.querySelector('[data-local-connection-banner]');
  if (node) return node;
  node = document.createElement('div');
  node.className = 'local-connection-banner';
  node.dataset.localConnectionBanner = '';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.hidden = true;
  document.body.append(node);
  return node;
}
function setConnectionBanner(text, state = 'reconnecting') {
  const node = connectionBanner();
  node.textContent = text; node.dataset.state = state; node.hidden = false;
}
function clearConnectionBannerSoon() {
  const node = connectionBanner();
  node.textContent = 'Reconnected to KL01.'; node.dataset.state = 'restored'; node.hidden = false;
  setTimeout(() => { if (node.dataset.state === 'restored') node.hidden = true; }, 1400);
}
function beginLocalRecovery() {
  if (recoveryLoop) return recoveryLoop;
  recoveryLoop = (async () => {
    let attempt = 0;
    setConnectionBanner('Local server connection lost · reconnecting automatically');
    while (true) {
      const delay = Math.min(5000, 250 * 2 ** Math.min(attempt, 5));
      await new Promise(resolve => setTimeout(resolve, delay));
      try {
        const response = await fetch('/api/health', { cache:'no-store' });
        if (response.ok) { clearConnectionBannerSoon(); return true; }
      } catch {}
      attempt += 1;
      setConnectionBanner(`Local server unavailable · reconnecting automatically · attempt ${attempt + 1}`);
    }
  })().finally(() => { recoveryLoop = null; });
  return recoveryLoop;
}
if (typeof window !== 'undefined') {
  window.addEventListener('kl01:connection-lost', () => { void beginLocalRecovery(); });
  window.addEventListener('kl01:connection-restored', () => { if (!recoveryLoop) clearConnectionBannerSoon(); });
}

function parse() {
  const raw = location.hash.replace(/^#/, '') || 'chat';
  const [route, id] = raw.split('/');
  return { route: ['models', 'chat', 'settings'].includes(route) ? route : 'chat', id };
}
function go(route, id) { location.hash = id ? `${route}/${id}` : route; }
function nextScreen() {
  if (welcomeMode) return createWelcomeScreen({ mode: welcomeMode, onContinue: () => { welcomeMode = null; go('chat'); } });
  const { route, id } = parse();
  return route === 'models'
    ? createModelsScreen({ onRoute: go })
    : route === 'settings'
      ? createSettingsScreen({ onRoute: go })
      : createChatScreen({ onRoute: go, initialChatId: id });
}

function preparedHost() {
  const host = document.createElement('div');
  host.className = 'screen-slot screen-preparing';
  host.setAttribute('aria-hidden', 'true');
  return host;
}

function waitForPreparedContent(host) {
  if (host.firstElementChild) return Promise.resolve();
  return new Promise(resolve => {
    const observer = new MutationObserver(() => {
      if (!host.firstElementChild) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(host, { childList: true });
  });
}

async function mount() {
  if (!root) return;
  if (mounting) { remountRequested = true; requestVersion += 1; return; }
  mounting = true;
  try {
    do {
      remountRequested = false;
      const version = ++requestVersion;
      const screen = nextScreen();
      const host = preparedHost();
      root.append(host);
      try {
        screen.mount(host);
        await waitForPreparedContent(host);
      } catch (error) {
        screen.unmount?.();
        host.remove();
        throw error;
      }
      if (remountRequested || version !== requestVersion) {
        screen.unmount?.();
        host.remove();
        continue;
      }
      const outgoing = current;
      outgoing?.screen?.unmount?.();
      outgoing?.host?.remove?.();
      host.classList.remove('screen-preparing');
      host.removeAttribute('aria-hidden');
      current = { screen, host };
      host.querySelector('[autofocus]')?.focus?.({ preventScroll: true });
    } while (remountRequested);
  } finally {
    mounting = false;
    if (remountRequested) mount();
  }
}

async function boot() {
  try {
    const [preferences, installed, runtime, health] = await Promise.all([api.preferences(), api.installed(), api.runtime(), api.health()]);
    state.set({ preferences, product: health.product || state.get().product });
    state.setRuntime(runtime);
    document.documentElement.dataset.theme = preferences.appearance.theme;
    document.documentElement.dataset.textSize = preferences.appearance.textSize;
    const decision = decideInitialView(preferences, installed);
    welcomeMode = decision.screen === 'welcome' ? decision.mode : null;
  } catch { welcomeMode = null; }
  document.documentElement.classList.remove('appearance-pending');
  window.addEventListener('hashchange', mount);
  if (!welcomeMode && !['#chat', '#models', '#settings'].includes(location.hash)) history.replaceState(null, '', '#chat');
  mount();
}
if (root) boot();
