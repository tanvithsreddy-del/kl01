import fs from 'node:fs/promises';
import { HOST, DEFAULT_PORT } from './config.js';
import { requiredDataDirs, DATA_DIR, RUNTIME_DIR, WEB_DIR } from './lib/paths.js';
import { log } from './lib/log.js';
import { healthRoute } from './routes/health.js';
import { machineRoute } from './routes/machine.js';
import { modelsRoute } from './routes/models.js';
import { runtimeRoute } from './routes/runtime.js';
import { chatsRoute } from './routes/chats.js';
import { messagesRoute } from './routes/messages.js';
import { servicesRoute } from './routes/services.js';
import { settingsRoute } from './routes/settings.js';
import { modesRoute } from './routes/modes.js';
import { recipesRoute } from './routes/recipes.js';
import { compressionRoute } from './routes/compression.js';
import { repairRoute } from './routes/repair.js';
import { createHttpServer } from './index.js';
import { createRuntimeService } from './services/runtime.js';
import { createEngineService } from './services/engine.js';
import { createInferenceService } from './services/inference.js';
import { createContextService } from './services/context.js';
import { createMessageFlow } from './services/message-flow.js';
import { createModelSelectionService } from './services/model-selection.js';
import { createModelManagementService } from './services/model-management.js';
import { recoverInterrupted, reconcileChatIndex } from './services/chats.js';
import { loadCatalogue } from './services/catalogue.js';
import { restoreDownloads } from './services/download.js';
import { listInstalled, getSettings, selectStartupModel } from './services/installed.js';
import * as externalServices from './services/services.js';
import { createSnapshotService } from './services/snapshots.js';
import { createContextAccessService } from './services/context-access.js';
import { createCompressionService } from './services/compression.js';
import { createStructuredService } from './services/structured.js';
import { createRepairService } from './services/repair.js';
import { migrateRemovedFeatures } from './services/legacy-feature-migration.js';
import * as preferences from './services/preferences.js';
import { createWebService } from './web/service.js';
import { createDiscoveryService } from './web/discovery.js';
import { createRunCoordinator } from './services/run-coordinator.js';
import { createTargetExecutor } from './research/target-executor.js';
import { createResearchService } from './research/research-service.js';
import { createRuntimePool } from './execution/runtime-pool.js';
import { createResourceGovernor } from './execution/resource-governor.js';
import { createProcessRegistry } from './execution/process-registry.js';
import { createTargetRegistry } from './execution/target-registry.js';
import { createTargetManager } from './execution/target-manager.js';
import { createExecutionScheduler } from './execution/scheduler.js';
import { executionRoute } from './routes/execution.js';
import { diagnosticsRoute } from './routes/diagnostics.js';
import { migrateRecipes } from './services/recipes.js';
import { createDocumentLibrary } from './services/document-library.js';

