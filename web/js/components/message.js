import { el, copyText, cssTime } from './dom.js';
import { parseRepairStructure, topRepairNodes } from '../repair-structure.js';
import { bytes } from '../format.js';
import { researchWork, releaseResearchWorkInstancesWithin } from './research-work.js';
import { workInspector, releaseWorkInspectorInstancesWithin } from './work-inspector.js';



export function releaseMessageViewState(container) {
  if (!container) return;
  releaseResearchWorkInstancesWithin(container);
  releaseWorkInspectorInstancesWithin(container);
}

function copyButton(text, label = 'Copy', className = 'nav-chip') {
  const button = el('button', { class: className, type: 'button', text: label, 'aria-label': label });
  button.addEventListener('click', async () => {
    try {
      await copyText(text);
      button.textContent = 'Copied';
      button.setAttribute('aria-label', 'Copied');
      setTimeout(() => { if (button.isConnected) { button.textContent = label; button.setAttribute('aria-label', label); } }, cssTime('--kl01-copy-reset'));
    } catch {
      button.textContent = 'Copy failed; try again';
      button.setAttribute('aria-label', 'Copy failed; try again');
      setTimeout(() => { if (button.isConnected && button.textContent === 'Copy failed; try again') { button.textContent = label; button.setAttribute('aria-label', label); } }, cssTime('--kl01-copy-reset'));
    }
  });
  return button;
}

function repairAttrs(node) {
  return { class: 'repair-node', 'data-repair-path': node.path, 'data-repair-kind': node.kind };
}

function nestedRepairNode(content, node, nodes) {
  const children = nodes.filter(candidate => candidate.parentPath === node.path).sort((a,b) => a.start - b.start);
  if (!children.length) return el('span', { ...repairAttrs(node), text: node.text });
  const parent = el('span', repairAttrs(node));
  let cursor = node.start;
  for (const child of children) {
    if (child.start > cursor) parent.append(document.createTextNode(content.slice(cursor, child.start)));
    parent.append(el('span', { ...repairAttrs(child), text: child.text }));
    cursor = child.end;
  }
  if (cursor < node.end) parent.append(document.createTextNode(content.slice(cursor, node.end)));
  return parent;
}

function codeRepairNode(content, node, repairable = true) {
  const firstBreak = node.text.indexOf('\n');
  const firstLine = firstBreak >= 0 ? node.text.slice(0, firstBreak) : node.text;
  const language = firstLine.replace(/^\s*```/u, '').trim();
  const body = firstBreak >= 0 ? node.text.slice(firstBreak + 1).replace(/\n?\s*```\s*$/u, '') : '';
  return el('div', repairable ? { class: 'code-block repair-node', 'data-repair-path': node.path, 'data-repair-kind': node.kind, 'data-repair-visible': body } : { class: 'code-block' },
    el('div', { class: 'code-head' }, el('span', { text: language || 'Code' }), copyButton(body, 'Copy code', 'nav-chip code-copy')),
    el('pre', { 'data-repair-content': '' }, el('code', { text: body })));
}

function appendInlineMarkdown(parent, value) {
  const source = String(value || '');
  const pattern = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_))/gu;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index || 0;
    if (index > cursor) parent.append(document.createTextNode(source.slice(cursor, index)));
    if (match[2] && match[3]) {
      const link = el('a', { href: match[3], target: '_blank', rel: 'noreferrer noopener', text: match[2] });
      parent.append(link);
    } else if (match[4]) parent.append(el('code', { class: 'inline-code', text: match[4] }));
    else if (match[5] || match[6]) parent.append(el('strong', { text: match[5] || match[6] }));
    else parent.append(el('em', { text: match[7] || match[8] || '' }));
    cursor = index + match[0].length;
  }
  if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
}

function matchingRepairNode(nodes, start, end, kinds = null) {
  const candidates = nodes.filter(node => node.start <= start && node.end >= end && (!kinds || kinds.includes(node.kind)));
  candidates.sort((a, b) => (a.end - a.start) - (b.end - b.start));
  return candidates[0] || null;
}

function applyRepairAttributes(element, node, repairable) {
  if (!repairable || !node) return element;
  element.classList.add('repair-node');
  element.dataset.repairPath = node.path;
  element.dataset.repairKind = node.kind;
  return element;
}

function appendInlineWithSentenceRepair(parent, value, sourceStart, repairNodes, repairable) {
  if (!repairable) { appendInlineMarkdown(parent, value); return; }
  const text = String(value || '');
  const sentences = repairNodes
    .filter(node => node.kind === 'sentence' && node.start >= sourceStart && node.end <= sourceStart + text.length)
    .sort((a, b) => a.start - b.start);
  if (!sentences.length) { appendInlineMarkdown(parent, text); return; }
  let cursor = 0;
  for (const sentence of sentences) {
    const localStart = sentence.start - sourceStart;
    const localEnd = sentence.end - sourceStart;
    if (localStart > cursor) appendInlineMarkdown(parent, text.slice(cursor, localStart));
    const span = el('span'); appendInlineMarkdown(span, text.slice(localStart, localEnd));
    applyRepairAttributes(span, sentence, true); parent.append(span); cursor = localEnd;
  }
  if (cursor < text.length) appendInlineMarkdown(parent, text.slice(cursor));
}

