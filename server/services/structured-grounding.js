import { log } from '../lib/log.js';

const WORD = /[\p{L}\p{N}]+/gu;

function clean(value) {
  return String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function canonical(value) {
  return clean(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tokens(value) {
  return new Set(canonical(value).match(WORD) || []);
}

function overlapRatio(value, source) {
  const wanted = tokens(value);
  if (!wanted.size) return 0;
  const available = tokens(source);
  let shared = 0;
  for (const token of wanted) if (available.has(token)) shared += 1;
  return shared / wanted.size;
}

function editDistance(a, b) {
  a = canonical(a); b = canonical(b);
  if (!a || !b) return Math.max(a.length, b.length);
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

export function resemblesExample(value, examples = []) {
  const candidate = canonical(value);
  if (!candidate) return false;
  return examples.some(example => {
    const sample = canonical(example);
    if (!sample) return false;
    if (candidate === sample || candidate.includes(sample) || sample.includes(candidate)) return true;
    const scale = Math.max(candidate.length, sample.length);
    return scale <= 64 && editDistance(candidate, sample) / scale <= 0.2;
  });
}

export function traceable(value, sources = [], mode = 'paraphrase') {
  const candidate = clean(value);
  if (!candidate) return false;
  const sourceText = sources.map(clean).filter(Boolean).join('\n');
  if (!sourceText) return false;
  if (canonical(sourceText).includes(canonical(candidate))) return true;
  if (mode === 'exact') return false;
  const words = tokens(candidate).size;
  const threshold = words <= 3 ? 1 : words <= 6 ? 0.66 : 0.5;
  return overlapRatio(candidate, sourceText) >= threshold;
}

function getPath(root, path) {
  return path.split('.').reduce((value, key) => value?.[key], root);
}

function dropReason(stageId, path, reason, value) {
  log.warn('structured.guard-drop', { stageId, path, reason, value: clean(value).slice(0, 160) });
}

function guardedExamples(guard = {}) {
  return Array.isArray(guard.examples) ? guard.examples.map(clean).filter(Boolean) : [];
}

function guardCompression(value, vars, guard, drops) {
  const examples = guardedExamples(guard);
  const snippets = (value?.snippets || []).filter((snippet, index) => {
    if (resemblesExample(snippet, examples)) {
      drops.push({ path: `snippets[${index}]`, reason: 'PROMPT_EXAMPLE_ECHO' });
      dropReason('compression-extract', `snippets[${index}]`, 'PROMPT_EXAMPLE_ECHO', snippet);
      return false;
    }
    if (!traceable(snippet, [vars.source], 'exact')) {
      drops.push({ path: `snippets[${index}]`, reason: 'SOURCE_UNTRACEABLE' });
      dropReason('compression-extract', `snippets[${index}]`, 'SOURCE_UNTRACEABLE', snippet);
      return false;
    }
    return true;
  });
  return { ...value, snippets };
}

export function guardStructuredValue(stageId, value, vars = {}, guard = {}) {
  const drops = [];
  let guarded = value;
  if (stageId === 'compression-extract') guarded = guardCompression(value, vars, guard, drops);
  else {
    const examples = guardedExamples(guard);
    for (const path of guard.echoPaths || []) {
      const field = getPath(value, path);
      if (field && resemblesExample(field, examples)) {
        drops.push({ path, reason: 'PROMPT_EXAMPLE_ECHO' });
        dropReason(stageId, path, 'PROMPT_EXAMPLE_ECHO', field);
        guarded = null;
        break;
      }
    }
  }
  return { ok: guarded !== null, value: guarded, drops };
}
