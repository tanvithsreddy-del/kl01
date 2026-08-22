import crypto from 'node:crypto';
import { fail } from '../lib/errors.js';
import * as chats from './chats.js';
import { repairNode, parseRepairStructure } from '../../web/js/repair-structure.js';
import { protectRewriteText, restoreProtectedText, validateProtectedRewrite } from './rewrite-protection.js';

const OPERATIONS = Object.freeze({
  shorter: { label: 'Shorter', instruction: 'Say the same thing in fewer words.' },
  clearer: { label: 'Clearer', instruction: 'Keep the same content and make the construction simpler.' },
  'more-detail': { label: 'More detail', instruction: 'Expand only this selected part with useful detail that follows from the supplied text.' },
  'change-tone': { label: 'Change the tone', instruction: null },
  fix: { label: 'Fix this', instruction: null },
  remove: { label: 'Remove', instruction: 'Remove exactly the selected range.' },
});
const TERMINAL = new Set(['complete', 'completed', 'cancelled', 'failed']);
const now = () => new Date().toISOString();
const makeId = prefix => `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
const hashText = value => crypto.createHash('sha256').update(String(value ?? '').normalize('NFC')).digest('hex');
const clean = value => String(value ?? '').normalize('NFC').trim();

function operation(value) {
  const key = String(value || '');
  if (!OPERATIONS[key]) throw fail('REPAIR_OPERATION', 'Choose one of the six section repair operations.', 400);
  return key;
}

function validateAnchor(chat, message, anchor) {
  if (!anchor || String(anchor.chatId || '') !== String(chat.id) || String(anchor.messageId) !== String(message.id)) {
    throw fail('REPAIR_ANCHOR', 'This selection is no longer available; select the section again.', 409);
  }
  const node = repairNode(message.content || '', anchor.path);
  const messageChanged = anchor.messageHash && hashText(message.content || '') !== String(anchor.messageHash);
  if (!node || messageChanged || hashText(node.text) !== String(anchor.contentHash || '')) {
    throw fail('REPAIR_ANCHOR_STALE', 'This message changed after the section was selected; select it again.', 409);
  }
  return node;
}

function structureValid(kind, replacement) {
  if (replacement === '') return true;
  const nodes = parseRepairStructure(replacement);
  const top = nodes.filter(node => !node.parentPath);
  if (kind === 'sentence') return !/[\r\n]/u.test(replacement) && top.length === 1 && top[0].kind === 'paragraph';
  if (kind === 'paragraph') return top.length === 1 && top[0].kind === 'paragraph';
  if (kind === 'heading') return top.length === 1 && top[0].kind === 'heading';
  if (kind === 'list-item') return top.length === 1 && top[0].kind === 'list' && nodes.filter(node => node.parentPath === top[0].path).length === 1;
  if (kind === 'list') return top.length === 1 && top[0].kind === 'list';
  if (kind === 'table-row') return top.length === 1 && top[0].kind === 'table' && nodes.filter(node => node.parentPath === top[0].path).length === 1;
  if (kind === 'table') return top.length === 1 && top[0].kind === 'table';
  if (kind === 'code-block') return top.length === 1 && top[0].kind === 'code-block';
  return false;
}

function contextFor(content, node) {
  const source = String(content || '');
  const width = 320;
  return { before: source.slice(Math.max(0, node.start - width), node.start), after: source.slice(node.end, Math.min(source.length, node.end + width)) };
}

export function createRepairService({ structured, snapshots, compression } = {}) {
  const pendingPreviews = new Set();
  const keyFor = (chatId, messageId) => `${chatId}:${messageId}`;

  function assertEligible(chat, message, { allowPending = false } = {}) {
    if (message.role !== 'assistant') throw fail('REPAIR_USER_MESSAGE', 'Section repair is only available on KL01 replies; edit your message instead.', 409);
    if (!TERMINAL.has(message.status)) throw fail('REPAIR_STREAMING', 'This reply is still changing; wait until it finishes before repairing a section.', 409);
    if (compression?.isBusy?.(chat.id)) throw fail('REPAIR_COMPRESSION_ACTIVE', 'Compression is running in this chat; wait until it finishes before repairing a section.', 409);
    if (compression?.reviewIncludesMessage?.(chat.id, message.id)) throw fail('REPAIR_COMPRESSION_PROPOSAL', 'This message is in an open compression review; finish or close that review before repairing it.', 409);
    if (!allowPending && message.repairPreview) throw fail('REPAIR_PENDING', 'Review or discard the current repair before starting another.', 409);
  }

  async function anchor(chatId, messageId, path) {
    const chat = await chats.getChat(chatId);
    const message = (chat.messages || []).find(item => item.id === messageId);
    if (!message) throw fail('MESSAGE_NOT_FOUND', 'This message is no longer in the chat; reload the chat.', 404);
    assertEligible(chat, message);
    const node = repairNode(message.content || '', path);
    if (!node) throw fail('REPAIR_SELECTION', 'Select one complete sentence, paragraph, list item, list, table row, table, code block, or heading.', 400);
    return { chatId: chat.id, messageId: message.id, path: node.path, kind: node.kind, contentHash: hashText(node.text), messageHash: hashText(message.content || ''), length: [...node.text].length };
  }

  async function makeReplacement(message, node, op, instruction, signal) {
    const protection = protectRewriteText(node.text, { computed: message.computed || null, protectProperNouns: false });
    if (op === 'remove') {
      if (protection.immutable.length) throw fail('REPAIR_PROTECTED_REMOVE', 'This section contains protected content and cannot be removed; select a range without protected content.', 409);
      return '';
    }
    if (!structured?.structured) throw fail('REPAIR_UNAVAILABLE', 'Section repair is unavailable in this build; keep the original text.', 500);
    const requestedInstruction = clean(instruction);
    const effectiveInstruction = OPERATIONS[op].instruction || requestedInstruction;
    if ((op === 'fix' || op === 'change-tone') && !effectiveInstruction) {
      throw fail('REPAIR_INSTRUCTION', op === 'change-tone'
        ? 'Describe the tone you want, such as more formal, warmer, or more direct.'
        : 'Describe what is wrong with this section, then try again.', 400);
    }
    if ([...effectiveInstruction].length > 800) throw fail('REPAIR_INSTRUCTION_LONG', 'Keep the repair instruction under 800 characters.', 400);
    const context = contextFor(message.content, node);
    const immutableSpans = protection.immutable.length ? protection.immutable.map(item => `${item.token} = ${item.kind}`).join('\n') : 'None';
    const result = await structured.structured('section-repair', {
      operation: OPERATIONS[op].label,
      instruction: effectiveInstruction,
      beforeContext: context.before,
      maskedText: protection.maskedText,
      afterContext: context.after,
      immutableSpans,
      __maxTokens: 4096,
    }, null, signal);
    if (!result.ok) throw fail('REPAIR_GENERATION_FAILED', 'Section repair did not produce a valid replacement; keep the original text and retry.', 502, { reason: result.reason?.code || 'UNKNOWN' });
    const restored = restoreProtectedText(String(result.value?.replacement ?? ''), protection.immutable);
    if (!restored.ok) throw fail('REPAIR_PROTECTION_FAILED', 'Section repair changed protected content; the original section was kept.', 409, { reason: restored.reason });
    const replacement = restored.value;
    if (!replacement.trim()) throw fail('REPAIR_EMPTY', 'This operation produced no replacement; keep the original or use Remove.', 409);
    const checked = validateProtectedRewrite(node.text, replacement, protection);
    if (!checked.ok) throw fail('REPAIR_PROTECTION_FAILED', 'Section repair changed protected content; the original section was kept.', 409, { failures: checked.failures });
    if (!structureValid(node.kind, replacement)) throw fail('REPAIR_STRUCTURE', 'The proposed replacement does not preserve this section type; keep the original and retry.', 409);
    if (replacement === node.text) throw fail('REPAIR_NO_CHANGE', 'This repair produced no change; choose another operation or describe what should change.', 409);
    return replacement;
  }

  async function preview(chatId, messageId, input = {}) {
    const op = operation(input.operation);
    const pendingKey = keyFor(chatId, messageId);
    if (pendingPreviews.has(pendingKey)) throw fail('REPAIR_PENDING', 'A repair is already being prepared for this message; wait for it to finish.', 409);
    const chat = await chats.getChat(chatId);
    const message = (chat.messages || []).find(item => item.id === messageId);
    if (!message) throw fail('MESSAGE_NOT_FOUND', 'This message is no longer in the chat; reload the chat.', 404);
    assertEligible(chat, message);
    const node = validateAnchor(chat, message, input.anchor);
    pendingPreviews.add(pendingKey);
    try {
      const replacement = await makeReplacement(message, node, op, input.instruction, input.signal || null);
      const previewRecord = {
        id: makeId('repair-preview'), status: 'ready', operation: op, operationLabel: OPERATIONS[op].label,
        instruction: (op === 'fix' || op === 'change-tone') ? clean(input.instruction) : null,
        anchor: structuredClone(input.anchor), original: node.text, replacement, createdAt: now(),
      };
      const result = await chats.mutateMessage(chatId, messageId, async ({ chat: liveChat, message: liveMessage }) => {
        assertEligible(liveChat, liveMessage);
        validateAnchor(liveChat, liveMessage, input.anchor);
        return { message: { ...liveMessage, repairPreview: previewRecord } };
      });
      return { preview: structuredClone(previewRecord), message: result.message };
    } finally {
      pendingPreviews.delete(pendingKey);
    }
  }

  async function discard(chatId, messageId) {
    const result = await chats.mutateMessage(chatId, messageId, async ({ message }) => {
      if (!message.repairPreview) throw fail('REPAIR_PREVIEW_NOT_FOUND', 'There is no repair preview to discard.', 404);
      return { message: { ...message, repairPreview: null } };
    });
    return { discarded: true, message: result.message };
  }

  async function apply(chatId, messageId) {
    const result = await chats.mutateMessage(chatId, messageId, async ({ chat, message }) => {
      assertEligible(chat, message, { allowPending: true });
      const previewRecord = message.repairPreview;
      if (!previewRecord || previewRecord.status !== 'ready') throw fail('REPAIR_PREVIEW_NOT_FOUND', 'There is no repair preview to apply.', 404);
      const node = validateAnchor(chat, message, previewRecord.anchor);
      if (previewRecord.original !== node.text) throw fail('REPAIR_ANCHOR_STALE', 'This section changed after the preview was made; discard it and select the section again.', 409);
      const baseRevision = message.revisionId
        ? await snapshots.messageRevision(chat, message.revisionId)
        : await snapshots.createMessageRevision(chat, { messageId: message.id, content: message.content, operation: 'original', selection: null, parentId: null, metadata: null });
      if (!baseRevision) throw fail('REVISION_NOT_FOUND', 'The current message revision is missing; reload the chat before repairing it.', 409);
      const replacement = String(previewRecord.replacement ?? '');
      const nextContent = `${message.content.slice(0, node.start)}${replacement}${message.content.slice(node.end)}`;
      const child = await snapshots.createMessageRevision(chat, {
        messageId: message.id,
        content: nextContent,
        operation: previewRecord.operationLabel,
        selection: { path: previewRecord.anchor.path, kind: previewRecord.anchor.kind, contentHash: previewRecord.anchor.contentHash, original: previewRecord.original },
        parentId: baseRevision.id,
        metadata: null,
      });
      return { message: { ...message, content: nextContent, revisionId: child.id, repairPreview: null }, revision: child };
    });
    return { message: result.message, revision: result.revision };
  }

  async function undo(chatId, messageId) {
    const result = await chats.mutateMessage(chatId, messageId, async ({ chat, message }) => {
      if (message.repairPreview) throw fail('REPAIR_PENDING', 'Discard the current repair preview before undoing a revision.', 409);
      if (!message.revisionId) throw fail('REPAIR_UNDO_EMPTY', 'This message has no repair revision to undo; keep the current text.', 409);
      const current = await snapshots.messageRevision(chat, message.revisionId);
      if (!current?.parentId) throw fail('REPAIR_UNDO_EMPTY', 'This message is already at its original revision; keep the current text.', 409);
      const parent = await snapshots.messageRevision(chat, current.parentId);
      if (!parent) throw fail('REVISION_NOT_FOUND', 'The previous revision is missing; reload the chat.', 409);
      return { message: { ...message, content: parent.content, revisionId: parent.id, repairPreview: null }, revision: parent };
    });
    return { message: result.message, revision: result.revision };
  }

  async function restore(chatId, messageId, revisionId) {
    const result = await chats.mutateMessage(chatId, messageId, async ({ chat, message }) => {
      if (message.repairPreview) throw fail('REPAIR_PENDING', 'Discard the current repair preview before changing revisions.', 409);
      const target = await snapshots.messageRevision(chat, revisionId);
      if (!target || target.messageId !== message.id) throw fail('REVISION_NOT_FOUND', 'This revision is no longer available; reload the chat.', 404);
      return { message: { ...message, content: target.content, revisionId: target.id, repairPreview: null }, revision: target };
    });
    return { message: result.message, revision: result.revision };
  }

  async function history(chatId, messageId) {
    const chat = await chats.getChat(chatId);
    const message = (chat.messages || []).find(item => item.id === messageId);
    if (!message) throw fail('MESSAGE_NOT_FOUND', 'This message is no longer in the chat; reload the chat.', 404);
    const revisions = await snapshots.messageHistory(chat, messageId);
    return { activeRevisionId: message.revisionId || null, revisions: revisions.map(item => ({ id: item.id, parentId: item.parentId, createdAt: item.createdAt, operation: item.operation, selection: item.selection })) };
  }

  return { anchor, preview, discard, apply, undo, restore, history, operations: OPERATIONS };
}
