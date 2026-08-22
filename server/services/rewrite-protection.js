function clean(value) { return String(value ?? '').normalize('NFC').trim(); }

function candidateSpans(text, { computed = null, protectProperNouns = true } = {}) {
  const spans = [];
  const addRegex = (regex, kind) => {
    for (const match of text.matchAll(regex)) {
      if (match[0]) spans.push({ start: match.index, end: match.index + match[0].length, text: match[0], kind });
    }
  };
  addRegex(/```[\s\S]*?```|`[^`\n]+`/gu, 'code');
  addRegex(/\[[^\]\n]+\]\([^\s)]+(?:\s+"[^"]*")?\)|https?:\/\/[^\s<>)\]}]+|\[(?:\d+|[A-Za-z][\w.-]*)\]/gu, 'citation');
  addRegex(/["“”][^"“”\n]+["“”]|['‘’][^'‘’\n]+['‘’]/gu, 'quotation');
  addRegex(/(?:[$€£¥₹]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent|kg|g|mg|km|m|cm|mm|mi|ft|in|L|ml|MB|GB|TB|ms|s|sec|seconds?|minutes?|hours?|days?|weeks?|months?|years?|USD|EUR|GBP|INR|dollars?|rupees?|lakh|crore)?\b)/giu, 'number');
  addRegex(/\b(?:\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b/giu, 'date');
  if (protectProperNouns) addRegex(/\b(?:[A-Z][\p{L}\p{M}'’.-]+(?:\s+[A-Z][\p{L}\p{M}'’.-]+){0,4})\b/gu, 'proper-noun');
  const computedText = clean(computed?.display || computed?.text || '');
  if (computedText) {
    let cursor = 0;
    while ((cursor = text.indexOf(computedText, cursor)) >= 0) {
      spans.push({ start: cursor, end: cursor + computedText.length, text: computedText, kind: 'computed' });
      cursor += computedText.length;
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start < last.end) {
      if (span.end > last.end) {
        last.end = span.end;
        last.text = text.slice(last.start, last.end);
        last.kind = `${last.kind}+${span.kind}`;
      }
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

export function protectRewriteText(text, options = {}) {
  const source = String(text || '');
  const spans = candidateSpans(source, options);
  let maskedText = '';
  let cursor = 0;
  const immutable = spans.map((span, index) => ({
    token: `⟦ZR${String(index + 1).padStart(4, '0')}⟧`,
    text: span.text,
    kind: span.kind,
  }));
  spans.forEach((span, index) => {
    maskedText += source.slice(cursor, span.start) + immutable[index].token;
    cursor = span.end;
  });
  maskedText += source.slice(cursor);
  return { maskedText, immutable };
}

function numberSequence(text) {
  return [...String(text || '').matchAll(/(?:[$€£¥₹]\s?)?\d[\d,]*(?:\.\d+)?(?:\s?%|\s?[A-Za-z]+)?/gu)].map(match => match[0]);
}

export function validateProtectedRewrite(original, rewritten, protection) {
  const failures = [];
  for (const item of protection.immutable || []) {
    const count = rewritten.split(item.text).length - 1;
    if (count !== 1) failures.push(`${count < 1 ? 'missing' : 'duplicated'}:${item.kind}:${item.text}`);
  }
  if (JSON.stringify(numberSequence(original)) !== JSON.stringify(numberSequence(rewritten))) failures.push('numbers-changed');
  return { ok: failures.length === 0, failures };
}

export function restoreProtectedText(masked, immutable) {
  let value = String(masked || '');
  for (const item of immutable || []) {
    const count = value.split(item.token).length - 1;
    if (count !== 1) return { ok: false, reason: `token-count:${item.token}:${count}` };
    value = value.replace(item.token, item.text);
  }
  if (/⟦ZR\d{4}⟧/u.test(value)) return { ok: false, reason: 'unknown-token' };
  return { ok: true, value };
}
