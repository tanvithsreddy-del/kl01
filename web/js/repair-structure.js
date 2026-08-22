function text(value) { return String(value ?? '').normalize('NFC'); }

function lineRecords(source) {
  const out = [];
  let start = 0;
  for (let index = 0; index <= source.length; index += 1) {
    if (index !== source.length && source[index] !== '\n') continue;
    const end = index;
    out.push({ start, end, fullEnd: index < source.length ? index + 1 : index, text: source.slice(start, end) });
    start = index + 1;
  }
  return out;
}

function sentenceChildren(source, block, blockIndex) {
  const children = [];
  const value = source.slice(block.start, block.end);
  const regex = /[^.!?。！？।॥\n]+(?:[.!?。！？।॥]+(?=\s|$)|$)/gu;
  let match;
  let index = 0;
  while ((match = regex.exec(value))) {
    const raw = match[0];
    const lead = raw.match(/^\s*/u)?.[0]?.length || 0;
    const tail = raw.match(/\s*$/u)?.[0]?.length || 0;
    const start = block.start + match.index + lead;
    const end = block.start + match.index + raw.length - tail;
    if (end <= start) continue;
    children.push({ path: `block:${blockIndex}/sentence:${index++}`, kind: 'sentence', start, end, text: source.slice(start, end), parentPath: `block:${blockIndex}` });
  }
  return children;
}

function blockKind(line) {
  if (/^\s*#{1,6}\s+\S/u.test(line)) return 'heading';
  if (/^\s*(?:[-+*]|\d+[.)])\s+\S/u.test(line)) return 'list-item';
  if (/^\s*\|.*\|\s*$/u.test(line)) return 'table-row';
  return 'paragraph';
}

export function parseRepairStructure(input) {
  const source = text(input);
  const lines = lineRecords(source);
  const nodes = [];
  let i = 0;
  let blockIndex = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.text.trim()) { i += 1; continue; }
    const path = `block:${blockIndex}`;
    if (/^\s*```/u.test(line.text)) {
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/u.test(lines[j].text)) j += 1;
      if (j < lines.length) j += 1;
      const endLine = lines[Math.max(i, j - 1)];
      const node = { path, kind: 'code-block', start: line.start, end: endLine.end, text: source.slice(line.start, endLine.end) };
      nodes.push(node); blockIndex += 1; i = j; continue;
    }
    const kind = blockKind(line.text);
    if (kind === 'heading') {
      nodes.push({ path, kind, start: line.start, end: line.end, text: source.slice(line.start, line.end) });
      blockIndex += 1; i += 1; continue;
    }
    if (kind === 'list-item') {
      let j = i + 1;
      while (j < lines.length && blockKind(lines[j].text) === 'list-item') j += 1;
      const endLine = lines[j - 1];
      nodes.push({ path, kind: 'list', start: line.start, end: endLine.end, text: source.slice(line.start, endLine.end) });
      for (let n = i, item = 0; n < j; n += 1, item += 1) nodes.push({ path: `${path}/item:${item}`, kind: 'list-item', start: lines[n].start, end: lines[n].end, text: source.slice(lines[n].start, lines[n].end), parentPath: path });
      blockIndex += 1; i = j; continue;
    }
    if (kind === 'table-row') {
      let j = i + 1;
      while (j < lines.length && blockKind(lines[j].text) === 'table-row') j += 1;
      const endLine = lines[j - 1];
      nodes.push({ path, kind: 'table', start: line.start, end: endLine.end, text: source.slice(line.start, endLine.end) });
      for (let n = i, row = 0; n < j; n += 1, row += 1) nodes.push({ path: `${path}/row:${row}`, kind: 'table-row', start: lines[n].start, end: lines[n].end, text: source.slice(lines[n].start, lines[n].end), parentPath: path });
      blockIndex += 1; i = j; continue;
    }
    let j = i + 1;
    while (j < lines.length && lines[j].text.trim() && blockKind(lines[j].text) === 'paragraph' && !/^\s*```/u.test(lines[j].text)) j += 1;
    const endLine = lines[j - 1];
    const node = { path, kind: 'paragraph', start: line.start, end: endLine.end, text: source.slice(line.start, endLine.end) };
    nodes.push(node, ...sentenceChildren(source, node, blockIndex));
    blockIndex += 1; i = j;
  }
  return nodes;
}

export function repairNode(input, path) {
  return parseRepairStructure(input).find(node => node.path === String(path || '')) || null;
}

export function topRepairNodes(input) {
  return parseRepairStructure(input).filter(node => !node.parentPath);
}
