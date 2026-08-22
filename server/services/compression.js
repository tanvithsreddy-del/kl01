import crypto from 'node:crypto';
import { fail } from '../lib/errors.js';
import * as chats from './chats.js';
import { runPipeline } from './pipeline.js';
import { createStructuredService } from './structured.js';

const reviews = new Map();
const now = () => new Date().toISOString();
const id = () => `review-${crypto.randomBytes(8).toString('hex')}`;

function messageContent(message) {
  return message.content || '';
}

function chatHash(chat) {
  const payload = (chat.messages || []).map(message => ({
    id: message.id,
    role: message.role,
    content: messageContent(message),
    status: message.status,
    pinned: Boolean(message.pinned),
    edited: Boolean(message.edited),
    updatedAt: message.updatedAt,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function protectedReasons(message, recentIds) {
  const reasons = [];
  if (/```/.test(messageContent(message))) reasons.push('Code block');
  if (message.pinned) reasons.push('Pinned');
  if (message.edited) reasons.push('Edited message');
  if (recentIds.has(message.id)) reasons.push('Most recent exchange');
  return reasons;
}

function groupExchanges(messages) {
  const ranges = [];
  let current = [];
  for (const message of messages) {
    if (message.role === 'user' && current.length) {
      ranges.push(current);
      current = [message];
    } else current.push(message);
  }
  if (current.length) ranges.push(current);
  return ranges;
}

function sourceForChunk(messages) {
  return messages.map(message => `[${message.role === 'user' ? 'User' : 'KL01'} ${message.id}]\n${messageContent(message)}`).join('\n\n');
}

function exactExcerptFallback(messages) {
  const excerpts = [];
  for (const message of messages) {
    const source = messageContent(message).trim();
    if (!source) continue;
    const first = source.split(/\n\s*\n|(?<=[.!?।])\s+/u)[0] || source;
    const excerpt = first.length > 180 ? first.slice(0, 180).trimEnd() : first;
    if (excerpt) excerpts.push({ role: message.role, text: excerpt, messageId: message.id });
    if (excerpts.length >= 4) break;
  }
  return excerpts;
}

function renderExtractive(excerpts) {
  return excerpts.map(item => `- ${item.role === 'user' ? 'User' : 'KL01'}: “${item.text}”`).join('\n');
}

export function createCompressionService({ inference, snapshots, access, structured = null }) {
  const busyCounts = new Map();
  const enterBusy = chatId => busyCounts.set(String(chatId), (busyCounts.get(String(chatId)) || 0) + 1);
  const leaveBusy = chatId => { const key = String(chatId); const next = (busyCounts.get(key) || 1) - 1; if (next > 0) busyCounts.set(key, next); else busyCounts.delete(key); };
  const withBusy = async (chatId, work) => { enterBusy(chatId); try { return await work(); } finally { leaveBusy(chatId); } };
  const structuredService = structured || createStructuredService({ inference });
  async function tokenCountForMessage(message) {
    const result = await inference.countInputTokens([{ role: message.role, content: messageContent(message) }]);
    return Math.max(1, Number(result.count || 0));
  }

  async function summariseChunk(messages, maxTokens) {
    const source = sourceForChunk(messages);
    const result = await structuredService.structured('compression-extract', { source, __maxTokens: maxTokens }, null, null);
    const valid = [];
    if (result.ok && Array.isArray(result.value?.snippets)) {
      for (const value of result.value.snippets) {
        const text = String(value || '').trim();
        if (!text) continue;
        const owner = messages.find(message => messageContent(message).includes(text));
        if (!owner) continue;
        if (!valid.some(item => item.text === text)) valid.push({ role: owner.role, text, messageId: owner.id });
        if (valid.length >= 4) break;
      }
    }
    if (valid.length) return {
      excerpts: valid,
      method: 'model-selected-verbatim',
      promptId: result.promptId,
      promptVersion: result.promptVersion,
      attempts: result.attempts,
      constrained: Boolean(result.constrained),
    };
    return {
      excerpts: exactExcerptFallback(messages),
      method: 'deterministic-verbatim-fallback',
      promptId: result.promptId || 'compression-extract',
      promptVersion: result.promptVersion || 1,
      attempts: result.attempts || 2,
      failure: result.ok ? 'model snippets were not verbatim source text' : result.reason?.sentence || 'structured generation failed',
    };
  }

  async function summariseRange(chatId, range) {
    const limitResult = await inference.contextLimit();
    const limit = Number(limitResult.limit || 0);
    if (!limit) throw fail('COMPRESSION_NO_MODEL', 'Start a model before creating a compression preview.', 409);
    const sourceBudget = Math.max(8, Math.floor(limit * 0.45));
    const outputBudget = Math.max(8, Math.min(Math.floor(limit * 0.20), 384));
    const turns = range.turns;
    if (turns.some(turn => turn.tokens > sourceBudget)) {
      const oversized = turns.find(turn => turn.tokens > sourceBudget);
      return {
        summary: null,
        summaryTokens: 0,
        tooLarge: true,
        message: 'This turn is too large to shorten in one pass; keep it, or Drop it if KL01 does not need it for the answer.',
        diagnostics: { limit, sourceBudget, outputBudget, oversizedMessageId: oversized.messageId, chunks: [] },
      };
    }
    const chunks = [];
    let current = [];
    let currentTokens = 0;
    for (const turn of turns) {
      if (current.length && currentTokens + turn.tokens > sourceBudget) {
        chunks.push(current); current = []; currentTokens = 0;
      }
      current.push(turn); currentTokens += turn.tokens;
    }
    if (current.length) chunks.push(current);

    const pipelineState = { turnId: `compression:${chatId}:${range.rangeId}`, status: 'ready', stages: {}, order: [] };
    const stages = chunks.map((chunk, index) => ({
      name: `chunk-${index + 1}`,
      timeoutMs: 45_000,
      retries: 0,
      run: async () => {
        const chunkMessages = chunk.map(turn => range.messages.find(message => message.id === turn.messageId));
        return summariseChunk(chunkMessages, outputBudget);
      },
    }));
    const pipeline = await runPipeline(stages, { pipelineState });
    const summaries = [];
    const diagnostics = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const result = pipeline.stageResults[`chunk-${index + 1}`];
      const text = renderExtractive(result.excerpts);
      if (text) summaries.push(text);
      diagnostics.push({
        index: index + 1,
        messageIds: chunk.map(turn => turn.messageId),
        sourceTokens: chunk.reduce((sum, turn) => sum + turn.tokens, 0),
        method: result.method,
        excerpts: result.excerpts.length,
        promptId: result.promptId,
        promptVersion: result.promptVersion,
        attempts: result.attempts,
        constrained: Boolean(result.constrained),
        ...(result.failure ? { failure: result.failure } : {}),
      });
    }
    const summary = summaries.join('\n');
    const summaryTokens = summary ? Number((await inference.countInputTokens([{ role: 'system', content: summary }])).count || 0) : 0;
    return { summary, summaryTokens, tooLarge: false, message: null, diagnostics: { limit, sourceBudget, outputBudget, chunks: diagnostics } };
  }

  async function buildRanges(chat) {
    const relevant = (chat.messages || []).filter(message => ['user', 'assistant'].includes(message.role) && message.status !== 'failed');
    const grouped = groupExchanges(relevant);
    const recent = new Set(grouped.at(-1)?.map(message => message.id) || []);
    const active = await snapshots.active(chat);
    const activeByMessage = new Map();
    for (const operation of active?.effectiveOperations || active?.operations || []) for (const messageId of operation.messageIds) activeByMessage.set(messageId, operation);
    const ranges = [];
    let totalTokens = 0;
    for (const messages of grouped) {
      const turns = [];
      for (const message of messages) {
        const tokens = await tokenCountForMessage(message);
        totalTokens += tokens;
        const reasons = protectedReasons(message, recent);
        turns.push({ messageId: message.id, role: message.role, tokens, protectedReasons: reasons, preview: String(message.content || '').slice(0, 240) });
      }
      const reasons = [...new Set(turns.flatMap(turn => turn.protectedReasons))];
      const firstActive = activeByMessage.get(messages[0]?.id);
      const inherited = firstActive && messages.every(message => activeByMessage.get(message.id)?.rangeId === firstActive.rangeId)
        ? firstActive
        : null;
      ranges.push({
        rangeId: `range-${messages.map(message => message.id).join('-')}`,
        messageIds: messages.map(message => message.id),
        messages,
        turns,
        tokens: turns.reduce((sum, turn) => sum + turn.tokens, 0),
        protected: reasons.length > 0,
        protectedReasons: reasons,
        activeOperation: inherited?.operation || 'keep',
        inheritedSummary: inherited?.summary || null,
        inheritedDiagnostics: inherited?.summaryDiagnostics || null,
      });
    }
    for (const range of ranges) for (const turn of range.turns) turn.share = totalTokens ? turn.tokens / totalTokens : 0;
    return { ranges, totalTokens };
  }

  async function createReview(chatId) {
    const chat = await chats.getChat(chatId);
    const { ranges, totalTokens } = await buildRanges(chat);
    const assembled = await access.assembleModelRequest(chatId);
    const [usedResult, limitResult] = await Promise.all([
      inference.countInputTokens(assembled.messages),
      inference.contextLimit(),
    ]);
    const used = Number(usedResult.count || 0);
    const limit = Number(limitResult.limit || 0);
    const targetUsed = Math.floor(limit * 0.65);
    let targetRecovery = Math.max(1, used - targetUsed);
    if (used > limit * 0.85) targetRecovery = Math.max(targetRecovery, Math.floor(used * 0.20));
    const active = await snapshots.active(chat);
    let estimatedRecovered = 0;
    for (const range of ranges) {
      if (range.activeOperation !== 'keep') {
        range.defaultOperation = range.activeOperation;
        range.summary = range.inheritedSummary;
        range.summaryDiagnostics = range.inheritedDiagnostics;
        range.summaryTokens = range.summary ? Number((await inference.countInputTokens([{ role: 'system', content: range.summary }])).count || 0) : 0;
        continue;
      }
      if (range.protected || estimatedRecovered >= targetRecovery) {
        range.defaultOperation = 'keep';
        range.summary = null;
        range.summaryTokens = 0;
        continue;
      }
      range.defaultOperation = 'summarise';
      const result = await summariseRange(chatId, range);
      if (result.tooLarge || !result.summary) {
        range.defaultOperation = 'keep';
        range.summary = null;
        range.summaryTokens = 0;
        range.tooLarge = Boolean(result.tooLarge);
        range.summaryMessage = result.message;
        range.summaryDiagnostics = result.diagnostics;
      } else {
        range.summary = result.summary;
        range.summaryTokens = result.summaryTokens;
        range.summaryDiagnostics = result.diagnostics;
        estimatedRecovered += Math.max(0, range.tokens - range.summaryTokens);
      }
    }
    const averageTurnTokens = Math.max(1, totalTokens / Math.max(1, relevantTurnCount(ranges)));
    for (const range of ranges) {
      range.recovery = {
        keep: 0,
        summarise: Math.max(0, range.tokens - Number(range.summaryTokens || Math.ceil(range.tokens * 0.25))),
        drop: range.tokens,
      };
      delete range.messages;
      delete range.inheritedSummary;
      delete range.inheritedDiagnostics;
    }
    const reviewId = id();
    const record = {
      reviewId,
      chatId,
      chatHash: chatHash(chat),
      createdAt: now(),
      used,
      limit,
      ratio: limit ? used / limit : 0,
      totalTokens,
      averageTurnTokens,
      activeSnapshotId: active?.id || null,
      ranges,
    };
    reviews.set(reviewId, structuredClone(record));
    return structuredClone(record);
  }

  function relevantTurnCount(ranges) {
    return ranges.reduce((sum, range) => sum + range.turns.length, 0);
  }

  async function previewRange(chatId, reviewId, rangeId, { unlockProtected = false } = {}) {
    const review = reviews.get(reviewId);
    if (!review || review.chatId !== chatId) throw fail('COMPRESSION_REVIEW_EXPIRED', 'This compression review has expired; open it again.', 409);
    const chat = await chats.getChat(chatId);
    if (review.chatHash !== chatHash(chat)) throw fail('COMPRESSION_REVIEW_STALE', 'The chat changed while this review was open; open a fresh review.', 409);
    const range = review.ranges.find(item => item.rangeId === rangeId);
    if (!range) throw fail('COMPRESSION_RANGE', 'This range is no longer available; open a fresh compression review.', 404);
    if (range.protected && !unlockProtected) throw fail('COMPRESSION_PROTECTED', 'This range is protected; unlock it before changing what KL01 can use.', 409, { reasons: range.protectedReasons });
    const messages = chat.messages.filter(message => range.messageIds.includes(message.id));
    const withMessages = { ...range, messages };
    const result = await summariseRange(chatId, withMessages);
    range.summary = result.summary;
    range.summaryTokens = result.summaryTokens;
    range.tooLarge = result.tooLarge;
    range.summaryMessage = result.message;
    range.summaryDiagnostics = result.diagnostics;
    range.previewUnlockedProtected = Boolean(unlockProtected);
    range.recovery.summarise = Math.max(0, range.tokens - Number(range.summaryTokens || Math.ceil(range.tokens * 0.25)));
    reviews.set(reviewId, review);
    return structuredClone(range);
  }

  async function apply(chatId, { reviewId, operations = [], mode = 'manual' } = {}) {
    const review = reviews.get(reviewId);
    if (!review || review.chatId !== chatId) throw fail('COMPRESSION_REVIEW_EXPIRED', 'This compression review has expired; open it again.', 409);
    const chat = await chats.getChat(chatId);
    if (review.chatHash !== chatHash(chat)) throw fail('COMPRESSION_REVIEW_STALE', 'The chat changed while this review was open; open a fresh review.', 409);
    const byRange = new Map(review.ranges.map(range => [range.rangeId, range]));
    const finalOperations = [];
    for (const requested of operations) {
      const range = byRange.get(requested.rangeId);
      if (!range) throw fail('COMPRESSION_RANGE', 'A selected range is no longer available; open a fresh compression review.', 409);
      const operation = ['keep', 'summarise', 'drop'].includes(requested.operation) ? requested.operation : 'keep';
      const unlockedProtected = Boolean(requested.unlockedProtected);
      if (range.protected && operation !== 'keep' && !unlockedProtected) throw fail('COMPRESSION_PROTECTED', 'A protected range stayed locked, so KL01 did not change it.', 409, { rangeId: range.rangeId, reasons: range.protectedReasons });
      if (operation === 'summarise') {
        if (range.protected && !range.previewUnlockedProtected) throw fail('COMPRESSION_PREVIEW_REQUIRED', 'This protected range has no preview; preview it before applying its summary.', 409);
        if (range.tooLarge) throw fail('COMPRESSION_TURN_TOO_LARGE', range.summaryMessage || 'This turn is too large to summarise in one pass. Drop it instead.', 409, { rangeId: range.rangeId });
        if (!range.summary) throw fail('COMPRESSION_PREVIEW_REQUIRED', 'This range has no preview; preview it before applying its summary.', 409, { rangeId: range.rangeId });
      }
      finalOperations.push({
        rangeId: range.rangeId,
        messageIds: range.messageIds,
        operation,
        summary: operation === 'summarise' ? range.summary : null,
        unlockedProtected,
        protectedReasons: range.protectedReasons,
        summaryDiagnostics: operation === 'summarise' ? range.summaryDiagnostics : null,
      });
    }
    if (!finalOperations.some(item => item.operation !== 'keep')) throw fail('COMPRESSION_NO_CHANGE', 'Choose at least one older range to summarise or drop before applying compression.', 409);
    const snapshot = await snapshots.create(chat, { operations: finalOperations, mode, reviewId });
    reviews.delete(reviewId);
    return { snapshot, view: await snapshots.transcriptView(chat), lineage: await snapshots.lineage(chat) };
  }

  async function autoCompress(chatId) {
    const review = await createReview(chatId);
    const operations = review.ranges.map(range => ({ rangeId: range.rangeId, operation: range.defaultOperation, unlockedProtected: false }));
    const changed = operations.some(item => item.operation !== 'keep');
    if (!changed) throw fail('COMPRESSION_NO_SAFE_RANGE', 'There is no older unprotected range KL01 can shorten automatically; review the chat or start a new one.', 409);
    return apply(chatId, { reviewId: review.reviewId, operations, mode: 'automatic' });
  }

  async function undo(chatId) {
    const chat = await chats.getChat(chatId);
    return { ...(await snapshots.undo(chat)), view: await snapshots.transcriptView(chat), lineage: await snapshots.lineage(chat) };
  }

  async function state(chatId) {
    const chat = await chats.getChat(chatId);
    return snapshots.inspect(chat);
  }

  function hasActiveReview(chatId) { return [...reviews.values()].some(review => review.chatId === String(chatId)); }
  function reviewIncludesMessage(chatId, messageId) { return [...reviews.values()].some(review => review.chatId === String(chatId) && (review.ranges || []).some(range => (range.messageIds || []).includes(String(messageId)))); }
  function cancelReview(chatId, reviewId) { const review = reviews.get(reviewId); if (!review || review.chatId !== String(chatId)) return { cancelled: false }; reviews.delete(reviewId); return { cancelled: true }; }
  function isBusy(chatId) { return (busyCounts.get(String(chatId)) || 0) > 0; }

  return { createReview: chatId => withBusy(chatId, () => createReview(chatId)), previewRange: (chatId, ...args) => withBusy(chatId, () => previewRange(chatId, ...args)), apply: (chatId, ...args) => withBusy(chatId, () => apply(chatId, ...args)), autoCompress: chatId => withBusy(chatId, () => autoCompress(chatId)), undo, state, isBusy, hasActiveReview, reviewIncludesMessage, cancelReview };
}
