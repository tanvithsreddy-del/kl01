import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { DOWNLOAD_HEADROOM_BYTES, DOWNLOAD_BACKOFF_MS, USER_AGENT } from '../config.js';
import { downloadPart, downloadMeta, DOWNLOADS_DIR } from '../lib/paths.js';
import { getCatalogueEntry } from './catalogue.js';
import { inspectMachine } from './machine.js';
import { installValidated } from './installed.js';
import { writeJson, readJson } from './store.js';
import { fail, publicError, KL01Error } from '../lib/errors.js';
import { log } from '../lib/log.js';

const jobs = new Map();
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 8;

function publicJob(job) {
  const prefixActive = job.prerequisiteRunning || (job.prerequisiteComplete && job.prerequisiteTotal > 0);
  const totalBytes = prefixActive ? job.prerequisiteTotal + job.totalBytes : job.totalBytes;
  const bytesReceived = job.prerequisiteRunning
    ? job.prerequisiteBytes
    : prefixActive
      ? job.prerequisiteTotal + job.bytesReceived
      : job.bytesReceived;
  const remaining = Math.max(0, totalBytes - bytesReceived);
  const etaSeconds = job.speed > 0 ? Math.ceil(remaining / job.speed) : null;
  return {
    id: job.id,
    state: job.state,
    bytesReceived,
    totalBytes,
    speed: job.speed,
    etaSeconds,
    nextAttemptAt: job.nextAttemptAt,
    restartReason: job.restartReason,
    error: job.error,
  };
}

function getOrCreate(id) {
  if (!jobs.has(id)) {
    jobs.set(id, {
      id,
      state: 'idle',
      bytesReceived: 0,
      totalBytes: 0,
      speed: 0,
      nextAttemptAt: null,
      restartReason: null,
      error: null,
      emitter: new EventEmitter(),
      controller: null,
      pauseRequested: false,
      cancelRequested: false,
      promise: null,
      wakeBackoff: null,
      prerequisiteRunning: false,
      prerequisiteComplete: false,
      prerequisiteBytes: 0,
      prerequisiteTotal: 0,
      lastEmittedSignature: null,
    });
  }
  return jobs.get(id);
}

function emit(job, { force = false } = {}) {
  const value = publicJob(job);
  const signature = JSON.stringify(value);
  if (!force && signature === job.lastEmittedSignature) return false;
  job.lastEmittedSignature = signature;
  job.emitter.emit('progress', value);
  return true;
}

function parsePositiveInteger(value) {
  if (!/^\d+$/.test(String(value || ''))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(value || '').trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return null;
  return { start, end, total };
}

function parseUnsatisfiedRange(value) {
  const match = /^bytes \*\/(\d+)$/.exec(String(value || '').trim());
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

async function fetchStep(url, { headers, signal }) {
  try {
    return await fetch(url, { headers, signal, redirect: 'manual' });
  } catch (error) {
    if (signal.aborted) throw error;
    throw fail('DOWNLOAD_NETWORK', 'The connection was interrupted; wait while KL01 retries from the saved position.', 503, undefined, error);
  }
}

async function fetchWithRedirects(url, { headers, signal }) {
  let current = new URL(url);
  for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
    const response = await fetchStep(current, { headers, signal });
    if (!REDIRECT_CODES.has(response.status)) return { response, url: current.toString(), redirects: count };
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location) throw fail('DOWNLOAD_REDIRECT', 'The AI source returned an invalid redirect; try again later or choose another AI.', 502);
    if (count === MAX_REDIRECTS) throw fail('DOWNLOAD_REDIRECT', 'The AI source redirected too many times; try again later or choose another AI.', 502);
    current = new URL(location, current);
    if (current.protocol !== 'https:') throw fail('DOWNLOAD_REDIRECT', 'The AI source redirected to an unsafe address; choose another AI.', 502);
    // The same headers object is intentionally reused so Range survives every redirect.
  }
  throw fail('DOWNLOAD_REDIRECT', 'The AI source redirected too many times; try again later or choose another AI.', 502);
}

async function checkpoint(metaFile, entryUrl, entry, job, serverTotalBytes) {
  try {
    await writeJson(metaFile, {
      url: entryUrl,
      catalogueSize: entry.size,
      serverTotalBytes,
      bytesReceived: job.bytesReceived,
      resumeMethod: 'part-file-length',
    });
  } catch (error) {
    if (error instanceof KL01Error && error.code === 'DOWNLOAD_CHECKPOINT') throw error;
    throw fail('DOWNLOAD_CHECKPOINT', 'KL01 could not save download recovery state. Check disk access or free space, then retry.', 507, { id: entry.id, causeCode: error?.code || error?.name || null }, error);
  }
}

