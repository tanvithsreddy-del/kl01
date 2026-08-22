import crypto from 'node:crypto';

function verdictError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const ALLOWED = new Set(['computed', 'contradicted', 'subjective', 'unverified']);

export function createVerdict({ turnId, text, kind, verdict, reason, artifact, source = 'deterministic-engine', createdAt = new Date().toISOString(), snapshotDate = null } = {}) {
  if (!turnId) throw verdictError('VERDICT_TURN_REQUIRED', 'a verdict needs the turn that it belongs to');
  if (!text || typeof text !== 'string') throw verdictError('VERDICT_TEXT_REQUIRED', 'a verdict needs readable claim text');
  if (!kind || typeof kind !== 'string') throw verdictError('VERDICT_KIND_REQUIRED', 'a verdict needs a claim kind');
  if (!verdict || typeof verdict !== 'string') throw verdictError('VERDICT_VALUE_REQUIRED', 'a verdict needs an explicit outcome');
  if (!ALLOWED.has(verdict)) throw verdictError('VERDICT_VALUE_UNKNOWN', `unsupported verdict ${verdict}`);
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw verdictError('VERDICT_ARTIFACT_REQUIRED', 'a verdict cannot exist without the artifact that supports it');
  if (verdict === 'computed' && (!Array.isArray(artifact.steps) || artifact.steps.length === 0 || artifact.steps.some(step => typeof step !== 'string' || !step.trim()))) {
    throw verdictError('COMPUTED_STEPS_REQUIRED', 'a computed verdict requires non-empty working steps');
  }
  if (verdict === 'contradicted' && (artifact.engineConfirmed !== true || !Array.isArray(artifact.steps) || artifact.steps.length === 0)) {
    throw verdictError('CONTRADICTION_ENGINE_REQUIRED', 'a contradicted verdict requires engine-confirmed evidence and working steps');
  }
  const reasonRecord = typeof reason === 'string'
    ? { code: verdict === 'computed' ? 'DETERMINISTIC_COMPUTATION' : 'EXPLICIT_VERDICT', sentence: reason }
    : reason;
  if (!reasonRecord?.code || !reasonRecord?.sentence) throw verdictError('VERDICT_REASON_REQUIRED', 'a verdict needs a reason code and a readable reason sentence');
  if (!source || typeof source !== 'string') throw verdictError('VERDICT_SOURCE_REQUIRED', 'a verdict needs an evidence source');
  const id = `claim-${crypto.randomBytes(8).toString('hex')}`;
  return {
    claim: { id, turnId, text, kind, verdict, reason: structuredClone(reasonRecord), createdAt },
    evidence: { claimId: id, source, artifact: structuredClone(artifact), snapshotDate: snapshotDate || createdAt },
  };
}
