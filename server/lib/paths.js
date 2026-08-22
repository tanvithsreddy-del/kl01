import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { LLAMA_BINARY_NAME } from '../config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(HERE, '..', '..');
export const WEB_DIR = path.join(ROOT_DIR, 'web');
function defaultDataDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'KL01');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'KL01');
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'kl01');
}
export const DATA_DIR = path.resolve(process.env.KL01_DATA_DIR || defaultDataDir());
export const MODELS_DIR = path.join(DATA_DIR, 'models');
export const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
export const CHATS_DIR = path.join(DATA_DIR, 'chats');
export const DOCUMENTS_DIR = path.join(DATA_DIR, 'documents');
export const DOCUMENT_INDEX_FILE = path.join(DOCUMENTS_DIR, 'index.json');
export const SNAPSHOTS_DIR = path.join(DATA_DIR, 'context-snapshots');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const WEB_DATA_ROOT = path.join(DATA_DIR, 'web');
export const WEB_CACHE_DIR = path.join(WEB_DATA_ROOT, 'cache');
export const WEB_BROWSER_PROFILES_DIR = path.join(WEB_DATA_ROOT, 'browser-profiles');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const RECIPES_FILE = path.join(DATA_DIR, 'workflow-recipes.json');
export const INSTALLED_FILE = path.join(DATA_DIR, 'installed.json');
export const SERVICES_FILE = path.join(DATA_DIR, 'services.json');
export const CHAT_INDEX_FILE = path.join(CHATS_DIR, 'index.json');
export const CHAT_SEARCH_FILE = path.join(DATA_DIR, 'chat-search.json');
export const CATALOGUE_FILE = path.resolve(process.env.KL01_CATALOGUE_FILE || path.join(ROOT_DIR, 'server', 'catalogue.json'));
export const RUNTIME_DIR = path.join(ROOT_DIR, 'runtime');
export const LLAMA_BINARY = path.join(RUNTIME_DIR, LLAMA_BINARY_NAME);
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const WORK_RUNS_DIR = path.join(TMP_DIR, 'work-runs');
export const WEB_OPERATION_STATS_FILE = path.join(WEB_DATA_ROOT, 'source-operations.json');

export const requiredDataDirs = Object.freeze([
  DATA_DIR, MODELS_DIR, DOWNLOADS_DIR, CHATS_DIR, DOCUMENTS_DIR, SNAPSHOTS_DIR, LOGS_DIR, TMP_DIR, WORK_RUNS_DIR,
]);

export function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
}
export function modelFile(id) { return path.join(MODELS_DIR, `${safeId(id)}.gguf`); }
export function downloadPart(id) { return path.join(DOWNLOADS_DIR, `${safeId(id)}.part`); }
export function downloadMeta(id) { return path.join(DOWNLOADS_DIR, `${safeId(id)}.part.json`); }
export function chatFile(id) { return path.join(CHATS_DIR, `${safeId(id)}.json`); }
export function documentFile(id) { return path.join(DOCUMENTS_DIR, `${safeId(id)}.json`); }
export function logFile(date = new Date()) { return path.join(LOGS_DIR, `${date.toISOString().slice(0,10)}.log`); }
export function defaultSideloadDirectory() { return path.join(os.homedir(), 'Downloads'); }
