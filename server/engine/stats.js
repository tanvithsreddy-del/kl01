import { parseDecimal, toString, add, sub, mul, div, compare, fromNumberApprox, toNumber, sqrtExact } from './decimal.js';

function failure(code, message, extra = {}) { return { error: { code, message, ...extra } }; }

function parseData(data) {
  if (!Array.isArray(data)) return failure('STATS_DATA', 'data must be an array of numbers');
  if (!data.length) return failure('STATS_EMPTY', 'statistics are undefined for an empty set');
  const values = [];
  for (let i = 0; i < data.length; i += 1) {
    const parsed = parseDecimal(String(data[i]));
    if (parsed.error) return failure('STATS_VALUE', `cannot read data value at index ${i}: ${parsed.error.message}`, { index: i });
    values.push(parsed.value);
  }
  return { values };
}

function sumValues(values) {
  let total = parseDecimal('0').value;
  for (const value of values) total = add(total, value);
  return total;
}

function meanValue(values) {
  const total = sumValues(values);
  const quotient = div(total, parseDecimal(String(values.length)).value);
  return { total, mean: quotient.value, exact: quotient.exact };
}

function medianValue(values) {
  const sorted = [...values].sort(compare);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return { value: sorted[mid], sorted, exact: true };
  const quotient = div(add(sorted[mid - 1], sorted[mid]), parseDecimal('2').value);
  return { value: quotient.value, sorted, exact: quotient.exact };
}

function varianceValue(values, sample = false) {
  if (sample && values.length < 2) return failure('STATS_SAMPLE_SIZE', 'sample variance requires at least two values');
  const mean = meanValue(values);
  let sumSquares = parseDecimal('0').value;
  for (const value of values) {
    const delta = sub(value, mean.mean);
    sumSquares = add(sumSquares, mul(delta, delta));
  }
  const divisor = parseDecimal(String(sample ? values.length - 1 : values.length)).value;
  const quotient = div(sumSquares, divisor);
  return { value: quotient.value, mean: mean.mean, sumSquares, exact: mean.exact && quotient.exact };
}

export function compute(op, data) {
  const parsed = parseData(data);
  if (parsed.error) return parsed;
  const values = parsed.values;
  const name = String(op || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  try {
    if (name === 'sum') {
      const value = sumValues(values);
      return { value: toString(value), exact: true, steps: [`Add all ${values.length} values: ${toString(value)}.`] };
    }
    if (name === 'mean' || name === 'average') {
      const result = meanValue(values);
      return { value: toString(result.mean), exact: result.exact, steps: [`Add the ${values.length} values: ${toString(result.total)}.`, `Divide by ${values.length}: ${toString(result.mean)}.`] };
    }
    if (name === 'median') {
      const result = medianValue(values);
      const sorted = result.sorted.map(toString).join(', ');
      return { value: toString(result.value), exact: result.exact, steps: [`Sort the values: ${sorted}.`, result.sorted.length % 2 ? `Take the middle value: ${toString(result.value)}.` : `Average the two middle values: ${toString(result.value)}.`] };
    }
    if (name === 'min' || name === 'minimum' || name === 'max' || name === 'maximum') {
      const wantMin = name.startsWith('min');
      let chosen = values[0];
      for (const value of values.slice(1)) if ((wantMin ? compare(value, chosen) < 0 : compare(value, chosen) > 0)) chosen = value;
      return { value: toString(chosen), exact: true, steps: [`Compare all ${values.length} values; the ${wantMin ? 'smallest' : 'largest'} is ${toString(chosen)}.`] };
    }
    if (name === 'range') {
      let min = values[0], max = values[0];
      for (const value of values.slice(1)) { if (compare(value, min) < 0) min = value; if (compare(value, max) > 0) max = value; }
      const value = sub(max, min);
      return { value: toString(value), exact: true, steps: [`Minimum: ${toString(min)}. Maximum: ${toString(max)}.`, `Range = maximum - minimum = ${toString(value)}.`] };
    }
    if (name === 'mode') {
      const counts = new Map();
      for (const value of values) { const key = toString(value); counts.set(key, (counts.get(key) || 0) + 1); }
      const maxCount = Math.max(...counts.values());
      const modes = [...counts.entries()].filter(([, count]) => count === maxCount).map(([value]) => value);
      return { value: modes.length === 1 ? modes[0] : modes, exact: true, steps: [`Count each distinct value. Highest frequency: ${maxCount}.`, `Mode${modes.length === 1 ? '' : 's'}: ${modes.join(', ')}.`] };
    }
    if (['variance','variance_population','population_variance','variance_sample','sample_variance'].includes(name)) {
      const sample = name.includes('sample');
      const result = varianceValue(values, sample); if (result.error) return result;
      return { value: toString(result.value), exact: result.exact, steps: [`Mean: ${toString(result.mean)}.`, `Sum the squared distances from the mean: ${toString(result.sumSquares)}.`, `Divide by ${sample ? values.length - 1 : values.length}: ${toString(result.value)}.`] };
    }
    if (['stddev','standard_deviation','stddev_population','population_stddev','stddev_sample','sample_stddev'].includes(name)) {
      const sample = name.includes('sample');
      const variance = varianceValue(values, sample); if (variance.error) return variance;
      const exactRoot = variance.exact ? sqrtExact(variance.value) : null;
      if (exactRoot) {
        return { value: toString(exactRoot), exact: true, steps: [`Variance: ${toString(variance.value)}.`, `Its exact square root is ${toString(exactRoot)}.`] };
      }
      const numeric = Math.sqrt(toNumber(variance.value));
      const value = fromNumberApprox(numeric, 17);
      return { value: toString(value), exact: false, steps: [`Variance: ${toString(variance.value)}.`, `Its square root is irrational or the variance is approximate, so report a 17-significant-digit numerical approximation: ${toString(value)}.`] };
    }
    return failure('STATS_OPERATION', `unknown statistics operation: ${String(op)}`);
  } catch (cause) {
    return failure(cause.code || 'STATS_CALCULATION', cause.message || 'statistics calculation failed');
  }
}