function markdownTable(lines, startIndex, sourceOffset, repairable, repairNodes) {
  const split = line => line.trim().replace(/^\||\|$/gu, '').split('|').map(cell => cell.trim());
  const headers = split(lines[startIndex].text);
  const rows = [];
  let index = startIndex + 2;
  while (index < lines.length && /\|/u.test(lines[index].text) && lines[index].text.trim()) {
    rows.push(split(lines[index].text));
    index += 1;
  }
  const headerRow = el('tr', {}, ...headers.map(header => { const th = el('th'); appendInlineMarkdown(th, header); return th; }));
  applyRepairAttributes(headerRow, repairNodes.find(node => node.kind === 'table-row' && node.start === lines[startIndex].start), repairable);
  const bodyRows = rows.map((row, rowIndex) => {
    const sourceLine = lines[startIndex + 2 + rowIndex];
    const tr = el('tr', {}, ...headers.map((_, cellIndex) => { const td = el('td'); appendInlineMarkdown(td, row[cellIndex] || ''); return td; }));
    applyRepairAttributes(tr, repairNodes.find(node => node.kind === 'table-row' && node.start === sourceLine?.start), repairable);
    return tr;
  });
  const table = el('div', { class: 'data-table-wrap' }, el('table', { class: 'data-table' },
    el('thead', {}, headerRow), el('tbody', {}, ...bodyRows)));
  const endLine = lines[Math.max(startIndex, index - 1)];
  const node = matchingRepairNode(repairNodes, sourceOffset, endLine.end);
  applyRepairAttributes(table, node, repairable);
  return { node: table, next: index };
}

