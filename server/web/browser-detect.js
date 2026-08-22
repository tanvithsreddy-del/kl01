import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const WINDOWS_CANDIDATES = [
  ['edge','Microsoft Edge',['ProgramFiles(x86)','ProgramFiles','LOCALAPPDATA'],'Microsoft/Edge/Application/msedge.exe'],
  ['chrome','Google Chrome',['ProgramFiles','ProgramFiles(x86)','LOCALAPPDATA'],'Google/Chrome/Application/chrome.exe'],
  ['brave','Brave',['ProgramFiles','ProgramFiles(x86)','LOCALAPPDATA'],'BraveSoftware/Brave-Browser/Application/brave.exe'],
  ['chromium','Chromium',['LOCALAPPDATA','ProgramFiles','ProgramFiles(x86)'],'Chromium/Application/chrome.exe'],
];
const LINUX_NAMES = [
  ['edge','Microsoft Edge','microsoft-edge'], ['edge','Microsoft Edge','microsoft-edge-stable'],
  ['chrome','Google Chrome','google-chrome'], ['chrome','Google Chrome','google-chrome-stable'],
  ['brave','Brave','brave-browser'], ['brave','Brave','brave-browser-stable'],
  ['chromium','Chromium','chromium'], ['chromium','Chromium','chromium-browser'],
];
const MAC_CANDIDATES = [
  ['edge','Microsoft Edge','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ['chrome','Google Chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['brave','Brave','/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  ['chromium','Chromium','/Applications/Chromium.app/Contents/MacOS/Chromium'],
];

async function executable(file) {
  try { await fs.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return true; }
  catch { return false; }
}

async function canonical(file) {
  try { return await fs.realpath(file); } catch { return path.resolve(file); }
}

function candidateId(vendor, file) {
  return `${vendor}-${crypto.createHash('sha256').update(String(file).toLowerCase()).digest('hex').slice(0, 12)}`;
}

function pathEntries(env = process.env) {
  return String(env.PATH || '').split(path.delimiter).filter(Boolean);
}

export async function detectBrowsers({ platform = process.platform, env = process.env, home = os.homedir(), preferredId = null } = {}) {
  const raw=[];
  if (platform === 'win32') {
    for (const [vendor,name,roots,relative] of WINDOWS_CANDIDATES) {
      for (const rootKey of roots) {
        const root = env[rootKey]; if (!root) continue;
        raw.push({ vendor, name, path:path.join(root, ...relative.split('/')), source:`env:${rootKey}` });
      }
    }
    for (const [vendor,name,exe] of [['edge','Microsoft Edge','msedge.exe'],['chrome','Google Chrome','chrome.exe'],['brave','Brave','brave.exe'],['chromium','Chromium','chromium.exe']]) {
      for (const dir of pathEntries(env)) raw.push({ vendor,name,path:path.join(dir,exe),source:'PATH' });
    }
  } else if (platform === 'darwin') {
    for (const [vendor,name,file] of MAC_CANDIDATES) raw.push({ vendor,name,path:file,source:'standard' });
    raw.push({ vendor:'chrome', name:'Google Chrome', path:path.join(home,'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), source:'home' });
  } else {
    for (const [vendor,name,exe] of LINUX_NAMES) {
      for (const dir of pathEntries(env)) raw.push({ vendor,name,path:path.join(dir,exe),source:'PATH' });
      for (const dir of ['/usr/bin','/usr/local/bin','/opt/google/chrome','/opt/microsoft/msedge']) raw.push({ vendor,name,path:path.join(dir,exe),source:'standard' });
    }
  }
  const out=[]; const seen=new Set();
  for (const item of raw) {
    if (!(await executable(item.path))) continue;
    const file=await canonical(item.path); const key=platform === 'win32' ? file.toLowerCase() : file;
    if (seen.has(key)) continue; seen.add(key);
    out.push({ id:candidateId(item.vendor,file), vendor:item.vendor, name:item.name, path:file, source:item.source });
  }
  const vendorRank = platform === 'win32' ? ['edge','chrome','brave','chromium'] : ['chrome','chromium','brave','edge'];
  out.sort((a,b) => (a.id === preferredId ? -100 : b.id === preferredId ? 100 : vendorRank.indexOf(a.vendor)-vendorRank.indexOf(b.vendor)) || a.path.localeCompare(b.path));
  return out;
}
