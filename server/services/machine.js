import os from 'node:os';
import fs from 'node:fs/promises';
import { DATA_DIR } from '../lib/paths.js';
import { MODEL_APP_MEMORY_RESERVE_BYTES, MODEL_MEMORY_HEADROOM_RATIO } from '../config.js';

const GIB = 1024 ** 3;

export function memoryNeededForModel(entry) {
  const weights = Number(entry?.size || 0);
  const configuredContext = Math.max(1024, Number(entry?.contextSize || 8192));
  const contextReserve = Math.ceil(192 * 1024 ** 2 * Math.sqrt(configuredContext / 8192));
  return Math.ceil(weights * (1 + MODEL_MEMORY_HEADROOM_RATIO)) + MODEL_APP_MEMORY_RESERVE_BYTES + contextReserve;
}

function activeParameters(entry) {
  const declared = Number(entry?.activeParameterCountB ?? entry?.parameterCountB);
  if (Number.isFinite(declared) && declared > 0) return declared;
  return Math.max(0.5, Number(entry?.size || 0) / 1_000_000_000);
}

function demandFor(entry, machine) {
  const total = Math.max(1, Number(machine?.memoryTotal || 0));
  const cores = Math.max(1, Number(machine?.cores || 1));
  const memoryPressure = memoryNeededForModel(entry) / Math.max(1, total * 0.82);
  const computePressure = activeParameters(entry) / Math.max(1, cores * 0.75);
  return memoryPressure * 0.78 + computePressure * 0.22;
}

function classForPosition(index, count) {
  if (count <= 1) return 'balanced';
  if (count === 2) return index === 0 ? 'quick' : 'powerful';
  const position = index / (count - 1);
  if (position <= 0.34) return 'quick';
  if (position <= 0.67) return 'balanced';
  return 'powerful';
}

export function classifyModelsForMachine(entries, machine) {
  const memoryTotal = Number(machine?.memoryTotal || 0);
  const memoryAvailable = Number(machine?.memoryAvailable || 0);
  const stableCapacity = memoryTotal > 0 ? memoryTotal * 0.82 : 0;
  const measured = Number.isFinite(memoryTotal) && memoryTotal > 0;
  const ranked = entries.map((entry, originalIndex) => ({
    entry,
    originalIndex,
    memoryNeededBytes: memoryNeededForModel(entry),
    demand: demandFor(entry, machine),
  }));
  const fitting = ranked
    .filter(item => measured && item.memoryNeededBytes <= stableCapacity)
    .sort((left, right) => left.demand - right.demand || left.originalIndex - right.originalIndex || String(left.entry.id).localeCompare(String(right.entry.id)));
  const classes = new Map(fitting.map((item, index) => [item.entry.id, classForPosition(index, fitting.length)]));
  return ranked.map(item => {
    const hardwareClass = classes.get(item.entry.id) || 'too-large';
    const canRunNow = memoryAvailable > 0 && memoryAvailable >= item.memoryNeededBytes;
    const label = hardwareClass === 'too-large'
      ? 'Too large for this computer'
      : `${hardwareClass[0].toUpperCase()}${hardwareClass.slice(1)} on this computer`;
    const reason = !measured
      ? 'KL01 could not measure this computer reliably.'
      : hardwareClass === 'too-large'
        ? `This model needs about ${formatMemory(item.memoryNeededBytes)} and exceeds the safe capacity of this computer.`
        : canRunNow
          ? `${label}. It needs about ${formatMemory(item.memoryNeededBytes)} with room to spare.`
          : `${label}, but it needs about ${formatMemory(item.memoryNeededBytes)} available now; ${formatMemory(memoryAvailable)} is currently available.`;
    return {
      ...item.entry,
      originalIndex: item.originalIndex,
      machineFit: {
        class: hardwareClass,
        label,
        reason,
        demand: item.demand,
        canRunNow,
        memoryNeededBytes: item.memoryNeededBytes,
        memoryAvailableBytes: memoryAvailable,
        memoryTotalBytes: memoryTotal,
      },
    };
  });
}

export function formatMemory(bytes) {
  const gb = Number(bytes || 0) / GIB;
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
}

export async function inspectMachine() {
  const memoryTotal = os.totalmem();
  const memoryAvailable = os.freemem();
  let diskAvailable = 0;
  try {
    const stats = await fs.statfs(DATA_DIR);
    diskAvailable = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    try {
      const stats = await fs.statfs(process.cwd());
      diskAvailable = Number(stats.bavail) * Number(stats.bsize);
    } catch {}
  }
  const cpus = os.cpus();
  const cores = cpus.length;
  const processor = cpus[0]?.model || 'Unknown processor';
  return { memoryTotal, memoryAvailable, diskAvailable, cores, processor };
}
