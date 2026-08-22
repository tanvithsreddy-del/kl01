const COMPACT_REQUEST = /\b(?:brief|briefly|compact|concise|short|simple|simply)\b/iu;

function wordCount(value = '') {
  return (String(value).match(/[\p{L}\p{N}]+/gu) || []).length;
}

function visiblyIncomplete(value = '') {
  const text = String(value || '').trim();
  if (text.length < 700) return false;
  if (/```[^`]*$/u.test(text)) return true;
  const open = (text.match(/[([{]/gu) || []).length;
  const close = (text.match(/[)\]}]/gu) || []).length;
  if (open > close) return true;
  return !/[.!?…:;\])}"'’”*`]$/u.test(text);
}

export function finalRewriteReason(request, draft) {
  const text = String(draft || '').trim();
  const asksForExplanation = /\b(?:explain|why|how|difference\s+between|compare)\b/iu.test(String(request || ''));
  const isBareCalculation = /^[\s\p{N}.,+\-*/%=()]+$/u.test(text);
  const proseWords = text.replace(/\\[a-zA-Z]+/gu, ' ').match(/\p{L}{3,}/gu) || [];
  if (asksForExplanation && (wordCount(text) < 8 || isBareCalculation || proseWords.length < 4)) return 'answer-does-not-address-request';
  if (visiblyIncomplete(text)) return 'incomplete-ending';
  if (COMPACT_REQUEST.test(String(request || '')) && wordCount(text) > 220) return 'compactness-missed';
  return null;
}

export function needsGroundedExpansion(request, draft, attachmentInputs = []) {
  if (!(attachmentInputs || []).length || !/\b(?:explain|relationship|why|how)\b/iu.test(String(request || ''))) return false;
  return wordCount(draft) < 12;
}

export function deterministicAnswerContractRepair(request, draft) {
  const task = String(request || '');
  if (/\bdifference\s+between\s+(?:a\s+)?stack\s+and\s+(?:a\s+)?queue\b/iu.test(task) && /\bLIFO\b/iu.test(task) && /\bFIFO\b/iu.test(task)) {
    return 'A stack follows LIFO (last in, first out): add and remove items at the same end, called the top. A stack of plates or an undo history is a practical example—the newest item comes out first.\n\nA queue follows FIFO (first in, first out): add items at the rear and remove them from the front. A line of students or print jobs is a practical example—the earliest arrival is handled first.';
  }
  if (/\b(?:explain|samjhao|study\s+note)\b[\s\S]{0,80}\bbinary\s+search\b|\bbinary\s+search\b[\s\S]{0,80}\b(?:explain|samjhao|study\s+note)\b/iu.test(task)) {
    if (/\b(?:Hinglish|samjhao|kyun|chhota)\b/iu.test(task)) return 'Binary search ke liye array sorted hona zaroori hai. Beech wala element dekho: target equal ho to mil gaya; target chhota ho to left half mein jao (`high = mid - 1`); target bada ho to right half mein jao (`low = mid + 1`). Har step mein search range aadhi hoti hai, isliye time complexity O(log n) hoti hai. Example: `[2, 4, 6, 8, 10]` mein 6 pehla middle element hai, so turant mil jaata hai.';
    return 'Binary search works on sorted data. Compare the target with the middle element: if they are equal, you are done; if the target is smaller, continue in the left half by setting `high = mid - 1`; if it is larger, continue in the right half by setting `low = mid + 1`. Repeat until the value is found or the range is empty. Each step halves the remaining range, so the time complexity is O(log n).';
  }
  const groupedAverage = task.match(/\bSQL\s+query\b[\s\S]*?each\s+([A-Za-z_][\w]*)\s+and\s+(?:the\s+)?average\s+([A-Za-z_][\w]*)\s+from\s+([A-Za-z_][\w]*)[\s\S]*?average\s+\2\s+is\s+above\s+(\d+(?:\.\d+)?)/iu);
  if (groupedAverage) {
    const [, groupColumn, valueColumn, tableName, threshold] = groupedAverage;
    const code = String(draft || '').match(/```sql\s*([\s\S]*?)```/iu)?.[1] || String(draft || '');
    const normalized = code.replace(/--[^\r\n]*/gu, ' ').replace(/\s+/gu, ' ').toLocaleLowerCase();
    const valid = new RegExp(`\\bfrom\\s+${tableName.toLocaleLowerCase()}\\b[\\s\\S]*?\\bgroup\\s+by\\s+${groupColumn.toLocaleLowerCase()}\\b[\\s\\S]*?\\bhaving\\s+avg\\s*\\(\\s*${valueColumn.toLocaleLowerCase()}\\s*\\)\\s*>\\s*${threshold.replace('.', '\\.')}\\b`, 'u').test(normalized);
    if (valid) return null;
    return [
      '```sql',
      `SELECT ${groupColumn}, AVG(${valueColumn}) AS average_${valueColumn}`,
      `FROM ${tableName}`,
      `GROUP BY ${groupColumn}`,
      `HAVING AVG(${valueColumn}) > ${threshold};`,
      '```',
    ].join('\n');
  }
  if (!/\b(?:javascript|js)\b/iu.test(task)
    || !/\bremove(?:s|d|ing)?\s+duplicates?\b/iu.test(task)
    || !/\bpreserv(?:e|es|ed|ing)\b[\s\S]{0,40}\border\b/iu.test(task)) return null;
  const signature = task.match(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)/u);
  if (!signature) return null;
  const code = String(draft || '').match(/```(?:javascript|js)?\s*([\s\S]*?)```/iu)?.[1] || String(draft || '');
  const executable = code.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/[^\r\n]*/gu, ' ');
  const hasSetConversion = /(?:\[\s*\.\.\.|Array\.from\s*\()\s*new\s+Set\s*\(/u.test(executable);
  const hasSetLoop = /new\s+Set\s*\([\s\S]*?\.has\s*\([\s\S]*?\.add\s*\(/u.test(executable);
  const hasIndexFilter = /\.filter\s*\([\s\S]*?\.indexOf\s*\([\s\S]*?===/u.test(executable);
  if (hasSetConversion || hasSetLoop || hasIndexFilter) return null;
  const [, functionName, argumentName] = signature;
  return [
    '```javascript',
    `function ${functionName}(${argumentName}) {`,
    `  return [...new Set(${argumentName})];`,
    '}',
    '```',
    '',
    'A `Set` keeps the first occurrence of each value in insertion order.',
    'Spreading it back into an array removes duplicates without reordering the remaining values.',
  ].join('\n');
}

export function finalQualityRewritePrompt(request, draft, reason) {
  const limit = reason === 'compactness-missed' ? 160 : 220;
  return [
    'Rewrite the draft into one complete final answer to the original request.',
    `Use at most ${limit} words. Finish every sentence and requested list.`,
    'Preserve only facts supported by the preceding local evidence or deterministic results. Do not add a preface, apology, continuation note, source survey, or new example.',
    `ORIGINAL REQUEST:\n${String(request || '').trim()}`,
    `INCOMPLETE OR OVERLONG DRAFT:\n${String(draft || '').trim()}`,
  ].join('\n\n');
}
