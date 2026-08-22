import {
  DECIMAL_LIMITS, parseDecimal, parseScaleWord, toString, formatIndian,
  add, sub, mul, div, negate, abs as absDecimal, powInteger, roundToScale,
  floorDecimal, ceilDecimal, toNumber, fromNumberApprox, compare, isInteger, integerValue, sqrtExact,
} from './decimal.js';
import { resolveUnit } from './unit-defs.js';

const MAX_SOURCE_LENGTH = 32768;
const MAX_AST_DEPTH = 128;
const BP = Object.freeze({ IFF: 5, ADD: 10, MUL: 20, POW: 30, POSTFIX: 40 });

function error(code, message, position = null, extra = {}) {
  return { error: { code, message, ...(position == null ? {} : { position }), ...extra } };
}

function isIdentStart(ch) { return /[A-Za-z_°]/.test(ch || ''); }
function isIdent(ch) { return /[A-Za-z0-9_°]/.test(ch || ''); }

function matchCurrency(source, index) {
  if (source[index] === '₹') return { length: 1, code: 'INR' };
  const rest = source.slice(index);
  const inr = rest.match(/^INR\b/i);
  if (inr) return { length: inr[0].length, code: 'INR' };
  const rs = rest.match(/^Rs\.?\s*(?=\d)/i);
  if (rs) return { length: rs[0].length, code: 'INR' };
  return null;
}

function readNumber(source, start) {
  let integerEnd = start;
  while (/[\d,]/.test(source[integerEnd] || '')) integerEnd += 1;
  let integerRaw = source.slice(start, integerEnd);
  if (integerRaw.includes(',')) {
    const validGrouped = value => /^\d{1,3}(?:,\d{3})+$/.test(value) || /^\d{1,2}(?:,\d{2})+,\d{3}$/.test(value);
    if (!validGrouped(integerRaw)) {
      const commaOffsets = [...integerRaw.matchAll(/,/g)].map(match => match.index);
      let chosen = null;
      for (let index = commaOffsets.length - 1; index >= 0; index -= 1) {
        const prefix = integerRaw.slice(0, commaOffsets[index]);
        if (!prefix.includes(',') ? /^\d+$/.test(prefix) : validGrouped(prefix)) { chosen = prefix.length; break; }
      }
      integerEnd = chosen == null ? integerEnd : start + chosen;
      integerRaw = source.slice(start, integerEnd);
    }
  }
  let i = integerEnd;
  if (source[i] === '.') {
    i += 1;
    while (/\d/.test(source[i] || '')) i += 1;
  }
  if (/[eE]/.test(source[i] || '')) {
    const eStart = i;
    i += 1;
    if (/[+-]/.test(source[i] || '')) i += 1;
    const digitStart = i;
    while (/\d/.test(source[i] || '')) i += 1;
    if (digitStart === i) i = eStart;
  }
  return { raw: source.slice(start, i), end: i };
}

function tokenizer(source) {
  const tokens = [];
  let i = 0;
  let pendingCurrency = null;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    const currency = matchCurrency(source, i);
    if (currency) {
      if (pendingCurrency) return error('CALC_CURRENCY_SYNTAX', 'a currency marker must be followed by one number', i);
      pendingCurrency = currency.code;
      i += currency.length;
      continue;
    }
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(source[i + 1] || ''))) {
      let number;
      if (ch === '.') {
        const read = readNumber(`0${source.slice(i)}`, 0);
        number = { raw: source.slice(i, i + read.end - 1), end: i + read.end - 1 };
      } else number = readNumber(source, i);
      const parsed = parseDecimal(number.raw, { position: i });
      if (parsed.error) return { error: parsed.error };
      const indianGrouped = /,/.test(number.raw) && /^\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d*)?(?:[eE][+-]?\d+)?$/.test(number.raw);
      tokens.push({ type: 'number', raw: number.raw, value: parsed.value, start: i, end: number.end, currency: pendingCurrency, indianGrouped });
      pendingCurrency = null;
      i = number.end;
      continue;
    }
    if (pendingCurrency) return error('CALC_CURRENCY_SYNTAX', 'a currency marker must be followed by a number', i);
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (isIdent(source[end])) end += 1;
      tokens.push({ type: 'ident', raw: source.slice(i, end), value: source.slice(i, end), start: i, end });
      i = end;
      continue;
    }
    if ('+-*/^(),%'.includes(ch)) {
      tokens.push({ type: ch, raw: ch, start: i, end: i + 1 }); i += 1; continue;
    }
    return error('CALC_TOKEN', `unexpected character "${ch}" at position ${i}`, i);
  }
  if (pendingCurrency) return error('CALC_CURRENCY_SYNTAX', 'a currency marker must be followed by a number', source.length);
  tokens.push({ type: 'eof', raw: '', start: source.length, end: source.length });
  return { tokens };
}