function renderMarkdownLite(raw, { repairable = false } = {}) {
  const content = String(raw || '').replace(/\r\n?/gu, '\n');
  const container = el('div', { class: 'message-content markdown-content' });
  const repairNodes = parseRepairStructure(content);
  const lines = [];
  let offset = 0;
  for (const text of content.split('\n')) {
    lines.push({ text, start: offset, end: offset + text.length });
    offset += text.length + 1;
  }
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.text.trim();
    if (!trimmed) { index += 1; continue; }

    if (/^```/u.test(trimmed)) {
      let close = index + 1;
      while (close < lines.length && !/^```\s*$/u.test(lines[close].text.trim())) close += 1;
      const endLine = lines[Math.min(close, lines.length - 1)];
      const node = matchingRepairNode(repairNodes, line.start, endLine.end, ['code-block']) || {
        path: `code-${line.start}`, kind: 'code-block', text: content.slice(line.start, endLine.end), start: line.start, end: endLine.end,
      };
      container.append(codeRepairNode(content, node, repairable));
      index = Math.min(lines.length, close + 1);
      continue;
    }

    if (index + 1 < lines.length && /\|/u.test(line.text) && /^\s*\|?\s*:?-{3,}/u.test(lines[index + 1].text)) {
      const result = markdownTable(lines, index, line.start, repairable, repairNodes);
      container.append(result.node); index = result.next; continue;
    }

    const heading = line.text.match(/^\s*(#{1,6})\s+(.+)$/u);
    if (heading) {
      const node = el(`h${Math.min(6, heading[1].length)}`, { class: 'markdown-heading' });
      appendInlineMarkdown(node, heading[2]);
      applyRepairAttributes(node, matchingRepairNode(repairNodes, line.start, line.end), repairable);
      container.append(node); index += 1; continue;
    }

    if (/^\s*[-*+]\s+/u.test(line.text) || /^\s*\d+[.)]\s+/u.test(line.text)) {
      const ordered = /^\s*\d+[.)]\s+/u.test(line.text);
      const list = el(ordered ? 'ol' : 'ul', { class: 'markdown-list' });
      const blockStart = line.start;
      let blockEnd = line.end;
      while (index < lines.length) {
        const current = lines[index];
        const expression = ordered ? /^\s*\d+[.)]\s+(.+)$/u : /^\s*[-*+]\s+(.+)$/u;
        const match = current.text.match(expression);
        if (!match) break;
        const item = el('li'); appendInlineMarkdown(item, match[1]);
        applyRepairAttributes(item, repairNodes.find(node => node.kind === 'list-item' && node.start === current.start), repairable);
        list.append(item); blockEnd = current.end; index += 1;
      }
      applyRepairAttributes(list, matchingRepairNode(repairNodes, blockStart, blockEnd), repairable);
      container.append(list); continue;
    }

    if (/^\s*>\s?/u.test(line.text)) {
      const quote = el('blockquote', { class: 'markdown-quote' });
      const blockStart = line.start;
      let blockEnd = line.end;
      while (index < lines.length && /^\s*>\s?/u.test(lines[index].text)) {
        const p = el('p'); appendInlineMarkdown(p, lines[index].text.replace(/^\s*>\s?/u, '')); quote.append(p);
        blockEnd = lines[index].end; index += 1;
      }
      applyRepairAttributes(quote, matchingRepairNode(repairNodes, blockStart, blockEnd), repairable);
      container.append(quote); continue;
    }

    const paragraphLines = [line.text];
    const blockStart = line.start;
    let blockEnd = line.end;
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (!next.text.trim() || /^```/u.test(next.text.trim()) || /^\s*(#{1,6})\s+/u.test(next.text) || /^\s*[-*+]\s+/u.test(next.text) || /^\s*\d+[.)]\s+/u.test(next.text) || /^\s*>\s?/u.test(next.text)) break;
      if (index + 1 < lines.length && /\|/u.test(next.text) && /^\s*\|?\s*:?-{3,}/u.test(lines[index + 1].text)) break;
      paragraphLines.push(next.text); blockEnd = next.end; index += 1;
    }
    const paragraph = el('p', { class: 'markdown-paragraph' });
    let paragraphOffset = blockStart;
    paragraphLines.forEach((value, lineIndex) => {
      if (lineIndex) { paragraph.append(document.createElement('br')); paragraphOffset += 1; }
      appendInlineWithSentenceRepair(paragraph, value, paragraphOffset, repairNodes, repairable);
      paragraphOffset += value.length;
    });
    applyRepairAttributes(paragraph, matchingRepairNode(repairNodes, blockStart, blockEnd), repairable);
    container.append(paragraph);
  }
  return container;
}

function selectionRepairPath(article) {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const selected = String(selection.toString() || '');
  if (!selected.trim()) return null;
  const range = selection.getRangeAt(0);
  const startElement = range.startContainer?.nodeType === 1 ? range.startContainer : range.startContainer?.parentElement;
  const endElement = range.endContainer?.nodeType === 1 ? range.endContainer : range.endContainer?.parentElement;
  if (!startElement || !endElement || !article.contains(startElement) || !article.contains(endElement)) return null;
  const candidates = [...article.querySelectorAll('[data-repair-path]')].filter(node => node.contains(startElement) && node.contains(endElement));
  candidates.sort((a,b) => (a.textContent || '').length - (b.textContent || '').length);
  for (const node of candidates) {
    const visible = node.getAttribute('data-repair-visible') ?? node.textContent ?? '';
    if (selected === visible || selected.trim() === visible.trim()) return node.getAttribute('data-repair-path');
  }
  return null;
}

function installRepairSelection(article, message, onRepairSelect) {
  if (!onRepairSelect) return;
  let control = null;
  const clearControl = () => { control?.remove(); control = null; };
  const reveal = () => {
    clearControl();
    const path = selectionRepairPath(article);
    if (!path) return;
    const selection = window.getSelection?.();
    const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect?.() : null;
    control = el('button', { class: 'repair-selection-trigger', type: 'button', text: 'Fix this', 'aria-label': 'Fix selected section', onClick: () => { clearControl(); onRepairSelect(message, path); } });
    if (rect) { control.style.setProperty('--repair-anchor-x', `${rect.left + rect.width / 2}px`); control.style.setProperty('--repair-anchor-y', `${rect.bottom}px`); }
    article.append(control);
  };
  article.addEventListener('mouseup', () => queueMicrotask(reveal));
  article.addEventListener('keyup', event => { if (event.key !== 'Tab' && event.key !== 'Escape') queueMicrotask(reveal); });
  article.addEventListener('blur', event => { if (!article.contains(event.relatedTarget)) clearControl(); }, true);
}

function repairPreview(message, options) {
  const preview = message.repairPreview;
  const busy = Boolean(options.repairBusy);
  if (!preview) return null;
  return el('section', { class: 'repair-preview-inline', 'data-repair-preview': preview.id, 'aria-label': 'Section repair preview' },
    el('div', { class: 'repair-preview-copy' },
      el('div', { class: 'repair-preview-side' }, el('strong', { text: 'Original' }), el('pre', { text: preview.original || '' })),
      el('div', { class: 'repair-preview-side' }, el('strong', { text: 'Proposed' }), el('pre', { text: preview.replacement || '' }))),
    el('div', { class: 'repair-preview-actions' },
      el('button', { class: 'btn primary', type: 'button', disabled: busy, 'aria-label': busy ? 'Apply disabled while section repair is running' : 'Apply repair', onClick: () => options.onRepairApply?.(message), text: 'Apply' }),
      el('button', { class: 'btn', type: 'button', disabled: busy, 'aria-label': busy ? 'Discard disabled while section repair is running' : 'Discard repair', onClick: () => options.onRepairDiscard?.(message), text: 'Discard' }),
      busy ? el('span', { class: 'disabled-reason muted', text: 'Section repair is running.' }) : null));
}

function repairEditor(message, options) {
  const editor = options.repairEditor;
  if (!editor || editor.messageId !== message.id || message.repairPreview) return null;
  const busy = Boolean(options.repairBusy);
  const instruction = el('input', {
    class: 'field repair-instruction', type: 'text', maxlength: '800', disabled: busy,
    placeholder: 'Describe a fix or tone, e.g. more formal',
    'aria-label': busy ? 'Repair instruction disabled while section repair is running' : 'Repair or tone instruction',
  });
  const act = operation => options.onRepairPreview?.(message, editor.anchor, operation, { instruction: instruction.value });
  instruction.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); act('fix'); } });
  return el('section', { class: 'repair-editor-inline', 'data-repair-editor': editor.anchor?.path || '', 'aria-label': 'Fix selected section' },
    el('div', { class: 'repair-operation-row' },
      el('button', { class: 'nav-chip', type: 'button', disabled: busy, onClick: () => act('shorter'), text: 'Shorter' }),
      el('button', { class: 'nav-chip', type: 'button', disabled: busy, onClick: () => act('clearer'), text: 'Clearer' }),
      el('button', { class: 'nav-chip', type: 'button', disabled: busy, onClick: () => act('more-detail'), text: 'More detail' }),
      el('button', { class: 'nav-chip', type: 'button', disabled: busy, onClick: () => act('change-tone'), text: 'Change the tone' }),
      el('button', { class: 'nav-chip', type: 'button', disabled: busy, onClick: () => act('remove'), text: 'Remove' })),
    el('div', { class: 'repair-free-row' }, instruction, el('button', { class: 'btn', type: 'button', disabled: busy, onClick: () => act('fix'), text: 'Fix this' }), busy ? el('span', { class: 'disabled-reason muted', text: 'Section repair is running.' }) : null));
}

function revisionControls(message, options) {
  if (!message.revisionId) return null;
  const busy = Boolean(options.repairBusy);
  const history = options.repairHistory?.messageId === message.id ? options.repairHistory : null;
  return el('div', { class: 'repair-revision-controls' },
    el('button', { class: 'nav-chip', type: 'button', disabled: busy, onClick: () => options.onRepairHistory?.(message), text: 'Revisions' }),
    el('button', { class: 'nav-chip', type: 'button', disabled: busy, onClick: () => options.onRepairUndo?.(message), text: 'Undo repair' }),
    history ? el('div', { class: 'repair-history-list', 'aria-label': 'Message revisions' }, ...(history.revisions || []).map((revision, index) =>
      el('button', { class: `repair-history-item ${revision.id === history.activeRevisionId ? 'active' : ''}`, type: 'button', disabled: busy || revision.id === history.activeRevisionId, onClick: () => options.onRepairRestore?.(message, revision.id), text: `${index === 0 ? 'Latest' : `Revision ${history.revisions.length - index}`} · ${revision.operation}` }))) : null);
}

function statusBlock(message, onRestart) {
  if (message.status === 'streaming') return null;
  if (message.status === 'cancelled') return el('div', { class: 'message-meta', text: 'Stopped. This response is incomplete.' });
  if (message.status !== 'failed') return null;
  if (message.error?.code === 'MODEL_STOPPED') {
    return el('div', { class: 'message-recovery' },
      el('span', { text: 'The AI stopped before finishing; select Start it again to continue.' }),
      onRestart ? el('button', { class: 'btn primary', type: 'button', onClick: onRestart, text: 'Start it again' }) : null);
  }
  return el('div', { class: 'message-meta', text: 'This reply ended before completion. Send the message again.' });
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function metricsLine(metrics) {
  if (!metrics) return '';
  const first = Number(metrics.timeToFirstWordMs || 0) / 1000;
  const speed = Number(metrics.wordsPerSecond || 0);
  return `${first.toFixed(1)} sec to first word · ${speed.toFixed(1)} words/sec`;
}

function attachmentList(attachments = []) {
  const files = Array.isArray(attachments) ? attachments : [];
  if (!files.length) return null;
  return el('div', { class: 'message-attachments', 'aria-label': `${files.length} attached file${files.length === 1 ? '' : 's'}` },
    ...files.map(item => el('span', { class: 'message-attachment-chip', title: `${item.name || 'Attached file'} · ${bytes(item.size || 0)}` },
      el('span', { class: 'message-attachment-name', text: String(item.name || 'Attached file') }),
      el('span', { class: 'message-attachment-size numeric muted', text: bytes(item.size || 0) }))));
}

function localDocumentDetails(message) {
  const documents = Array.isArray(message?.documentContext?.documents) ? message.documentContext.documents : [];
  if (!documents.length) return null;
  const chunks = Array.isArray(message?.documentContext?.selection) ? message.documentContext.selection.length : 0;
  return el('details', { class:'local-document-details' },
    el('summary', { text:`Local files · ${documents.length} document${documents.length === 1 ? '' : 's'} · ${chunks} excerpt${chunks === 1 ? '' : 's'}` }),
    el('div', { class:'local-document-list' },
      ...documents.map(item => el('p', {},
        el('strong', { text:String(item.name || 'Local document') }),
        el('span', { class:'muted numeric', text:` · ${Number(item.chunkCount || 0)} indexed sections` })))));
}


function messageActionMenu(message, options, { user, assistant, terminal }) {
  if (!terminal) return null;
  const details = el('details', { class: `message-options accent-${options.accent || 'violet'}` });
  const summary = el('summary', { class: 'message-options-trigger', 'aria-label': 'Message options', title: 'Message options', text: '•••' });
  const menu = el('div', { class: 'message-options-menu', role: 'menu', 'aria-label': 'Message options' });
  const action = (label, run, { active = false, title = '' } = {}) => {
    const button = el('button', { class: `message-option-item ${active ? 'active' : ''}`.trim(), type: 'button', role: 'menuitem', title, text: label });
    button.addEventListener('click', async event => {
      event.preventDefault();
      try { await run?.(); } finally { details.open = false; }
    });
    menu.append(button);
  };
  if (assistant && message.content) action('Copy answer', () => copyText(message.content || ''));
  if (assistant && message.reasoning) action('Copy reasoning', () => copyText(message.reasoning || ''));
  if (terminal && options.onBranch) action('Branch from here', () => options.onBranch(message));
  if (terminal && options.onPin) action(message.pinned ? 'Unpin' : 'Pin', () => options.onPin(message), { active: Boolean(message.pinned) });
  if (assistant && message.executionProfile && options.onReuseSetup) action('Reuse setup', () => options.onReuseSetup(message), { title: 'Restore the prompt and Advanced setup without sending it.' });
  if (assistant && message.work?.kind === 'research') action('Inspect research', () => {
    const section = details.closest('article')?.querySelector('.research-work');
    const drawer = section?.querySelector('.research-work-drawer');
    const toggle = section?.querySelector('.research-work-strip');
    if (drawer && toggle) { drawer.hidden = false; toggle.setAttribute('aria-expanded', 'true'); section.querySelector('[role="tab"][aria-selected="true"]')?.focus({ preventScroll:true }); }
  });
  if (assistant && message.web) action('Inspect Research', () => {
    const inspect = details.closest('article')?.querySelector('.web-input-details');
    if (inspect) { inspect.open = true; inspect.querySelector('summary')?.focus({ preventScroll:true }); }
  });
  if (user && options.lastUserId === message.id && options.onEdit) action('Edit', () => options.onEdit(message));
  else if (user && options.onEditFromHere) action('Edit from here', () => options.onEditFromHere(message));
  if (!menu.childNodes.length) return null;
  details.append(summary, menu);
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    for (const other of document.querySelectorAll('.message-options[open]')) if (other !== details) other.removeAttribute('open');
    const rect = details.getBoundingClientRect?.();
    const viewportHeight = Number(globalThis.innerHeight || document.documentElement?.clientHeight || 0);
    details.classList.toggle('open-down', Boolean(rect && rect.top < Math.min(240, viewportHeight * 0.34)));
    queueMicrotask(() => menu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true }));
  });
  details.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); details.open = false; summary.focus({ preventScroll: true }); }
  });
  return details;
}

function reasoningElapsed(message) {
  const value = Number(message?.reasoningElapsedMs);
  if (!Number.isFinite(value) || value < 0) return '';
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} sec`;
}
function configureReasoningFollow(details) {
  const content = details?.querySelector?.('.reasoning-content');
  if (!content || content.dataset.followBound === 'true') return;
  content.dataset.followBound = 'true'; content.dataset.followReasoning = 'true';
  content.addEventListener('scroll', () => {
    const distance = Math.max(0, content.scrollHeight - content.scrollTop - content.clientHeight);
    content.dataset.followReasoning = String(distance <= 16);
  }, { passive:true });
}
function followReasoning(details) {
  const content = details?.querySelector?.('.reasoning-content');
  if (!content || content.dataset.followReasoning === 'false') return;
  content.scrollTop = content.scrollHeight;
}


