import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { SNAPSHOTS_DIR, safeId } from '../lib/paths.js';
import { readJson, writeJson } from './store.js';
import { fail } from '../lib/errors.js';

const now = () => new Date().toISOString();
const snapshotId = () => `snap-${crypto.randomBytes(8).toString('hex')}`;
const revisionId = () => `rev-${crypto.randomBytes(8).toString('hex')}`;

function chatDir(chatId) { return path.join(SNAPSHOTS_DIR, safeId(chatId)); }
function stateFile(chatId) { return path.join(chatDir(chatId), 'state.json'); }
function snapshotFile(chatId, id) { return path.join(chatDir(chatId), `${safeId(id)}.json`); }
function revisionFile(chatId, id) { return path.join(chatDir(chatId), `${safeId(id)}.json`); }

function normaliseOperation(operation) {
  const op = ['keep', 'summarise', 'drop'].includes(operation?.operation) ? operation.operation : 'keep';
  return {
    rangeId: String(operation?.rangeId || ''),
    messageIds: Array.isArray(operation?.messageIds) ? operation.messageIds.map(String) : [],
    operation: op,
    summary: op === 'summarise' ? String(operation?.summary || '') : null,
    unlockedProtected: Boolean(operation?.unlockedProtected),
    protectedReasons: Array.isArray(operation?.protectedReasons) ? operation.protectedReasons.map(String) : [],
    summaryDiagnostics: operation?.summaryDiagnostics || null,
  };
}

function combineEffective(parentOperations = [], deltaOperations = []) {
  const delta = deltaOperations.map(normaliseOperation);
  const overridden = new Set(delta.flatMap(operation => operation.messageIds));
  const preserved = parentOperations.map(normaliseOperation).map(operation => ({
    ...operation,
    messageIds: operation.messageIds.filter(messageId => !overridden.has(messageId)),
  })).filter(operation => operation.messageIds.length);
  return [...preserved, ...delta.filter(operation => operation.messageIds.length)];
}

