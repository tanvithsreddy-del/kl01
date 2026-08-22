const MAX_DIGITS = 1024;
const MAX_SCALE = 4096;
const DIV_SIGNIFICANT_DIGITS = 34;
const MAX_POW10 = MAX_SCALE + MAX_DIGITS + 32;
const POW10 = [1n];

function decimalError(code, message, position = null) {
  return { code, message, ...(position == null ? {} : { position }) };
}

export const DECIMAL_LIMITS = Object.freeze({
  maxDigits: MAX_DIGITS,
  maxScale: MAX_SCALE,
  divisionSignificantDigits: DIV_SIGNIFICANT_DIGITS,
  rounding: 'half-even',
});

function absBigInt(value) { return value < 0n ? -value : value; }
function signBigInt(value) { return value < 0n ? -1n : 1n; }

function pow10(exp) {
  if (!Number.isInteger(exp) || exp < 0 || exp > MAX_POW10) throw Object.assign(new Error(`decimal scale ${exp} exceeds the supported boundary`), { code: 'DECIMAL_SCALE_OVERFLOW' });
  while (POW10.length <= exp) POW10.push(POW10.at(-1) * 10n);
  return POW10[exp];
}

function digitCount(value) {
  return absBigInt(value).toString().length;
}

function assertBoundary(coeff, scale) {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw Object.assign(new Error(`decimal scale ${scale} exceeds the supported boundary of ${MAX_SCALE}`), { code: 'DECIMAL_SCALE_OVERFLOW' });
  }
  const digits = digitCount(coeff);
  if (digits > MAX_DIGITS) {
    throw Object.assign(new Error(`decimal coefficient has ${digits} digits; the supported boundary is ${MAX_DIGITS}`), { code: 'DECIMAL_DIGIT_OVERFLOW' });
  }
}

function normalizeRaw(coeff, scale) {
  let c = BigInt(coeff);
  let s = Number(scale);
  if (c === 0n) return { c: 0n, s: 0 };
  while (s > 0 && c % 10n === 0n) { c /= 10n; s -= 1; }
  assertBoundary(c, s);
  return { c, s };
}

export function decimal(coeff, scale = 0) {
  return normalizeRaw(coeff, scale);
}

function validateGroupedInteger(raw) {
  if (!raw.includes(',')) return true;
  if (/^\d{1,3}(?:,\d{3})+$/.test(raw)) return true;
  if (/^\d{1,2}(?:,\d{2})+,\d{3}$/.test(raw)) return true;
  return false;
}

export function parseDecimal(input, { position = null } = {}) {
  const source = String(input ?? '').trim();
  if (!source) return { error: decimalError('DECIMAL_EMPTY', 'number is empty', position) };
  const match = source.match(/^([+-]?)(\d[\d,]*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!match) return { error: decimalError('DECIMAL_SYNTAX', `cannot read number "${source}"`, position) };
  const [, sign, integerRaw, fractionRaw = '', exponentRaw] = match;
  if (!validateGroupedInteger(integerRaw)) return { error: decimalError('DECIMAL_GROUPING', `malformed digit grouping in "${source}"`, position) };
  const integer = integerRaw.replaceAll(',', '');
  if (fractionRaw && /,/.test(fractionRaw)) return { error: decimalError('DECIMAL_GROUPING', `commas are not allowed after the decimal point in "${source}"`, position) };
  const exponent = exponentRaw == null ? 0 : Number(exponentRaw);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > MAX_SCALE) return { error: decimalError('DECIMAL_SCALE_OVERFLOW', `scientific exponent exceeds the supported boundary of ${MAX_SCALE}`, position) };
  const digits = `${integer}${fractionRaw}`.replace(/^0+(?=\d)/, '') || '0';
  let coeff;
  try { coeff = BigInt(`${sign === '-' ? '-' : ''}${digits}`); }
  catch { return { error: decimalError('DECIMAL_SYNTAX', `cannot read number "${source}"`, position) }; }
  let scale = fractionRaw.length - exponent;
  try {
    if (scale < 0) {
      coeff *= pow10(-scale);
      scale = 0;
    }
    return { value: normalizeRaw(coeff, scale) };
  } catch (error) {
    return { error: decimalError(error.code || 'DECIMAL_OVERFLOW', error.message, position) };
  }
}