function webDetails(message) {
  const web=message?.web;if(!web)return null;
  const inspect=el('details',{class:'web-input-details web-input-details'},
    el('summary',{text:'Research details'}),
    el('dl',{class:'web-input-list'},
      el('dt',{text:'Outbound query'}),el('dd',{},el('code',{text:web.query||''})),
      web.corrections?.length?el('dt',{text:'Normalization'}):null,
      web.corrections?.length?el('dd',{text:web.corrections.map(x=>`${x.from} → ${x.to}`).join(', ')}):null,
      web.discoveryDiagnostics?.length?el('dt',{text:'Discovery'}):null,
      web.discoveryDiagnostics?.length?el('dd',{text:web.discoveryDiagnostics.map(x=>{const transport=Array.isArray(x.transportAttempts)&&x.transportAttempts.length?` [${x.transportAttempts.map(t=>`${t.id}:${t.code}${t.cause?`/${t.cause}`:''}${t.curlExitCode!=null?`#${t.curlExitCode}`:''}`).join(', ')}]`:'';return `${x.adapter}: ${x.outcome}${x.errorCode?` · ${x.errorCode}`:''}${x.causeCode?` (${x.causeCode})`:''}${transport}`;}).join(' | ')}):null,
      el('dt',{text:'Evidence rule'}),el('dd',{text:web.sufficiency?.reason||web.reason||'Waiting for evidence'})));
  if(['planned','pending'].includes(web.status)){
    const label=web.progress==='reading-pages'?'Reading pages':web.progress==='checking-evidence'?'Checking evidence':'Finding sources';
    return el('section',{class:'web-state pending',role:'status'},el('div',{class:'web-state-head'},el('strong',{text:label}),el('span',{class:'web-state-kind',text:'Research'})),inspect);
  }
  if(web.status==='failed')return el('section',{class:'web-state failed',role:'status'},el('div',{class:'web-state-head'},el('strong',{text:'Research evidence was insufficient'}),el('span',{class:'web-state-kind',text:'Research'})),el('p',{class:'web-failure-reason',text:'KL01 did not substitute local model knowledge for missing current evidence.'}),inspect);
  const sources=Array.isArray(web.sources)?web.sources:[];
  return el('section',{class:'web-state success','data-web-sources':String(sources.length)},
    el('div',{class:'web-source-summary'},el('strong',{text:`${sources.length} evidence source${sources.length===1?'':'s'}`})),
    el('div',{class:'web-source-list'},...sources.map(source=>el('article',{class:'web-source-row'},
      el('a',{href:source.url,target:'_blank',rel:'noreferrer noopener',class:'web-source-link','aria-label':`Open evidence source ${source.id||'S'} from ${source.domain||'public source'} in a new tab`,title:'Opens the public source in your browser',text:`[${source.id||'S'}] ${source.title||source.domain||'Public source'}`}),
      el('p',{class:'web-source-meta muted',text:[source.domain,source.mode].filter(Boolean).join(' · ')})))),
    web.support?.status==='unsupported-details'?el('p',{class:'web-support-warning',role:'status',text:'Some answer details were not present in the retrieved evidence.'}):null,inspect);
}


