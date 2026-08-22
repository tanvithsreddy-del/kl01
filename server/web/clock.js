import { performance } from 'node:perf_hooks';

export function monotonicNow() { return performance.now(); }
export function deadlineAfter(ms) { return monotonicNow() + Math.max(0, Number(ms) || 0); }
export function remainingMs(deadline) { return Math.max(0, deadline - monotonicNow()); }
export function beforeDeadline(deadline) { return monotonicNow() < deadline; }
