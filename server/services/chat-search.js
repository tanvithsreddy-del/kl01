import { CHAT_SEARCH_FILE } from '../lib/paths.js';
import { readJsonRecovering, updateJson, writeJson } from './store.js';

const INDEX_VERSION = 1;
const EMPTY_INDEX = { version: INDEX_VERSION, updatedAt: null, documents: {} };
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function now() { return new Date().toISOString(); }

export function normaliseSearchText(value) {
  return String(value || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\p{Z}\s]+/gu, ' ')
    .trim();
}

function tokens(value) {
  const normalised = normaliseSearchText(value);
  const out = [];
  for (const part of wordSegmenter.segment(normalised)) {
    if (part.isWordLike && part.segment) out.push(part.segment);
  }
  if (!out.length && normalised) out.push(...normalised.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  return [...new Set(out)];
}

function trigrams(value) {
  const chars = [...normaliseSearchText(value).replace(/\s+/gu, ' ')];
  if (chars.length < 3) return new Set(chars.length ? [chars.join('')] : []);
  const out = new Set();
  for (let index = 0; index <= chars.length - 3; index += 1) out.add(chars.slice(index, index + 3).join(''));
  return out;
}

function similarity(left, right) {
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const item of left) if (right.has(item)) common += 1;
  return common / (left.size + right.size - common);
}

function field(role, text) {
  const source = String(text || '');
  return { role, text: source, normalised: normaliseSearchText(source), tokens: tokens(source) };
}

export function buildSearchDocument(chat) {
  const fields = [field('title', chat.title)];
  for (const message of chat.messages || []) {
    if (!['user', 'assistant'].includes(message.role)) continue;
    const text = message.content;
    if (String(text || '').trim()) fields.push(field(message.role, text));
  }
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    accent: chat.accent,
    branchedFrom: chat.branchedFrom || null,
    projectId: chat.projectId || null,
    pinned: Boolean(chat.pinned),
    archived: Boolean(chat.archived),
    archivedAt: chat.archivedAt || null,
    fields,
  };
}

export async function replaceSearchDocuments(chats) {
  const documents = {};
  for (const chat of chats || []) documents[chat.id] = buildSearchDocument(chat);
  return writeJson(CHAT_SEARCH_FILE, { version: INDEX_VERSION, updatedAt: now(), documents });
}

export async function upsertSearchDocument(chat) {
  const document = buildSearchDocument(chat);
  await updateJson(CHAT_SEARCH_FILE, EMPTY_INDEX, index => ({
    version: INDEX_VERSION,
    updatedAt: now(),
    documents: { ...(index?.version === INDEX_VERSION ? index.documents : {}), [chat.id]: document },
  }));
  return document;
}

export async function removeSearchDocument(chatId) {
  await updateJson(CHAT_SEARCH_FILE, EMPTY_INDEX, index => {
    const documents = { ...(index?.version === INDEX_VERSION ? index.documents : {}) };
    delete documents[chatId];
    return { version: INDEX_VERSION, updatedAt: now(), documents };
  });
}

function roleWeight(role) {
  if (role === 'title') return 1.8;
  if (role === 'user') return 1.2;
  return 1;
}