function executionDetails(message) {
  const execution=message.execution;
  if(!execution || (!execution.activeTargetId && !(execution.fallbacks||[]).length && !(execution.events||[]).length && !execution.live)) return null;
  const mode=String(execution.effectiveMode||'sequential').replaceAll('-', ' ');
  const fallbacks=Array.isArray(execution.fallbacks)?execution.fallbacks:[];
  const events=Array.isArray(execution.events)?execution.events:[];
  const summary=[execution.live?.label||null,mode,execution.activeTargetId?`target ${execution.activeTargetId}`:null,fallbacks.length?`${fallbacks.length} fallback${fallbacks.length===1?'':'s'}`:null].filter(Boolean).join(' · ');
  return el('details',{class:'execution-details'},
    el('summary',{},el('span',{text:'Execution'}),el('span',{class:'muted numeric',text:summary})),
    el('div',{class:'execution-event-list'},
      fallbacks.map(item=>el('p',{class:'execution-fallback',role:'status',text:item.message||`${item.requestedTargetId||'Requested target'} → ${item.selectedTargetId||'fallback target'}`})),
      ...events.slice(-12).map(item=>el('div',{class:'execution-event-row'},
        el('span',{class:'execution-event-type',text:String(item.type||'event').replaceAll('-', ' ')}),
        item.message?el('span',{class:'muted',text:item.message}):null,
        item.targetId?el('span',{class:'muted numeric',text:item.targetId}):null))));
}

