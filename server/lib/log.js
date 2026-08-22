import fs from 'node:fs/promises';
import { LOGS_DIR, logFile } from './paths.js';

async function write(level, event, detail = {}) {
  const record = { time: new Date().toISOString(), level, event, ...detail };
  const line = `${JSON.stringify(record)}
`;
  try {
    await fs.mkdir(LOGS_DIR, { recursive: true });
    await fs.appendFile(logFile(), line, 'utf8');
  } catch {}
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  console[method](`[${record.time}] ${event}`, detail);
  return record;
}
export const log = Object.freeze({
  info: (event, detail) => write('info', event, detail),
  warn: (event, detail) => write('warn', event, detail),
  error: (event, detail) => write('error', event, detail),
});
