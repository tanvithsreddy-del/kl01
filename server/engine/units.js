import { parseDecimal, toString, add, sub, mul, div } from './decimal.js';
import { resolveUnit } from './unit-defs.js';

function failure(code, message, extra = {}) { return { error: { code, message, ...extra } }; }

function readValue(value) {
  if (value && typeof value === 'object' && typeof value.c === 'bigint' && Number.isInteger(value.s)) return { value };
  return parseDecimal(String(value));
}

function factorParts(definition) {
  const numerator = parseDecimal(definition.numerator || definition.factor || '1');
  const denominator = parseDecimal(definition.denominator || '1');
  if (numerator.error || denominator.error) throw Object.assign(new Error(`unit factor for ${definition.id} is invalid`), { code: 'UNIT_DEFINITION' });
  return { numerator: numerator.value, denominator: denominator.value };
}

function toBaseFactor(value, definition) {
  const parts = factorParts(definition);
  return div(mul(value, parts.numerator), parts.denominator);
}

function fromBaseFactor(value, definition) {
  const parts = factorParts(definition);
  return div(mul(value, parts.denominator), parts.numerator);
}

const D32 = parseDecimal('32').value;
const D5 = parseDecimal('5').value;
const D9 = parseDecimal('9').value;
const D27315 = parseDecimal('273.15').value;

function toKelvin(value, definition) {
  if (definition.affine === 'kelvin') return { value, steps: [`Use ${toString(value)} K as the absolute temperature.`] };
  if (definition.affine === 'celsius') {
    const result = add(value, D27315);
    return { value: result, steps: [`Add 273.15 to convert Celsius to Kelvin: ${toString(value)} + 273.15 = ${toString(result)} K.`] };
  }
  if (definition.affine === 'fahrenheit') {
    const shifted = sub(value, D32);
    const ratio = div(mul(shifted, D5), D9);
    const result = add(ratio.value, D27315);
    return { value: result, steps: [`Subtract 32 from Fahrenheit: ${toString(value)} - 32 = ${toString(shifted)}.`, `Multiply by 5/9 and add 273.15: ${toString(result)} K.`] };
  }
  throw Object.assign(new Error('unknown temperature scale'), { code: 'UNIT_DEFINITION' });
}

function fromKelvin(value, definition) {
  if (definition.affine === 'kelvin') return { value, steps: [`Keep the Kelvin value at ${toString(value)} K.`] };
  if (definition.affine === 'celsius') {
    const result = sub(value, D27315);
    return { value: result, steps: [`Subtract 273.15 from Kelvin: ${toString(value)} - 273.15 = ${toString(result)} °C.`] };
  }
  if (definition.affine === 'fahrenheit') {
    const celsius = sub(value, D27315);
    const ratio = div(mul(celsius, D9), D5);
    const result = add(ratio.value, D32);
    return { value: result, steps: [`Subtract 273.15 from Kelvin: ${toString(celsius)} °C.`, `Multiply by 9/5 and add 32: ${toString(result)} °F.`] };
  }
  throw Object.assign(new Error('unknown temperature scale'), { code: 'UNIT_DEFINITION' });
}

export function convert(v, from, to) {
  const source = resolveUnit(from);
  const target = resolveUnit(to);
  if (!source) return failure('UNIT_UNKNOWN_SOURCE', `unknown source unit: ${String(from)}`);
  if (!target) return failure('UNIT_UNKNOWN_TARGET', `unknown target unit: ${String(to)}`);
  if (source.dimension !== target.dimension) {
    return failure('UNIT_DIMENSION_MISMATCH', `mismatched dimensions: cannot convert ${String(from)} to ${String(to)}`, { fromDimension: source.dimension, toDimension: target.dimension });
  }
  const parsed = readValue(v);
  if (parsed.error) return failure('UNIT_VALUE', parsed.error.message, { cause: parsed.error.code });
  try {
    if (source.id === target.id) return { value: toString(parsed.value), steps: [`${toString(parsed.value)} ${source.id} is already in ${target.id}.`] };
    if (source.dimension === 'temperature') {
      const base = toKelvin(parsed.value, source);
      const output = fromKelvin(base.value, target);
      return { value: toString(output.value), steps: [...base.steps, ...output.steps] };
    }
    const baseResult = toBaseFactor(parsed.value, source);
    const base = baseResult.value;
    const output = fromBaseFactor(base, target);
    return {
      value: toString(output.value),
      steps: [
        `Convert ${toString(parsed.value)} ${source.id} to the ${source.dimension} base scale: ${toString(base)} ${source.dimension === 'count' ? 'units' : source.id === target.id ? target.id : ''}`.trim(),
        `Convert the base value to ${target.id}: ${toString(output.value)} ${target.id}.`,
      ],
    };
  } catch (cause) {
    return failure(cause.code || 'UNIT_CONVERSION', cause.message || 'unit conversion failed');
  }
}

export function convertChain(v, path) {
  if (!Array.isArray(path) || path.length < 2) return failure('UNIT_CHAIN', 'a conversion chain needs at least two units');
  let value = String(v);
  const steps = [];
  for (let i = 0; i < path.length - 1; i += 1) {
    const result = convert(value, path[i], path[i + 1]);
    if (result.error) return result;
    value = result.value;
    steps.push(...result.steps);
  }
  return { value, steps };
}
