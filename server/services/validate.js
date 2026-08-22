import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import { fail } from '../lib/errors.js';

const ALLOWED_TYPES = new Set(['application/octet-stream','binary/octet-stream','application/x-gguf','application/gguf','']);
export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve,reject) => {
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}
export async function validateModelFile({ file, contentType = '', expectedSize = null, expectedHash = null }) {
  const normalizedType = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.has(normalizedType)) throw fail('MODEL_CONTENT_TYPE', 'The download was not a supported AI file; retry the download or choose another file from this computer.', 422);
  let handle;
  try { handle = await fs.open(file, 'r'); } catch (error) {
    throw fail('MODEL_FILE_MISSING', 'The AI file could not be opened; choose it again.', 404, undefined, error);
  }
  const header = Buffer.alloc(4);
  try { await handle.read(header, 0, 4, 0); } finally { await handle.close(); }
  if (header.toString('ascii') !== 'GGUF') throw fail('MODEL_HEADER', 'The selected file is not a supported AI file; choose a different file.', 422);
  const stat = await fs.stat(file);
  if (expectedSize != null && stat.size !== expectedSize) {
    throw fail('MODEL_SIZE', 'The download did not arrive intact; retry the download or choose a file from this computer.', 422, { expectedSize, observedSize: stat.size });
  }
  const hash = await sha256File(file);
  if (expectedHash && hash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw fail('MODEL_HASH', 'The download did not arrive intact; retry the download or choose a file from this computer.', 422);
  }
  return { size: stat.size, hash };
}
