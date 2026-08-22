import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveActiveChatId } from '../web/js/screens/chat-selection.js';

test('active chat selection never reuses a deleted chat id', () => {
  const chats = [{ id:'replacement' }];
  assert.equal(resolveActiveChatId({ requestedId:null, currentId:'deleted', chats }), 'replacement');
});

test('deleting the final chat leaves no active id so load creates a fresh chat', () => {
  assert.equal(resolveActiveChatId({ requestedId:null, currentId:'deleted', chats:[] }), null);
});

test('a valid explicit route remains authoritative', () => {
  const chats = [{ id:'first' }, { id:'selected' }];
  assert.equal(resolveActiveChatId({ requestedId:'selected', currentId:'first', chats }), 'selected');
});
