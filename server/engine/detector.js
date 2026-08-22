import { resolveUnit } from './unit-defs.js';

const NUMBER = String.raw`[+-]?(?:₹\s*|(?:INR|Rs\.?)[ ]*)?\d[\d,]*(?:\.\d+)?`;
const UNIT = String.raw`[\p{L}°]+(?:\/[\p{L}]+)?`;

const CALC_WORDS = new Set([
  'abs', 'round', 'floor', 'ceil', 'min', 'max', 'sqrt', 'sin', 'cos', 'tan', 'ln', 'log', 'log10', 'exp', 'pi', 'e',
  'thousand', 'lakh', 'lakhs', 'lac', 'lacs', 'crore', 'crores', 'cr', 'million', 'millions', 'mn', 'billion', 'billions', 'bn',
  'inr', 'rs',
]);

function onlyKnownCalcWords(text) {
  const words = String(text).match(/[\p{L}_°][\p{L}\p{N}_°]*/gu) || [];
  return words.every(word => CALC_WORDS.has(word.toLocaleLowerCase()) || Boolean(resolveUnit(word)));
}

function stripQuestion(text) { return text.trim().replace(/[?？]\s*$/u, '').trim(); }
function cleanNumber(text) { return String(text).replace(/^₹\s*/u, '').replace(/^(?:INR|Rs\.?)\s*/iu, ''); }
function unitPair(a, b) { return resolveUnit(a) && resolveUnit(b); }

function detectUnit(text) {
  let match = text.match(new RegExp(`^convert\\s+(${NUMBER})\\s*(${UNIT})\\s+(?:to|into)\\s+(${UNIT})$`, 'iu'));
  if (!match) match = text.match(new RegExp(`^(${NUMBER})\\s*(${UNIT})\\s+(?:in|to)\\s+(${UNIT})$`, 'iu'));
  if (!match || !unitPair(match[2], match[3])) return null;
  return { kind: 'units', value: cleanNumber(match[1]), from: match[2], to: match[3], source: text };
}

function detectDate(text) {
  let match = text.match(/^(?:how many\s+)?days?\s+between\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2})(?:\s+in\s+([A-Za-z_]+\/[A-Za-z_]+))?$/iu);
  if (match) return { kind: 'dates-between', a: match[1], b: match[2], tz: match[3] || 'Asia/Kolkata', source: text };
  match = text.match(/^(\d{4}-\d{2}-\d{2})\s*\+\s*([+-]?\d+)\s+(months?|days?)$/iu);
  if (match) return { kind: 'dates-add', date: match[1], duration: match[3].toLowerCase().startsWith('month') ? { months: Number(match[2]) } : { days: Number(match[2]) }, tz: 'Asia/Kolkata', source: text };
  match = text.match(/^weekday\s+(?:of\s+)?(\d{4}-\d{2}-\d{2})$/iu);
  if (match) return { kind: 'dates-weekday', date: match[1], tz: 'Asia/Kolkata', source: text };
  return null;
}

function detectStats(text) {
  const match = text.match(/^(mean|average|median|mode|sum|range|variance|population variance|sample variance|standard deviation|population standard deviation|sample standard deviation)\s+(?:of|for)\s+(.+)$/iu);
  if (!match) return null;
  const raw = match[2].trim();
  if (!/^[+\-\d.,\s]+$/u.test(raw)) return null;
  const data = raw.split(/\s*,\s*|\s+/u).filter(Boolean);
  if (!data.length || data.some(value => !/^[+-]?\d+(?:\.\d+)?$/u.test(value))) return null;
  return { kind: 'stats', op: match[1].toLowerCase(), data, source: text };
}

