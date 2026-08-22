import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 512;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 768 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 300;

function requireRange(buffer, offset, length, message = 'ZIP record is truncated') {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) throw new Error(message);
}

function findEocd(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) return offset;
  }
  throw new Error('ZIP end record not found');
}

export async function readZipEntries(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARCHIVE_BYTES) throw new Error('ZIP archive size is unsafe');
  const buffer = await fs.readFile(file);
  const eocd = findEocd(buffer);
  requireRange(buffer, eocd, 22, 'ZIP end record is truncated');
  const count = buffer.readUInt16LE(eocd + 10);
  if (!count || count > MAX_ENTRIES) throw new Error('ZIP entry count is unsafe');
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  let expandedBytes = 0;
  for (let index = 0; index < count; index += 1) {
    requireRange(buffer, offset, 46, 'ZIP central directory is truncated');
    if (buffer.readUInt32LE(offset) !== CENTRAL) throw new Error('ZIP central directory is invalid');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    requireRange(buffer, offset, recordLength, 'ZIP central directory entry is truncated');
    if (size > MAX_ENTRY_BYTES) throw new Error('ZIP entry is too large');
    expandedBytes += size;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('ZIP expanded size is unsafe');
    if (size > 0 && compressedSize === 0) throw new Error('ZIP entry compression is invalid');
    if (compressedSize > 0 && size / compressedSize > MAX_COMPRESSION_RATIO) throw new Error('ZIP compression ratio is unsafe');
    requireRange(buffer, localOffset, 30, 'ZIP local record is truncated');
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replaceAll('\\', '/');
    entries.push({ name, method, compressedSize, size, localOffset });
    offset += recordLength;
  }
  return { buffer, entries };
}

function decodeEntry(buffer, entry) {
  const offset = entry.localOffset;
  requireRange(buffer, offset, 30, 'ZIP local header is truncated');
  if (buffer.readUInt32LE(offset) !== LOCAL) throw new Error('ZIP local header is invalid');
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  requireRange(buffer, start, entry.compressedSize, 'ZIP compressed entry is truncated');
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new Error(`Unsupported ZIP compression method ${entry.method}`);
}

export const zipLimits = Object.freeze({ MAX_ARCHIVE_BYTES, MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_EXPANDED_BYTES, MAX_COMPRESSION_RATIO });

export async function extractZipTree(file, destination, { anchorFile = null } = {}) {
  const { buffer, entries } = await readZipEntries(file);
  let prefix = '';
  if (anchorFile) {
    const anchor = entries.find(entry => path.posix.basename(entry.name).toLowerCase() === anchorFile.toLowerCase());
    if (!anchor) throw new Error(`${anchorFile} is missing from archive`);
    prefix = path.posix.dirname(anchor.name);
    if (prefix === '.') prefix = '';
  }
  await fs.mkdir(destination, { recursive: true });
  const written = [];
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    let relative = entry.name;
    if (prefix) {
      if (!relative.startsWith(`${prefix}/`)) continue;
      relative = relative.slice(prefix.length + 1);
    }
    const normalized = path.posix.normalize(relative);
    if (!normalized || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) throw new Error('ZIP path is unsafe');
    const target = path.join(destination, ...normalized.split('/'));
    const resolved = path.resolve(target);
    const root = `${path.resolve(destination)}${path.sep}`;
    if (!resolved.startsWith(root)) throw new Error('ZIP path escapes destination');
    const data = decodeEntry(buffer, entry);
    if (data.length !== entry.size) throw new Error('ZIP entry size mismatch');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    written.push(target);
  }
  return written;
}