async function announceRestart(job, reason) {
  job.state = 'restarting';
  job.restartReason = `The download could not be resumed and will start again. ${reason}`;
  job.error = null;
  emit(job);
  await log.warn('download.restart-from-zero', { id: job.id, reason });
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function resetPart(job, part, metaFile, entryUrl, entry, reason) {
  await announceRestart(job, reason);
  await fs.rm(part, { force: true });
  job.bytesReceived = 0;
  job.totalBytes = entry.size;
  await checkpoint(metaFile, entryUrl, entry, job, null);
}

async function checkDiskForResponse(remainingBytes) {
  const machine = await inspectMachine();
  const required = remainingBytes + DOWNLOAD_HEADROOM_BYTES;
  if (machine.diskAvailable && machine.diskAvailable < required) {
    throw fail('DISK_SPACE', 'There is not enough free space for this AI; free space, then retry.', 409, { needed: required, available: machine.diskAvailable });
  }
}

async function openResponse({ entry, entryUrl, job, offset, part, metaFile }) {
  const headers = { 'user-agent': USER_AGENT };
  if (offset) headers.Range = `bytes=${offset}-`;
  let result = await fetchWithRedirects(entryUrl, { headers, signal: job.controller.signal });
  let { response } = result;

  if (offset && response.status === 416) {
    const total = parseUnsatisfiedRange(response.headers.get('content-range'));
    await response.body?.cancel().catch(() => {});
    if (total === offset) return { response: null, offset, serverTotalBytes: total, contentType: '' };
    throw fail('DOWNLOAD_RESUME', 'The saved download no longer matches its source; discard it, then start again.', 409);
  }

  if (offset && response.status === 200) {
    await response.body?.cancel().catch(() => {});
    await resetPart(job, part, metaFile, entryUrl, entry, 'The source did not accept the saved position.');
    offset = 0;
    const freshHeaders = { 'user-agent': USER_AGENT };
    result = await fetchWithRedirects(entryUrl, { headers: freshHeaders, signal: job.controller.signal });
    response = result.response;
  }

  if (offset) {
    if (response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      throw fail('DOWNLOAD_RESUME', `The source returned HTTP ${response.status} instead of a resumable response; discard the saved download or retry later.`, 409);
    }
    const range = parseContentRange(response.headers.get('content-range'));
    if (!range || range.start !== offset) {
      await response.body?.cancel().catch(() => {});
      throw fail('DOWNLOAD_RESUME', 'The source returned a different resume position; discard the saved download or retry later.', 409);
    }
    const responseLength = parsePositiveInteger(response.headers.get('content-length'));
    if (responseLength == null || responseLength !== range.end - range.start + 1) {
      await response.body?.cancel().catch(() => {});
      throw fail('DOWNLOAD_LENGTH', 'The AI source returned inconsistent size information; try again later or choose another AI.', 502);
    }
    return { response, offset, serverTotalBytes: range.total, contentType: response.headers.get('content-type') || '' };
  }

  if (!response.ok) {
    const status = response.status;
    await response.body?.cancel().catch(() => {});
    throw fail('DOWNLOAD_HTTP', `The AI source returned HTTP ${status}; try again later or choose another AI.`, 502, { status });
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw fail('DOWNLOAD_HTTP', `The AI source returned HTTP ${response.status}; try again later or choose another AI.`, 502, { status: response.status });
  }
  const serverTotalBytes = parsePositiveInteger(response.headers.get('content-length'));
  if (serverTotalBytes == null || serverTotalBytes <= 0) {
    await response.body?.cancel().catch(() => {});
    throw fail('DOWNLOAD_LENGTH', 'The AI source did not state the file size; try again later or choose another AI.', 502);
  }
  return { response, offset: 0, serverTotalBytes, contentType: response.headers.get('content-type') || '' };
}

async function transfer(job, entry) {
  const part = downloadPart(entry.id);
  const metaFile = downloadMeta(entry.id);
  const entryUrl = entry.resolvedDownloadUrl || entry.downloadUrl;
  const saved = await readJson(metaFile, null);
  let offset = 0;
  try { offset = (await fs.stat(part)).size; } catch (error) { if (error?.code !== 'ENOENT') throw error; }

  if (offset && (!saved || saved.url !== entryUrl)) {
    await resetPart(job, part, metaFile, entryUrl, entry, saved ? 'The model source changed since the previous attempt.' : 'The saved download record is missing.');
    offset = 0;
  } else if (saved && saved.bytesReceived !== offset) {
    await log.warn('download.metadata-offset-corrected', { id: entry.id, recordedBytes: saved.bytesReceived, partBytes: offset });
  }

  job.bytesReceived = offset;
  job.totalBytes = saved?.serverTotalBytes || entry.size;
  job.state = 'downloading';
  job.restartReason = null;
  job.error = null;
  job.speed = 0;
  emit(job);
  job.controller = new AbortController();

  let opened;
  try {
    opened = await openResponse({ entry, entryUrl, job, offset, part, metaFile });
  } catch (error) {
    if (job.pauseRequested || job.cancelRequested) throw error;
    throw error;
  }

  const serverTotalBytes = opened.serverTotalBytes;
  offset = opened.offset;
  job.bytesReceived = offset;
  job.totalBytes = serverTotalBytes;
  if (serverTotalBytes !== entry.size) {
    await opened.response?.body?.cancel().catch(() => {});
    await fs.rm(part, { force: true });
    await fs.rm(metaFile, { force: true });
    throw fail('DOWNLOAD_INTEGRITY', 'The AI download did not match this KL01 release and was rejected.', 502, { expectedSize: entry.size, observedSize: serverTotalBytes });
  }
  await checkDiskForResponse(Math.max(0, serverTotalBytes - offset));
  await checkpoint(metaFile, entryUrl, entry, job, serverTotalBytes);
  emit(job);

  if (opened.response) {
    let handle;
    const started = Date.now();
    let lastBytes = offset;
    let lastTime = started;
    try {
      handle = await fs.open(part, offset ? 'a' : 'w');
      try {
        for await (const chunk of opened.response.body) {
          if (job.pauseRequested || job.cancelRequested) { job.controller.abort(); break; }
          try { await handle.write(chunk); }
          catch (error) {
            throw fail('DISK_WRITE', 'The AI could not be saved; check free space, then retry.', 507, undefined, error);
          }
          job.bytesReceived += chunk.length;
          const now = Date.now();
          if (now - lastTime >= 400) {
            job.speed = Math.round((job.bytesReceived - lastBytes) / ((now - lastTime) / 1000));
            lastBytes = job.bytesReceived;
            lastTime = now;
            await checkpoint(metaFile, entryUrl, entry, job, serverTotalBytes);
            emit(job);
          }
        }
      } catch (error) {
        if (job.pauseRequested || job.cancelRequested) throw error;
        if (error instanceof KL01Error) throw error;
        throw fail('DOWNLOAD_NETWORK', 'The connection was interrupted; wait while KL01 retries from the saved position.', 503, undefined, error);
      }
    } finally {
      await handle?.close().catch(() => {});
      // The part file is the source of truth after a crash or socket drop.
      try { job.bytesReceived = (await fs.stat(part)).size; } catch {}
      await checkpoint(metaFile, entryUrl, entry, job, serverTotalBytes).catch(error => log.warn('download.checkpoint-final-failed', { id:entry.id, code:error?.code||error?.name||'UNKNOWN' }));
    }
  }

  if (job.cancelRequested) {
    await fs.rm(part, { force: true });
    await fs.rm(metaFile, { force: true });
    job.state = 'cancelled';
    job.bytesReceived = 0;
    job.totalBytes = 0;
    job.prerequisiteRunning = false;
    job.prerequisiteComplete = false;
    job.prerequisiteBytes = 0;
    job.prerequisiteTotal = 0;
    emit(job);
    return;
  }
  if (job.pauseRequested) { job.state = 'paused'; emit(job); return; }

  if (job.bytesReceived < serverTotalBytes) {
    throw fail('DOWNLOAD_NETWORK', 'The connection ended before the file arrived; wait while KL01 retries from the saved position.', 503);
  }
  if (job.bytesReceived > serverTotalBytes) {
    throw fail('DOWNLOAD_SIZE', 'The AI source sent more data than it declared; discard the saved download or choose another AI.', 502, { declared: serverTotalBytes, observed: job.bytesReceived });
  }

  job.state = 'checking';
  emit(job);
  const record = await installValidated({
    id: entry.id,
    source: part,
    expectedSize: entry.size,
    expectedHash: entry.sha256,
    contentType: opened.contentType,
    displayName: entry.name,
    contextSize: entry.contextSize,
    sourceType: 'download',
    licence: entry.licence || 'unknown',
  });
  await fs.rm(part, { force: true });
  await fs.rm(metaFile, { force: true });
  job.state = 'completed';
  job.error = null;
  job.restartReason = null;
  emit(job);
  return record;
}

async function waitForRetry(job, delay) {
  await new Promise(resolve => {
    const timer = setTimeout(resolve, delay);
    job.wakeBackoff = () => { clearTimeout(timer); resolve(); };
  });
  job.wakeBackoff = null;
}

async function run(job, entry, prerequisite = null) {
  let attempt = 0;
  let prerequisiteComplete = false;
  while (!job.cancelRequested && !job.pauseRequested) {
    try {
      if (prerequisite && !prerequisiteComplete) {
        job.state = 'downloading';
        job.bytesReceived = 0;
        job.totalBytes = entry.size;
        job.speed = 0;
        job.error = null;
        job.prerequisiteRunning = true;
        emit(job);
        job.controller = new AbortController();
        await prerequisite({
          signal: job.controller.signal,
          onProgress: progress => {
            job.prerequisiteBytes = Number(progress?.bytesReceived || 0);
            job.prerequisiteTotal = Number(progress?.totalBytes || 0);
            job.speed = Number(progress?.speed || 0);
            emit(job);
          },
        });
        job.controller = null;
        job.prerequisiteRunning = false;
        job.prerequisiteComplete = true;
        prerequisiteComplete = true;
        if (job.pauseRequested || job.cancelRequested) throw new DOMException('Aborted', 'AbortError');
      }
      return await transfer(job, entry);
    }
    catch (error) {
      if (job.cancelRequested) {
        await fs.rm(downloadPart(entry.id), { force: true });
        await fs.rm(downloadMeta(entry.id), { force: true });
        job.state = 'cancelled';
        job.bytesReceived = 0;
        job.totalBytes = 0;
        job.prerequisiteRunning = false;
        job.prerequisiteComplete = false;
        job.prerequisiteBytes = 0;
        job.prerequisiteTotal = 0;
        job.error = null;
        emit(job);
        return;
      }
      if (job.pauseRequested) { job.state = 'paused'; job.error = null; emit(job); return; }
      if (error?.code !== 'DOWNLOAD_NETWORK') throw error;
      const delay = DOWNLOAD_BACKOFF_MS[Math.min(attempt++, DOWNLOAD_BACKOFF_MS.length - 1)];
      job.state = 'waiting';
      job.nextAttemptAt = new Date(Date.now() + delay).toISOString();
      job.error = publicError(error);
      emit(job);
      await waitForRetry(job, delay);
      job.nextAttemptAt = null;
    }
  }
}

export async function startDownload(id, { prerequisite = null } = {}) {
  const entry = await getCatalogueEntry(id);
  const machine = await inspectMachine();
  const required = entry.size + DOWNLOAD_HEADROOM_BYTES;
  if (machine.diskAvailable && machine.diskAvailable < required) {
    throw fail('DISK_SPACE', 'There is not enough free space for this AI; free space, then retry.', 409, { needed: required, available: machine.diskAvailable });
  }
  const job = getOrCreate(id);
  if (job.promise && ['downloading','checking','waiting','restarting'].includes(job.state)) return publicJob(job);
  job.pauseRequested = false;
  job.cancelRequested = false;
  job.nextAttemptAt = null;
  job.restartReason = null;
  job.promise = run(job, entry, prerequisite)
    .catch(error => { job.state = 'failed'; job.error = publicError(error); emit(job); })
    .finally(() => { job.promise = null; job.controller = null; job.wakeBackoff = null; });
  return publicJob(job);
}

export async function pauseDownload(id) {
  const job = getOrCreate(id);
  job.pauseRequested = true;
  job.controller?.abort();
  job.wakeBackoff?.();
  return publicJob(job);
}
export async function resumeDownload(id) { return startDownload(id); }
export async function cancelDownload(id) {
  const job = getOrCreate(id);
  job.cancelRequested = true;
  job.controller?.abort();
  job.wakeBackoff?.();
  return publicJob(job);
}
export function getDownload(id) { return publicJob(getOrCreate(id)); }
export function subscribeDownload(id, listener) {
  const job = getOrCreate(id);
  job.emitter.on('progress', listener);
  listener(publicJob(job));
  return () => job.emitter.off('progress', listener);
}
export async function restoreDownloads() {
  let names = [];
  try { names = await fs.readdir(DOWNLOADS_DIR); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  let restored = 0;
  for (const name of names.filter(value => value.endsWith('.part.json'))) {
    const id = name.slice(0, -'.part.json'.length);
    const meta = await readJson(downloadMeta(id), null);
    if (!meta) continue;
    let bytesReceived = 0;
    try { bytesReceived = (await fs.stat(downloadPart(id))).size; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (!bytesReceived) continue;
    const job = getOrCreate(id);
    job.state = 'paused';
    job.bytesReceived = bytesReceived;
    job.totalBytes = meta.serverTotalBytes || meta.catalogueSize || meta.expectedSize || bytesReceived;
    job.error = null;
    restored += 1;
  }
  return restored;
}
