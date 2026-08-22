import { parseDecimal, add, sub, mul, div, compare, toString } from './decimal.js';

function failure(code, message, index = null) { return { error: { code, message, ...(index == null ? {} : { index }) } }; }

function read(value, index) {
  if (typeof value === 'number' && !Number.isFinite(value)) return failure('SEQUENCE_NUMBER', `item ${index + 1} is not a finite number`, index);
  const parsed = parseDecimal(String(value), { position: index });
  if (parsed.error) return failure('SEQUENCE_NUMBER', `item ${index + 1}: ${parsed.error.message}`, index);
  return { value: parsed.value };
}

export function check(nums) {
  if (!Array.isArray(nums)) return failure('SEQUENCE_INPUT', 'sequence must be an array of numbers');
  if (nums.length < 2) return failure('SEQUENCE_TOO_SHORT', 'at least two values are required to determine a sequence rule');
  if (nums.length > 4096) return failure('SEQUENCE_TOO_LONG', 'sequence exceeds the supported boundary of 4096 values');
  const values = [];
  for (let index = 0; index < nums.length; index += 1) {
    const parsed = read(nums[index], index);
    if (parsed.error) return parsed;
    values.push(parsed.value);
  }

  const differences = [];
  for (let i = 1; i < values.length; i += 1) differences.push(sub(values[i], values[i - 1]));
  if (differences.every(item => compare(item, differences[0]) === 0)) {
    const next = add(values.at(-1), differences[0]);
    return {
      kind: 'arithmetic',
      rule: `add ${toString(differences[0])}`,
      next: toString(next),
      steps: [
        `Consecutive differences are ${differences.map(toString).join(', ')}.`,
        `The difference is constant at ${toString(differences[0])}.`,
        `${toString(values.at(-1))} + ${toString(differences[0])} = ${toString(next)}.`,
      ],
    };
  }

  if (values.slice(0, -1).every(value => value.c !== 0n)) {
    const ratios = [];
    let ratioExact = true;
    for (let i = 1; i < values.length; i += 1) {
      const result = div(values[i], values[i - 1]);
      ratios.push(result.value); ratioExact = ratioExact && result.exact;
    }
    if (ratioExact && ratios.every(item => compare(item, ratios[0]) === 0)) {
      const product = mul(values.at(-1), ratios[0]);
      return {
        kind: 'geometric',
        rule: `multiply by ${toString(ratios[0])}`,
        next: toString(product),
        exact: true,
        steps: [
          `Consecutive ratios are ${ratios.map(toString).join(', ')}.`,
          `The ratio is exactly constant at ${toString(ratios[0])}.`,
          `${toString(values.at(-1))} × ${toString(ratios[0])} = ${toString(product)}.`,
        ],
      };
    }
    if (!ratioExact && ratios.every(item => compare(item, ratios[0]) === 0)) {
      return {
        kind: 'neither',
        rule: 'no exactly proven constant arithmetic difference or geometric ratio',
        next: null,
        steps: [
          `Consecutive ratios round to ${ratios.map(toString).join(', ')}.`,
          'At least one ratio has a non-terminating decimal expansion, so equality was not proved exactly.',
          'The engine refuses to label the sequence geometric from rounded ratios.',
        ],
      };
    }
  }

  return {
    kind: 'neither',
    rule: 'no constant arithmetic difference or geometric ratio',
    next: null,
    steps: [
      `Consecutive differences are ${differences.map(toString).join(', ')}.`,
      'They are not constant, and the values do not share one constant geometric ratio.',
      'The engine refuses to invent a more complicated pattern from this finite sample.',
    ],
  };
}
