import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = path.resolve(HERE, '..', 'prompts');
const FILES = Object.freeze({
  'chat-base': 'chat-base.v1.json',
  'compression-extract': 'compression-extract.v1.json',
  'structured-repair': 'structured-repair.v1.json',
  'computed-explain': 'computed-explain.v1.json',
  'section-repair': 'section-repair.v1.json',
});
const CACHE = new Map();

function validatePrompt(stageId, filename, parsed) {
  if (parsed.id !== stageId || !Number.isInteger(parsed.version) || parsed.version < 1) throw Object.assign(new Error(`invalid prompt metadata in ${filename}`), { code: 'PROMPT_METADATA' });
  if (typeof parsed.system !== 'string' || typeof parsed.user !== 'string') throw Object.assign(new Error(`invalid prompt text in ${filename}`), { code: 'PROMPT_SHAPE' });
  return Object.freeze({ ...parsed, filename });
}

await Promise.all(Object.entries(FILES).map(async ([stageId, filename]) => {
  const file = path.join(PROMPT_DIR, filename);
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  CACHE.set(stageId, validatePrompt(stageId, filename, parsed));
}));

function load(stageId) {
  if (!FILES[stageId]) throw Object.assign(new Error(`unknown prompt stage ${stageId}`), { code: 'PROMPT_UNKNOWN' });
  return CACHE.get(stageId);
}

function render(template, vars) {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw Object.assign(new Error(`prompt variable ${key} is required`), { code: 'PROMPT_VARIABLE', variable: key });
    const value = vars[key];
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

export function compose(stageId, vars = {}) {
  const prompt = load(stageId);
  return {
    promptId: prompt.id,
    promptVersion: prompt.version,
    system: render(prompt.system, vars),
    user: render(prompt.user, vars),
    schema: prompt.schema == null ? null : structuredClone(prompt.schema),
    maxTokens: Number(prompt.maxTokens),
    guard: prompt.guard == null ? null : structuredClone(prompt.guard),
  };
}

export function promptManifest() {
  return Object.keys(FILES).map(stageId => {
    const prompt = load(stageId);
    return { id: prompt.id, version: prompt.version, file: prompt.filename };
  });
}
