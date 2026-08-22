import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { CHAT_INDEX_FILE, chatFile, CHATS_DIR } from '../lib/paths.js';
import { readJson, writeJson, updateJson } from './store.js';
import { fail } from '../lib/errors.js';
import { normalizeExecutionProfile } from './response-profile.js';
import {
  removeSearchDocument,
  replaceSearchDocuments,
  searchChatIndex,
  searchIndexDocumentIds,
  upsertSearchDocument,
} from './chat-search.js';

const INDEX_VERSION = 3;
const EMPTY_INDEX = { version: INDEX_VERSION, chats: [] };
const now = () => new Date().toISOString();
const id = prefix => `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const CHAT_ACCENTS = ['yellow', 'pink', 'green', 'blue', 'violet'];
const mutationQueues = new Map();

function withChatMutation(chatId, work) {
  const key = String(chatId);
  const previous = mutationQueues.get(key) || Promise.resolve();
  const next = previous.then(work, work);
  const tail = next.catch(() => {});
  mutationQueues.set(key, tail);
  return next.finally(() => { if (mutationQueues.get(key) === tail) mutationQueues.delete(key); });
}

function graphemes(value) {
  return [...graphemeSegmenter.segment(String(value || ''))].map(item => item.segment);
}

function normaliseText(value) {
  return String(value || '').normalize('NFC');
}

function migrateMessage(message = {}) {
  const hiddenPartial = typeof message.voiceSourceContent === 'string' ? message.voiceSourceContent : '';
  const {
    voice: _voice,
    voiceFailure: _voiceFailure,
    voiceSourceContent: _voiceSourceContent,
    checkWork: _checkWork,
    reasoningDepth: _reasoningDepth,
    reasoningAskWhenMatters: _reasoningAskWhenMatters,
    reasoningShowWorkingAtRun: _reasoningShowWorkingAtRun,
    reasoningProgress: _reasoningProgress,
    reasoningResult: _reasoningResult,
    socratic: _socratic,
    repairCheck: _repairCheck,
    ...kept
  } = message || {};
  const next = { pinned: false, edited: false, revisionId: null, repairPreview: null, ...kept };
  if (next.role === 'user') {
    next.attachments = Array.isArray(next.attachments) ? next.attachments.map(item => ({
      id: String(item?.id || ''),
      name: String(item?.name || 'Attached file'),
      extension: String(item?.extension || ''),
      type: String(item?.type || 'text/plain'),
      size: Number(item?.size || 0),
      kind: String(item?.kind || 'text'),
      documentId: item?.documentId ? String(item.documentId) : null,
    })) : [];
    // Durable chat history never owns attached file bodies. Older builds embedded them in modelContent.
    next.modelContent = next.attachments.length ? String(next.content || '') : String(next.modelContent ?? next.content ?? '');
  }
  if (next.role === 'assistant' && !String(next.content || '') && hiddenPartial) next.content = hiddenPartial;
  if (next.role === 'assistant') { next.workflow = next.workflow && typeof next.workflow === 'object' ? structuredClone(next.workflow) : null; next.work = next.work && typeof next.work === 'object' ? structuredClone(next.work) : null; }
  if (next.status === 'waiting-for-user') {
    next.status = 'cancelled';
    next.error = { code: 'LEGACY_TURN_CLOSED', message: 'This unfinished response was closed during the upgrade. Send the message again to continue.' };
  }
  if (next.repairPreview && typeof next.repairPreview === 'object') {
    const { voiceId: _removedVoiceId, ...preview } = next.repairPreview;
    next.repairPreview = preview;
  }
  return next;
}

export function accentForChatId(chatId) {
  const digest = crypto.createHash('sha256').update(String(chatId)).digest();
  return CHAT_ACCENTS[digest[0] % CHAT_ACCENTS.length];
}

export function titleFromFirstMessage(input, max = 40) {
  const cleaned = normaliseText(input).replace(/\s+/gu, ' ').trim();
  const clusters = graphemes(cleaned);
  if (clusters.length <= max) return cleaned || 'Untitled chat';
  const clippedClusters = clusters.slice(0, max);
  const clipped = clippedClusters.join('');
  const next = clusters[max] || '';
  if (/\s/u.test(next) || /\s$/u.test(clipped)) return clipped.trim();
  let lastSpaceCluster = -1;
  for (let index = clippedClusters.length - 1; index >= 0; index -= 1) {
    if (/\s/u.test(clippedClusters[index])) { lastSpaceCluster = index; break; }
  }
  return (lastSpaceCluster > 0 ? clippedClusters.slice(0, lastSpaceCluster).join('') : clipped).trim() || 'Untitled chat';
}

function summary(chat) {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    accent: chat.accent || accentForChatId(chat.id),
    branchedFrom: chat.branchedFrom || null,
    projectId: chat.projectId || null,
    pinned: Boolean(chat.pinned),
    archived: Boolean(chat.archived),
    archivedAt: chat.archivedAt || null,
  };
}

function migrateChat(chat) {
  if (!chat) return chat;
  const {
    voiceId: _voiceId,
    reasoning: _reasoning,
    temporary: _temporary,
    ...kept
  } = chat;
  return {
    ...kept,
    accent: chat.accent || accentForChatId(chat.id),
    projectId: chat.projectId || null,
    titleLocked: Boolean(chat.titleLocked),
    pinned: Boolean(chat.pinned),
    archived: Boolean(chat.archived),
    archivedAt: chat.archived ? (chat.archivedAt || chat.updatedAt || now()) : null,
    executionProfile: chat.executionProfile && typeof chat.executionProfile === 'object'
      ? normalizeExecutionProfile(chat.executionProfile, { reasoningSupported: true })
      : normalizeExecutionProfile({}, { reasoningSupported: true }),
    draft: chat.draft && typeof chat.draft === 'object'
      ? {
          text: String(chat.draft.text || ''),
          updatedAt: chat.draft.updatedAt || null,
          editedFrom: chat.draft.editedFrom || null,
          modelContent: String(chat.draft.text || ''),
          attachments: Array.isArray(chat.draft.attachments) ? structuredClone(chat.draft.attachments) : [],
          attachmentContents: [],
          executionProfile: chat.draft.executionProfile && typeof chat.draft.executionProfile === 'object' ? normalizeExecutionProfile(chat.draft.executionProfile, { reasoningSupported: true }) : null,
          sourceRunId: chat.draft.sourceRunId || null,
          warnings: Array.isArray(chat.draft.warnings) ? chat.draft.warnings.map(String) : [],
        }
      : { text: '', updatedAt: null, editedFrom: null, modelContent: '', attachments: [], attachmentContents: [], executionProfile: null, sourceRunId: null, warnings: [] },
    branchedFrom: chat.branchedFrom || null,
    messages: Array.isArray(chat.messages) ? chat.messages.map(migrateMessage) : [],
  };
}

function sortPrimary(a, b) {
  return Number(b.pinned) - Number(a.pinned)
    || String(b.updatedAt).localeCompare(String(a.updatedAt))
    || collator.compare(a.title, b.title);
}

function sortArchived(a, b) {
  return String(b.archivedAt || '').localeCompare(String(a.archivedAt || ''))
    || String(b.updatedAt).localeCompare(String(a.updatedAt))
    || collator.compare(a.title, b.title);
}

async function readIndex() {
  const index = await readJson(CHAT_INDEX_FILE, EMPTY_INDEX);
  return {
    version: INDEX_VERSION,
    chats: Array.isArray(index?.chats) ? index.chats.map(item => ({
      ...item,
      accent: item.accent || accentForChatId(item.id),
      branchedFrom: item.branchedFrom || null,
      projectId: item.projectId || null,
      pinned: Boolean(item.pinned),
      archived: Boolean(item.archived),
      archivedAt: item.archived ? (item.archivedAt || item.updatedAt || null) : null,
    })) : [],
  };
}

export async function listChats() {
  const index = await readIndex();
  return index.chats.filter(item => !item.archived).sort(sortPrimary);
}

export async function listArchivedChats() {
  const index = await readIndex();
  return index.chats.filter(item => item.archived).sort(sortArchived);
}

async function listAllChats() {
  const index = await readIndex();
  return index.chats.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || collator.compare(a.title, b.title));
}

function needsAttachmentPrivacyRewrite(raw){
  if(Array.isArray(raw?.draft?.attachmentContents)&&raw.draft.attachmentContents.length)return true;
  if(raw?.draft?.modelContent&&String(raw.draft.modelContent)!==String(raw.draft.text||''))return true;
  return (raw?.messages||[]).some(message=>message?.role==='user'&&Array.isArray(message.attachments)&&message.attachments.length&&String(message.modelContent||'')!==String(message.content||''));
}

export async function reconcileChatIndex() {
  await fs.mkdir(CHATS_DIR, { recursive: true });
  const entries = await fs.readdir(CHATS_DIR, { withFileTypes: true });
  const summaries = [];
  const documents = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === 'index.json' || !entry.name.endsWith('.json')) continue;
    const chatId = entry.name.slice(0, -5);
    try {
      const raw = await readJson(chatFile(chatId), null);
      if (raw?.id !== chatId) continue;
      const migrated = migrateChat(raw);
      summaries.push(summary(migrated));
      documents.push(migrated);
      const needsRewrite = raw.temporary !== undefined
        || raw.pinned === undefined
        || raw.archived === undefined
        || raw.archivedAt === undefined
        || needsAttachmentPrivacyRewrite(raw);
      if (needsRewrite) await writeJson(chatFile(chatId), migrated);
    } catch {
      // Keep damaged chat bytes untouched; the index simply omits an unreadable record.
    }
  }
  summaries.sort((a, b) => a.archived && !b.archived ? 1 : !a.archived && b.archived ? -1 : a.archived ? sortArchived(a, b) : sortPrimary(a, b));
  await writeJson(CHAT_INDEX_FILE, { version: INDEX_VERSION, chats: summaries });
  await replaceSearchDocuments(documents);
  return { chats: summaries.length, archived: summaries.filter(item => item.archived).length, searchIndexed: documents.length };
}

export async function createChat(title = '', options = {}) {
  const timestamp = now();
  const chatId = id('chat');
  let cleanTitle = String(title || '').trim();
  if (!cleanTitle || cleanTitle === 'Untitled chat') cleanTitle = 'New chat';
  const chat = migrateChat({
    id: chatId,
    title: cleanTitle,
    titleLocked: Boolean(options.titleLocked),
    accent: accentForChatId(chatId),
    branchedFrom: options.branchedFrom || null,
    projectId: options.projectId || null,
    pinned: Boolean(options.pinned),
    archived: false,
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    executionProfile: options.executionProfile && typeof options.executionProfile === 'object' ? normalizeExecutionProfile(options.executionProfile, { reasoningSupported: true }) : normalizeExecutionProfile({}, { reasoningSupported: true }),
    draft: { text: '', updatedAt: null, editedFrom: null, modelContent: '', attachments: [], attachmentContents: [], executionProfile: null, sourceRunId: null, warnings: [] },
    messages: Array.isArray(options.messages) ? options.messages : [],
  });
  await fs.mkdir(CHATS_DIR, { recursive: true });
  await writeJson(chatFile(chat.id), chat);
  await updateJson(CHAT_INDEX_FILE, EMPTY_INDEX, index => ({
    version: INDEX_VERSION,
    chats: [summary(chat), ...(Array.isArray(index.chats) ? index.chats : []).filter(item => item.id !== chat.id)],
  }));
  await upsertSearchDocument(chat);
  return chat;
}

export async function getChat(chatId) {
  let raw;
  try { raw = await readJson(chatFile(chatId), null); }
  catch (error) { if (error instanceof SyntaxError) throw fail('CHAT_CORRUPT', 'This chat file is damaged; open another chat.', 409, undefined, error); throw error; }
  if (!raw) throw fail('CHAT_NOT_FOUND', 'This chat no longer exists; open another chat.', 404);
  return migrateChat(raw);
}

async function saveChat(input, { touch = true, updateSearch = true } = {}) {
  const chat = migrateChat(input);
  if (touch) chat.updatedAt = now();
  await writeJson(chatFile(chat.id), chat);
  await updateJson(CHAT_INDEX_FILE, EMPTY_INDEX, index => ({
    version: INDEX_VERSION,
    chats: (Array.isArray(index.chats) ? index.chats : []).some(item => item.id === chat.id)
      ? index.chats.map(item => item.id === chat.id ? summary(chat) : item)
      : [summary(chat), ...(Array.isArray(index.chats) ? index.chats : [])],
  }));
  if (updateSearch) await upsertSearchDocument(chat);
  return chat;
}

export async function renameChat(chatId, title) {
  return withChatMutation(chatId, async () => {
    const chat = await getChat(chatId);
    const clean = normaliseText(title).replace(/\s+/gu, ' ').trim();
    if (!clean) return chat;
    chat.title = graphemes(clean).slice(0, 120).join('');
    chat.titleLocked = true;
    await saveChat(chat);
    return chat;
  });
}

export async function setChatPinned(chatId, pinned = true) {
  return withChatMutation(chatId, async () => {
    const chat = await getChat(chatId);
    chat.pinned = Boolean(pinned);
    await saveChat(chat, { touch: false });
    return summary(chat);
  });
}

export async function archiveChat(chatId) {
  return withChatMutation(chatId, async () => {
    const chat = await getChat(chatId);
    if (chat.archived) return summary(chat);
    chat.archived = true;
    chat.archivedAt = now();
    await saveChat(chat, { touch: false });
    return summary(chat);
  });
}

export async function restoreChat(chatId) {
  return withChatMutation(chatId, async () => {
    const chat = await getChat(chatId);
    if (!chat.archived) return summary(chat);
    chat.archived = false;
    chat.archivedAt = null;
    await saveChat(chat, { touch: false });
    return summary(chat);
  });
}

export async function deleteChat(chatId) {
  return withChatMutation(chatId, async () => {
    await getChat(chatId);
    try { await fs.unlink(chatFile(chatId)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await updateJson(CHAT_INDEX_FILE, EMPTY_INDEX, index => ({ version: INDEX_VERSION, chats: (index.chats || []).filter(item => item.id !== chatId) }));
    await removeSearchDocument(chatId);
    return { deleted: chatId };
  });
}

export async function saveDraft(chatId, input = {}) {
  return withChatMutation(chatId, async () => {
    const chat = await getChat(chatId);
    const previous = chat.draft || {};
    const nextEditedFrom = input.editedFrom === undefined ? previous.editedFrom || null : input.editedFrom || null;
    chat.draft = {
      text: String(input.text ?? previous.text ?? ''),
      updatedAt: now(),
      editedFrom: nextEditedFrom,
      modelContent: String(input.text ?? previous.text ?? ''),
      attachments: Array.isArray(input.attachments) ? structuredClone(input.attachments) : structuredClone(previous.attachments || []),
      attachmentContents: [],
      executionProfile: input.executionProfile === undefined ? (previous.executionProfile ? normalizeExecutionProfile(previous.executionProfile, { reasoningSupported: true }) : null) : (input.executionProfile ? normalizeExecutionProfile(input.executionProfile, { reasoningSupported: true }) : null),
      sourceRunId: input.sourceRunId === undefined ? previous.sourceRunId || null : input.sourceRunId || null,
      warnings: Array.isArray(input.warnings) ? input.warnings.map(String) : [...(previous.warnings || [])],
    };
    await saveChat(chat, { touch: false, updateSearch: false });
    return structuredClone(chat.draft);
  });
}

export async function saveChatExecutionProfile(chatId, input = {}) {
  return withChatMutation(chatId, async () => {
    const chat = await getChat(chatId);
    chat.executionProfile = normalizeExecutionProfile(input, { reasoningSupported: true });
    await saveChat(chat, { touch: false, updateSearch: false });
    return structuredClone(chat.executionProfile);
  });
}

export async function clearNextRunExecutionProfile(chatId) {
  return withChatMutation(chatId, async () => {
    const chat = await getChat(chatId);
    chat.draft = { ...(chat.draft || {}), executionProfile: null, updatedAt: now() };
    await saveChat(chat, { touch: false, updateSearch: false });
    return { executionProfile: null, chatExecutionProfile: structuredClone(chat.executionProfile) };
  });
}

export async function clearDraft(chatId) {
  return saveDraft(chatId, { text: '', editedFrom: null, modelContent: '', attachments: [], attachmentContents: [], executionProfile: null, sourceRunId: null, warnings: [] });
}

export async function addUserMessage(chatId, { text, modelContent = null, attachments = [], documentContext = null, executionProfile = null, runId = null, requestFingerprint = null, webPlan = null, executionSettings = null }) {
  return withChatMutation(chatId, async () => {
    const chat = await getChat(chatId);
    const firstUser = !chat.messages.some(message => message.role === 'user');
    if (firstUser && !chat.titleLocked && chat.title === 'New chat') chat.title = titleFromFirstMessage(text);
    const timestamp = now();
    const message = {
      id: id('msg'), role: 'user', content: text, modelContent: modelContent ?? text, attachments: Array.isArray(attachments) ? structuredClone(attachments) : [], status: 'completed', pinned: false,
      documentContext: documentContext && typeof documentContext === 'object' ? structuredClone(documentContext) : null,
      executionProfile: executionProfile ? structuredClone(executionProfile) : null, runId: runId || null, requestFingerprint: requestFingerprint || null,
      webPlan: webPlan && typeof webPlan === 'object' ? structuredClone(webPlan) : null,
      executionSettings: executionSettings && typeof executionSettings === 'object' ? structuredClone(executionSettings) : null,
      edited: Boolean(chat.draft?.editedFrom), editedFrom: chat.draft?.editedFrom || null,
      createdAt: timestamp, updatedAt: timestamp,
    };
    chat.messages.push(message);
    chat.draft = { text: '', updatedAt: timestamp, editedFrom: null, modelContent: '', attachments: [], attachmentContents: [], executionProfile: null, sourceRunId: null, warnings: [] };
    await saveChat(chat);
    return message;
  });
}

export async function addAssistantMessage(chatId, producer = null, { computed = null, reasoning = null, documentContext = null, executionProfile = null, runId = null, requestFingerprint = null, workflow = null, web = null, work = null, execution = null } = {}) {
  return withChatMutation(chatId, async () => {
    const chat = await getChat(chatId);
    const timestamp = now();
    const message = {
      id: id('msg'), role: 'assistant', content: '', reasoning: '', reasoningLevel: reasoning?.supported ? reasoning.level : null, status: 'streaming', pinned: false, edited: false,
      executionProfile: executionProfile ? structuredClone(executionProfile) : null, runId: runId || null, requestFingerprint: requestFingerprint || null,
      workflow: workflow && typeof workflow === 'object' ? structuredClone(workflow) : null,
      web: web && typeof web === 'object' ? structuredClone(web) : null,
      work: work && typeof work === 'object' ? structuredClone(work) : null,
      documentContext: documentContext && typeof documentContext === 'object' ? structuredClone(documentContext) : null,
      execution: execution && typeof execution === 'object' ? structuredClone(execution) : null,
      producer: producer || { kind: 'unknown', name: 'Unknown model', id: null },
      computed: computed ? structuredClone(computed) : null,
      metrics: null, createdAt: timestamp, updatedAt: timestamp, error: null,
    };
    chat.messages.push(message);
    await saveChat(chat);
    return message;
  });
}

export async function addModelMarker(chatId, producer) {
  return withChatMutation(chatId, async () => {
    const chat = await getChat(chatId);
    if (!chat.messages.length) return null;
    const name = String(producer?.name || producer?.model || '').trim();
    if (!name) return null;
    const last = chat.messages.at(-1);
    if (last?.role === 'marker' && last.markerType === 'model-change' && last.producer?.name === name) return last;
    const timestamp = now();
    const marker = { id: id('msg'), role: 'marker', markerType: 'model-change', content: `Switched to ${name}`, producer, status: 'completed', createdAt: timestamp, updatedAt: timestamp };
    chat.messages.push(marker);
    await saveChat(chat);
    return marker;
  });
}

export async function updateMessage(chatId, messageId, patch) {
  return withChatMutation(chatId, async () => {
    const chat = await getChat(chatId);
    const index = chat.messages.findIndex(item => item.id === messageId);
    if (index < 0) throw fail('MESSAGE_NOT_FOUND', 'This response could not be updated; reload the chat.', 404);
    chat.messages[index] = migrateMessage({ ...chat.messages[index], ...patch, updatedAt: now() });
    await saveChat(chat, { updateSearch: patch?.status !== 'streaming' });
    return chat.messages[index];
  });
}

export async function mutateMessage(chatId, messageId, work) {
  return withChatMutation(chatId, async () => {
    const chat = await getChat(chatId);
    const index = chat.messages.findIndex(item => item.id === messageId);
    if (index < 0) throw fail('MESSAGE_NOT_FOUND', 'This message is no longer in the chat; reload the chat.', 404);
    const message = chat.messages[index];
    const result = await work({ chat, message: structuredClone(message), index });
    const nextMessage = migrateMessage(result?.message || message);
    chat.messages[index] = { ...nextMessage, updatedAt: now() };
    await saveChat(chat);
    return { ...(result || {}), message: structuredClone(chat.messages[index]), chat: structuredClone(chat) };
  });
}

export async function pinMessage(chatId, messageId, pinned = true) {
  return withChatMutation(chatId, async () => {
    const chat = await getChat(chatId);
    const index = chat.messages.findIndex(item => item.id === messageId);
    if (index < 0) throw fail('MESSAGE_NOT_FOUND', 'This message is no longer in the chat; reload the chat.', 404);
    chat.messages[index] = { ...chat.messages[index], pinned: Boolean(pinned), updatedAt: now() };
    await saveChat(chat, { updateSearch: false });
    return chat.messages[index];
  });
}

export async function editLastUserMessage(chatId, messageId) {
  return withChatMutation(chatId, async () => {
    const chat = await getChat(chatId);
    let userIndex = -1;
    for (let index = chat.messages.length - 1; index >= 0; index -= 1) if (chat.messages[index].role === 'user') { userIndex = index; break; }
    if (userIndex < 0 || chat.messages[userIndex].id !== messageId) throw fail('EDIT_NOT_LAST_USER', 'Only the latest message you sent can be edited here; use “Edit from here” to branch from an older message.', 409);
    const original = structuredClone(chat.messages[userIndex]);
    const following = chat.messages[userIndex + 1]?.role === 'assistant' ? structuredClone(chat.messages[userIndex + 1]) : null;
    const remove = [userIndex, ...(following ? [userIndex + 1] : [])];
    const warnings = [];
    const restoredAttachments = Array.isArray(original.attachments) ? structuredClone(original.attachments) : [];
    const attachmentContents = [];
    if (restoredAttachments.length) warnings.push('Attachment contents are intentionally not retained after a completed run. Reattach these files before resending.');
    const draft = {
      text: String(original.content || ''),
      updatedAt: now(),
      editedFrom: original.id,
      modelContent: String(original.content || ''),
      attachments: restoredAttachments,
      attachmentContents,
      executionProfile: original.executionProfile ? structuredClone(original.executionProfile) : (following?.executionProfile ? structuredClone(following.executionProfile) : null),
      sourceRunId: original.runId || following?.runId || null,
      warnings,
    };
    chat.messages = chat.messages.filter((_, index) => !remove.includes(index));
    chat.draft = draft;
    await saveChat(chat);
    return { draft: structuredClone(draft), text: draft.text, removedIds: remove.map(index => index === userIndex ? original.id : following?.id).filter(Boolean), chat: structuredClone(chat) };
  });
}

export async function branchChat(chatId, messageId) {
  const original = await getChat(chatId);
  const stop = original.messages.findIndex(message => message.id === messageId);
  if (stop < 0) throw fail('MESSAGE_NOT_FOUND', 'This message is no longer in the chat; reload the chat.', 404);
  const copies = original.messages.slice(0, stop + 1).map(message => ({
    ...structuredClone(message),
    id: id('msg'),
    sourceMessageId: message.id,
  }));
  return createChat(`${original.title} (branch)`, {
    titleLocked: true,
    branchedFrom: { chatId: original.id, messageId },
    projectId: original.projectId || null,
    executionProfile: structuredClone(original.executionProfile),
    messages: copies,
  });
}

export async function searchChats(query) {
  const primary = await listChats();
  const archived = await listArchivedChats();
  const summaries = [...primary, ...archived];
  const expectedIds = summaries.map(item => item.id).sort();
  const indexedIds = await searchIndexDocumentIds();
  const indexMatches = indexedIds.length === expectedIds.length && indexedIds.every((item, index) => item === expectedIds[index]);
  if (!indexMatches) {
    const durableChats = [];
    for (const item of summaries) durableChats.push(await getChat(item.id));
    await replaceSearchDocuments(durableChats);
  }
  return searchChatIndex(query, { includeArchived: false, limit: 50 });
}

function slugTitle(title) {
  const source = normaliseText(title).toLocaleLowerCase();
  const cleaned = source.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return graphemes(cleaned || 'chat').slice(0, 64).join('');
}

function modelLabel(message) {
  return message.producer?.name || message.producer?.model || 'Unknown model';
}

export async function exportChat(chatId, format = 'markdown') {
  const chat = await getChat(chatId);
  const date = String(chat.createdAt || now()).slice(0, 10);
  const lines = [];
  if (format === 'markdown') {
    lines.push(`# ${chat.title}`, '', `Date: ${date}`, '');
    for (const message of chat.messages) {
      if (message.role === 'marker') { lines.push('---', '', message.content, ''); continue; }
      if (message.role === 'user') lines.push('## You', '', message.content || '');
      if (message.role === 'assistant') lines.push(`## KL01 · ${modelLabel(message)}`, '', message.content, '');
    }
  } else if (format === 'text') {
    lines.push(chat.title, `Date: ${date}`, '');
    for (const message of chat.messages) {
      if (message.role === 'marker') { lines.push(message.content, ''); continue; }
      if (message.role === 'user') lines.push('You', message.content || '');
      if (message.role === 'assistant') lines.push(`KL01 · ${modelLabel(message)}`, message.content, '');
    }
  } else throw fail('EXPORT_FORMAT', 'Choose Markdown or plain text.', 400);
  return {
    filename: `${slugTitle(chat.title)}-${date}.${format === 'markdown' ? 'md' : 'txt'}`,
    contentType: format === 'markdown' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
    body: `${lines.join('\n').trim()}\n`,
  };
}