function reasoningDetails(message) {
  const value = String(message.reasoning || '');
  if (!value) return null;
  const streaming = message.status === 'streaming';
  const collapsed = Boolean(message.content) || !streaming;
  const elapsed = reasoningElapsed(message);
  const details = el('details', { class:`reasoning-details ${streaming ? 'streaming' : 'complete'} ${collapsed ? 'collapsed-reasoning' : ''}`.trim(), open:streaming && !collapsed ? true : null },
    el('summary', { text:collapsed ? `Reasoning${elapsed ? ` · ${elapsed}` : ''}` : 'Reasoning…' }),
    el('div', { class:'reasoning-content', text:value }));
  // Assign the property as well as the attribute. The real browser reflects the
  // boolean attribute, while the deterministic DOM harness intentionally does not.
  // Keeping the property explicit makes the open state testable at the rendered
  // component boundary instead of merely checking source markup.
  if (streaming && !collapsed) details.open = true;
  configureReasoningFollow(details);
  if (streaming && !collapsed) queueMicrotask(() => followReasoning(details));
  return details;
}
function finalAnswerNode(message, { repairable = false } = {}) {
  const content = String(message.content || '');
  if (content) {
    const node = renderMarkdownLite(content, { repairable });
    node.classList.add('answer-content');
    return node;
  }
  if (message.status === 'streaming' && !message.reasoning) {
    if (message.work?.kind === 'research' || message.workflow) return null;
    return el('span', { class: 'message-content answer-content muted', role:'status', text:message.execution?.live?.label || 'Preparing response' });
  }
  if (['complete','completed'].includes(message.status) && message.reasoning) {
    return el('p', { class: 'message-content answer-content muted', text: 'The model finished its reasoning without producing a final answer.' });
  }
  return null;
}

function messageClassName(message, options = {}) {
  const user = message.role === 'user';
  return ['message', user ? 'user' : 'assistant', message.status === 'streaming' ? 'streaming' : '', message.content ? 'has-content' : '', message.reasoning ? 'has-reasoning' : '', options.animate ? 'message-enter' : '', ['cancelled','failed'].includes(message.status) ? 'incomplete' : ''].filter(Boolean).join(' ');
}

