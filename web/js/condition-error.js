export const CONDITION_CLEARERS = Object.freeze({
  'models-load': 'models-load-success',
  'runtime-model-ready': 'runtime-ready',
  'model-sideload': 'model-sideload-success',
  'model-remove': 'model-remove-success',
  'setup-complete': 'setup-complete-success',
  'settings-load': 'settings-load-success',
  'setting-save': 'setting-save-success',
  'service-remove': 'service-remove-success',
  'service-form': 'service-form-valid',
  'service-save': 'service-save-success',
  'context-preview': 'context-preview-success',
  'pin-write': 'pin-write-success',
  'compression-review': 'compression-review-success',
  'compression-summary-size': 'compression-summary-valid',
  'compression-summary-preview': 'compression-summary-preview-success',
  'compression-apply': 'compression-apply-success',
  'compression-undo': 'compression-undo-success',
  'visibility-load': 'visibility-load-success',
  'chat-bootstrap': 'chat-list-load-success',
  'chat-create': 'chat-create-success',
  'chat-load': 'chat-load-success',
  'compression-auto': 'compression-auto-success',
  'message-send': 'message-send-success',
  'run-stop': 'run-stop-success',
  'model-switch': 'model-switch-success',
  'draft-save': 'draft-save-success',
  'section-repair': 'section-repair-success',
  'compression-cancel': 'compression-cancel-success',
});

export function conditionError(condition, message, detail = {}) {
  const id = String(condition || 'unknown');
  return { condition: id, clearWhen: CONDITION_CLEARERS[id] || null, message: String(message || ''), ...detail };
}

export function clearCondition(error, condition) {
  return error?.condition === condition ? null : error;
}

export function clearConditions(error, conditions = []) {
  return conditions.includes(error?.condition) ? null : error;
}
