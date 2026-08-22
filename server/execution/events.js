import { WORK_EVENT_SCHEMA, workEvent as baseWorkEvent } from '../research/contracts.js';
import { fail } from '../lib/errors.js';

export const EXECUTION_EVENT_SCHEMA=WORK_EVENT_SCHEMA;
export const EXECUTION_EVENT_TYPES=Object.freeze(new Set([
  'run-started','run-status','run-stopping','run-resumed','done','cancelled','error','heartbeat',
  'research-work','research-progress','research-heartbeat','research-token-telemetry','research-dossier','research-source-skipped','research-completed','research-failed','web-started','web-progress','web-completed','web-failed','query-started','query-completed','discovery-attempt','discovery-result','page-open-started','page-render-fallback','page-rejected','page-read',
  'node-ready','node-queued-resource','node-loading-target','node-started','node-completed','node-degraded','node-failed','node-cancelled','node-skipped','node-retrying',
  'resource-snapshot','resource-released','execution-mode','target-pinned','target-reacquired','target-fallback','target-failed','stage-started','stage-completed','stage-delta','reasoning-delta','reasoning-completed','delta','clarification-request'
]));
export function executionEvent(input={}){return baseWorkEvent(input);}
export function validateExecutionEvent(value){if(!value||Number(value.schemaVersion)!==EXECUTION_EVENT_SCHEMA)throw fail('WORK_EVENT_VERSION','This live-work event uses an incompatible schema version.',409,{expected:EXECUTION_EVENT_SCHEMA,received:value?.schemaVersion??null});if(!Number.isInteger(Number(value.seq))||Number(value.seq)<1||!value.runId||!value.type)throw fail('WORK_EVENT_SHAPE','This live-work event is malformed.',500);if(!EXECUTION_EVENT_TYPES.has(String(value.type)))throw fail('WORK_EVENT_VERSION','This live-work event type is unknown to the current schema version.',409,{expectedVersion:EXECUTION_EVENT_SCHEMA,type:value.type});return true;}