export function messageView(message, options = {}) {
  if (message.role === 'marker') return el('div', { class: 'transcript-marker', 'data-message-id': message.id }, el('span', { text: message.content }));
  const user = message.role === 'user';
  const assistant = message.role === 'assistant';
  const thinking = assistant && message.status === 'streaming' && !message.content && message.work?.kind !== 'research';
  const terminal = ['complete', 'completed', 'cancelled', 'failed'].includes(message.status);
  const actions = messageActionMenu(message, options, { user, assistant, terminal });
  const producer = assistant ? (message.producer?.name || message.producer?.model || 'Unknown model') : '';
  const meta = [];
  if (assistant && producer) meta.push(el('span', { class: 'message-producer', text: producer }));
  if (options.showTimes) meta.push(el('span', { class: 'message-time numeric readout', text: formatTime(message.createdAt) }));
  if (assistant && options.showReplySpeed && message.metrics) meta.push(el('span', { class: 'reply-speed numeric readout', text: metricsLine(message.metrics) }));
  const article = el('article', { class: messageClassName(message, options), 'data-message-id': message.id, 'data-accent': options.accent || 'violet', 'data-stream-content': message.status === 'streaming' ? String(message.content || '') : null, tabindex: '0' },
    assistant ? el('span', { class: `assistant-mark ${thinking ? 'thinking' : ''}` }, el('img', { src: '/logos/kl01-favicon.svg', alt: 'KL01' })) : null,
    el('div', { class: 'bubble' },
      user ? attachmentList(message.attachments) : null,
      assistant ? reasoningDetails(message) : null,
      assistant && message.workflow ? workInspector(message, { onResume:options.onResumeRun, onDiscard:options.onDiscardRun, onRetry:options.onRetryWorkflow, onExportDiagnostic:options.onExportDiagnostic }) : null,
      assistant && !message.workflow ? executionDetails(message) : null,
      assistant && !message.workflow ? researchWork(message, { onResume:options.onResumeRun, onDiscard:options.onDiscardRun }) : null,
      assistant ? localDocumentDetails(message) : null,
      finalAnswerNode(message, { repairable: assistant && terminal }),
      assistant ? webDetails(message) : null,
      repairPreview(message, options),
      repairEditor(message, options),
      revisionControls(message, options),
      statusBlock(message, options.onRestart),
      meta.length ? el('div', { class: 'message-meta' }, ...meta) : null,
      assistant && message.computed && Array.isArray(message.computed.steps) && message.computed.steps.length
        ? el('details', { class: 'computed-details' }, el('summary', { text: 'Computed' }), el('div', { class: 'computed-details-list' }, ...message.computed.steps.map(step => el('p', { text: step }))))
        : null,
      actions));
  if (assistant && terminal && !message.repairPreview && !options.repairBusy) installRepairSelection(article, message, options.onRepairSelect);
  return article;
}

function syncAssistantMark(current, next, { moveIntoNext = false } = {}) {
  const currentMark = current.querySelector('.assistant-mark');
  const nextMark = next.querySelector('.assistant-mark');
  if (!currentMark || !nextMark) return currentMark || null;
  const wasThinking = currentMark.classList.contains('thinking');
  const willThink = nextMark.classList.contains('thinking');
  currentMark.className = nextMark.className;
  if (wasThinking && !willThink) {
    // First token is the hard stop signal: remove the looping class synchronously.
    currentMark.classList.remove('thinking');
  }
  if (moveIntoNext) nextMark.replaceWith(currentMark);
  return currentMark;
}

function patchStreamingContent(current, message) {
  const bubble = current.querySelector('.bubble');
  if (!bubble) return false;
  let contentNode = bubble.querySelector('.answer-content');
  const nextText = String(message.content || '');
  const previousText = String(current.getAttribute('data-stream-content') || '');
  const structuredWork = message.work?.kind === 'research' || Boolean(message.workflow);
  if (!nextText) {
    if (structuredWork) contentNode?.remove();
    else {
      const label = message.execution?.live?.label || 'Preparing response';
      if (!contentNode) {
        contentNode = el('span', { class: 'message-content answer-content muted', role:'status', text:label });
        bubble.insertBefore(contentNode, bubble.firstChild || null);
      } else {
        contentNode.className = 'message-content answer-content muted';
        contentNode.setAttribute('role', 'status');
        contentNode.textContent = label;
      }
    }
    current.setAttribute('data-stream-content', '');
    return true;
  }
  if (!contentNode || contentNode.classList.contains('muted')) {
    const first = el('div', { class: 'message-content answer-content', text: nextText });
    if (contentNode) contentNode.replaceWith(first); else bubble.insertBefore(first, bubble.firstChild || null);
    contentNode = first;
    current.classList.add('first-token');
    queueMicrotask(() => current?.isConnected && current.classList.remove('first-token'));
  } else if (nextText.startsWith(previousText)) {
    const delta = nextText.slice(previousText.length);
    if (delta) contentNode.append(document.createTextNode(delta));
  } else if (contentNode.textContent !== nextText) {
    contentNode.textContent = nextText;
  }
  current.setAttribute('data-stream-content', nextText);
  return true;
}




function patchStreamingWorkInspector(current, message, options = {}) {
  const bubble=current.querySelector('.bubble');if(!bubble)return false;
  const existing=bubble.querySelector('.work-inspector');
  if(!message.workflow){existing?.remove();return true;}
  const drawer=existing?.querySelector('.work-inspector-drawer');const restoreOpen=Boolean(drawer&&!drawer.hidden);const restoreTab=existing?.dataset?.workTab||'Work';
  const next=workInspector(message,{restoreOpen,restoreTab,onResume:options.onResumeRun,onDiscard:options.onDiscardRun,onRetry:options.onRetryWorkflow,onExportDiagnostic:options.onExportDiagnostic});
  if(existing)existing.replaceWith(next);else{const reasoning=bubble.querySelector('.reasoning-details');if(reasoning)reasoning.after(next);else bubble.insertBefore(next,bubble.firstChild||null);}return true;
}

