function stableValue(job = {}) {
  return {
    state: job.state || 'idle',
    bytesReceived: Number(job.bytesReceived || 0),
    totalBytes: Number(job.totalBytes || 0),
    speed: Number(job.speed || 0),
    etaSeconds: job.etaSeconds == null ? null : Number(job.etaSeconds),
    nextAttemptAt: job.nextAttemptAt || null,
    restartReason: job.restartReason || null,
    errorCode: job.error?.code || null,
    errorMessage: job.error?.message || null,
  };
}
export function downloadSnapshot(job) { return JSON.stringify(stableValue(job)); }
export function sameDownloadSnapshot(a, b) { return downloadSnapshot(a) === downloadSnapshot(b); }
export function createDownloadProgressGate(render, initial = null) {
  let previous = initial ? downloadSnapshot(initial) : null;
  return job => {
    const next = downloadSnapshot(job);
    if (next === previous) return false;
    previous = next;
    render(job);
    return true;
  };
}
export function progressPercent(job) {
  const total = Number(job?.totalBytes || 0);
  const received = Number(job?.bytesReceived || 0);
  return total > 0 ? Math.min(100, Math.max(0, Math.round((received / total) * 100))) : 0;
}
