import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CHAT_INDEX_FILE,
  CHATS_DIR,
  DATA_DIR,
  SETTINGS_FILE,
  SNAPSHOTS_DIR,
} from '../lib/paths.js';
import { log } from '../lib/log.js';
import { readJson, writeJson } from './store.js';

const MIGRATION_VERSION = 2;
const MIGRATIONS_DIR = path.join(DATA_DIR, 'migrations');
const MARKER_FILE = path.join(MIGRATIONS_DIR, `clean-gut-v${MIGRATION_VERSION}.json`);
const OLD_ARCHIVE_DIR = path.join(DATA_DIR, 'legacy-removed-features');
const OBSOLETE_PATHS = [
  path.join(DATA_DIR, 'about-you.json'),
  path.join(DATA_DIR, 'memory-proposals.json'),
  path.join(DATA_DIR, 'documents'),
  path.join(DATA_DIR, 'lookup-cache'),
  OLD_ARCHIVE_DIR,
  path.join(DATA_DIR, 'almanac.json'),
  path.join(DATA_DIR, 'voices.json'),
  path.join(DATA_DIR, 'konda-engine.json'),
];
const REMOVED_KEYS = new Set([
  'memoryCandidates', 'memoryUsed', 'voiceId', 'voice', 'voiceFailure', 'voiceSourceContent',
  'checkWork', 'reasoningDepth', 'reasoningAskWhenMatters', 'reasoningShowWorkingAtRun',
  'reasoningProgress', 'reasoningResult', 'socratic', 'repairCheck',
  'lookup', 'lookupDecision',
]);

const now = () => new Date().toISOString();

async function exists(target) {
  try { await fs.access(target); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function removeObsoletePath(target) {
  if (!(await exists(target))) return null;
  const relative = path.relative(DATA_DIR, target) || path.basename(target);
  await fs.rm(target, { recursive: true, force: true });
  return relative;
}

function scrubValue(value) {
  if (Array.isArray(value)) return value.map(scrubValue);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  const hiddenPartial = typeof value.voiceSourceContent === 'string' ? value.voiceSourceContent : '';
  for (const [key, child] of Object.entries(value)) {
    if (REMOVED_KEYS.has(key)) continue;
    output[key] = scrubValue(child);
  }
  if (value.role === 'user' && typeof value.content === 'string' && !Array.isArray(value.attachments)) output.modelContent = value.content;
  else if (value.role === 'user' && typeof value.content === 'string' && Array.isArray(value.attachments) && !value.attachments.length) output.modelContent = value.content;
  else if (value.role === 'user' && typeof value.content === 'string' && typeof output.modelContent !== 'string') output.modelContent = value.content;
  if (value.role === 'assistant' && !String(output.content || '') && hiddenPartial) output.content = hiddenPartial;
  if (value.status === 'waiting-for-user') {
    output.status = 'cancelled';
    output.error = { code:'LEGACY_TURN_CLOSED', message:'This unfinished response was closed during the upgrade. Send the message again to continue.' };
  }
  if (output.repairPreview && typeof output.repairPreview === 'object') {
    const { voiceId: _removedVoiceId, ...preview } = output.repairPreview;
    output.repairPreview = preview;
  }
  return output;
}

async function scrubJsonFile(file) {
  let raw;
  try { raw = await readJson(file, null); }
  catch (error) {
    await log.warn('migration.clean-gut-skip-damaged-json', { file:path.relative(DATA_DIR, file), code:error?.code || error?.name || 'UNKNOWN' });
    return { changed:false, skipped:true };
  }
  if (raw == null) return { changed:false, skipped:false };
  const scrubbed = scrubValue(raw);
  if (JSON.stringify(raw) === JSON.stringify(scrubbed)) return { changed:false, skipped:false };
  await writeJson(file, scrubbed);
  return { changed:true, skipped:false };
}

async function jsonFilesUnder(directory) {
  const output=[];
  async function walk(current) {
    let entries=[];
    try { entries=await fs.readdir(current,{withFileTypes:true}); }
    catch(error){ if(error?.code==='ENOENT') return; throw error; }
    for(const entry of entries){
      const target=path.join(current,entry.name);
      if(entry.isDirectory()) await walk(target);
      else if(entry.isFile() && entry.name.endsWith('.json')) output.push(target);
    }
  }
  await walk(directory);
  return output;
}

async function scrubSettings() {
  let settings;
  try { settings = await readJson(SETTINGS_FILE, null); }
  catch (error) {
    const backup = `${SETTINGS_FILE}.corrupt-${Date.now()}`;
    await fs.rename(SETTINGS_FILE, backup);
    await writeJson(SETTINGS_FILE, { version:10 });
    await log.warn('migration.clean-gut-recovered-damaged-settings', { backup:path.relative(DATA_DIR, backup), code:error?.code || error?.name || 'UNKNOWN' });
    return { changed:true, skipped:true };
  }
  if (!settings) return { changed:false, skipped:false };
  const { lookup:_lookup, memory:_memory, reasoning:_reasoning, ...kept } = settings;
  const next = { ...kept, version:Math.max(10, Number(kept.version) || 0) };
  if (JSON.stringify(settings) === JSON.stringify(next)) return { changed:false, skipped:false };
  await writeJson(SETTINGS_FILE, next);
  return { changed:true, skipped:false };
}

export async function migrateRemovedFeatures() {
  if (await exists(MARKER_FILE)) return { migrated:false, version:MIGRATION_VERSION };
  await fs.mkdir(MIGRATIONS_DIR,{recursive:true});

  const removed=[];
  for(const target of OBSOLETE_PATHS){
    const item=await removeObsoletePath(target);
    if(item) removed.push(item);
  }

  let chatsChanged=0;
  let snapshotsChanged=0;
  let skippedDamaged=0;
  for(const file of await jsonFilesUnder(CHATS_DIR)){
    if(file===CHAT_INDEX_FILE) continue;
    const result=await scrubJsonFile(file);
    if(result.changed) chatsChanged += 1;
    if(result.skipped) skippedDamaged += 1;
  }
  for(const file of await jsonFilesUnder(SNAPSHOTS_DIR)){
    const result=await scrubJsonFile(file);
    if(result.changed) snapshotsChanged += 1;
    if(result.skipped) skippedDamaged += 1;
  }
  const settingsResult=await scrubSettings();
  if(settingsResult.skipped) skippedDamaged += 1;

  const result={ migrated:true, version:MIGRATION_VERSION, completedAt:now(), removed, chatsChanged, snapshotsChanged, settingsChanged:settingsResult.changed, skippedDamaged };
  await writeJson(MARKER_FILE,result);
  await log.info('migration.clean-gut-complete',result);
  return result;
}