function detectSequence(text) {
  const match = text.match(/^(?:what(?:'s| is)\s+)?(?:the\s+)?next\s+(?:number\s+)?(?:in\s+)?(?:the\s+)?sequence\s*[:：]?\s*(.+)$/iu);
  if (!match) return null;
  const raw = match[1].trim();
  if (!/^[+\-\d.,\s]+$/u.test(raw)) return null;
  const nums = raw.split(/\s*,\s*|\s+/u).filter(Boolean);
  if (nums.length < 2 || nums.some(value => !/^[+-]?\d+(?:\.\d+)?$/u.test(value))) return null;
  return { kind: 'sequence', nums, source: text };
}

function detectLogic(text) {
  let match = text.match(/^(?:truth table for|analyse logic|analyze logic|is this a tautology\s*[:：]?)\s+(.+)$/iu);
  if (!match) return null;
  const formula = match[1].trim();
  if (!/[∧∨¬→↔]|\b(?:and|or|not|implies|iff)\b|->|<->/iu.test(formula)) return null;
  return { kind: 'logic', formula, source: text };
}

function detectSyllogism(text) {
  const match = text.match(/^syllogism\s*[:：]\s*(.+)$/isu);
  if (!match) return null;
  const statements = match[1].split(/\s*;\s*/u).filter(Boolean);
  if (statements.length !== 3) return null;
  if (statements.some(statement => !/^(?:all|no|some)\s+/iu.test(statement))) return null;
  return { kind: 'syllogism', statements, source: text };
}

function normalizeArithmeticWords(expression) {
  let value = expression.trim();
  const percentOf = value.match(/^([+-]?\d+(?:\.\d+)?)\s*%\s+of\s+(.+)$/iu);
  if (percentOf) return `${percentOf[1]}% * (${percentOf[2]})`;
  value = value
    .replace(/\bmultiplied\s+by\b/giu, '*')
    .replace(/\btimes\b/giu, '*')
    .replace(/\bdivided\s+by\b/giu, '/')
    .replace(/\bplus\b/giu, '+')
    .replace(/\bminus\b/giu, '-');
  return value;
}

function stripCalculationOutputInstruction(expression) {
  return String(expression || '').replace(/[.;:]\s*(?:state|give|show|return|reply|answer|include)\b[\s\S]*$/iu, '').trim();
}

function looksPureArithmetic(text) {
  if (!/\d/u.test(text)) return false;
  if (/^\d{4}\s*-\s*\d{4}$/u.test(text)) return false;
  if (/^[\d,]+$/u.test(text)) return false;
  if (!/[+*/^%()]|\s-\s|−/u.test(text)) return false;
  if (!/^[\d\s,.+\-*/^%()₹°\p{L}/]+$/u.test(text)) return false;
  return onlyKnownCalcWords(text);
}

function detectCalc(text) {
  const prefix = text.match(/^(?:what is|what's|calculate|compute|solve|how much is)\s+(.+)$/iu);
  const expression = normalizeArithmeticWords(stripCalculationOutputInstruction(prefix ? prefix[1] : text));
  if (!prefix && !looksPureArithmetic(expression)) return null;
  if (prefix && !/\d/u.test(expression)) return null;
  if (/[?？]/u.test(expression)) return null;
  return { kind: 'calc', expression, source: text };
}

export function detect(input) {
  const raw = String(input ?? '').normalize('NFC').trim();
  if (!raw || raw.length > 32_768 || raw.includes('\n\n')) return null;
  const text = stripQuestion(raw);
  return detectUnit(text)
    || detectDate(text)
    || detectStats(text)
    || detectSequence(text)
    || detectLogic(text)
    || detectSyllogism(text)
    || detectCalc(text)
    || null;
}

export const DETECTION_RULES = Object.freeze([
  'Explicit unit conversions using convert X unit to unit, or X unit in unit.',
  'Explicit date arithmetic, weekday requests, or days-between requests using ISO dates.',
  'Named statistics followed by an explicit numeric dataset.',
  'Explicit sequence-next requests followed only by numbers.',
  'Explicit truth-table or tautology requests containing formal logical operators.',
  'Explicit syllogism requests containing three controlled categorical sentences separated by semicolons.',
  'A whole arithmetic expression, or arithmetic following What is, calculate, compute, solve, or how much is.',
]);
