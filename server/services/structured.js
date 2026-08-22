import { compose } from './prompts.js';
import { guardStructuredValue } from './structured-grounding.js';

function typedReason(code, sentence, details = {}) { return { code, sentence, ...details }; }
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

export function validateSchema(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return { ok: false, reason: typedReason('SCHEMA_MISSING', 'A structured stage must provide a JSON schema.') };
  if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return { ok: false, reason: typedReason('SCHEMA_ENUM', `${path} is not one of the allowed values.`, { path }) };
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) return { ok: false, reason: typedReason('SCHEMA_CONST', `${path} does not equal the required constant.`, { path }) };
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(candidate => validateSchema(value, candidate, path).ok);
    if (matches.length !== 1) return { ok: false, reason: typedReason('SCHEMA_ONE_OF', `${path} must match exactly one allowed shape.`, { path }) };
    return { ok: true };
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some(candidate => validateSchema(value, candidate, path).ok)) return { ok: false, reason: typedReason('SCHEMA_ANY_OF', `${path} does not match any allowed shape.`, { path }) };
    return { ok: true };
  }
  if (schema.type) {
    const actual = typeOf(value);
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const typeMatch = types.some(expected => expected === actual || (expected === 'number' && (actual === 'number' || actual === 'integer')));
    if (!typeMatch) return { ok: false, reason: typedReason('SCHEMA_TYPE', `${path} must be ${types.join(' or ')}, but the model returned ${actual}.`, { path, expected: types, actual }) };
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && [...value].length < schema.minLength) return { ok: false, reason: typedReason('SCHEMA_MIN_LENGTH', `${path} is shorter than the allowed minimum.`, { path }) };
    if (schema.maxLength != null && [...value].length > schema.maxLength) return { ok: false, reason: typedReason('SCHEMA_MAX_LENGTH', `${path} is longer than the allowed maximum.`, { path }) };
    if (schema.pattern != null && !(new RegExp(schema.pattern, 'u')).test(value)) return { ok: false, reason: typedReason('SCHEMA_PATTERN', `${path} does not match the required pattern.`, { path }) };
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) return { ok: false, reason: typedReason('SCHEMA_MIN_ITEMS', `${path} has too few items.`, { path }) };
    if (schema.maxItems != null && value.length > schema.maxItems) return { ok: false, reason: typedReason('SCHEMA_MAX_ITEMS', `${path} has too many items.`, { path }) };
    if (schema.items) for (let index = 0; index < value.length; index += 1) {
      const result = validateSchema(value[index], schema.items, `${path}[${index}]`);
      if (!result.ok) return result;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) if (!(key in value)) return { ok: false, reason: typedReason('SCHEMA_REQUIRED', `${path}.${key} is required.`, { path: `${path}.${key}` }) };
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find(key => !(key in properties));
      if (extra) return { ok: false, reason: typedReason('SCHEMA_EXTRA_PROPERTY', `${path}.${extra} is not allowed.`, { path: `${path}.${extra}` }) };
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in value)) continue;
      const result = validateSchema(value[key], childSchema, `${path}.${key}`);
      if (!result.ok) return result;
    }
  }
  if ((typeof value === 'number') && Number.isFinite(value)) {
    if (schema.minimum != null && value < schema.minimum) return { ok: false, reason: typedReason('SCHEMA_MINIMUM', `${path} is below the allowed minimum.`, { path }) };
    if (schema.maximum != null && value > schema.maximum) return { ok: false, reason: typedReason('SCHEMA_MAXIMUM', `${path} is above the allowed maximum.`, { path }) };
  }
  return { ok: true };
}

function parseJson(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: typedReason('STRUCTURED_EMPTY', 'The model returned an empty structured response.') };
  try { return { ok: true, value: JSON.parse(text), text }; }
  catch { return { ok: false, reason: typedReason('STRUCTURED_MALFORMED_JSON', 'The model response was not valid JSON.') }; }
}

function validateRaw(raw, schema) {
  const parsed = parseJson(raw);
  if (!parsed.ok) return parsed;
  const validated = validateSchema(parsed.value, schema);
  if (!validated.ok) return validated;
  return { ok: true, value: parsed.value };
}

