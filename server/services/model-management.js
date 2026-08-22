import { loadCatalogue } from './catalogue.js';
import * as installed from './installed.js';
import * as downloads from './download.js';
import { inspectMachine, classifyModelsForMachine } from './machine.js';
import { normalizedModelEntry, TEXT_FILE_TYPES } from './model-capabilities.js';
import { DOWNLOAD_HEADROOM_BYTES } from '../config.js';
import { log } from '../lib/log.js';

function publicModel({ path, hash, ...record }) {
  return { ...record, licence: record.licence || 'unknown' };
}

function sideloadDefaults(record) {
  return normalizedModelEntry({
    ...record,
    kind: 'sideload',
    name: record.displayName || record.id,
    description: 'Added from this computer.',
    plainDescription: 'Added from this computer.',
    providerId: 'local-file',
    providerName: 'Local file',
    family: record.displayName || 'Custom GGUF',
    filename: record.displayName || record.id,
    provenance: 'User-sideloaded GGUF',
    licence: record.licence || 'unknown',
    capabilities: { inputModalities: ['text'], tasks: ['general'], fileTypes: TEXT_FILE_TYPES },
  });
}

export function createModelManagementService({ runtime, engine = null, selection = null, governor = null, runtimePool = null }) {
  const pendingRemovals = new Set();
  let removalChain = Promise.resolve();
  let removalRetryTimer = null;
  let removalRetryDelay = 750;
  function scheduleRemovalRetry(){
    if(removalRetryTimer || !pendingRemovals.size) return;
    removalRetryTimer=setTimeout(()=>{removalRetryTimer=null;removalChain=removalChain.then(finalizePending,finalizePending);},removalRetryDelay);
    removalRetryTimer.unref?.();
    removalRetryDelay=Math.min(10000,Math.round(removalRetryDelay*1.8));
  }
  async function finalizePending() {
    let progressed=false;
    for (const id of [...pendingRemovals]) {
      if (Number(governor?.reservationCount?.(`local:${id}`) || 0) > 0) continue;
      try {
        const stopped=await runtimePool?.unloadTarget?.(`local:${id}`);
        if(stopped && !stopped.unloaded && !['not-loaded','stopped','failed'].includes(stopped.reason)) continue;
        await installed.uninstall(id);
        pendingRemovals.delete(id);progressed=true;
      } catch(error) {
        await log.warn('model.pending-removal-retry', { id, code:error?.code||error?.name||'UNKNOWN' });
      }
    }
    if(progressed) removalRetryDelay=750;
    if(pendingRemovals.size) scheduleRemovalRetry();
  }
  const unsubscribeGovernor = governor?.subscribe?.(() => { removalChain = removalChain.then(finalizePending, finalizePending); });
  async function init(){const records=await installed.listInstalled();for(const record of records)if(record.pendingRemoval)pendingRemovals.add(record.id);await finalizePending();return{pendingRemovals:[...pendingRemovals]};}
  async function catalogue() {
    const [loaded, machine, engineState] = await Promise.all([
      loadCatalogue(),
      inspectMachine(),
      engine?.capability?.() || Promise.resolve({ present: true, canAcquire: true }),
    ]);
    const classified = classifyModelsForMachine(loaded.entries, machine);
    const entries = classified.map(entry => {
      const needed = Number(entry.size || 0) + DOWNLOAD_HEADROOM_BYTES;
      const spaceBlocked = Boolean(machine.diskAvailable && machine.diskAvailable < needed);
      const engineBlocked = !engineState.canAcquire;
      const memoryBlocked = !entry.machineFit.canRunNow;
      const canDownload = !spaceBlocked && !engineBlocked && Boolean(entry.resolvedDownloadUrl || entry.downloadUrl);
      const canRun = !memoryBlocked && (engineState.present || engineState.canAcquire);
      return {
        ...entry,
        availability: {
          canUse: canDownload && canRun,
          canDownload,
          canRun,
          canActivate: canRun,
          engineBlocked,
          memoryBlocked,
          spaceBlocked,
          neededBytes: needed,
          freeBytes: machine.diskAvailable,
          memoryAvailableBytes: machine.memoryAvailable,
          memoryNeededBytes: entry.machineFit.memoryNeededBytes,
        },
      };
    });
    return {
      ...loaded,
      entries,
      machine: {
        ...machine,
        localSetupAvailable: engineState.canAcquire,
      },
    };
  }

  async function installedState() {
    const [records, settings, catalogueState] = await Promise.all([
      installed.listInstalled(), installed.getSettings(), loadCatalogue(),
    ]);
    const byId = new Map(catalogueState.entries.map(entry => [entry.id, entry]));
    const models = records.map(record => {
      const source = byId.get(record.id);
      const merged = source
        ? { ...source, ...record, displayName: record.displayName || source.modelName || source.name, licence: record.licence || source.licence || 'unknown' }
        : { ...sideloadDefaults(record), ...record, displayName: record.displayName || record.id };
      return publicModel(merged);
    });
    return { models, settings };
  }

  async function sideload(path) { return publicModel(await installed.sideload(path)); }
  async function act(id, action) {
    if (action === 'activate') return selection ? selection.activateLocal(id) : runtime.activate(id);
    if (action === 'download') return downloads.startDownload(id, { prerequisite: engine ? options => engine.ensure(options) : null });
    if (action === 'pause') return downloads.pauseDownload(id);
    if (action === 'resume') return downloads.startDownload(id, { prerequisite: engine ? options => engine.ensure(options) : null });
    if (action === 'cancel') return downloads.cancelDownload(id);
    throw new Error(`Unknown model action: ${action}`);
  }

  async function uninstallModel(id) {
    const defer=async(code=null)=>{
      await installed.markPendingRemoval(id,true);
      pendingRemovals.add(id);scheduleRemovalRetry();
      return { removed:null,pendingRemoval:id,status:'pending-removal',reason:code||null };
    };
    if (Number(governor?.reservationCount?.(`local:${id}`) || 0) > 0) {
      if (selection?.deselectLocal) await selection.deselectLocal(id).catch(()=>{});
      return defer('MODEL_RESERVED');
    }
    try {
      if (selection?.deselectLocal) await selection.deselectLocal(id);
      const stopped=await runtimePool?.unloadTarget?.(`local:${id}`);
      if(stopped && !stopped.unloaded && !['not-loaded','stopped','failed'].includes(stopped.reason)) return defer(`RUNTIME_${String(stopped.reason||'BUSY').toUpperCase().replace(/[^A-Z0-9]+/g,'_')}`);
      return await installed.uninstall(id);
    } catch(error) {
      await log.warn('model.uninstall-deferred', { id, code:error?.code||error?.name||'UNKNOWN' });
      return defer(error?.code||error?.name||'MODEL_UNINSTALL_RETRY');
    }
  }

  return {
    catalogue,
    installedState,
    sideload,
    act,
    getDownload: downloads.getDownload,
    subscribeDownload: downloads.subscribeDownload,
    uninstall: uninstallModel,
    init,
    close: () => { unsubscribeGovernor?.(); clearTimeout(removalRetryTimer); removalRetryTimer=null; },
    pendingRemovals: () => [...pendingRemovals],
  };
}
