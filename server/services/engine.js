import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { LLAMA_BINARY_NAME, LLAMA_RELEASE_TAG, LLAMA_WINDOWS_ASSET, LLAMA_WINDOWS_URL, LLAMA_WINDOWS_SIZE, LLAMA_WINDOWS_SHA256, DOWNLOAD_HEADROOM_BYTES, USER_AGENT } from '../config.js';
import { RUNTIME_DIR, SETTINGS_FILE, downloadPart, downloadMeta } from '../lib/paths.js';
import { readJson, writeJson, updateJson } from './store.js';
import { inspectMachine } from './machine.js';
import { extractZipTree, readZipEntries } from '../lib/zip.js';
import { fail } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { DEFAULT_SETTINGS } from './preferences.js';

const ENGINE_ID = `kl01-${LLAMA_RELEASE_TAG}-win-x64`;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 8;

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function peLooksValid(file) {
  let handle;
  try { handle = await fs.open(file, 'r'); } catch { return false; }
  try {
    const head = Buffer.alloc(64);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead < 64 || head.toString('ascii', 0, 2) !== 'MZ') return false;
    const peOffset = head.readUInt32LE(0x3c);
    const signature = Buffer.alloc(4);
    const read = await handle.read(signature, 0, 4, peOffset);
    return read.bytesRead === 4 && signature.equals(Buffer.from([0x50, 0x45, 0x00, 0x00]));
  } finally { await handle.close(); }
}

async function nativeBinaryLooksValid(file, platform) {
  let handle;
  try {
    await fs.access(file, fs.constants.X_OK);
    handle = await fs.open(file, 'r');
  } catch { return false; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return false;
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead !== 4) return false;
    if (platform === 'linux') return head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    if (platform === 'darwin') return new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca']).has(head.toString('hex'));
    return false;
  } finally { await handle.close(); }
}

async function listFiles(directory) {
  const out = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await walk(directory);
  return out;
}

async function snapshotEngine(directory = RUNTIME_DIR, binaryName = LLAMA_BINARY_NAME) {
  const binary = path.join(directory, binaryName);
  if (!(await peLooksValid(binary))) return null;
  const files = await listFiles(directory);
  const dlls = files.filter(file => file.toLowerCase().endsWith('.dll'));
  if (!dlls.length) return null;
  const records = [];
  for (const file of files) {
    const stat = await fs.stat(file);
    records.push({ name: path.relative(directory, file).replaceAll('\\', '/'), size: stat.size, sha256: await sha256(file) });
  }
  return { tag: LLAMA_RELEASE_TAG, asset: LLAMA_WINDOWS_ASSET, files: records.sort((a, b) => a.name.localeCompare(b.name)) };
}

async function recordEngine(snapshot, archiveHash = null) {
  await updateJson(SETTINGS_FILE, DEFAULT_SETTINGS, settings => ({ ...DEFAULT_SETTINGS, ...settings, engine: { ...snapshot, archiveHash, recordedAt: new Date().toISOString() } }));
}

async function verifyRecorded(directory = RUNTIME_DIR, binaryName = LLAMA_BINARY_NAME) {
  const settings = await readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
  const record = settings.engine;
  if (!record || record.tag !== LLAMA_RELEASE_TAG || !Array.isArray(record.files) || !record.files.length) return false;
  for (const item of record.files) {
    const file = path.join(directory, ...String(item.name).split('/'));
    let stat;
    try { stat = await fs.stat(file); } catch { return false; }
    if (!stat.isFile() || stat.size !== item.size || await sha256(file) !== item.sha256) return false;
  }
  return peLooksValid(path.join(directory, binaryName));
}

async function fetchManual(url, { headers, signal }) {
  let current = new URL(url);
  for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
    let response;
    try { response = await fetch(current, { headers, signal, redirect: 'manual' }); }
    catch (error) { if (signal?.aborted) throw error; throw fail('DOWNLOAD_NETWORK', 'The connection was interrupted; wait while KL01 retries from the saved position.', 503, undefined, error); }
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location || count === MAX_REDIRECTS) throw fail('ENGINE_DOWNLOAD', 'The download could not finish; try again.', 502);
    current = new URL(location, current);
    if (current.protocol !== 'https:' && current.hostname !== '127.0.0.1') throw fail('ENGINE_DOWNLOAD', 'The download could not finish; try again.', 502);
  }
  throw fail('ENGINE_DOWNLOAD', 'The download could not finish; try again.', 502);
}

function contentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(value || ''));
  return match ? { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) } : null;
}

