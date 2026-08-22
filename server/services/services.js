import crypto from 'node:crypto';
import { SERVICES_FILE, SETTINGS_FILE } from '../lib/paths.js';
import { readJson, updateJson } from './store.js';
import { fail } from '../lib/errors.js';
import { DEFAULT_SETTINGS } from './preferences.js';

const EMPTY = { version: 4, services: [] };

function publicRecord({ apiKey, ...record }) {
  const health=record.health&&typeof record.health==='object'?record.health:{status:'unknown',checkedAt:null,lastFailureCode:null};
  return { ...record, health, capabilities:{ inputModalities:['text'], fileTypes:[], attachments:false, structuredOutput:false, reasoning:false }, hasKey: Boolean(apiKey) };
}



export async function migrateServiceIdentities() {
  let changed = 0;
  await updateJson(SERVICES_FILE, EMPTY, async data => {
    const services = [];
    for (const raw of Array.isArray(data?.services) ? data.services : []) {
      const { logo: _logo, ...withoutLogo } = raw;
      const next = { ...withoutLogo, providerId: 'openai-compatible' };
      if (raw.providerId !== next.providerId || raw.logo != null) changed += 1;
      services.push(next);
    }
    return { ...data, version: 4, services };
  });
  return { migrated: changed, version: 4 };
}

export async function listServices() {
  return (await readJson(SERVICES_FILE, EMPTY)).services.map(publicRecord);
}

export async function saveService(input) {
  if (!input || typeof input.name !== 'string' || typeof input.baseUrl !== 'string' || typeof input.model !== 'string') {
    throw fail('SERVICE_SHAPE', 'Enter the service address and model name, then save again.', 400);
  }
  let url;
  try { url = new URL(input.baseUrl); }
  catch { throw fail('SERVICE_URL', 'Enter a valid service address, then save again.', 400); }
  if (!['http:', 'https:'].includes(url.protocol)) throw fail('SERVICE_URL', 'Enter an HTTP or HTTPS service address.', 400);
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !localHttp) throw fail('SERVICE_INSECURE', 'Use HTTPS for external AI services; use HTTP only for services on this computer.', 400);
  const id = input.id || `service-${crypto.randomBytes(6).toString('hex')}`;
  const record = {
    id,
    name: input.name.trim().slice(0, 80),
    baseUrl: url.toString().replace(/\/$/, ''),
    model: input.model.trim().slice(0, 160),
    apiKey: String(input.apiKey || ''),
    providerId: 'openai-compatible',
    contextSize: Number.isFinite(Number(input.contextSize)) && Number(input.contextSize) > 0 ? Math.floor(Number(input.contextSize)) : null,
    health: input.id ? (await readJson(SERVICES_FILE, EMPTY)).services.find(item=>item.id===id)?.health || {status:'unknown',checkedAt:null,lastFailureCode:null} : {status:'unknown',checkedAt:null,lastFailureCode:null},
    updatedAt: new Date().toISOString(),
  };
  await updateJson(SERVICES_FILE, EMPTY, data => ({
    ...data,
    services: [...data.services.filter(item => item.id !== id), record],
  }));
  return publicRecord(record);
}

export async function recordServiceHealth(id,{ok=false,code=null}={}) {
  const checkedAt=new Date().toISOString();
  await updateJson(SERVICES_FILE, EMPTY, data => ({ ...data, version:4, services:(data.services||[]).map(item=>item.id===id?{...item,health:{status:ok?'healthy':'unavailable',checkedAt,lastFailureCode:ok?null:String(code||'SERVICE_FAILURE').slice(0,80)}}:item) }));
  return {id,status:ok?'healthy':'unavailable',checkedAt};
}

export async function removeService(id) {
  await updateJson(SERVICES_FILE, EMPTY, data => ({ ...data, services: data.services.filter(item => item.id !== id) }));
  await updateJson(SETTINGS_FILE, DEFAULT_SETTINGS, settings => settings.activeServiceId === id
    ? { ...settings, activeServiceId: null }
    : settings);
  return { removed: id };
}

export async function activateService(id) {
  const raw = await readJson(SERVICES_FILE, EMPTY);
  if (!raw.services.some(item => item.id === id)) throw fail('SERVICE_NOT_FOUND', 'This external AI service is no longer configured; add it again or choose another AI.', 404);
  await updateJson(SETTINGS_FILE, DEFAULT_SETTINGS, settings => ({ ...settings, activeServiceId: id, activeModelId: null }));
  return { activeServiceId: id, activeModelId: null };
}


export async function getService(id) {
  const raw = await readJson(SERVICES_FILE, EMPTY);
  const record = raw.services.find(item => item.id === id);
  if (!record) throw fail('SERVICE_NOT_FOUND', 'This external AI service is no longer configured; add it again or choose another AI.', 404);
  return { ...record };
}

export async function getActiveService() {
  const [settings, raw] = await Promise.all([
    readJson(SETTINGS_FILE, DEFAULT_SETTINGS),
    readJson(SERVICES_FILE, EMPTY),
  ]);
  if (!settings.activeServiceId) return null;
  const record = raw.services.find(item => item.id === settings.activeServiceId);
  if (!record) return null;
  return { ...record };
}

export async function getActiveServicePublic() {
  const record = await getActiveService();
  return record ? publicRecord(record) : null;
}

export async function deactivateService() {
  return updateJson(SETTINGS_FILE, DEFAULT_SETTINGS, settings => ({ ...settings, activeServiceId: null }));
}
