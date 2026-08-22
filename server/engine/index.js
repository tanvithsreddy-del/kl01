import * as calc from './calc.js';
import * as units from './units.js';
import * as dates from './dates.js';
import * as stats from './stats.js';
import * as logic from './logic.js';
import * as syllogism from './syllogism.js';
import * as sequence from './sequence.js';
import { detect } from './detector.js';

function failFrom(result) { return result?.error ? { matched: true, error: result.error } : null; }
function displayDuration(parts) {
  if ('totalDays' in parts) return `${parts.totalDays} day${Math.abs(parts.totalDays) === 1 ? '' : 's'}`;
  const sign = parts.sign < 0 ? '-' : '';
  return `${sign}${parts.days}d ${parts.hours}h ${parts.minutes}m ${parts.seconds}s`;
}
function statDisplay(value) { return Array.isArray(value) ? value.join(', ') : String(value); }

export function execute(candidate) {
  if (!candidate) return { matched: false };
  let result;
  let display;
  switch (candidate.kind) {
    case 'calc':
      result = calc.evaluate(candidate.expression);
      if (result.error) return failFrom(result);
      display = result.display || result.value;
      break;
    case 'units':
      result = units.convert(candidate.value, candidate.from, candidate.to);
      if (result.error) return failFrom(result);
      display = `${result.value} ${candidate.to}`;
      break;
    case 'dates-between':
      result = dates.between(candidate.a, candidate.b, candidate.tz);
      if (result.error) return failFrom(result);
      display = displayDuration(result.parts);
      break;
    case 'dates-add':
      result = dates.add(candidate.date, candidate.duration, candidate.tz);
      if (result.error) return failFrom(result);
      display = result.value;
      break;
    case 'dates-weekday':
      result = dates.weekday(candidate.date, candidate.tz);
      if (result.error) return failFrom(result);
      display = result.value;
      break;
    case 'stats':
      result = stats.compute(candidate.op, candidate.data);
      if (result.error) return failFrom(result);
      display = statDisplay(result.value);
      break;
    case 'logic':
      result = logic.analyse(candidate.formula);
      if (result.error) return failFrom(result);
      display = result.valid ? 'Valid' : 'Not valid';
      break;
    case 'syllogism':
      result = syllogism.analyse(candidate.statements);
      if (result.error) return failFrom(result);
      display = result.valid ? 'Valid' : 'Not valid';
      break;
    case 'sequence':
      result = sequence.check(candidate.nums);
      if (result.error) return failFrom(result);
      display = result.next == null ? 'No forced arithmetic or geometric next value' : result.next;
      break;
    default: return { matched: false };
  }
  if (!Array.isArray(result.steps) || result.steps.length === 0) throw Object.assign(new Error(`engine success for ${candidate.kind} has no working steps`), { code: 'ENGINE_STEPS_REQUIRED' });
  return { matched: true, kind: candidate.kind, display, result, steps: result.steps, candidate };
}

export function inspect(input) {
  const candidate = detect(input);
  if (!candidate) return { matched: false };
  return execute(candidate);
}

export { calc, units, dates, stats, logic, syllogism, sequence, detect };