function bestFieldMatch(document, query) {
  const queryTokens = tokens(query);
  const queryTrigrams = trigrams(query);
  let best = null;
  for (const candidate of document.fields || []) {
    let score = 0;
    let match = null;
    const weight = roleWeight(candidate.role);
    const phraseIndex = candidate.normalised.indexOf(query);
    if (phraseIndex >= 0) {
      score += (candidate.role === 'title' ? 150 : candidate.role === 'user' ? 80 : 64) * weight;
      if (candidate.role === 'title' && phraseIndex === 0) score += 35;
      match = { kind: 'phrase', value: query, index: phraseIndex };
    }
    for (const queryToken of queryTokens) {
      if (!queryToken) continue;
      if (candidate.tokens.includes(queryToken)) {
        score += (candidate.role === 'title' ? 28 : candidate.role === 'user' ? 17 : 13) * weight;
        match ||= { kind: 'token', value: queryToken, index: candidate.normalised.indexOf(queryToken) };
        continue;
      }
      const prefix = candidate.tokens.find(token => token.startsWith(queryToken) || queryToken.startsWith(token));
      if (prefix && Math.min(prefix.length, queryToken.length) >= 3) {
        score += (candidate.role === 'title' ? 16 : candidate.role === 'user' ? 10 : 8) * weight;
        match ||= { kind: 'token', value: prefix, index: candidate.normalised.indexOf(prefix) };
        continue;
      }
      if (queryToken.length < 4) continue;
      let fuzzy = null;
      let fuzzyScore = 0;
      const queryTokenTrigrams = trigrams(queryToken);
      for (const token of candidate.tokens) {
        if (Math.abs(token.length - queryToken.length) > 3) continue;
        const current = similarity(queryTokenTrigrams, trigrams(token));
        if (current > fuzzyScore) { fuzzyScore = current; fuzzy = token; }
      }
      if (fuzzy && fuzzyScore >= 0.5) {
        score += fuzzyScore * (candidate.role === 'title' ? 12 : candidate.role === 'user' ? 8 : 6) * weight;
        match ||= { kind: 'token', value: fuzzy, index: candidate.normalised.indexOf(fuzzy) };
      }
    }
    if (queryTokens.length > 1 && queryTokens.every(token => candidate.tokens.some(item => item === token || item.startsWith(token)))) score += 22 * weight;
    if (!match && query.length >= 4) {
      const wholeSimilarity = similarity(queryTrigrams, trigrams(candidate.normalised.slice(0, Math.max(120, query.length * 5))));
      if (wholeSimilarity >= 0.42) {
        score += wholeSimilarity * 8 * weight;
        match = { kind: 'token', value: candidate.tokens[0] || candidate.text.slice(0, query.length), index: 0 };
      }
    }
    if (!best || score > best.score) best = { score, field: candidate, match };
  }
  return best;
}

function snippet(fieldValue, match) {
  const source = String(fieldValue?.text || '');
  if (!source) return null;
  const folded = normaliseSearchText(source);
  const requested = String(match?.value || '').normalize('NFC');
  let index = Number.isInteger(match?.index) ? match.index : folded.indexOf(normaliseSearchText(requested));
  if (index < 0) index = 0;
  const sourceChars = [...source];
  const beforeStart = Math.max(0, index - 36);
  const length = Math.max(1, [...requested].length || 1);
  return {
    before: sourceChars.slice(beforeStart, index).join(''),
    match: sourceChars.slice(index, index + length).join('') || sourceChars.slice(0, length).join(''),
    after: sourceChars.slice(index + length, index + length + 56).join(''),
  };
}

function recencyBoost(updatedAt) {
  const age = Date.now() - Date.parse(updatedAt || 0);
  if (!Number.isFinite(age) || age < 0) return 0;
  const days = age / 86_400_000;
  return Math.max(0, 8 - Math.log2(days + 1));
}

export async function searchChatIndex(query, { includeArchived = false, limit = 50 } = {}) {
  const needle = normaliseSearchText(query);
  if (!needle) return [];
  const index = await readJsonRecovering(CHAT_SEARCH_FILE, EMPTY_INDEX);
  if (index?.version !== INDEX_VERSION || !index.documents || typeof index.documents !== 'object') return [];
  const results = [];
  for (const document of Object.values(index.documents)) {
    if (Boolean(document.archived) !== Boolean(includeArchived)) continue;
    const best = bestFieldMatch(document, needle);
    if (!best?.match || best.score <= 0) continue;
    const score = best.score + recencyBoost(document.updatedAt) + (document.pinned ? 4 : 0);
    results.push({
      id: document.id,
      title: document.title,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      accent: document.accent,
      branchedFrom: document.branchedFrom || null,
      projectId: document.projectId || null,
      pinned: Boolean(document.pinned),
      archived: Boolean(document.archived),
      archivedAt: document.archivedAt || null,
      score,
      snippet: best.field.role === 'title' ? null : snippet(best.field, best.match),
    });
  }
  return results
    .sort((a, b) => b.score - a.score
      || Number(b.pinned) - Number(a.pinned)
      || String(b.updatedAt).localeCompare(String(a.updatedAt))
      || collator.compare(a.title, b.title))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 50)))
    .map(({ score: _score, ...result }) => result);
}

export async function searchIndexDocumentIds() {
  const index = await readJsonRecovering(CHAT_SEARCH_FILE, EMPTY_INDEX);
  if (index?.version !== INDEX_VERSION || !index.documents || typeof index.documents !== 'object') return [];
  return Object.keys(index.documents).sort();
}

export async function searchIndexDocumentCount() {
  return (await searchIndexDocumentIds()).length;
}