export function createSnapshotService() {
  async function activeId(chat) {
    const state = await readJson(stateFile(chat.id), { version: 1, activeSnapshotId: null });
    return state.activeSnapshotId || null;
  }

  async function get(chat, id) {
    if (!id) return null;
    return readJson(snapshotFile(chat.id, id), null);
  }

  async function active(chat) {
    const id = await activeId(chat);
    return id ? get(chat, id) : null;
  }

  async function setActive(chat, id) {
    await fs.mkdir(chatDir(chat.id), { recursive: true });
    await writeJson(stateFile(chat.id), { version: 1, activeSnapshotId: id || null });
    return id || null;
  }

  async function create(chat, { operations, mode = 'manual', reviewId = null }) {
    const parent = await active(chat);
    const id = snapshotId();
    const delta = (operations || []).map(normaliseOperation);
    const snapshot = {
      version: 1,
      id,
      chatId: chat.id,
      parentId: parent?.id || null,
      createdAt: now(),
      mode,
      reviewId,
      operations: delta,
      effectiveOperations: combineEffective(parent?.effectiveOperations || parent?.operations || [], delta),
    };
    await fs.mkdir(chatDir(chat.id), { recursive: true });
    await writeJson(snapshotFile(chat.id, id), snapshot);
    await setActive(chat, id);
    return structuredClone(snapshot);
  }

  async function undo(chat) {
    const current = await active(chat);
    if (!current) return { activeSnapshotId: null, undone: false };
    await setActive(chat, current.parentId || null);
    return { activeSnapshotId: current.parentId || null, undone: true, restoredFrom: current.id };
  }

  async function lineage(chat) {
    const out = [];
    let current = await active(chat);
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      out.push(structuredClone(current));
      current = current.parentId ? await get(chat, current.parentId) : null;
    }
    return out;
  }

  async function modelMessages(chat, { excludeMessageIds = [] } = {}) {
    const snapshot = await active(chat);
    const excluded = new Set((excludeMessageIds || []).map(String));
    const messages = (chat.messages || []).filter(message => ['user', 'assistant'].includes(message.role)
      && message.status !== 'failed'
      && message.status !== 'waiting-for-user'
      && !excluded.has(String(message.id)));
    if (!snapshot) return { messages: messages.map(message => ({ role: message.role, content: message.content })), snapshot: null };
    const operations = snapshot.effectiveOperations || snapshot.operations || [];
    const byMessage = new Map();
    for (const operation of operations) for (const messageId of operation.messageIds) byMessage.set(messageId, operation);
    const emittedSummaries = new Set();
    const out = [];
    for (const message of messages) {
      const operation = byMessage.get(message.id);
      if (!operation || operation.operation === 'keep') {
        out.push({ role: message.role, content: message.content });
        continue;
      }
      if (operation.operation === 'drop') continue;
      if (operation.operation === 'summarise' && !emittedSummaries.has(operation.rangeId)) {
        emittedSummaries.add(operation.rangeId);
        out.push({ role: 'system', content: `Earlier conversation summary (user-reviewed):\n${operation.summary}` });
      }
    }
    return { messages: out, snapshot: structuredClone(snapshot) };
  }

  async function transcriptView(chat) {
    const snapshot = await active(chat);
    if (!snapshot) return { activeSnapshotId: null, mode: 'full', items: (chat.messages || []).map(message => ({ kind: 'message', messageId: message.id })) };
    const operations = snapshot.effectiveOperations || snapshot.operations || [];
    const byMessage = new Map();
    for (const operation of operations) for (const messageId of operation.messageIds) byMessage.set(messageId, operation);
    const emitted = new Set();
    const items = [];
    for (const message of chat.messages || []) {
      if (message.role === 'marker') { items.push({ kind: 'message', messageId: message.id }); continue; }
      const operation = byMessage.get(message.id);
      if (!operation || operation.operation === 'keep') items.push({ kind: 'message', messageId: message.id });
      else if (operation.operation === 'summarise' && !emitted.has(operation.rangeId)) {
        emitted.add(operation.rangeId);
        items.push({ kind: 'summary', rangeId: operation.rangeId, messageIds: operation.messageIds, summary: operation.summary, protectedUnlocked: operation.unlockedProtected });
      }
    }
    return { activeSnapshotId: snapshot.id, mode: snapshot.mode, parentId: snapshot.parentId, createdAt: snapshot.createdAt, items };
  }

  async function createMessageRevision(chat, { messageId, content, operation = 'original', selection = null, parentId = null, metadata = null }) {
    const id = revisionId();
    const record = {
      version: 1,
      kind: 'message-revision',
      id,
      chatId: chat.id,
      messageId: String(messageId || ''),
      parentId: parentId || null,
      createdAt: now(),
      operation: String(operation || 'original'),
      selection: selection ? structuredClone(selection) : null,
      content: String(content ?? ''),
      metadata: metadata ? structuredClone(metadata) : null,
    };
    if (!record.messageId) throw fail('REVISION_MESSAGE_REQUIRED', 'The message revision could not be created; reload the chat.', 500);
    await fs.mkdir(chatDir(chat.id), { recursive: true });
    await writeJson(revisionFile(chat.id, id), record);
    return structuredClone(record);
  }

  async function messageRevision(chat, id) {
    if (!id) return null;
    const record = await readJson(revisionFile(chat.id, id), null);
    return record?.kind === 'message-revision' ? record : null;
  }

  async function settleMessageRevision(chat, id, metadata) {
    const current = await messageRevision(chat, id);
    if (!current) throw fail('REVISION_NOT_FOUND', 'This revision is no longer available; reload the chat.', 404);
    const next = { ...current, metadata: metadata ? structuredClone(metadata) : null };
    await writeJson(revisionFile(chat.id, id), next);
    return structuredClone(next);
  }

  async function messageLineage(chat, messageId, activeRevisionId) {
    const out = [];
    let current = await messageRevision(chat, activeRevisionId);
    const seen = new Set();
    while (current && current.messageId === String(messageId) && !seen.has(current.id)) {
      seen.add(current.id);
      out.push(structuredClone(current));
      current = current.parentId ? await messageRevision(chat, current.parentId) : null;
    }
    return out;
  }

  async function messageHistory(chat, messageId) {
    let files = [];
    try { files = await fs.readdir(chatDir(chat.id)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const out = [];
    for (const file of files.filter(name => /^rev-[a-f0-9]+\.json$/u.test(name))) {
      const record = await readJson(path.join(chatDir(chat.id), file), null);
      if (record?.kind === 'message-revision' && record.messageId === String(messageId)) out.push(record);
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(item => structuredClone(item));
  }

  async function cleanupChat(chatId) {
    await fs.rm(chatDir(chatId), { recursive: true, force: true });
    return { cleared: true };
  }

  async function inspect(chat) {
    const snapshot = await active(chat);
    return { activeSnapshotId: snapshot?.id || null, active: snapshot ? structuredClone(snapshot) : null, lineage: await lineage(chat), view: await transcriptView(chat) };
  }

  return { create, undo, active, activeId, modelMessages, transcriptView, lineage, inspect, createMessageRevision, messageRevision, settleMessageRevision, messageLineage, messageHistory, cleanupChat };
}
