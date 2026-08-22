
export function mergeSourceWorkDelta(work, incoming, { limit = 40 } = {}) {
  if (!work || work.kind !== 'research' || !incoming?.sourceId) return work;
  const sourceId = String(incoming.sourceId);
  const sourceWorks = Array.isArray(work.sourceWorks) ? work.sourceWorks : [];
  const index = sourceWorks.findIndex(item => String(item?.sourceId || '') === sourceId);
  if (index >= 0) {
    const previousRevision = Math.max(0, Number(sourceWorks[index]?.revision || 0));
    const nextRevision = Math.max(0, Number(incoming.revision || 0));
    if (previousRevision && nextRevision && nextRevision <= previousRevision) return work;
  }
  const next = structuredClone(work);
  const rows = Array.isArray(next.sourceWorks) ? next.sourceWorks : [];
  const copy = structuredClone(incoming);
  const at = rows.findIndex(item => String(item?.sourceId || '') === sourceId);
  if (at >= 0) rows[at] = copy;
  else rows.push(copy);
  next.sourceWorks = rows
    .sort((a, b) => String(a?.createdAt || '').localeCompare(String(b?.createdAt || '')) || String(a?.sourceId || '').localeCompare(String(b?.sourceId || '')))
    .slice(0, Math.max(1, Math.min(64, Number(limit || 40))));
  return next;
}

const TELEMETRY_TYPES = new Set(['research-token-telemetry']);

export function createWorkEventReconciler({ maxHz = 4 } = {}) {
  const runs = new Map();
  const intervalMs = Math.max(16, Math.ceil(1000 / Math.max(1, Number(maxHz || 4))));
  function record(runId) {
    const id = String(runId || '');
    let item = runs.get(id);
    if (!item) { item = { generation:0, lastSeq:0, lastRenderAt:0, timer:null, pending:null, sourceRevisions:new Map() }; runs.set(id, item); }
    return item;
  }
  function applyPending(item) {
    if (!item.pending) return;
    const pending = item.pending; item.pending = null; item.timer = null; item.lastRenderAt = performance.now(); pending.apply();
  }
  function accept(event, envelope, apply) {
    const runId = envelope?.runId || envelope?.publicPayload?.runId;
    const item = record(runId);
    const generation = Math.max(0, Number(envelope?.generation || 0));
    const seq = Math.max(0, Number(envelope?.seq || envelope?.sequence || 0));
    if (generation && generation < item.generation) return false;
    if (generation > item.generation) { if (item.timer) clearTimeout(item.timer); Object.assign(item,{ generation, lastSeq:0, timer:null, pending:null, sourceRevisions:new Map() }); }
    if (seq && seq <= item.lastSeq) return false;
    const sourceWork=envelope?.publicPayload?.sourceWork;
    if (event==='source-work-delta'&&sourceWork?.sourceId){const revision=Math.max(0,Number(sourceWork.revision||0));const previous=item.sourceRevisions.get(String(sourceWork.sourceId))||0;if(revision&&revision<=previous)return false;if(revision)item.sourceRevisions.set(String(sourceWork.sourceId),revision);}
    if (seq) item.lastSeq = seq;
    if (!TELEMETRY_TYPES.has(event)) {
      if (item.timer) { clearTimeout(item.timer); item.timer = null; item.pending = null; }
      item.lastRenderAt = performance.now(); apply(); return true;
    }
    const elapsed = performance.now() - item.lastRenderAt;
    if (elapsed >= intervalMs) { item.lastRenderAt = performance.now(); apply(); return true; }
    item.pending = { apply };
    if (!item.timer) item.timer = setTimeout(() => applyPending(item), Math.max(0, intervalMs - elapsed));
    return true;
  }
  function clear(runId) { const item=runs.get(String(runId||'')); if(item?.timer)clearTimeout(item.timer); runs.delete(String(runId||'')); }
  function destroy() { for (const item of runs.values()) if(item.timer)clearTimeout(item.timer); runs.clear(); }
  return { accept, clear, destroy };
}
