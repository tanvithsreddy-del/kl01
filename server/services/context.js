import { CONTEXT_THRESHOLDS } from '../config.js';

export function createContextService({ inference }) {
  async function measure({ messages, pendingText = '' }) {
    const limitResult = await inference.contextLimit();
    const limit = Number(limitResult.limit || 0);
    if (!limit) return { used: 0, limit: 0, ratio: 0, state: 'unavailable', label: limitResult.unknown ? 'Conversation length unavailable' : 'No model is running', note: limitResult.unknown ? 'This model service did not tell KL01 its context limit.' : null, estimated: Boolean(limitResult.estimated), messagesLeft: null };
    const proposed = pendingText ? [...messages, { role: 'user', content: pendingText }] : messages;
    const tokenResult = await inference.countInputTokens(proposed);
    const used = Number(tokenResult.count || 0);
    const ratio = used / limit;
    const status = ratio >= CONTEXT_THRESHOLDS.full ? 'full' : ratio >= CONTEXT_THRESHOLDS.long ? 'almost-full' : ratio >= CONTEXT_THRESHOLDS.quiet ? 'getting-long' : 'plenty';
    const note = status === 'full'
      ? 'This conversation is full.'
      : status === 'almost-full'
        ? 'This conversation is almost full.'
        : status === 'getting-long'
          ? 'This conversation is getting long.'
          : null;
    const turnCount = Math.max(1, Math.ceil(proposed.filter(message => ['user', 'assistant'].includes(message.role)).length / 2));
    const averageTurn = Math.max(1, used / turnCount);
    const messagesLeft = Math.max(0, Math.floor((limit - used) / averageTurn));
    return { used, limit, ratio, state: status, label: 'Conversation length', note, estimated: Boolean(limitResult.estimated || tokenResult.estimated), messagesLeft, averageTurnTokens: averageTurn };
  }
  return { measure };
}