async function downloadArchive({ signal, url = LLAMA_WINDOWS_URL, expectedSize = LLAMA_WINDOWS_SIZE, expectedHash = LLAMA_WINDOWS_SHA256, onProgress = null } = {}) {
  const part = downloadPart(ENGINE_ID);
  const metaFile = downloadMeta(ENGINE_ID);
  let offset = 0;
  try { offset = (await fs.stat(part)).size; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const headers = { 'user-agent': USER_AGENT };
  if (offset) headers.Range = `bytes=${offset}-`;
  let response = await fetchManual(url, { headers, signal });
  if (offset && response.status === 200) {
    await response.body?.cancel().catch(() => {});
    await fs.rm(part, { force: true });
    offset = 0;
    response = await fetchManual(url, { headers: { 'user-agent': USER_AGENT }, signal });
    await log.warn('engine.download-restarted', { reason: 'source rejected saved position' });
  }
  let total;
  if (offset) {
    if (response.status !== 206) throw fail('ENGINE_DOWNLOAD', 'The download could not resume; try again.', 502);
    const range = contentRange(response.headers.get('content-range'));
    if (!range || range.start !== offset) throw fail('ENGINE_DOWNLOAD', 'The download could not resume; try again.', 502);
    total = range.total;
  } else {
    if (response.status !== 200) throw fail('ENGINE_DOWNLOAD', 'The download could not finish; try again.', 502);
    total = Number(response.headers.get('content-length'));
  }
  if (!Number.isSafeInteger(total) || total <= 0) throw fail('ENGINE_DOWNLOAD', 'The download could not finish; try again.', 502);
  if (Number.isSafeInteger(expectedSize) && expectedSize > 0 && total !== expectedSize) {
    await response.body?.cancel().catch(() => {});
    await fs.rm(part, { force: true });
    await fs.rm(metaFile, { force: true });
    throw fail('ENGINE_INTEGRITY', 'The runtime download did not match this KL01 release and was rejected.', 502, { expectedSize, observedSize: total });
  }
  const machine = await inspectMachine();
  if (machine.diskAvailable && machine.diskAvailable < (total - offset) + DOWNLOAD_HEADROOM_BYTES) throw fail('DISK_SPACE', 'There is not enough free space for this download; free space, then try again.', 409, { needed: total - offset + DOWNLOAD_HEADROOM_BYTES, available: machine.diskAvailable });
  await writeJson(metaFile, { url, total, bytesReceived: offset });
  onProgress?.({ bytesReceived: offset, totalBytes: total, speed: 0 });
  const handle = await fs.open(part, offset ? 'a' : 'w');
  let lastBytes = offset;
  let lastTime = Date.now();
  try {
    for await (const chunk of response.body) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await handle.write(chunk);
      offset += chunk.length;
      const now = Date.now();
      const elapsed = Math.max(1, now - lastTime);
      const speed = Math.round((offset - lastBytes) / (elapsed / 1000));
      await writeJson(metaFile, { url, total, bytesReceived: offset });
      onProgress?.({ bytesReceived: offset, totalBytes: total, speed });
      lastBytes = offset;
      lastTime = now;
    }
  } finally { await handle.close(); }
  if (offset !== total) throw fail('DOWNLOAD_NETWORK', 'The connection was interrupted; wait while KL01 retries from the saved position.', 503);
  const hash = await sha256(part);
  if (!/^[a-f0-9]{64}$/u.test(String(expectedHash || '')) || hash !== String(expectedHash).toLowerCase()) {
    await fs.rm(part, { force: true });
    await fs.rm(metaFile, { force: true });
    throw fail('ENGINE_INTEGRITY', 'The runtime download failed its release integrity check and was deleted.', 502, { expectedHash: String(expectedHash || '').slice(0,64), observedHash: hash });
  }
  return { file: part, metaFile, hash, total };
}

async function installArchive(archive, { destination = RUNTIME_DIR, binaryName = LLAMA_BINARY_NAME } = {}) {
  const { entries } = await readZipEntries(archive);
  if (!entries.some(entry => path.posix.basename(entry.name).toLowerCase() === binaryName.toLowerCase())) throw fail('ENGINE_ARCHIVE', 'The download could not be checked; try again.', 422);
  const temp = `${destination}.install-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  await fs.rm(temp, { recursive: true, force: true });
  try {
    await extractZipTree(archive, temp, { anchorFile: binaryName });
    const snapshot = await snapshotEngine(temp, binaryName);
    if (!snapshot) throw fail('ENGINE_ARCHIVE', 'The download could not be checked; try again.', 422);
    await fs.mkdir(destination, { recursive: true });
    for (const file of await listFiles(temp)) {
      const relative = path.relative(temp, file);
      const target = path.join(destination, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(file, target);
    }
    return snapshotEngine(destination, binaryName);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

export function createEngineService({ platform = process.platform, arch = process.arch, assetUrl = LLAMA_WINDOWS_URL, assetSize = LLAMA_WINDOWS_SIZE, assetHash = LLAMA_WINDOWS_SHA256, assumePresent = false, runtimeDir = RUNTIME_DIR, binaryName = platform === 'win32' ? 'llama-server.exe' : LLAMA_BINARY_NAME } = {}) {
  async function present() {
    if (assumePresent) return true;
    if (platform === 'win32' && arch === 'x64') {
      if (await verifyRecorded(runtimeDir, binaryName)) return true;
      const snapshot = await snapshotEngine(runtimeDir, binaryName);
      if (!snapshot) return false;
      await recordEngine(snapshot, null);
      return true;
    }
    if (platform === 'linux' && arch === 'x64') return nativeBinaryLooksValid(path.join(runtimeDir, binaryName), platform);
    if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return nativeBinaryLooksValid(path.join(runtimeDir, binaryName), platform);
    return false;
  }
  async function capability() {
    const isPresent = await present();
    return { present: isPresent, canAcquire: isPresent || (platform === 'win32' && arch === 'x64'), platform, arch };
  }
  async function ensure({ signal, onProgress = null } = {}) {
    if (assumePresent || await present()) return { present: true, downloaded: false };
    if (platform !== 'win32' || arch !== 'x64') throw fail('ENGINE_PLATFORM', 'Local AI downloads are not available on this computer; add an AI file or open Advanced to use an external service.', 409);
    const archive = await downloadArchive({ signal, url: assetUrl, expectedSize:assetSize, expectedHash:assetHash, onProgress });
    const snapshot = await installArchive(archive.file, { destination: runtimeDir, binaryName });
    await recordEngine(snapshot, archive.hash);
    await fs.rm(archive.file, { force: true });
    await fs.rm(archive.metaFile, { force: true });
    return { present: true, downloaded: true, bytes: archive.total };
  }
  return { present, capability, ensure, installArchive, snapshot: () => snapshotEngine(runtimeDir, binaryName) };
}

export const engineInternals = { peLooksValid, nativeBinaryLooksValid, snapshotEngine, downloadArchive, installArchive };
