import fs from 'node:fs/promises';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { HOST, RUNTIME_READY_TIMEOUT_MS, RUNTIME_STOP_TIMEOUT_MS, DEFAULT_CONTEXT_SIZE } from '../config.js';
import { LLAMA_BINARY } from '../lib/paths.js';
import { fail } from '../lib/errors.js';
import { verifyInstalled, setActiveModel, recordModelUsage } from './installed.js';
import { inspectMachine } from './machine.js';
import { log } from '../lib/log.js';
import { probeRuntimeCapabilities } from '../execution/capability-probe.js';

function freePort() {
  return new Promise((resolve,reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
async function waitExit(child, timeout = RUNTIME_STOP_TIMEOUT_MS) {
  if (!child || child.exitCode !== null) return;
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise((_,reject) => setTimeout(() => reject(new Error('runtime stop timeout')), timeout)),
  ]);
}
export function createRuntimeService({ adapter = null, engine = null, healthProbe = null, healthIntervalMs = 2000, healthFailureThreshold = 3, persistSelection = true, runtimeId = 'interactive' } = {}) {
  let child = null;
  let state = { runtimeId, status: 'stopped', modelId: null, modelName: null, baseUrl: null, port: null, contextSize: null, failure: null, pid: null, parallelCapacity: 1, parallelVerified: false, properties: {} };
  const emitter = new EventEmitter();
  let healthTimer = null;
  let healthFailures = 0;
  let lastReadyState = null;
  let stateSignature = JSON.stringify(state);
  function setState(next) {
    const signature = JSON.stringify(next);
    state = next;
    if (signature === stateSignature) return false;
    stateSignature = signature;
    emitter.emit('state', structuredClone(state));
    return true;
  }
  function clearHealthMonitor() {
    if (healthTimer) clearTimeout(healthTimer);
    healthTimer = null;
    healthFailures = 0;
  }
  async function probeHealth(baseUrl) {
    if (healthProbe) return Boolean(await healthProbe(baseUrl));
    try { const response = await fetch(`${baseUrl}/health`); return response.ok; } catch { return false; }
  }
  function scheduleHealthMonitor(baseUrl) {
    clearHealthMonitor();
    const tick = async () => {
      healthTimer = null;
      if (!baseUrl || !['ready', 'failed'].includes(state.status)) return;
      if (state.status === 'failed' && state.failure?.code !== 'RUNTIME_HEALTH_LOST') return;
      const healthy = await probeHealth(baseUrl).catch(() => false);
      if (healthy) {
        healthFailures = 0;
        if (state.status === 'failed' && state.failure?.code === 'RUNTIME_HEALTH_LOST' && lastReadyState) setState({ ...lastReadyState, failure: null });
      } else {
        healthFailures += 1;
        if (healthFailures >= healthFailureThreshold && state.status === 'ready') {
          setState({ ...state, status: 'failed', failure: { code: 'RUNTIME_HEALTH_LOST', message: 'The AI stopped responding; wait while KL01 reconnects automatically.' } });
        }
      }
      if (['ready', 'failed'].includes(state.status) && (state.status !== 'failed' || state.failure?.code === 'RUNTIME_HEALTH_LOST')) {
        healthTimer = setTimeout(tick, healthIntervalMs);
        healthTimer.unref?.();
      }
    };
    healthTimer = setTimeout(tick, healthIntervalMs);
    healthTimer.unref?.();
  }
  function observeExit(processHandle) {
    processHandle?.once?.('exit', (code, signal) => {
      clearHealthMonitor();
      if (state.status === 'ready' || state.status === 'starting' || state.failure?.code === 'RUNTIME_HEALTH_LOST') setState({ ...state, status: 'failed', failure: { code: 'RUNTIME_EXITED', message: 'The AI stopped unexpectedly; restart it to continue.', exitCode: code, signal } });
    });
  }
  async function binaryPresent() {
    if (adapter) return true;
    if (engine) return engine.present();
    try { await fs.access(LLAMA_BINARY); return true; } catch { return false; }
  }
  async function stop() {
    clearHealthMonitor();
    lastReadyState = null;
    if (state.status === 'stopped' && !child) return state;
    setState({ ...state, status: 'stopping' });
    try {
      if (adapter) await adapter.stop?.();
      else if (child && child.exitCode === null) {
        if (process.platform === 'win32') {
          await new Promise(resolve => {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            killer.once('exit', resolve); killer.once('error', resolve);
          });
        } else child.kill('SIGTERM');
        try { await waitExit(child); } catch { if (child.exitCode === null) child.kill('SIGKILL'); await waitExit(child).catch(()=>{}); }
      }
    } finally {
      child = null;
      setState({ runtimeId, status: 'stopped', modelId: null, modelName: null, baseUrl: null, port: null, contextSize: null, failure: null, pid: null, parallelCapacity: 1, parallelVerified: false, properties: {} });
    }
    return state;
  }
  async function pollReady(baseUrl) {
    const deadline = Date.now() + RUNTIME_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${baseUrl}/health`); if (r.ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw fail('RUNTIME_TIMEOUT', 'The AI did not start in time; check its files, then try again.', 504);
  }
  async function activate(modelId, options = {}) {
    const shouldPersistSelection = options.persistSelection ?? persistSelection;
    const requestedParallel = Math.max(1, Math.floor(Number(options.parallel || 1)));
    const model = await verifyInstalled(modelId);
    await stop();
    setState({ runtimeId, status: 'starting', modelId, modelName: model.displayName || modelId, baseUrl: null, port: null, contextSize: model.contextSize || DEFAULT_CONTEXT_SIZE, failure: null, pid: null, parallelCapacity: 1, parallelVerified: false, properties: {} });
    try {
      if (!adapter) {
        if (engine) await engine.ensure();
        else if (!(await binaryPresent())) throw fail('RUNTIME_MISSING', 'KL01 could not prepare the AI on this computer; try the download again.', 409);
      }
      const port = await freePort();
      const machine = await inspectMachine();
      const args = ['--model', model.path, '--ctx-size', String(model.contextSize || DEFAULT_CONTEXT_SIZE), '--threads', String(Math.max(1, Math.min(machine.cores, 12))), '--parallel', String(requestedParallel), '--host', HOST, '--port', String(port)];
      setState({ ...state, port });
      await log.info('runtime.command', { binary: LLAMA_BINARY, args });
      let baseUrl;
      if (adapter) {
        const started = await adapter.start({ model, port, args });
        baseUrl = started.baseUrl;
        child = started.child || null;
        observeExit(child);
        setState({ ...state, pid: child?.pid || started.pid || null });
      } else {
        child = spawn(LLAMA_BINARY, args, { cwd: process.cwd(), windowsHide: true, stdio: ['ignore','pipe','pipe'] });
        child.stdout.on('data', data => log.info('runtime.stdout', { text: String(data).trim() }));
        child.stderr.on('data', data => log.warn('runtime.stderr', { text: String(data).trim() }));
        observeExit(child);
        setState({ ...state, pid: child?.pid || null });
        baseUrl = `http://${HOST}:${port}`;
      }
      await pollReady(baseUrl);
      const probed=await probeRuntimeCapabilities(baseUrl,{fallbackContext:model.contextSize||DEFAULT_CONTEXT_SIZE,requestedParallel});
      const actualContextSize=Number(probed.contextSize||model.contextSize||DEFAULT_CONTEXT_SIZE);const {properties,parallelCapacity,parallelVerified}=probed;
      if (shouldPersistSelection) await setActiveModel(modelId, actualContextSize); else await recordModelUsage(modelId, actualContextSize);
      setState({ runtimeId, status: 'ready', modelId, modelName: model.displayName || modelId, baseUrl, port, contextSize: actualContextSize, failure: null, pid: child?.pid || state.pid || null, parallelCapacity, parallelVerified, properties });
      lastReadyState = structuredClone(state);
      scheduleHealthMonitor(baseUrl);
      return state;
    } catch (error) {
      await stop().catch(()=>{});
      setState({ runtimeId, status: 'failed', modelId, modelName: model.displayName || modelId, baseUrl: null, port: null, contextSize: null, failure: { code: error.code || 'RUNTIME_START_FAILED', message: error.publicMessage || 'The model could not start. Check the model file, then try again.' }, pid:null, parallelCapacity:1, parallelVerified:false, properties:{} });
      throw error;
    }
  }
  function endpoint() {
    if (state.status !== 'ready' || !state.baseUrl) throw fail('MODEL_NOT_RUNNING', 'No AI is running; start one to send a message.', 409);
    return state.baseUrl;
  }
  function subscribe(listener) {
    emitter.on('state', listener);
    return () => emitter.off('state', listener);
  }
  async function healthCheckNow() {
    if (!state.baseUrl || !['ready', 'failed'].includes(state.status)) return state;
    const healthy = await probeHealth(state.baseUrl).catch(() => false);
    if (healthy) {
      healthFailures = 0;
      if (state.status === 'failed' && state.failure?.code === 'RUNTIME_HEALTH_LOST' && lastReadyState) setState({ ...lastReadyState, failure: null });
    } else {
      healthFailures += 1;
      if (healthFailures >= healthFailureThreshold && state.status === 'ready') setState({ ...state, status: 'failed', failure: { code: 'RUNTIME_HEALTH_LOST', message: 'The AI stopped responding; wait while KL01 reconnects automatically.' } });
    }
    return structuredClone(state);
  }
  return { activate, stop, endpoint, getState: () => structuredClone(state), binaryPresent, subscribe, healthCheckNow, processInfo: () => ({ runtimeId, pid: child?.pid || state.pid || null, modelId: state.modelId, status: state.status, parallelCapacity: state.parallelCapacity || 1, parallelVerified: Boolean(state.parallelVerified) }) };
}