export async function createKL01Server({ port = DEFAULT_PORT, host = HOST, runtimeAdapter = null, webService = null, discoveryService = null, researchService = null } = {}) {
  await Promise.all(requiredDataDirs.map(directory => fs.mkdir(directory, { recursive: true })));
  // K8 Settings v13 owns the Settings-file migration boundary. Run it before
  // older feature cleanup so a read/commit failure cannot be masked by legacy
  // damaged-Settings recovery that would replace the authoritative file.
  const researchSettingsMigration = await preferences.migrateSettingsV13();
  const featureMigration = await migrateRemovedFeatures();
  const recipeMigration = await migrateRecipes();
  const serviceIdentityMigration = await externalServices.migrateServiceIdentities();
  const reconciledChats = await reconcileChatIndex();
  const catalogue = await loadCatalogue({ refresh: true });
  const resumable = await restoreDownloads();
  const engine = createEngineService({ assumePresent: Boolean(runtimeAdapter) });
  const runtime = createRuntimeService({ adapter: runtimeAdapter, engine, persistSelection: true, runtimeId: 'interactive' });
  const runtimePool = createRuntimePool({
    primaryRuntime: runtime,
    createRuntime: runtimeAdapter && !runtimeAdapter.createChild ? null : async runtimeId => createRuntimeService({ adapter: runtimeAdapter?.createChild ? await runtimeAdapter.createChild(runtimeId) : null, engine, persistSelection: false, runtimeId }),
  });
  const processRegistry = createProcessRegistry({ runtimePool });
  const governor = createResourceGovernor({ runtimePool, processRegistry });
  const registry = createTargetRegistry({ runtimePool, governor });
  const targetManager = createTargetManager({ registry, governor, runtimePool });
  const inference = createInferenceService({ targetManager });
  const selection = createModelSelectionService({ runtime, governor });
  const context = createContextService({ inference });
  const snapshots = createSnapshotService();
  const access = createContextAccessService({ snapshots });
  const structured = createStructuredService({ inference, targetManager });
  const compression = createCompressionService({ inference, snapshots, access, structured });
  const documents = createDocumentLibrary();
  const repair = createRepairService({ structured, snapshots, compression });
  const models = createModelManagementService({ runtime, engine, selection, governor, runtimePool });
  await models.init?.();
  const scheduler = createExecutionScheduler({ targetManager });
  const web = webService || createWebService({ preferences });
  const discovery = discoveryService || createDiscoveryService({ web, preferences });
  const coordinator = createRunCoordinator();
  const targetExecutor = createTargetExecutor({ inference, targetManager, emit:(runId,stageId,type,payload)=>{ const current=runId&&coordinator.get(runId); if(current) coordinator.publish(runId,type,{ messageId:current.assistantMessageId||null, ...payload },{stageId,targetRef:payload?.targetId||payload?.selectedTargetId||null,fallback:type==='target-fallback'?payload:null}); }, commitFallback:async(runId,artifact)=>{ const committed=await coordinator.commitArtifact(runId,artifact); const current=coordinator.get(runId); if(current){const existing=(current.fallbacks||[]).filter(item=>item.artifactId!==artifact.artifactId); coordinator.attach(runId,{fallbacks:[...existing,{...structuredClone(artifact.payload||{}),artifactId:artifact.artifactId}]});} return committed;} });
  const research = researchService || createResearchService({ web, discovery, preferences, targetExecutor, coordinator });
  const flow = createMessageFlow({ context, inference, access, compression, preferences, documents, web, research, coordinator, targetManager, governor, scheduler });
  const recoveredWorkRuns = await flow.init();
  const resumableRunIds = new Set(recoveredWorkRuns.filter(item => item?.runId && !['corrupt','expired','completed','cancelled','failed'].includes(item.status || item.state)).map(item => item.runId));
  const recovered = await recoverInterrupted({ resumableRunIds });
  const routes = [
    healthRoute(), machineRoute(), modelsRoute({ models, selection, targetManager, governor }), runtimeRoute({ runtime, selection }),
    chatsRoute({ access, flow, snapshots, documents }), messagesRoute({ flow }), executionRoute({ targetManager, governor, runtimePool }), diagnosticsRoute({ preferences, targetManager, governor, flow }), repairRoute({ repair }),
    compressionRoute({ compression }), servicesRoute({ selection }), settingsRoute(), modesRoute({ targetManager, governor, preferences }), recipesRoute(),
  ];
  const server = await createHttpServer({
    routes, port, host,
    onError: error => log.error('request.failed', { code: error?.code || error?.name }),
  });
  const address = server.address();
  let startupActivation = Promise.resolve();
  const [startupSettings, startupInstalled] = await Promise.all([getSettings(), listInstalled()]);
  const startupModel = startupSettings.activeServiceId ? null : selectStartupModel(startupInstalled, startupSettings);
  if (startupModel?.id) {
    startupActivation = runtime.activate(startupModel.id).catch(error =>
      log.warn('startup.model-start-failed', { modelId: startupModel.id, code: error?.code || error?.name || 'UNKNOWN' }));
  }
  await startupActivation.catch(() => {});
  await log.info('startup.self-check', {
    node: process.version,
    host,
    address: address.address,
    port: address.port,
    paths: { data: DATA_DIR, runtime: RUNTIME_DIR, web: WEB_DIR },
    catalogueValid: catalogue.entries.length,
    catalogueQuarantined: catalogue.quarantined.length,
    runtimePresent: await runtime.binaryPresent(),
    installedModels: startupInstalled.length,
    activeModel: startupModel?.id || null,
    featureMigration,
    researchSettingsMigration,
    recipeMigration,
    serviceIdentityMigration,
    reconciledChats,
    recoveredInterrupted: recovered,
    recoveredWorkRuns: recoveredWorkRuns.filter(item => item?.recovered).length,
    resumableDownloads: resumable,
  });
  return {
    server,
    port: address.port,
    host,
    url: `http://${host}:${address.port}`,
    services: { engine, runtime, runtimePool, processRegistry, governor, registry, targetManager, scheduler, inference, context, snapshots, access, structured, compression, documents, repair, flow, selection, models, web, discovery, research },
    close: async () => {
      await startupActivation.catch(() => {});
      flow.stopAll();
      selection.close?.();
      models.close?.();
      await web.close().catch(() => {});
      const runtimeClose=await runtimePool.close().catch(error=>({failed:[{code:error?.code||error?.name||'RUNTIME_CLOSE_FAILED',message:error?.message||'Runtime close failed.'}]}));
      if(runtimeClose?.failed?.length)await log.warn('shutdown.runtime-stop-incomplete',{failed:runtimeClose.failed});
      await new Promise(resolve => {
        let settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(forceTimer);resolve();};
        const forceTimer=setTimeout(()=>{try{server.closeAllConnections?.();}catch{}},500);forceTimer.unref?.();
        server.close(finish);
        try{server.closeIdleConnections?.();}catch{}
      });
    },
  };
}
