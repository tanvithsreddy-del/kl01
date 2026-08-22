import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createKL01Server } from './server/app.js';
import { requiredDataDirs } from './server/lib/paths.js';

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (![20, 22].includes(major)) throw new Error(`KL01 requires Node.js 20 or 22. Found ${process.version}.`);
}
function openBrowser(url) {
  if (process.env.KL01_NO_BROWSER === '1') return;
  const command = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}
export async function start() {
  checkNode();
  await Promise.all(requiredDataDirs.map(dir => fs.mkdir(dir, { recursive: true })));
  const explicitPort = process.env.KL01_PORT !== undefined && process.env.KL01_PORT !== '';
  const requestedPort = Number(explicitPort ? process.env.KL01_PORT : 3210);
  let app;
  try {
    app = await createKL01Server({ port: requestedPort });
  } catch (error) {
    if (explicitPort || error?.code !== 'EADDRINUSE') throw error;
    app = await createKL01Server({ port: 0 });
  }
  console.log(`KL01 is running at ${app.url}`);
  openBrowser(app.url);
  return app;
}
function isMainModule() {
  if (!process.argv[1]) return false;
  const here = path.resolve(fileURLToPath(import.meta.url));
  const invoked = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? here.toLowerCase() === invoked.toLowerCase() : here === invoked;
}
if (isMainModule()) {
  let app = null;
  let closing = false;
  const shutdown = async signal => {
    if (closing) return;
    closing = true;
    try { await app?.close?.(); }
    catch (error) { console.error(error.message); }
    process.exitCode = signal === 'SIGINT' ? 130 : 0;
  };
  start().then(started => {
    app = started;
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