export async function recoverInterrupted({ resumableRunIds = new Set() } = {}) {
  const summaries = await listAllChats();
  let recovered = 0;
  for (const item of summaries) {
    await withChatMutation(item.id, async () => {
      const chat = await getChat(item.id);
      let changed = false;
      chat.messages = chat.messages.map(message => {
        if (message.status !== 'streaming') return message;
        changed = true;
        recovered += 1;
        const resumable = Boolean(message.runId && resumableRunIds.has(message.runId));
        if (resumable) {
          const hasResearch = message.work?.kind === 'research';
          const work = hasResearch ? structuredClone(message.work) : (message.work ? structuredClone(message.work) : null);
          if (work?.kind === 'research') {
            work.status = 'interrupted'; work.stage = 'interrupted'; work.completedAt = null;
            work.live = { label:'Interrupted · ready to resume', detail:'Validated research checkpoints are available for this run.' };
          }
          const workflow = message.workflow && typeof message.workflow === 'object' ? structuredClone(message.workflow) : null;
          if (workflow) {
            workflow.status = 'interrupted'; workflow.currentStageId = null; workflow.completedAt = null;
            workflow.stages = (workflow.stages || []).map(stage => ({
              ...stage,
              status: ['running','loading-target','queued-resource','waiting-for-user','ready'].includes(stage.status) ? 'interrupted' : stage.status,
              completedAt: ['running','loading-target','queued-resource','waiting-for-user','ready'].includes(stage.status) ? null : stage.completedAt,
            }));
          }
          return migrateMessage({ ...message, status:'streaming', work, workflow, error:null, updatedAt:now() });
        }
        const workflow = message.workflow && typeof message.workflow === 'object' ? structuredClone(message.workflow) : null;
        if (workflow) {
          workflow.status = 'interrupted';
          workflow.currentStageId = null;
          workflow.completedAt = now();
          workflow.stages = (workflow.stages || []).map(stage => ({
            ...stage,
            status: ['running', 'waiting-for-user'].includes(stage.status) ? 'interrupted' : stage.status === 'pending' ? 'skipped' : stage.status,
            completedAt: ['running', 'waiting-for-user'].includes(stage.status) ? now() : stage.completedAt,
          }));
        }
        return migrateMessage({
          ...message,
          status: 'failed',
          workflow,
          error: { code: 'INTERRUPTED', message: 'This response ended before completion; send the message again or restart the AI if it stopped.' },
          updatedAt: now(),
        });
      });
      if (changed) await saveChat(chat);
    });
  }
  return recovered;
}