class Parser {
  constructor(source, tokens) { this.source = source; this.tokens = tokens; this.index = 0; }
  peek(offset = 0) { return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]; }
  take() { return this.tokens[this.index++]; }
  expect(type, message) {
    const token = this.peek();
    if (token.type !== type) throw Object.assign(new Error(message || `expected ${type}`), { code: 'CALC_PARSE', position: token.start });
    return this.take();
  }
  parse() {
    const node = this.expression(0, 0);
    const trailing = this.peek();
    if (trailing.type !== 'eof') throw Object.assign(new Error(`unexpected "${trailing.raw}" at position ${trailing.start}`), { code: 'CALC_PARSE', position: trailing.start });
    return node;
  }
  expression(minBp, depth) {
    if (depth > MAX_AST_DEPTH) throw Object.assign(new Error(`expression nesting exceeds the supported boundary of ${MAX_AST_DEPTH}`), { code: 'CALC_DEPTH', position: this.peek().start });
    let left = this.prefix(depth + 1);
    while (true) {
      const token = this.peek();
      if (token.type === '%') {
        if (BP.POSTFIX < minBp) break;
        this.take();
        left = { type: 'Percent', argument: left, start: left.start, end: token.end };
        continue;
      }
      if (token.type === 'ident') {
        const scale = parseScaleWord(token.value);
        const unit = resolveUnit(token.value);
        if (scale || unit) {
          if (BP.POSTFIX < minBp) break;
          this.take();
          if (scale) left = { type: 'Scale', argument: left, word: token.value, factor: scale, start: left.start, end: token.end };
          else left = { type: 'Unit', argument: left, unit: unit.id, dimension: unit.dimension, start: left.start, end: token.end };
          continue;
        }
      }
      const infix = this.infixBinding(token.type);
      if (!infix || infix.left < minBp) break;
      this.take();
      const right = this.expression(infix.right, depth + 1);
      left = { type: 'Binary', op: token.type, left, right, start: left.start, end: right.end, opPosition: token.start };
    }
    return left;
  }
  infixBinding(type) {
    if (type === '+' || type === '-') return { left: BP.ADD, right: BP.ADD + 1 };
    if (type === '*' || type === '/') return { left: BP.MUL, right: BP.MUL + 1 };
    if (type === '^') return { left: BP.POW, right: BP.POW };
    return null;
  }
  prefix(depth) {
    const token = this.take();
    if (token.type === '+' || token.type === '-') {
      const argument = this.expression(BP.POW, depth + 1);
      return { type: 'Unary', op: token.type, argument, start: token.start, end: argument.end, opPosition: token.start };
    }
    if (token.type === 'number') return { type: 'Number', value: token.value, raw: token.raw, currency: token.currency, indianGrouped: token.indianGrouped, start: token.start, end: token.end };
    if (token.type === '(') {
      const expr = this.expression(0, depth + 1);
      const close = this.expect(')', `missing closing parenthesis for "(" at position ${token.start}`);
      return { type: 'Group', expression: expr, start: token.start, end: close.end };
    }
    if (token.type === 'ident') {
      const name = token.value.toLowerCase();
      if (name === 'pi' || name === 'e') return { type: 'Constant', name, start: token.start, end: token.end };
      if (this.peek().type !== '(') throw Object.assign(new Error(`unknown name "${token.raw}" at position ${token.start}`), { code: 'CALC_NAME', position: token.start });
      this.take();
      const args = [];
      if (this.peek().type !== ')') {
        while (true) {
          args.push(this.expression(0, depth + 1));
          if (this.peek().type !== ',') break;
          this.take();
        }
      }
      const close = this.expect(')', `missing closing parenthesis for ${token.raw}(`);
      return { type: 'Call', name, args, start: token.start, end: close.end };
    }
    if (token.type === 'eof') throw Object.assign(new Error('expression ended before a value was found'), { code: 'CALC_PARSE', position: token.start });
    throw Object.assign(new Error(`expected a number, function, or parenthesis at position ${token.start}`), { code: 'CALC_PARSE', position: token.start });
  }
}

