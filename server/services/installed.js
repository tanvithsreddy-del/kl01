import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { INSTALLED_FILE, SETTINGS_FILE, MODELS_DIR, modelFile } from '../lib/paths.js';
import { readJson, updateJson } from './store.js';
import { validateModelFile, sha256File } from './validate.js';
import { fail } from '../lib/errors.js';
import { DEFAULT_SETTINGS, TEXT_SIZES } from './preferences.js';

const EMPTY = { version: 1, models: [] };
export async function listInstalled() { return (await readJson(INSTALLED_FILE, EMPTY)).models; }

export function selectStartupModel(records, settings = {}) {
  const installed = Array.isArray(records) ? records.filter(item => item?.id) : [];
  if (!installed.length) return null;
  const active = installed.find(item => item.id === settings.activeModelId);
  if (active) return active;
  if (installed.length === 1) return installed[0];
  return [...installed].sort((a, b) => {
    const aUsed = Date.parse(a.lastUsedAt || a.installedAt || 0) || 0;
    const bUsed = Date.parse(b.lastUsedAt || b.installedAt || 0) || 0;
    return bUsed - aUsed || String(a.id).localeCompare(String(b.id));
  })[0] || null;
}
export async function getSettings() {
  const settings = await readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...settings, appearance: { theme: 'dark', textSize: TEXT_SIZES.has(settings.appearance?.textSize) ? settings.appearance.textSize : 'default' }, chat: { ...DEFAULT_SETTINGS.chat, ...(settings.chat || {}) } };
}
export async function getInstalled(id) {
  const model = (await listInstalled()).find(item => item.id === id);
  if (!model) throw fail('MODEL_NOT_INSTALLED', 'This AI is not on this computer; download it or choose another AI.', 404);
  return model;
}
export async function recordInstalled(record) {
  return updateJson(INSTALLED_FILE, EMPTY, data => {
    data.models = data.models.filter(item => item.id !== record.id);
    data.models.push(record);
    return data;
  });
}
export async function verifyInstalled(id) {
  const record = await getInstalled(id);
  let stat;
  try { stat = await fs.stat(record.path); } catch (error) {
    throw fail('MODEL_FILE_MISSING', 'The AI file is missing; add it again.', 409, undefined, error);
  }
  if (!stat.isFile()) throw fail('MODEL_FILE_MISSING', 'The AI file is missing; add it again.', 409);
  const hash = await sha256File(record.path);
  if (hash !== record.hash) throw fail('MODEL_HASH', 'The AI file changed after it was checked; add it again.', 409);
  return { ...record, size: stat.size };
}
export async function installValidated({ id, source, expectedSize = null, expectedHash = null, contentType = '', displayName = id, contextSize = 8192, sourceType = 'download', licence = 'unknown' }) {
  await fs.mkdir(MODELS_DIR, { recursive: true });
  const validated = await validateModelFile({ file: source, contentType, expectedSize, expectedHash });
  const destination = modelFile(id);
  if (path.resolve(source) !== path.resolve(destination)) await fs.copyFile(source, destination);
  const record = { id, displayName, path: destination, hash: validated.hash, size: validated.size, contextSize, sourceType, installedAt: new Date().toISOString(), licence };
  await recordInstalled(record);
  return record;
}
export async function sideload(source) {
  if (typeof source !== 'string' || !source.toLowerCase().endsWith('.gguf')) throw fail('SIDELOAD_PATH', 'Choose a supported model file from this computer.', 400);
  const validated = await validateModelFile({ file: source });
  const id = `sideload-${validated.hash.slice(0,12)}`;
  return installValidated({ id, source, expectedSize: validated.size, expectedHash: validated.hash, displayName: path.basename(source, '.gguf'), sourceType: 'sideload', licence: 'unknown' });
}

export async function clearActiveModel(id = null) {
  return updateJson(SETTINGS_FILE, DEFAULT_SETTINGS, settings => {
    if (id && settings.activeModelId !== id) return settings;
    return { ...settings, activeModelId: null };
  });
}

export async function recordModelUsage(id, actualContextSize) {
  await getInstalled(id);
  return updateJson(INSTALLED_FILE, EMPTY, data => {
    const usedAt = new Date().toISOString();
    data.models = data.models.map(item => item.id === id ? { ...item, contextSize: actualContextSize || item.contextSize, lastUsedAt: usedAt } : item);
    return data;
  });
}

export async function setModelPreference(id) {
  await getInstalled(id);
  return updateJson(SETTINGS_FILE, DEFAULT_SETTINGS, settings => ({ ...settings, activeModelId: id, activeServiceId: null }));
}

export async function setActiveModel(id, actualContextSize) {
  await recordModelUsage(id, actualContextSize);
  return setModelPreference(id);
}

export async function markPendingRemoval(id, pending = true) {
  await getInstalled(id);
  await updateJson(INSTALLED_FILE, EMPTY, data => ({ ...data, models: data.models.map(item => item.id === id ? { ...item, pendingRemoval: Boolean(pending) } : item) }));
  if (pending) await clearActiveModel(id);
  return getInstalled(id);
}

export async function uninstall(id) {
  const record = await getInstalled(id);
  try { await fs.unlink(record.path); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await updateJson(INSTALLED_FILE, EMPTY, data => ({ ...data, models: data.models.filter(item => item.id !== id) }));
  await clearActiveModel(id);
  return { removed: id, freedBytes: record.size };
}
export async function createFixtureModel(file, bytes = 256) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = Buffer.alloc(Math.max(bytes, 8));
  body.write('GGUF', 0, 4, 'ascii');
  crypto.randomFillSync(body, 4);
  await fs.writeFile(file, body);
  return file;
}
