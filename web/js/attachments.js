export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 12 * 1024 * 1024;

export function extensionForName(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/u);
  return match?.[1] || '';
}

export function acceptedFileAttribute(fileTypes = []) {
  return [...new Set(fileTypes.map(item => `.${String(item).replace(/^\./u, '').toLowerCase()}`))].join(',');
}

export function fileTypeLabel(value) {
  const type = String(value || '').replace(/^\./u, '').toUpperCase();
  return type || 'FILE';
}

export async function readTextAttachments(files, allowedFileTypes = []) {
  const selected = [...(files || [])];
  const allowed = new Set(allowedFileTypes.map(item => String(item).replace(/^\./u, '').toLowerCase()));
  if (!selected.length) return [];
  if (selected.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new Error(`Attach no more than ${MAX_ATTACHMENTS_PER_MESSAGE} files to one message.`);
  const result = [];
  let total = 0;
  for (const file of selected) {
    const name = String(file?.name || 'Attached file');
    const extension = extensionForName(name);
    if (!allowed.has(extension)) throw new Error(`${name} is not supported by the selected AI.`);
    if (Number(file?.size || 0) > MAX_ATTACHMENT_BYTES) throw new Error(`${name} is too large; keep each text file under 8 MB.`);
    const text = String(await file.text()).replace(/^\uFEFF/u, '');
    if (!text || text.includes('\u0000')) throw new Error(`${name} does not appear to be a non-empty plain-text file.`);
    const measured = new TextEncoder().encode(text).byteLength;
    if (measured > MAX_ATTACHMENT_BYTES) throw new Error(`${name} is too large; keep each text file under 8 MB.`);
    total += measured;
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES) throw new Error('The attached files are too large together; keep the total under 12 MB.');
    result.push({
      clientId: `pending-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name,
      extension,
      type: String(file?.type || 'text/plain'),
      size: measured,
      text,
      kind: 'text',
    });
  }
  return result;
}