function patchStreamingResearch(current, message, options = {}) {
  const bubble = current.querySelector('.bubble');
  if (!bubble) return false;
  const existing = bubble.querySelector('.research-work');
  const drawer = existing?.querySelector('.research-work-drawer');
  const restoreOpen = Boolean(drawer && !drawer.hidden);
  const restoreTab = existing?.dataset?.researchTab || 'Live';
  const next = researchWork(message, { restoreOpen, restoreTab, onResume:options.onResumeRun, onDiscard:options.onDiscardRun });
  if (!next) { existing?.remove(); return true; }
  if (existing) existing.replaceWith(next);
  else {
    const workflow = bubble.querySelector('.workflow-details');
    const reasoning = bubble.querySelector('.reasoning-details');
    if (workflow) workflow.after(next);
    else if (reasoning) reasoning.after(next);
    else bubble.insertBefore(next, bubble.firstChild || null);
  }
  return true;
}


function patchStreamingWeb(current, message) {
  const bubble=current.querySelector('.bubble');if(!bubble)return false;
  const existing=bubble.querySelector('.web-state');const next=webDetails(message);
  if(!next){existing?.remove();return true;} if(existing)existing.replaceWith(next); else {const answer=bubble.querySelector('.answer-content');if(answer)answer.after(next);else bubble.append(next);} return true;
}


function patchStreamingExecution(current, message) {
  const bubble=current.querySelector('.bubble'); if(!bubble)return false;
  const existing=bubble.querySelector('.execution-details'); const next=executionDetails(message);
  if(!next){existing?.remove();return true;} if(existing)existing.replaceWith(next); else {const reasoning=bubble.querySelector('.reasoning-details'); if(reasoning)reasoning.after(next); else bubble.insertBefore(next,bubble.firstChild||null);} return true;
}


function patchStreamingReasoning(current, message) {
  const bubble = current.querySelector('.bubble');
  if (!bubble) return false;
  const nextText = String(message.reasoning || '');
  let details = bubble.querySelector('.reasoning-details');
  if (!nextText) { details?.remove(); current.removeAttribute('data-stream-reasoning'); return true; }
  const collapsed = Boolean(message.content);
  if (!details) {
    details = reasoningDetails({ ...message, status:'streaming' });
    bubble.insertBefore(details, bubble.firstChild || null);
    current.setAttribute('data-stream-reasoning', nextText);
    return true;
  }
  details.className = `reasoning-details streaming ${collapsed ? 'collapsed-reasoning' : ''}`.trim();
  details.open = !collapsed;
  const summary = details.querySelector('summary');
  if (summary) summary.textContent = collapsed ? `Reasoning${reasoningElapsed(message) ? ` · ${reasoningElapsed(message)}` : ''}` : 'Reasoning…';
  const content = details.querySelector('.reasoning-content');
  configureReasoningFollow(details);
  const previous = String(current.getAttribute('data-stream-reasoning') || '');
  if (nextText.startsWith(previous)) {
    const delta = nextText.slice(previous.length);
    if (delta) content.append(document.createTextNode(delta));
  } else if (content.textContent !== nextText) content.textContent = nextText;
  if (!collapsed) followReasoning(details);
  current.setAttribute('data-stream-reasoning', nextText);
  return true;
}
export function updateMessageNode(container, message, options = {}) {
  const selector = `[data-message-id="${CSS.escape(message.id)}"]`;
  const current = container.querySelector(selector);
  if (!current) return false;

  if (message.status === 'streaming') {
    // Streaming is an in-place patch path. Do not call messageView(): that would re-parse the
    // accumulated message on every token even if the replacement DOM were later discarded.
    current.className = messageClassName(message, { ...options, animate: false });
    current.setAttribute('tabindex', '0');
    if (message.role === 'assistant') {
      const mark = current.querySelector('.assistant-mark');
      if (mark) {
        const firstRealText = Boolean(message.content);
        const structuredWork = message.work?.kind === 'research' || Boolean(message.workflow);
        mark.className = `assistant-mark ${firstRealText || structuredWork ? '' : 'thinking'}`.trim();
        if (firstRealText) mark.classList.remove('thinking');
      }
    }
    patchStreamingReasoning(current, message);
    patchStreamingWorkInspector(current, message, options);
    if (!message.workflow) { patchStreamingExecution(current, message); patchStreamingResearch(current, message, options); }
    patchStreamingWeb(current, message);
    patchStreamingContent(current, message);
    return true;
  }

  const next = messageView(message, options);
  const assistantPair = current.classList.contains('assistant') && next.classList.contains('assistant');
  if (assistantPair) syncAssistantMark(current, next, { moveIntoNext: true });
  current.className = next.className;
  current.setAttribute('tabindex', next.getAttribute('tabindex') || '0');
  // Terminal/cancel/failure parses once, while preserving the article and starburst identity.
  current.replaceChildren(...next.childNodes);
  current.removeAttribute('data-stream-content');
  current.removeAttribute('data-stream-reasoning');
  return true;
}