export function createStructuredService({ inference, targetManager, composePrompt = compose }) {
  async function invoke(prompt, schema, signal, stageId = 'structured') {
    const messages = [{ role:'system', content:prompt.system }, { role:'user', content:prompt.user }];
    const owner = { runId:`utility-${Date.now()}-${Math.random().toString(36).slice(2)}`, nodeId:stageId, attemptId:'attempt-1', generation:1 };
    const response = await targetManager.withLease({ owner, requirements:{ inputModalities:['text'] }, signal }, lease => inference.completeStructured({ lease, owner, messages, schema, signal, maxTokens:prompt.maxTokens }));
    return { raw:response.text, constrained:Boolean(response.constrained) };
  }

  async function structured(stageId, vars, schema, signal = null) {
    const initial = composePrompt(stageId, vars || {});
    if (Number.isFinite(Number(vars?.__maxTokens))) initial.maxTokens = Math.max(1, Math.min(initial.maxTokens, Number(vars.__maxTokens)));
    const targetSchema = schema || initial.schema;
    if (!targetSchema) return { ok: false, reason: typedReason('STRUCTURED_SCHEMA_REQUIRED', `Stage ${stageId} has no schema to validate against.`) };
    if (signal?.aborted) return { ok: false, reason: typedReason('STRUCTURED_CANCELLED', 'The structured stage was cancelled before generation began.') };
    let first;
    try { first = await invoke(initial, targetSchema, signal, stageId); }
    catch (error) {
      return { ok: false, reason: typedReason(error?.code || 'STRUCTURED_MODEL_FAILURE', error?.publicMessage || error?.message || 'The model could not produce structured output.') };
    }
    let firstValidation = validateRaw(first.raw, targetSchema);
    if (firstValidation.ok) {
      const grounded = guardStructuredValue(stageId, firstValidation.value, vars || {}, initial.guard || {});
      if (grounded.ok) return {
      ok: true,
      value: grounded.value,
      attempts: 1,
      constrained: first.constrained,
      promptId: initial.promptId,
      promptVersion: initial.promptVersion,
      guardDrops: grounded.drops,
    };
      firstValidation = { ok: false, reason: typedReason('STRUCTURED_GROUNDING', `The ${stageId} output was not grounded in its source input.`) };
    }
    if (signal?.aborted) return { ok: false, reason: typedReason('STRUCTURED_CANCELLED', 'The structured stage was cancelled after its first attempt.') };

    const repair = composePrompt('structured-repair', {
      stageId,
      schemaJson: JSON.stringify(targetSchema),
      raw: String(first.raw ?? ''),
      reason: `${firstValidation.reason.code}: ${firstValidation.reason.sentence}`,
    });
    let second;
    try { second = await invoke(repair, targetSchema, signal, `${stageId}-repair`); }
    catch (error) {
      return { ok: false, reason: typedReason(error?.code || 'STRUCTURED_REPAIR_FAILURE', error?.publicMessage || error?.message || 'The bounded repair attempt could not finish.'), attempts: 2 };
    }
    let secondValidation = validateRaw(second.raw, targetSchema);
    if (secondValidation.ok) {
      const grounded = guardStructuredValue(stageId, secondValidation.value, vars || {}, initial.guard || {});
      if (grounded.ok) return {
      ok: true,
      value: grounded.value,
      attempts: 2,
      repaired: true,
      constrained: first.constrained || second.constrained,
      promptId: initial.promptId,
      promptVersion: initial.promptVersion,
      repairPromptId: repair.promptId,
      repairPromptVersion: repair.promptVersion,
      guardDrops: grounded.drops,
    };
      secondValidation = { ok: false, reason: typedReason('STRUCTURED_GROUNDING', `The repaired ${stageId} output was not grounded in its source input.`) };
    }
    return {
      ok: false,
      reason: typedReason('STRUCTURED_REPAIR_EXHAUSTED', `The model failed structured validation twice. First: ${firstValidation.reason.sentence} Second: ${secondValidation.reason.sentence}`, {
        firstCode: firstValidation.reason.code,
        secondCode: secondValidation.reason.code,
      }),
      attempts: 2,
      promptId: initial.promptId,
      promptVersion: initial.promptVersion,
    };
  }

  return { structured };
}
