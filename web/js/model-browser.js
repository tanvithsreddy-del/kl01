export const DEFAULT_MODEL_BROWSER = Object.freeze({
  query: '',
  machineClass: 'all',
  availability: 'all',
  provider: 'all',
  purpose: 'all',
  input: 'all',
  fileType: 'all',
  sort: 'name',
});

const MACHINE_CLASS_ORDER = Object.freeze({ balanced: 0, powerful: 1, quick: 2, 'too-large': 3 });
const PURPOSE_LABELS = Object.freeze({
  general: 'General', writing: 'Writing', summarisation: 'Summaries', reasoning: 'Reasoning', coding: 'Coding', multilingual: 'Multilingual', 'long-context': 'Long context',
});

export function normalizeSearch(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[-_/]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function purposesFor(entry) {
  const tasks = [...new Set((entry.capabilities?.tasks || ['general']).map(item => String(item).toLowerCase()))];
  if (Number(entry.nativeContextSize || entry.contextSize || 0) >= 65_536 && !tasks.includes('long-context')) tasks.push('long-context');
  return tasks;
}

export function purposeLabel(value) { return PURPOSE_LABELS[value] || String(value || '').replace(/(^|-)([a-z])/gu, (_m, _dash, letter) => letter.toUpperCase()); }

export function fileTypesFor(entry) {
  return [...new Set((entry.capabilities?.fileTypes || []).map(item => String(item).toLowerCase()))];
}

export function inputsFor(entry) {
  return [...new Set((entry.capabilities?.inputModalities || ['text']).map(item => String(item).toLowerCase()))];
}

export function modelSearchText(entry) {
  return normalizeSearch([
    entry.name, entry.modelName, entry.family, entry.providerName, entry.providerId,
    entry.description, entry.quantization, entry.licence, entry.primaryType,
    ...(entry.bestFor || []), ...(entry.notIdealFor || []),
    ...Object.entries(entry.capabilityCriteria || {}).flat(),
    ...purposesFor(entry), ...inputsFor(entry), ...fileTypesFor(entry),
  ].join(' '));
}

export function sanitizeBrowserState(value = {}) {
  const next = { ...DEFAULT_MODEL_BROWSER, ...(value || {}) };
  for (const key of Object.keys(DEFAULT_MODEL_BROWSER)) next[key] = String(next[key] ?? DEFAULT_MODEL_BROWSER[key]);
  return next;
}

export function matchesModel(entry, browser, context) {
  const query = normalizeSearch(browser.query);
  if (query && !modelSearchText(entry).includes(query)) return false;
  if (browser.machineClass !== 'all' && entry.machineFit?.class !== browser.machineClass) return false;
  if (browser.provider !== 'all' && entry.providerId !== browser.provider) return false;
  if (browser.purpose !== 'all' && !purposesFor(entry).includes(browser.purpose)) return false;
  if (browser.input !== 'all' && !inputsFor(entry).includes(browser.input)) return false;
  if (browser.fileType !== 'all' && !fileTypesFor(entry).includes(browser.fileType)) return false;
  if (browser.availability === 'runs-now' && !entry.availability?.canRun) return false;
  if (browser.availability === 'installed' && !context.installedIds.has(entry.id)) return false;
  if (browser.availability === 'downloading' && !context.liveDownloadIds.has(entry.id)) return false;
  return true;
}

function stableIdentity(left, right) {
  return Number(left.curationRank ?? Number.MAX_SAFE_INTEGER) - Number(right.curationRank ?? Number.MAX_SAFE_INTEGER)
    || Number(left.originalIndex ?? Number.MAX_SAFE_INTEGER) - Number(right.originalIndex ?? Number.MAX_SAFE_INTEGER)
    || String(left.id).localeCompare(String(right.id));
}

export function compareModels(left, right, browser, context) {
  if (browser.sort === 'quickest') {
    return Number(left.machineFit?.demand ?? Infinity) - Number(right.machineFit?.demand ?? Infinity) || stableIdentity(left, right);
  }
  if (browser.sort === 'powerful') {
    return Number(right.availability?.canRun) - Number(left.availability?.canRun)
      || Number(right.machineFit?.demand ?? -Infinity) - Number(left.machineFit?.demand ?? -Infinity)
      || stableIdentity(left, right);
  }
  if (browser.sort === 'installed') {
    return Number(context.installedIds.has(right.id)) - Number(context.installedIds.has(left.id)) || stableIdentity(left, right);
  }
  if (browser.sort === 'smallest') return Number(left.size || 0) - Number(right.size || 0) || stableIdentity(left, right);
  if (browser.sort === 'context') return Number(right.nativeContextSize || right.contextSize || 0) - Number(left.nativeContextSize || left.contextSize || 0) || stableIdentity(left, right);
  if (browser.sort === 'type') return purposeLabel(left.primaryType || 'general').localeCompare(purposeLabel(right.primaryType || 'general')) || stableIdentity(left, right);
  if (browser.sort === 'provider') return String(left.providerName || '').localeCompare(String(right.providerName || '')) || String(left.name).localeCompare(String(right.name)) || stableIdentity(left, right);
  if (browser.sort === 'name') return String(left.name).localeCompare(String(right.name)) || stableIdentity(left, right);
  return Number(right.id === context.activeId) - Number(left.id === context.activeId)
    || Number(context.installedIds.has(right.id)) - Number(context.installedIds.has(left.id))
    || Number(context.liveDownloadIds.has(right.id)) - Number(context.liveDownloadIds.has(left.id))
    || Number(right.availability?.canRun) - Number(left.availability?.canRun)
    || Number(MACHINE_CLASS_ORDER[left.machineFit?.class] ?? 9) - Number(MACHINE_CLASS_ORDER[right.machineFit?.class] ?? 9)
    || stableIdentity(left, right);
}

export function browseModels(entries, browserInput, contextInput = {}) {
  const browser = sanitizeBrowserState(browserInput);
  const context = {
    installedIds: contextInput.installedIds || new Set(),
    liveDownloadIds: contextInput.liveDownloadIds || new Set(),
    activeId: contextInput.activeId || null,
  };
  return [...entries].filter(entry => matchesModel(entry, browser, context)).sort((left, right) => compareModels(left, right, browser, context));
}

export function browserFacets(entries) {
  const providers = [...new Map(entries.map(entry => [entry.providerId, entry.providerName])).entries()]
    .filter(([id]) => id)
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const purposes = [...new Set(entries.flatMap(purposesFor))].sort((left, right) => purposeLabel(left).localeCompare(purposeLabel(right)));
  const inputs = [...new Set(entries.flatMap(inputsFor))].sort();
  const fileTypes = [...new Set(entries.flatMap(fileTypesFor))].sort();
  return { providers, purposes, inputs, fileTypes };
}

export function machineClassCounts(entries, browserInput, context) {
  const browser = sanitizeBrowserState(browserInput);
  const counts = {};
  for (const value of ['all', 'quick', 'balanced', 'powerful', 'too-large']) {
    counts[value] = browseModels(entries, { ...browser, machineClass: value }, context).length;
  }
  return counts;
}
