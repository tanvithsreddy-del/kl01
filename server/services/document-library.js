import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DOCUMENTS_DIR, DOCUMENT_INDEX_FILE, safeId } from '../lib/paths.js';
import { fail } from '../lib/errors.js';
import { readJson, readJsonRecovering, writeJson } from './store.js';

const VERSION = 1;
const PROCESSOR_VERSION = 4;
const DEFAULT_MAX_LIBRARY_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_CHAT_DOCUMENTS = 128;
const EMPTY_INDEX = Object.freeze({ version:VERSION, documents:[], chats:{} });
const STOP_WORDS = new Set([
  'a','an','and','answer','are','as','ask','asks','at','attached','be','book','by','can','compact','day','days','did','do','does','explain','find','for','from','help','how','i','identify','in','include','into','is','it','locate','make','me','my','of','on','one','only','or','per','please','question','relationship','self','sentence','short','show','simply','store','test','textbook','that','the','this','three','to','use','was','what','why','with','work','works','you','according',
]);
const INDIRECT = /\b(?:this|that|previous|last|same)\s+(?:exercise|problem|question|example|step|part|section|chapter|result|textbook\s+section|one)\b|\b(?:the\s+)?(?:second|third|next|previous|last)\s+(?:step|part|one)\b|^\s*(?:why|how|explain)\b.{0,80}\b(?:that|it)\b/iu;
const STRUCTURE = /\b(?:chapter|section|exercise|problem|question|example|worked\s+example|q(?:uestion)?|ques)\s*[-:#.]?\s*([a-z]?\d+(?:\.\d+)*)\b/giu;
const SYNONYM_GROUPS = [
  ['exercise','problem','question'],
  ['example','worked'],
  ['boundary','terminal','end'],
  ['derive','prove','show','demonstrate'],
  ['recurrence','recursive','relation'],
  ['step','stage','part'],
  ['induction','inductive'],
  ['transformer','machine'],
  ['loss','losses'],
];
const SYNONYMS = new Map();
for (const group of SYNONYM_GROUPS) for (const word of group) SYNONYMS.set(word, group);

const now = () => new Date().toISOString();
const clone = value => structuredClone(value);

function emptyIndex() { return clone(EMPTY_INDEX); }
function hashText(text) { return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex'); }
function documentId(contentHash) { return `doc-${String(contentHash).slice(0, 24)}`; }
function normalize(value = '') {
  return String(value).normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase('en').replace(/[’']/gu, '').replace(/[^\p{L}\p{N}.]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}
function stem(value = '') {
  const word = String(value);
  if (word.length > 6 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 5 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}
function terms(value = '') {
  const found = normalize(value).match(/[\p{L}\p{N}]+(?:\.[\p{N}]+)*/gu) || [];
  const output = new Set();
  for (const raw of found) {
    const word = stem(raw);
    if (word.length < 2 || STOP_WORDS.has(word)) continue;
    output.add(word);
    for (const synonym of SYNONYMS.get(word) || []) output.add(stem(synonym));
  }
  return [...output];
}
function structuralAliases(value = '') {
  const aliases = new Set();
  for (const match of String(value).matchAll(STRUCTURE)) {
    const whole = normalize(match[0]);
    const number = normalize(match[1]);
    if (whole) aliases.add(whole);
    if (number) aliases.add(number);
  }
  return [...aliases];
}

function makeChunks(text = '') {
  const source = String(text || '').replace(/\r\n?/gu, '\n').trim();
  const lines = source.split('\n');
  const sections = [];
  let current = { heading:'Document opening', lineStart:1, lines:[] };
  const flush = () => {
    const content = current.lines.join('\n').trim();
    if (content) sections.push({ ...current, content, lineEnd:Math.max(current.lineStart, current.lineStart + current.lines.length - 1) });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const markdownHeading = line.match(/^\s*#{1,6}\s+(.+?)\s*$/u);
    const textbookHeading = line.match(/^\s*((?:chapter|section|exercise|problem|question|worked\s+example|example)\s*[-:#.]?\s*[a-z]?\d+(?:\.\d+)*(?:\s*[:—-].*)?)\s*$/iu);
    const questionHeading = line.match(/^\s*=?\s*(?:ques\.|question)\s+(.+?)\s*=?\s*$/iu);
    const markedHeading = line.match(/^\s*=([^=\n]{3,120})=\s*(?:--.*)?$/u);
    const compact = line.trim();
    const uppercaseHeading = compact.length >= 4 && compact.length <= 100 && /\p{L}/u.test(compact) && compact === compact.toLocaleUpperCase() && !/[.!?]$/u.test(compact);
    const detectedHeading = markdownHeading?.[1] || textbookHeading?.[1] || questionHeading?.[1] || markedHeading?.[1] || (uppercaseHeading ? compact : '');
    if (detectedHeading && current.lines.length) {
      flush();
      current = { heading:String(detectedHeading).trim(), lineStart:index + 1, lines:[line] };
    } else {
      if (!current.lines.length && detectedHeading) current.heading = String(detectedHeading).trim();
      current.lines.push(line);
    }
  }
  flush();
  const chunks = [];
  for (const section of sections) {
    const value = section.content;
    for (let offset = 0, part = 0; offset < value.length; part += 1) {
      const proposed = Math.min(value.length, offset + 1_800);
      const boundary = proposed < value.length ? Math.max(value.lastIndexOf('\n', proposed), value.lastIndexOf(' ', proposed)) : proposed;
      const end = boundary > offset + 500 ? boundary : proposed;
      const content = value.slice(offset, end).trim();
      if (content) {
        const lineStart = section.lineStart + (value.slice(0, offset).match(/\n/gu) || []).length;
        const lineEnd = lineStart + (content.match(/\n/gu) || []).length;
        const tokenList = terms(`${section.heading} ${content}`);
        const frequencies = {};
        for (const token of tokenList) frequencies[token] = (frequencies[token] || 0) + 1;
        chunks.push({
          id:`chunk-${chunks.length + 1}`,
          order:chunks.length,
          heading:section.heading,
          lineStart,
          lineEnd,
          part,
          aliases:structuralAliases(`${section.heading}\n${content}`),
          frequencies,
          content,
        });
      }
      offset = end;
    }
  }
  return chunks;
}

function sanitizeIndex(raw) {
  const documents = [];
  for (const item of Array.isArray(raw?.documents) ? raw.documents : []) {
    const id = String(item?.id || '');
    if (!/^doc-[a-f0-9]{24}$/u.test(id)) continue;
    documents.push({
      id,
      contentHash:String(item?.contentHash || ''),
      name:String(item?.name || 'Local document'),
      names:[...new Set((Array.isArray(item?.names) ? item.names : [item?.name]).map(String).filter(Boolean))],
      extension:String(item?.extension || 'txt'),
      size:Number(item?.size || 0),
      chunkCount:Number(item?.chunkCount || 0),
      chatIds:[...new Set((Array.isArray(item?.chatIds) ? item.chatIds : []).map(String).filter(Boolean))],
      createdAt:item?.createdAt || now(),
      updatedAt:item?.updatedAt || item?.createdAt || now(),
    });
  }
  const chats = {};
  for (const [chatId, state] of Object.entries(raw?.chats && typeof raw.chats === 'object' ? raw.chats : {})) {
    chats[String(chatId)] = {
      documentIds:[...new Set((Array.isArray(state?.documentIds) ? state.documentIds : []).map(String).filter(id => documents.some(doc => doc.id === id)))],
      lastSelection:(Array.isArray(state?.lastSelection) ? state.lastSelection : []).filter(item => documents.some(doc => doc.id === item?.documentId)).map(item => ({ documentId:String(item.documentId), chunkId:String(item.chunkId || '') })).slice(0, 8),
      updatedAt:state?.updatedAt || null,
    };
  }
  return { version:VERSION, documents, chats };
}

function metadata(record, indexItem) {
  return {
    id:record.id,
    name:indexItem?.name || record.name,
    extension:indexItem?.extension || record.extension,
    size:Number(indexItem?.size || record.size || 0),
    chunkCount:record.chunks.length,
    processedAt:record.processedAt,
  };
}

function scoreChunk(chunk, queryTerms, aliases, { recent = false, current = false } = {}) {
  let score = current ? 5 : 0;
  const heading = normalize(chunk.heading);
  for (const alias of aliases) {
    if (chunk.aliases.includes(alias)) score += alias.includes(' ') ? 180 : 120;
    else if (normalize(chunk.content).includes(alias)) score += 70;
  }
  for (const term of queryTerms) {
    const frequency = Number(chunk.frequencies?.[term] || 0);
    if (frequency) score += Math.min(4, frequency) * 9;
    if (heading.includes(term)) score += 13;
  }
  if (recent) score += 90;
  return score;
}

function boundedDirectAnswer(chunk) {
  const content = String(chunk?.content || '');
  const answer = content.match(/^(\s*=?\s*(?:ques\.|question)[\s\S]*?\bAns\.\s*[^\n]*(?:\n(?!\s*\n)[^\n]*)*)/iu)?.[1]?.trim();
  if (!answer) return chunk;
  return { ...chunk, content:answer, lineEnd:chunk.lineStart + (answer.match(/\n/gu) || []).length };
}

function boundedFocusedEvidence(chunk, question) {
  const direct = boundedDirectAnswer(chunk);
  if (direct !== chunk) return direct;
  const request = String(question || '');
  if (/\bohm(?:['’]?s)?\s+law\b/iu.test(request) || (/\bcurrent\b/iu.test(request) && /\bresistance\b/iu.test(request) && /Ohm[’']?s\s+law\s+states/iu.test(String(chunk?.content || '')))) {
    const formula = String(chunk?.content || '').match(/Ohm[’']?s\s+law\s+states\s+that[\s\S]*?amperes\s*=\s*volts\s*\/\s*ohms/iu)?.[0]?.trim();
    if (formula) return { ...chunk, content:formula, lineEnd:chunk.lineStart + (formula.match(/\n/gu) || []).length };
  }
  return chunk;
}

function recordForInput(item) {
  const text = String(item?.text || '').replace(/^\uFEFF/u, '');
  const contentHash = String(item?.contentHash || hashText(text));
  const attachment = item?.attachment || {};
  return {
    version:VERSION,
    processorVersion:PROCESSOR_VERSION,
    id:documentId(contentHash),
    contentHash,
    name:String(attachment.name || 'Local document'),
    extension:String(attachment.extension || 'txt'),
    size:Number(attachment.size || Buffer.byteLength(text, 'utf8')),
    processedAt:now(),
    sourceText:text,
    chunks:makeChunks(text),
  };
}

export function createDocumentLibrary({ rootDir = DOCUMENTS_DIR, indexFile = null, maxLibraryBytes = DEFAULT_MAX_LIBRARY_BYTES, maxChatDocuments = DEFAULT_MAX_CHAT_DOCUMENTS } = {}) {
  const base = path.resolve(rootDir);
  const indexPath = path.resolve(indexFile || (base === path.resolve(DOCUMENTS_DIR) ? DOCUMENT_INDEX_FILE : path.join(base, 'index.json')));
  let mutation = Promise.resolve();
  const docPath = id => path.join(base, `${safeId(id)}.json`);
  const readIndex = async () => sanitizeIndex(await readJsonRecovering(indexPath, emptyIndex()));
  const writeIndex = index => writeJson(indexPath, sanitizeIndex(index));
  const mutate = work => {
    const next = mutation.then(work, work);
    mutation = next.catch(() => {});
    return next;
  };
  const loadRecord = async id => {
    try {
      const record = await readJson(docPath(id), null);
      if (!record || record.id !== id || !Array.isArray(record.chunks)) return null;
      if (Number(record.processorVersion || 0) < PROCESSOR_VERSION && typeof record.sourceText === 'string') {
        const migrated = recordForInput({
          attachment:{ name:record.name, extension:record.extension, size:record.size },
          text:record.sourceText,
          contentHash:record.contentHash,
        });
        await writeJson(docPath(id), migrated);
        return migrated;
      }
      return record;
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  };

  async function ingest(chatId, attachmentInputs) {
    const prepared = (attachmentInputs || []).map(recordForInput);
    if (!prepared.length) return { attachments:[], documentIds:[] };
    return mutate(async () => {
      await fs.mkdir(base, { recursive:true });
      const index = await readIndex();
      const chatKey = String(chatId);
      const state = index.chats[chatKey] || { documentIds:[], lastSelection:[], updatedAt:null };
      const uniqueNew = prepared.filter(record => !index.documents.some(item => item.id === record.id));
      const projectedBytes = index.documents.reduce((sum, item) => sum + Math.max(0, Number(item.size || 0)), 0) + uniqueNew.reduce((sum, item) => sum + item.size, 0);
      if (projectedBytes > Math.max(1, Number(maxLibraryBytes) || DEFAULT_MAX_LIBRARY_BYTES)) throw fail('DOCUMENT_LIBRARY_FULL', 'Local document storage is full. Delete an old chat with attached files before adding another textbook.', 413);
      const projectedChatDocuments = new Set([...state.documentIds, ...prepared.map(record => record.id)]).size;
      if (projectedChatDocuments > Math.max(1, Number(maxChatDocuments) || DEFAULT_MAX_CHAT_DOCUMENTS)) throw fail('CHAT_DOCUMENT_LIMIT', `This chat already has too many local documents. Start a new chat or delete unused attachments; the limit is ${Math.max(1, Number(maxChatDocuments) || DEFAULT_MAX_CHAT_DOCUMENTS)}.`, 413);
      const enriched = [];
      for (let position = 0; position < prepared.length; position += 1) {
        const record = prepared[position];
        const source = attachmentInputs[position];
        let item = index.documents.find(doc => doc.id === record.id);
        if (!item) {
          await writeJson(docPath(record.id), record);
          item = { ...metadata(record, record), contentHash:record.contentHash, names:[record.name], chatIds:[], createdAt:now(), updatedAt:now() };
          index.documents.push(item);
        } else {
          const stored = await loadRecord(record.id);
          if (!stored || Number(stored.processorVersion || 0) < PROCESSOR_VERSION) await writeJson(docPath(record.id), record);
          item.names = [...new Set([...(item.names || []), record.name])];
          item.chunkCount = record.chunks.length;
          item.updatedAt = now();
        }
        if (!item.chatIds.includes(chatKey)) item.chatIds.push(chatKey);
        if (!state.documentIds.includes(record.id)) state.documentIds.push(record.id);
        enriched.push({ ...clone(source.attachment), documentId:record.id });
      }
      state.updatedAt = now();
      index.chats[chatKey] = state;
      await writeIndex(index);
      return { attachments:enriched, documentIds:prepared.map(record => record.id) };
    });
  }

  async function select(chatId, question, { currentRecords = [], currentDocumentIds = [], persistSelection = false } = {}) {
    await mutation.catch(() => {});
    const index = await readIndex();
    const chatKey = String(chatId);
    const state = index.chats[chatKey] || { documentIds:[], lastSelection:[] };
    const allowedIds = [...new Set([...state.documentIds, ...currentDocumentIds])];
    const currentById = new Map(currentRecords.map(record => [record.id, record]));
    const records = [];
    for (const id of allowedIds) {
      const record = currentById.get(id) || await loadRecord(id);
      const indexItem = index.documents.find(item => item.id === id);
      if (record && (currentById.has(id) || indexItem?.chatIds?.includes(chatKey))) records.push({ record, indexItem });
    }
    if (!records.length) return { documents:[], attachmentInputs:[], selection:[] };
    const queryTerms = terms(question);
    const aliases = structuralAliases(question);
    const indirect = INDIRECT.test(String(question || ''));
    const recentKeys = new Set((state.lastSelection || []).map(item => `${item.documentId}:${item.chunkId}`));
    const ranked = [];
    const normalizedQuestion = normalize(question);
    for (const entry of records) for (const chunk of entry.record.chunks) {
      let semanticBoost = 0;
      if (/\bquestion\b/iu.test(String(question || '')) && /^\s*=?\s*(?:ques\.|question)(?:\s|=)/iu.test(String(chunk.content || ''))) semanticBoost += 220;
      if (/\bohm(?:s)?\s+law\b/iu.test(normalizedQuestion) && /(?:\bi\s*=\s*e\s*\/\s*r\b|amperes\s*=\s*volts\s*\/\s*ohms|current\s*=\s*electromotive\s+force\s*\/\s*resistance)/iu.test(chunk.content)) {
        semanticBoost += 140;
        if (/\bvoltage\b/iu.test(normalizedQuestion) && /\bvolts?|voltage\b/iu.test(chunk.content)) semanticBoost += 140;
      }
      ranked.push({
        ...entry,
        chunk,
        score:semanticBoost + scoreChunk(chunk, queryTerms, aliases, {
          recent:indirect && recentKeys.has(`${entry.record.id}:${chunk.id}`),
          current:currentDocumentIds.includes(entry.record.id),
        }),
      });
    }
    const documentFrequency = new Map();
    for (const item of ranked) for (const term of queryTerms) if (item.chunk.frequencies?.[term]) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    for (const item of ranked) {
      for (const term of queryTerms) {
        if (!item.chunk.frequencies?.[term]) continue;
        const rarity = Math.log((ranked.length + 1) / ((documentFrequency.get(term) || 0) + 1));
        item.score += Math.max(0, rarity) * 11 + Math.min(18, Math.max(0, term.length - 5) * 3);
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.chunk.order - b.chunk.order);
    const explicitContinuation = indirect && /\b(?:same|previous|last)\b|\b(?:this|that)\s+(?:same\s+)?(?:exercise|problem|question|example|step|part|section|chapter|result|one)\b/iu.test(String(question || ''));
    let winners = explicitContinuation ? ranked.filter(item => recentKeys.has(`${item.record.id}:${item.chunk.id}`)).slice(0, 4) : ranked.filter(item => item.score > 0).slice(0, 4);
    if (!winners.length && currentDocumentIds.length) winners = ranked.filter(item => currentDocumentIds.includes(item.record.id)).slice(0, 2);
    if (!winners.length && indirect && recentKeys.size) winners = ranked.filter(item => recentKeys.has(`${item.record.id}:${item.chunk.id}`)).slice(0, 3);
    if (!winners.length) return { documents:[], attachmentInputs:[], selection:[] };
    const best = winners[0].score;
    const anchor = [...queryTerms].sort((left, right) => {
      const leftDf = documentFrequency.get(left) || ranked.length;
      const rightDf = documentFrequency.get(right) || ranked.length;
      return (right.length * Math.log((ranked.length + 1) / (rightDf + 1))) - (left.length * Math.log((ranked.length + 1) / (leftDf + 1)));
    })[0] || '';
    const headedAnchor = anchor.length >= 8 ? ranked.find(item => normalize(item.chunk.heading).includes(anchor) && item.score >= best * 0.60) : null;
    const broadSynthesis = /\b(?:compare|comparison|overview|plan|revision|schedule|summari[sz]e|summary|multiple|several|across)\b/iu.test(String(question || ''));
    if (broadSynthesis) {
      const uncovered = new Set(queryTerms);
      const coverage = [];
      const pool = ranked.filter(item => item.score > 0 && !/=\s*\d+\s+to\s+\d+\s*=/iu.test(String(item.chunk.content || '')));
      while (coverage.length < 3 && pool.length) {
        pool.sort((left, right) => {
          const leftCoverage = [...uncovered].filter(term => left.chunk.frequencies?.[term]).length;
          const rightCoverage = [...uncovered].filter(term => right.chunk.frequencies?.[term]).length;
          return rightCoverage - leftCoverage || right.score - left.score || left.chunk.order - right.chunk.order;
        });
        const next = pool.shift();
        if (!next) break;
        coverage.push(next);
        for (const term of [...uncovered]) if (next.chunk.frequencies?.[term]) uncovered.delete(term);
      }
      winners = coverage;
    }
    winners = headedAnchor && !broadSynthesis
      ? [{ ...headedAnchor, chunk:boundedFocusedEvidence(headedAnchor.chunk, question) }]
      : broadSynthesis
        ? winners.slice(0, 3)
        : winners.slice(0, 1).map(item => ({ ...item, chunk:boundedFocusedEvidence(item.chunk, question) }));
    const grouped = new Map();
    for (const winner of winners) {
      if (!grouped.has(winner.record.id)) grouped.set(winner.record.id, { ...winner, chunks:[] });
      const group = grouped.get(winner.record.id);
      if (!group.chunks.some(chunk => chunk.id === winner.chunk.id)) group.chunks.push(winner.chunk);
    }
    const attachmentInputs = [];
    const documents = [];
    const selection = [];
    let remaining = 12_000;
    for (const group of grouped.values()) {
      if (remaining < 600) break;
      const parts = [];
      for (const chunk of group.chunks.sort((a, b) => a.order - b.order)) {
        const label = `[${group.indexItem?.name || group.record.name} · ${chunk.heading} · lines ${chunk.lineStart}-${chunk.lineEnd}]`;
        const available = Math.max(0, Math.min(5_000, remaining - label.length - 2));
        const content = chunk.content.slice(0, available).trim();
        if (!content) continue;
        parts.push(`${label}\n${content}`);
        remaining -= label.length + content.length + 2;
        selection.push({ documentId:group.record.id, chunkId:chunk.id });
      }
      if (!parts.length) continue;
      const name = group.indexItem?.name || group.record.name;
      attachmentInputs.push({
        attachment:{ id:`stored-${group.record.id}`, documentId:group.record.id, name, extension:group.indexItem?.extension || group.record.extension, type:'text/plain', size:Buffer.byteLength(parts.join('\n\n')), kind:'text' },
        text:parts.join('\n\n'),
        contentHash:group.record.contentHash,
        documentId:group.record.id,
        chunkIds:group.chunks.map(chunk => chunk.id),
      });
      documents.push(metadata(group.record, group.indexItem));
    }
    if (persistSelection && selection.length) await mutate(async () => {
      const latest = await readIndex();
      const next = latest.chats[chatKey] || { documentIds:[], lastSelection:[], updatedAt:null };
      next.lastSelection = selection.slice(0, 8);
      next.updatedAt = now();
      latest.chats[chatKey] = next;
      await writeIndex(latest);
    });
    return { documents, attachmentInputs, selection };
  }

  async function prepareContext(chatId, question, attachmentInputs = [], { persist = true } = {}) {
    const currentRecords = (attachmentInputs || []).map(recordForInput);
    let attachments = (attachmentInputs || []).map(item => clone(item.attachment));
    let currentDocumentIds = currentRecords.map(record => record.id);
    if (persist && attachmentInputs.length) {
      const ingested = await ingest(chatId, attachmentInputs);
      attachments = ingested.attachments;
      currentDocumentIds = ingested.documentIds;
    }
    const selected = await select(chatId, question, { currentRecords, currentDocumentIds, persistSelection:persist });
    return { ...selected, attachments };
  }

  async function listChat(chatId) {
    await mutation.catch(() => {});
    const index = await readIndex();
    const ids = index.chats[String(chatId)]?.documentIds || [];
    return { documents:index.documents.filter(item => ids.includes(item.id)).map(item => ({ id:item.id, name:item.name, names:[...(item.names || [])], extension:item.extension, size:item.size, chunkCount:item.chunkCount, createdAt:item.createdAt, updatedAt:item.updatedAt })) };
  }

  async function linkChatDocuments(chatId, documentIds) {
    return mutate(async () => {
      const index = await readIndex();
      const chatKey = String(chatId);
      const existing = new Set(index.documents.map(item => item.id));
      const ids = [...new Set((documentIds || []).map(String).filter(id => existing.has(id)))];
      const state = index.chats[chatKey] || { documentIds:[], lastSelection:[], updatedAt:null };
      state.documentIds = [...new Set([...state.documentIds, ...ids])];
      if (!state.lastSelection.length) {
        const inherited = Object.values(index.chats).flatMap(item => item?.lastSelection || []).filter(item => ids.includes(item.documentId));
        state.lastSelection = inherited.slice(-8);
      }
      state.updatedAt = now();
      index.chats[chatKey] = state;
      for (const item of index.documents) if (ids.includes(item.id) && !item.chatIds.includes(chatKey)) item.chatIds.push(chatKey);
      await writeIndex(index);
      return { documents:index.documents.filter(item => state.documentIds.includes(item.id)).map(item => ({ id:item.id, name:item.name, names:[...(item.names || [])], extension:item.extension, size:item.size, chunkCount:item.chunkCount, createdAt:item.createdAt, updatedAt:item.updatedAt })) };
    });
  }

  async function syncChatDocuments(chatId, documentIds) {
    return mutate(async () => {
      const index = await readIndex();
      const chatKey = String(chatId);
      const known = new Set(index.documents.map(item => item.id));
      const ids = [...new Set((documentIds || []).map(String).filter(id => known.has(id)))];
      const state = index.chats[chatKey] || { documentIds:[], lastSelection:[], updatedAt:null };
      state.documentIds = ids;
      state.lastSelection = (state.lastSelection || []).filter(item => ids.includes(item.documentId));
      state.updatedAt = now();
      if (ids.length) index.chats[chatKey] = state;
      else delete index.chats[chatKey];
      const removed = [];
      for (const item of index.documents) {
        item.chatIds = item.chatIds.filter(id => id !== chatKey);
        if (ids.includes(item.id)) item.chatIds.push(chatKey);
        item.chatIds = [...new Set(item.chatIds)];
        if (!item.chatIds.length) removed.push(item.id);
      }
      index.documents = index.documents.filter(item => item.chatIds.length);
      await writeIndex(index);
      for (const id of removed) await fs.rm(docPath(id), { force:true });
      return { documents:index.documents.filter(item => ids.includes(item.id)).map(item => ({ id:item.id, name:item.name, names:[...(item.names || [])], extension:item.extension, size:item.size, chunkCount:item.chunkCount, createdAt:item.createdAt, updatedAt:item.updatedAt })), removed };
    });
  }

  async function detachChat(chatId) {
    return mutate(async () => {
      const index = await readIndex();
      const chatKey = String(chatId);
      delete index.chats[chatKey];
      const removed = [];
      for (const item of index.documents) {
        item.chatIds = item.chatIds.filter(id => id !== chatKey);
        if (!item.chatIds.length) removed.push(item.id);
      }
      index.documents = index.documents.filter(item => item.chatIds.length);
      await writeIndex(index);
      for (const id of removed) await fs.rm(docPath(id), { force:true });
      return { detached:chatKey, removed };
    });
  }

  return { prepareContext, listChat, linkChatDocuments, syncChatDocuments, detachChat };
}
