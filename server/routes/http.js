import { MAX_REQUEST_BYTES } from '../config.js';
import { publicError, normalizeError } from '../lib/errors.js';

export async function readJsonBody(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE', publicMessage: 'This request is too large; keep it under 15 MB and try again.', status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON'), { code:'INVALID_JSON', publicMessage:'KL01 could not read this request; reload the app, then retry.', status:400 }); }
}
export function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}
`;
  response.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'content-length':Buffer.byteLength(body), 'cache-control':'no-store', 'x-content-type-options':'nosniff' });
  response.end(body);
}
export function sendError(response, error) {
  const normalized = normalizeError(error);
  sendJson(response, normalized.status || 500, { error: publicError(normalized) });
}

export function sendText(response, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  const value = String(body ?? '');
  response.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(value), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  response.end(value);
}
