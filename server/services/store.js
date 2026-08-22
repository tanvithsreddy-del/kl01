import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const queues = new Map();
const TRANSIENT_FILE_CODES = new Set(['EBUSY','EACCES','EPERM','EEXIST','ENOTEMPTY']);

export async function retryTransientFileOperation(operation) {
  const waits=[0,12,35,80,180,350]; let last;
  for(const wait of waits){if(wait)await delay(wait);try{return await operation();}catch(error){last=error;if(!TRANSIENT_FILE_CODES.has(error?.code))throw error;}}
  throw last;
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

export async function readJsonRecovering(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback);
    if (!(error instanceof SyntaxError)) throw error;
    const backup = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, backup);
    await writeJson(file, fallback);
    return structuredClone(fallback);
  }
}

async function syncDirectory(directory) {
  // File fsync + atomic rename is the durability contract. Directory fsync adds
  // protection for sudden power loss on filesystems that support it, but some
  // Windows/filesystem combinations do not permit opening directories as files.
  let handle;
  try { handle = await fs.open(directory, 'r'); await handle.sync(); }
  catch (error) {
    if (!['EINVAL','ENOTSUP','EPERM','EACCES','EISDIR','EBADF'].includes(error?.code)) throw error;
  } finally { await handle?.close().catch(() => {}); }
}

export async function writeJson(file, value) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let handle;
  let renamed = false;
  try {
    handle = await fs.open(temp, 'w', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await retryTransientFileOperation(() => fs.rename(temp, file)); renamed = true;
    await syncDirectory(directory);
    return value;
  } catch (error) {
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await fs.rm(temp, { force: true }).catch(() => {});
  }
}

export function updateJson(file, fallback, mutator) {
  const previous = queues.get(file) || Promise.resolve();
  const next = previous.then(async () => {
    const current = await readJson(file, fallback);
    const updated = await mutator(structuredClone(current));
    return writeJson(file, updated);
  });
  // Keep a failed write from poisoning later independent attempts; the caller of
  // this update still receives the original rejection and must handle it.
  queues.set(file, next.catch(() => {}));
  return next;
}
