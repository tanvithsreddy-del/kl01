const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');

const PRODUCT = 'KL01';
const PUBLIC_NAME = 'KL01 Pre Beta';
const APP_ID = 'com.kondalabs.kl01';
let localServer = null;
let mainWindow = null;
let quitting = false;
const ZOOM_STEPS = Object.freeze([0.5, 0.6, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5]);

function zoomState() {
  const factor = mainWindow?.webContents?.getZoomFactor?.() || 0.75;
  return { factor, percent:Math.round(factor * 100), minimum:50, maximum:150 };
}

function setZoomAction(action) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('KL01 window is unavailable.');
  const current = mainWindow.webContents.getZoomFactor();
  let target = action === 'reset' ? 1 : current;
  if (action === 'in') target = ZOOM_STEPS.find(value => value > current + 0.001) || ZOOM_STEPS.at(-1);
  if (action === 'out') target = [...ZOOM_STEPS].reverse().find(value => value < current - 0.001) || ZOOM_STEPS[0];
  if (!['in','out','reset','get'].includes(action)) throw new Error('Unsupported zoom action.');
  if (action !== 'get') mainWindow.webContents.setZoomFactor(target);
  const next = zoomState();
  if (action !== 'get') mainWindow.webContents.send('kl01:zoom-changed', next);
  return next;
}

function appSourceRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app') : path.resolve(__dirname, '..');
}

function isExternalUrl(value) {
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(value).protocol); }
  catch { return false; }
}

async function openOutside(value) {
  if (!isExternalUrl(value)) return false;
  await shell.openExternal(value, { activate: true });
  return true;
}

async function stopServer() {
  const current = localServer;
  localServer = null;
  if (current) await current.close().catch(() => {});
}

async function createMainWindow() {
  const sourceRoot = appSourceRoot();
  process.env.KL01_DATA_DIR = app.getPath('userData');
  const entry = pathToFileURL(path.join(sourceRoot, 'server', 'app.js')).href;
  const { createKL01Server } = await import(entry);
  localServer = await createKL01Server({ port: 0 });
  const allowedOrigin = new URL(localServer.url).origin;

  mainWindow = new BrowserWindow({
    title: PUBLIC_NAME,
    width: 1440,
    height: 920,
    minWidth: 360,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#09090b',
    icon: path.join(sourceRoot, process.platform === 'win32' ? 'kl01.ico' : 'kl01.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openOutside(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let origin = null;
    try { origin = new URL(url).origin; } catch {}
    if (origin === allowedOrigin) return;
    event.preventDefault();
    void openOutside(url);
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  // Chromium may restore an origin-specific zoom while navigation commits.
  // Apply the product default after the document loads so the first visible
  // frame and the Settings readout both begin at exactly 75%.
  mainWindow.webContents.once('did-finish-load', () => mainWindow?.webContents.setZoomFactor(0.75));
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!input.control || input.alt || input.meta) return;
    const key = String(input.key || '').toLocaleLowerCase();
    const code = String(input.code || '').toLocaleLowerCase();
    const action = ['+','=','add'].includes(key) || ['equal','numpadadd'].includes(code)
      ? 'in'
      : ['-','subtract'].includes(key) || ['minus','numpadsubtract'].includes(code)
        ? 'out'
        : key === '0' || ['digit0','numpad0'].includes(code)
          ? 'reset'
          : null;
    if (!action) return;
    event.preventDefault();
    setZoomAction(action);
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(localServer.url);
  // Some portable Windows launches complete navigation without emitting
  // ready-to-show. Do not leave a healthy packaged app running invisibly.
  if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setName(PUBLIC_NAME);
  app.setAppUserModelId(APP_ID);
  const localRoot = process.env.LOCALAPPDATA || app.getPath('appData');
  app.setPath('userData', path.join(localRoot, PRODUCT));
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(async () => {
    ipcMain.handle('kl01:zoom', (event, action) => {
      if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Untrusted zoom request.');
      return setZoomAction(String(action || ''));
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    await createMainWindow();
  }).catch(async error => {
    await stopServer();
    dialog.showErrorBox('KL01 could not start', String(error?.message || error));
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !localServer) return;
    event.preventDefault();
    quitting = true;
    stopServer().finally(() => app.quit());
  });
}