export function toString(value, { minFraction = 0, maxFraction = null, rounding = 'half-even' } = {}) {
  let v = value;
  if (maxFraction != null && v.s > maxFraction) v = roundToScale(v, maxFraction, rounding);
  const negative = v.c < 0n;
  const digits = absBigInt(v.c).toString();
  const scale = v.s;
  let text;
  if (scale === 0) text = digits;
  else if (digits.length <= scale) text = `0.${'0'.repeat(scale - digits.length)}${digits}`;
  else text = `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
  if (minFraction > 0) {
    const dot = text.indexOf('.');
    if (dot < 0) text += `.${'0'.repeat(minFraction)}`;
    else {
      const have = text.length - dot - 1;
      if (have < minFraction) text += '0'.repeat(minFraction - have);
    }
  }
  return negative && v.c !== 0n ? `-${text}` : text;
}

export function compare(a, b) {
  if (a.s === b.s) return a.c < b.c ? -1 : a.c > b.c ? 1 : 0;
  const scale = Math.max(a.s, b.s);
  const ac = a.c * pow10(scale - a.s);
  const bc = b.c * pow10(scale - b.s);
  return ac < bc ? -1 : ac > bc ? 1 : 0;
}

export function add(a, b) {
  const scale = Math.max(a.s, b.s);
  return normalizeRaw(a.c * pow10(scale - a.s) + b.c * pow10(scale - b.s), scale);
}

export function sub(a, b) { return add(a, { c: -b.c, s: b.s }); }

export function mul(a, b) {
  if (a.s + b.s > MAX_SCALE) throw Object.assign(new Error(`decimal scale ${a.s + b.s} exceeds the supported boundary of ${MAX_SCALE}`), { code: 'DECIMAL_SCALE_OVERFLOW' });
  return normalizeRaw(a.c * b.c, a.s + b.s);
}

export function negate(a) { return { c: -a.c, s: a.s }; }
export function abs(a) { return { c: absBigInt(a.c), s: a.s }; }

export function sqrtExact(value) {
  if (value.c < 0n) return null;
  let coeff = value.c;
  let scale = value.s;
  if (scale % 2) {
    coeff *= 10n;
    scale += 1;
  }
  if (coeff < 2n) return normalizeRaw(coeff, scale / 2);
  let x = coeff;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + coeff / x) / 2n;
  }
  if (x * x !== coeff) return null;
  return normalizeRaw(x, scale / 2);
}

function gcd(a, b) {
  let x = absBigInt(a), y = absBigInt(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

function factorCount(value, factor) {
  let n = value;
  let count = 0;
  while (n % factor === 0n) { n /= factor; count += 1; }
  return { rest: n, count };
}

function roundQuotient(numerator, denominator) {
  const q = numerator / denominator;
  const r = numerator % denominator;
  const twice = r * 2n;
  if (twice < denominator) return q;
  if (twice > denominator) return q + 1n;
  return q % 2n === 0n ? q : q + 1n;
}

function decimalExponentOfRatio(numerator, denominator) {
  const n = absBigInt(numerator), d = absBigInt(denominator);
  if (n === 0n) return 0;
  let exp = digitCount(n) - digitCount(d);
  if (exp >= 0) {
    if (n < d * pow10(exp)) exp -= 1;
  } else {
    if (n * pow10(-exp) < d) exp -= 1;
  }
  return exp;
}

function approximateRatio(numerator, denominator, significantDigits = DIV_SIGNIFICANT_DIGITS) {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = absBigInt(numerator), d = absBigInt(denominator);
  if (n === 0n) return { value: { c: 0n, s: 0 }, exact: true };
  const exp = decimalExponentOfRatio(n, d);
  const places = significantDigits - exp - 1;
  let coeff;
  let scale;
  if (places >= 0) {
    if (places > MAX_SCALE) throw Object.assign(new Error(`decimal scale ${places} exceeds the supported boundary of ${MAX_SCALE}`), { code: 'DECIMAL_SCALE_OVERFLOW' });
    coeff = roundQuotient(n * pow10(places), d);
    scale = places;
  } else {
    const factor = pow10(-places);
    coeff = roundQuotient(n, d * factor) * factor;
    scale = 0;
  }
  if (negative) coeff = -coeff;
  return { value: normalizeRaw(coeff, scale), exact: false };
}

export function div(a, b) {
  if (b.c === 0n) throw Object.assign(new Error('division by zero'), { code: 'DIVISION_BY_ZERO' });
  let numerator = a.c * pow10(b.s);
  let denominator = b.c * pow10(a.s);
  const common = gcd(numerator, denominator);
  numerator /= common;
  denominator /= common;
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  let remaining = denominator;
  const twos = factorCount(remaining, 2n); remaining = twos.rest;
  const fives = factorCount(remaining, 5n); remaining = fives.rest;
  if (remaining === 1n) {
    const scale = Math.max(twos.count, fives.count);
    if (scale > MAX_SCALE) throw Object.assign(new Error(`decimal scale ${scale} exceeds the supported boundary of ${MAX_SCALE}`), { code: 'DECIMAL_SCALE_OVERFLOW' });
    let coeff = numerator;
    if (twos.count < scale) coeff *= 2n ** BigInt(scale - twos.count);
    if (fives.count < scale) coeff *= 5n ** BigInt(scale - fives.count);
    return { value: normalizeRaw(coeff, scale), exact: true };
  }
  return approximateRatio(numerator, denominator);
}

export function powInteger(base, exponent) {
  if (!Number.isInteger(exponent)) throw Object.assign(new Error('exponent must be an integer for exact power'), { code: 'POWER_EXPONENT' });
  if (Math.abs(exponent) > 4096) throw Object.assign(new Error('exponent exceeds the supported boundary of 4096'), { code: 'POWER_EXPONENT_LIMIT' });
  if (exponent === 0) return { value: { c: 1n, s: 0 }, exact: true };
  if (exponent < 0) {
    const positive = powInteger(base, -exponent);
    const reciprocal = div({ c: 1n, s: 0 }, positive.value);
    return { value: reciprocal.value, exact: positive.exact && reciprocal.exact };
  }
  let result = { c: 1n, s: 0 };
  let factor = base;
  let n = exponent;
  while (n > 0) {
    if (n & 1) result = mul(result, factor);
    n >>= 1;
    if (n) factor = mul(factor, factor);
  }
  return { value: result, exact: true };
}

export function roundToScale(value, targetScale, mode = 'half-even') {
  if (!Number.isInteger(targetScale) || targetScale < 0 || targetScale > MAX_SCALE) throw Object.assign(new Error('rounding scale is outside the supported boundary'), { code: 'ROUND_SCALE' });
  if (value.s <= targetScale) return normalizeRaw(value.c * pow10(targetScale - value.s), targetScale);
  const factor = pow10(value.s - targetScale);
  const negative = value.c < 0n;
  const n = absBigInt(value.c);
  let q = n / factor;
  const r = n % factor;
  if (mode === 'half-even') {
    const twice = r * 2n;
    if (twice > factor || (twice === factor && q % 2n !== 0n)) q += 1n;
  } else if (mode === 'half-up') {
    if (r * 2n >= factor) q += 1n;
  } else if (mode === 'toward-zero') {
    // no increment
  } else throw Object.assign(new Error(`unsupported rounding mode ${mode}`), { code: 'ROUND_MODE' });
  return normalizeRaw(negative ? -q : q, targetScale);
}

export function floorDecimal(value) {
  if (value.s === 0) return value;
  const factor = pow10(value.s);
  let q = value.c / factor;
  if (value.c < 0n && value.c % factor !== 0n) q -= 1n;
  return normalizeRaw(q, 0);
}

export function ceilDecimal(value) {
  if (value.s === 0) return value;
  const factor = pow10(value.s);
  let q = value.c / factor;
  if (value.c > 0n && value.c % factor !== 0n) q += 1n;
  return normalizeRaw(q, 0);
}

export function toNumber(value) { return Number(toString(value)); }

export function fromNumberApprox(value, significantDigits = 17) {
  if (!Number.isFinite(value)) throw Object.assign(new Error('scientific function produced a non-finite value'), { code: 'NON_FINITE_RESULT' });
  const text = value.toPrecision(Math.max(1, Math.min(34, significantDigits)));
  const parsed = parseDecimal(text);
  if (parsed.error) throw Object.assign(new Error(parsed.error.message), { code: parsed.error.code });
  return parsed.value;
}

export function isInteger(value) { return value.s === 0; }

export function integerValue(value) {
  if (!isInteger(value)) throw Object.assign(new Error('value is not an integer'), { code: 'INTEGER_REQUIRED' });
  const n = Number(value.c);
  if (!Number.isSafeInteger(n)) throw Object.assign(new Error('integer is outside the safe control range'), { code: 'INTEGER_CONTROL_RANGE' });
  return n;
}

export function formatIndian(value, { currency = false, minFraction = 0, maxFraction = null } = {}) {
  let text = toString(value, { minFraction, maxFraction });
  const negative = text.startsWith('-');
  if (negative) text = text.slice(1);
  const [integer, fraction] = text.split('.');
  let grouped;
  if (integer.length <= 3) grouped = integer;
  else {
    const last3 = integer.slice(-3);
    const head = integer.slice(0, -3);
    const pairs = [];
    for (let end = head.length; end > 0; end -= 2) pairs.unshift(head.slice(Math.max(0, end - 2), end));
    grouped = `${pairs.join(',')},${last3}`;
  }
  const rendered = `${negative ? '-' : ''}${grouped}${fraction != null ? `.${fraction}` : ''}`;
  return currency ? `₹${rendered}` : rendered;
}

export function parseScaleWord(word) {
  const key = String(word || '').trim().toLowerCase().replace(/\.$/, '');
  const map = {
    thousand: '1000', k: '1000',
    lakh: '100000', lakhs: '100000', lac: '100000', lacs: '100000',
    crore: '10000000', crores: '10000000', cr: '10000000',
    million: '1000000', millions: '1000000', mn: '1000000',
    billion: '1000000000', billions: '1000000000', bn: '1000000000',
  };
  const raw = map[key];
  if (!raw) return null;
  return parseDecimal(raw).value;
}

export const decimalInternals = Object.freeze({ pow10, normalizeRaw, validateGroupedInteger, gcd, approximateRatio, decimalExponentOfRatio, roundQuotient });