function mergeMeta(a, b) {
  return {
    currency: a.currency || b.currency || null,
    indian: Boolean(a.indian || b.indian),
  };
}

function baseUnitForDimension(dimension) {
  return { length: 'm', mass: 'kg', time: 's', count: 'one', data: 'B', speed: 'm/s', temperature: 'C' }[dimension] || null;
}

function applyUnitFactor(value, unitId) {
  const definition = resolveUnit(unitId);
  if (!definition || definition.affine) return null;
  const numerator = parseDecimal(definition.numerator || definition.factor || '1').value;
  const denominator = parseDecimal(definition.denominator || '1').value;
  const scaled = mul(value, numerator);
  return div(scaled, denominator);
}

function renderEval(result) {
  const numeric = toString(result.decimal);
  if (result.dimension) return `${numeric} ${result.unit || baseUnitForDimension(result.dimension) || ''}`.trim();
  return numeric;
}


function evaluateCall(node, args) {
  const name = node.name;
  const dimensionless = () => {
    if (args.some(arg => arg.dimension)) throw Object.assign(new Error(`${name}() requires a dimensionless value`), { code: 'CALC_DIMENSION', position: node.start });
  };
  if (name === 'abs') {
    if (args.length !== 1) throw Object.assign(new Error('abs() takes exactly one argument'), { code: 'CALC_ARITY', position: node.start });
    return { ...args[0], decimal: absDecimal(args[0].decimal), steps: [...args[0].steps, `Take the absolute value: ${renderEval(args[0])} → ${toString(absDecimal(args[0].decimal))}`] };
  }
  if (name === 'round') {
    if (args.length < 1 || args.length > 2) throw Object.assign(new Error('round() takes one value and an optional number of decimal places'), { code: 'CALC_ARITY', position: node.start });
    dimensionless();
    const places = args[1] ? integerValue(args[1].decimal) : 0;
    if (places < 0 || places > DECIMAL_LIMITS.maxScale) throw Object.assign(new Error(`round() places must be between 0 and ${DECIMAL_LIMITS.maxScale}`), { code: 'CALC_ROUND_PLACES', position: node.start });
    const value = roundToScale(args[0].decimal, places);
    return { decimal: value, exact: args[0].exact, dimension: null, unit: null, meta: args[0].meta, steps: [...args.flatMap(x => x.steps), `Round half to even to ${places} decimal place${places === 1 ? '' : 's'}: ${toString(value, { minFraction: places })}`] };
  }
  if (name === 'floor' || name === 'ceil') {
    if (args.length !== 1) throw Object.assign(new Error(`${name}() takes exactly one argument`), { code: 'CALC_ARITY', position: node.start });
    dimensionless();
    const value = name === 'floor' ? floorDecimal(args[0].decimal) : ceilDecimal(args[0].decimal);
    return { decimal: value, exact: args[0].exact, dimension: null, unit: null, meta: args[0].meta, steps: [...args[0].steps, `${name === 'floor' ? 'Floor' : 'Ceiling'} gives ${toString(value)}`] };
  }
  if (name === 'min' || name === 'max') {
    if (!args.length) throw Object.assign(new Error(`${name}() needs at least one argument`), { code: 'CALC_ARITY', position: node.start });
    const dimension = args[0].dimension;
    if (args.some(arg => arg.dimension !== dimension)) throw Object.assign(new Error(`${name}() arguments have mismatched dimensions`), { code: 'CALC_DIMENSION', position: node.start });
    let chosen = args[0];
    for (const arg of args.slice(1)) if ((name === 'min' ? compare(arg.decimal, chosen.decimal) < 0 : compare(arg.decimal, chosen.decimal) > 0)) chosen = arg;
    return { ...chosen, steps: [...args.flatMap(x => x.steps), `${name}() selects ${renderEval(chosen)}`] };
  }
  if (name === 'sqrt') {
    if (args.length !== 1) throw Object.assign(new Error('sqrt() takes exactly one argument'), { code: 'CALC_ARITY', position: node.start });
    dimensionless();
    if (args[0].decimal.c < 0n) throw Object.assign(new Error('sqrt() is undefined for a negative real number'), { code: 'CALC_DOMAIN', position: node.start });
    const exact = sqrtExact(args[0].decimal);
    if (exact) return { decimal: exact, exact: args[0].exact, dimension: null, unit: null, meta: args[0].meta, steps: [...args[0].steps, `Square root: √${toString(args[0].decimal)} = ${toString(exact)}`] };
    const n = Math.sqrt(toNumber(args[0].decimal));
    const value = fromNumberApprox(n, 17);
    return { decimal: value, exact: false, dimension: null, unit: null, meta: args[0].meta, steps: [...args[0].steps, `Square root evaluated numerically: ${toString(value)}`] };
  }
  const scientific = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    ln: Math.log, log: Math.log10, log10: Math.log10,
    exp: Math.exp,
  }[name];
  if (scientific) {
    if (args.length !== 1) throw Object.assign(new Error(`${name}() takes exactly one argument`), { code: 'CALC_ARITY', position: node.start });
    dimensionless();
    const input = toNumber(args[0].decimal);
    if ((name === 'ln' || name === 'log' || name === 'log10') && input <= 0) throw Object.assign(new Error(`${name}() requires a positive value`), { code: 'CALC_DOMAIN', position: node.start });
    const output = scientific(input);
    if (!Number.isFinite(output)) throw Object.assign(new Error(`${name}() produced a non-finite result`), { code: 'CALC_DOMAIN', position: node.start });
    const value = fromNumberApprox(output, 17);
    return { decimal: value, exact: false, dimension: null, unit: null, meta: args[0].meta, steps: [...args[0].steps, `${name}(${toString(args[0].decimal)}) ≈ ${toString(value)}`] };
  }
  throw Object.assign(new Error(`unknown function "${name}"`), { code: 'CALC_NAME', position: node.start });
}

