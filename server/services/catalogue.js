import fs from 'node:fs/promises';
import { CATALOGUE_FILE } from '../lib/paths.js';
import { fail } from '../lib/errors.js';
import { normalizedModelEntry } from './model-capabilities.js';

let cache = null;
const ALLOWED_KINDS = new Set(['model', 'tier', 'named']);

function validateEntry(entry) {
  const problems = [];
  for (const key of ['id', 'kind', 'name', 'description', 'plainDescription', 'filename', 'provenance', 'licence']) {
    if (typeof entry?.[key] !== 'string' || !entry[key].trim()) problems.push(`missing ${key}`);
  }
  if (!ALLOWED_KINDS.has(entry?.kind)) problems.push('invalid kind');
  if (!Number.isFinite(entry?.size) || entry.size <= 0) problems.push('invalid size');
  if (!/^[a-f0-9]{64}$/u.test(String(entry?.sha256 || ''))) problems.push('missing or invalid SHA-256');
  if (entry?.downloadUrl && !/^https:\/\//u.test(entry.downloadUrl)) problems.push('download URL must use HTTPS');
  if (entry?.downloadUrl && !/^https:\/\/huggingface\.co\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/resolve\/[a-f0-9]{40}\//u.test(entry.downloadUrl)) problems.push('download URL must use a pinned Hugging Face revision');
  if (entry?.resolvedDownloadUrl && !/^https:\/\//u.test(entry.resolvedDownloadUrl)) problems.push('resolved download URL must use HTTPS');
  if (entry?.licenceUrl != null && !/^https:\/\//u.test(String(entry.licenceUrl))) problems.push('licence URL must use HTTPS');
  if (entry?.licenceAcceptanceRequired != null && typeof entry.licenceAcceptanceRequired !== 'boolean') problems.push('invalid licence acceptance flag');
  if (entry?.licenceAcceptanceRequired === true && !entry?.licenceUrl) problems.push('custom licence requires terms URL');
  if (entry?.contextSize != null && (!Number.isFinite(Number(entry.contextSize)) || Number(entry.contextSize) <= 0)) problems.push('invalid context size');
  return problems;
}

export async function loadCatalogue({ refresh = false } = {}) {
  if (cache && !refresh) return structuredClone(cache);
  const parsed = JSON.parse(await fs.readFile(CATALOGUE_FILE, 'utf8'));
  const valid = [];
  const quarantined = [];
  const ids = new Set();
  const filenames = new Set();
  const urls = new Set();
  for (const raw of parsed.entries || []) {
    const entry = normalizedModelEntry(raw);
    const problems = validateEntry(entry);
    if (ids.has(entry?.id)) problems.push('duplicate id');
    ids.add(entry?.id);
    if (filenames.has(entry?.filename)) problems.push('duplicate filename');
    filenames.add(entry?.filename);
    const url = String(entry?.resolvedDownloadUrl || entry?.downloadUrl || '').trim();
    if (url && urls.has(url)) problems.push('duplicate URL');
    if (url) urls.add(url);
    (problems.length ? quarantined : valid).push(problems.length ? { entry, problems } : entry);
  }
  cache = { version: parsed.version, entries: valid, quarantined };
  return structuredClone(cache);
}

export async function getCatalogueEntry(id) {
  const { entries } = await loadCatalogue();
  const entry = entries.find(item => item.id === id);
  if (!entry) throw fail('MODEL_NOT_FOUND', 'This AI is not in the catalogue; choose another AI.', 404);
  return entry;
}