function evaluateNode(node, source) {
  if (node.type === 'Number') return { decimal: node.value, exact: true, dimension: null, unit: null, meta: { currency: node.currency, indian: node.indianGrouped }, steps: [] };
  if (node.type === 'Constant') {
    const value = fromNumberApprox(node.name === 'pi' ? Math.PI : Math.E, 17);
    return { decimal: value, exact: false, dimension: null, unit: null, meta: { currency: null, indian: false }, steps: [`Use ${node.name === 'pi' ? 'π' : 'e'} ≈ ${toString(value)}`] };
  }
  if (node.type === 'Group') return evaluateNode(node.expression, source);
  if (node.type === 'Unary') {
    const inner = evaluateNode(node.argument, source);
    if (node.op === '+') return { ...inner, steps: inner.steps.length ? inner.steps : [`Unary plus keeps ${renderEval(inner)}`] };
    const value = negate(inner.decimal);
    return { ...inner, decimal: value, steps: [...inner.steps, `Apply unary minus: ${renderEval(inner)} → ${renderEval({ ...inner, decimal: value })}`] };
  }
  if (node.type === 'Percent') {
    const inner = evaluateNode(node.argument, source);
    if (inner.dimension) throw Object.assign(new Error(`percentage cannot be applied to ${inner.dimension}`), { code: 'CALC_DIMENSION', position: node.start });
    const hundred = parseDecimal('100').value;
    const quotient = div(inner.decimal, hundred);
    return { ...inner, decimal: quotient.value, exact: inner.exact && quotient.exact, steps: [...inner.steps, `${toString(inner.decimal)}% = ${toString(quotient.value)}`] };
  }
  if (node.type === 'Scale') {
    const inner = evaluateNode(node.argument, source);
    if (inner.dimension) throw Object.assign(new Error(`${node.word} cannot scale a value that already has a physical unit`), { code: 'CALC_DIMENSION', position: node.start });
    const value = mul(inner.decimal, node.factor);
    return { ...inner, decimal: value, meta: { ...inner.meta, indian: /lakh|lac|crore|cr/i.test(node.word) || inner.meta.indian }, steps: [...inner.steps, `${toString(inner.decimal)} ${node.word} = ${toString(value)}`] };
  }
  if (node.type === 'Unit') {
    const inner = evaluateNode(node.argument, source);
    if (inner.dimension) throw Object.assign(new Error('nested unit suffixes are not supported'), { code: 'CALC_UNIT', position: node.start });
    const definition = resolveUnit(node.unit);
    if (!definition) throw Object.assign(new Error(`unknown unit "${node.unit}"`), { code: 'CALC_UNIT', position: node.start });
    if (definition.affine) throw Object.assign(new Error(`temperature unit ${node.unit} requires the unit converter`), { code: 'CALC_UNIT_AFFINE', position: node.start });
    const converted = applyUnitFactor(inner.decimal, node.unit);
    const value = converted.value;
    return { ...inner, decimal: value, exact: inner.exact && converted.exact, dimension: definition.dimension, unit: baseUnitForDimension(definition.dimension), steps: [...inner.steps, `Read ${source.slice(node.start, node.end).trim()} as ${toString(value)} ${baseUnitForDimension(definition.dimension)}`] };
  }
  if (node.type === 'Call') return evaluateCall(node, node.args.map(arg => evaluateNode(arg, source)));
  if (node.type === 'Binary') {
    const left = evaluateNode(node.left, source);
    const right = evaluateNode(node.right, source);
    const meta = mergeMeta(left.meta, right.meta);
    const bothDimension = left.dimension && right.dimension;
    let value;
    let exact = left.exact && right.exact;
    let dimension = left.dimension || right.dimension || null;
    let unit = left.unit || right.unit || null;
    if (node.op === '+' || node.op === '-') {
      if (left.dimension !== right.dimension) throw Object.assign(new Error(`mismatched dimensions: cannot ${node.op === '+' ? 'add' : 'subtract'} ${left.dimension || 'a number'} and ${right.dimension || 'a number'}`), { code: 'CALC_DIMENSION', position: node.opPosition });
      value = node.op === '+' ? add(left.decimal, right.decimal) : sub(left.decimal, right.decimal);
    } else if (node.op === '*') {
      if (bothDimension) throw Object.assign(new Error(`multiplying ${left.dimension} by ${right.dimension} is outside this calculator's supported dimensions`), { code: 'CALC_DIMENSION_PRODUCT', position: node.opPosition });
      value = mul(left.decimal, right.decimal);
    } else if (node.op === '/') {
      if (right.decimal.c === 0n) throw Object.assign(new Error(`division by zero at position ${node.opPosition}`), { code: 'DIVISION_BY_ZERO', position: node.opPosition });
      if (bothDimension && left.dimension !== right.dimension) throw Object.assign(new Error(`dividing ${left.dimension} by ${right.dimension} is outside this calculator's supported dimensions`), { code: 'CALC_DIMENSION_QUOTIENT', position: node.opPosition });
      const quotient = div(left.decimal, right.decimal);
      value = quotient.value; exact = exact && quotient.exact;
      if (bothDimension && left.dimension === right.dimension) { dimension = null; unit = null; }
      else if (!left.dimension && right.dimension) throw Object.assign(new Error(`dividing a plain number by ${right.dimension} is outside this calculator's supported dimensions`), { code: 'CALC_DIMENSION_QUOTIENT', position: node.opPosition });
    } else if (node.op === '^') {
      if (left.dimension) throw Object.assign(new Error('powers of unit-bearing values are outside this calculator; convert the unit first'), { code: 'CALC_DIMENSION_POWER', position: node.opPosition });
      if (right.dimension) throw Object.assign(new Error('an exponent cannot carry a unit'), { code: 'CALC_DIMENSION_POWER', position: node.opPosition });
      if (isInteger(right.decimal)) {
        const powered = powInteger(left.decimal, integerValue(right.decimal));
        value = powered.value; exact = exact && powered.exact;
      } else {
        const n = Math.pow(toNumber(left.decimal), toNumber(right.decimal));
        if (!Number.isFinite(n)) throw Object.assign(new Error(`power is outside the supported real-number domain at position ${node.opPosition}`), { code: 'CALC_DOMAIN', position: node.opPosition });
        value = fromNumberApprox(n, 17); exact = false;
      }
      dimension = null; unit = null;
    }
    const leftText = renderEval(left), rightText = renderEval(right), resultText = renderEval({ decimal: value, dimension, unit });
    return { decimal: value, exact, dimension, unit, meta, steps: [...left.steps, ...right.steps, `${leftText} ${node.op} ${rightText} = ${resultText}`] };
  }
  throw Object.assign(new Error('unrecognized expression node'), { code: 'CALC_INTERNAL' });
}

export function parse(expr) {
  const source = String(expr ?? '').trim();
  if (!source) return error('CALC_EMPTY', 'expression is empty', 0);
  if (source.length > MAX_SOURCE_LENGTH) return error('CALC_SOURCE_LIMIT', `expression has ${source.length} characters; the supported boundary is ${MAX_SOURCE_LENGTH}`, MAX_SOURCE_LENGTH);
  const lexed = tokenizer(source);
  if (lexed.error) return lexed;
  try {
    const ast = new Parser(source, lexed.tokens).parse();
    return { ast, tokens: lexed.tokens.filter(token => token.type !== 'eof') };
  } catch (cause) {
    return error(cause.code || 'CALC_PARSE', cause.message, cause.position ?? null);
  }
}

export function evaluate(expr) {
  const source = String(expr ?? '').trim();
  const parsed = parse(source);
  if (parsed.error) return parsed;
  try {
    const result = evaluateNode(parsed.ast, source);
    const value = toString(result.decimal);
    const steps = result.steps.length ? result.steps : [`Read the value exactly as ${value}`];
    const displayNumber = result.meta.currency === 'INR'
      ? formatIndian(result.decimal, { currency: true, minFraction: 2 })
      : result.meta.indian
        ? formatIndian(result.decimal)
        : value;
    const display = result.dimension
      ? `${result.meta.indian ? formatIndian(result.decimal) : value} ${result.unit || baseUnitForDimension(result.dimension)}`
      : displayNumber;
    return { value, display, steps, exact: Boolean(result.exact), ast: parsed.ast, ...(result.dimension ? { dimension: result.dimension, unit: result.unit } : {}) };
  } catch (cause) {
    const code = cause.code || 'CALC_EVALUATION';
    const position = cause.position ?? null;
    return error(code, cause.message || 'calculation failed', position);
  }
}

export const calcInternals = Object.freeze({ tokenizer, Parser, evaluateNode, sqrtExact, MAX_SOURCE_LENGTH, MAX_AST_DEPTH });
