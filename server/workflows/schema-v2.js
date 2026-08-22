import crypto from 'node:crypto';
import { fail } from '../lib/errors.js';

export const WORKFLOW_SCHEMA_VERSION = 2;
export const WORKFLOW_NODE_TYPES = Object.freeze(['model', 'ask-user', 'research']);
export const WORKFLOW_JOIN_POLICIES = Object.freeze(['all', 'any', 'quorum', 'best-effort']);
export const WORKFLOW_WEB_POLICIES = Object.freeze(['inherit', 'off', 'shared', 'independent', 'required']);
export const WORKFLOW_CONTEXT_CONVERSATION = Object.freeze(['base', 'request-only', 'none']);
export const WORKFLOW_ARTIFACT_POLICIES = Object.freeze(['dependencies', 'explicit', 'none']);
export const WORKFLOW_VISIBILITY = Object.freeze(['public', 'hidden']);
export const WORKFLOW_TARGET_MODES = Object.freeze(['auto', 'explicit']);

const NODE_TYPES = new Set(WORKFLOW_NODE_TYPES);
const JOIN_POLICIES = new Set(WORKFLOW_JOIN_POLICIES);
const WEB_POLICIES = new Set(WORKFLOW_WEB_POLICIES);
const CONVERSATION_POLICIES = new Set(WORKFLOW_CONTEXT_CONVERSATION);
const ARTIFACT_POLICIES = new Set(WORKFLOW_ARTIFACT_POLICIES);
const VISIBILITY = new Set(WORKFLOW_VISIBILITY);
const TARGET_MODES = new Set(WORKFLOW_TARGET_MODES);
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u;

const clone = value => structuredClone(value);
const generatedId = prefix => `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
function text(value, max = 4000) { return String(value ?? '').trim().slice(0, max); }
function bool(value, fallback = false) { return value == null ? fallback : Boolean(value); }
function int(value, fallback, min, max) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback; }
function uniqText(values, maxItems = 32, maxLength = 180) { return Array.isArray(values) ? [...new Set(values.map(value => text(value, maxLength)).filter(Boolean))].slice(0, maxItems) : []; }
function assertId(value, code, label) { if (!SAFE_ID.test(value)) throw fail(code, `${label} must use letters, numbers, dashes, or underscores and be at most 80 characters.`, 400, { id: value }); }

function normalizeCapabilities(input = {}) {
  return {
    inputModalities: uniqText(input.inputModalities || input.modalities || ['text'], 8, 40).map(value => value.toLowerCase()),
    fileTypes: uniqText(input.fileTypes, 32, 24).map(value => value.replace(/^\./u, '').toLowerCase()),
    structuredOutput: bool(input.structuredOutput, false),
    reasoning: bool(input.reasoning, false),
    contextTokens: int(input.contextTokens || input.contextSize, 0, 0, 1_000_000),
  };
}

function normalizeTargetPolicy(input = {}) {
  const targetId = text(input.targetId, 180) || null;
  const mode = TARGET_MODES.has(String(input.mode)) ? String(input.mode) : (targetId ? 'explicit' : 'auto');
  if (mode === 'explicit' && !targetId) throw fail('WF_SLOT_TARGET', 'An explicit workflow slot needs a target.', 400);
  return { mode, targetId: mode === 'explicit' ? targetId : null };
}

function normalizeFallbackPolicy(input = {}) {
  return {
    allowFallback: input.allowFallback !== false,
    externalFallbackChain: uniqText(input.externalFallbackChain, 12, 180),
  };
}

function normalizeWebPolicy(input = {}, fallback = 'inherit') {
  const raw = typeof input === 'string' ? input : input?.mode;
  const mode = WEB_POLICIES.has(String(raw)) ? String(raw) : fallback;
  return { mode };
}

function normalizeContextPolicy(input = {}) {
  const artifactMode = ARTIFACT_POLICIES.has(String(input?.artifacts?.mode)) ? String(input.artifacts.mode) : 'dependencies';
  return {
    conversation: CONVERSATION_POLICIES.has(String(input.conversation)) ? String(input.conversation) : 'base',
    artifacts: { mode: artifactMode, nodeIds: artifactMode === 'explicit' ? uniqText(input?.artifacts?.nodeIds, 40, 80) : [] },
    research: input.research === 'none' ? 'none' : 'shared',
    includeAttachments: input.includeAttachments !== false,
  };
}

function normalizeQuestion(raw, nodeId) {
  const options = uniqText(raw?.options, 8, 120);
  if (options.length < 2) throw fail('WF_QUESTION_OPTIONS', `Ask-user node “${nodeId}” needs at least two options.`, 400, { nodeId });
  return {
    prompt: text(raw?.prompt, 500) || 'Choose an option.',
    options,
    allowOther: raw?.allowOther !== false,
    allowSkip: raw?.allowSkip !== false,
  };
}

function normalizeCondition(raw, nodeId) {
  if (!raw || typeof raw !== 'object') return null;
  const sourceNodeId = text(raw.sourceNodeId || raw.sourceStageId, 80);
  const contains = text(raw.contains, 200);
  if (!sourceNodeId || !contains) throw fail('WF_CONDITION', `Conditional node “${nodeId}” needs a source node and match text.`, 400, { nodeId });
  return { sourceNodeId, contains, negate: Boolean(raw.negate) };
}

function cycleCheck(nodeIds, edges) {
  const next = new Map([...nodeIds].map(id => [id, []]));
  for (const edge of edges) next.get(edge.from).push(edge.to);
  const visiting = new Set(); const visited = new Set();
  const visit = id => {
    if (visiting.has(id)) throw fail('WF_CYCLE', 'Workflow graph contains a cycle.', 400, { nodeId: id });
    if (visited.has(id)) return;
    visiting.add(id); for (const child of next.get(id) || []) visit(child); visiting.delete(id); visited.add(id);
  };
  for (const id of nodeIds) visit(id);
}

export function normalizeWorkflowDefinitionV2(input = {}, { requireId = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('WORKFLOW_SHAPE', 'A workflow must be a JSON object.', 400);
  if (Number(input.version || 0) !== WORKFLOW_SCHEMA_VERSION) throw fail('WORKFLOW_VERSION', `Workflow schema v${WORKFLOW_SCHEMA_VERSION} is required.`, 400, { receivedVersion: input.version ?? null });
  const id = text(input.id, 80) || null; if (requireId && !id) throw fail('WORKFLOW_ID_REQUIRED', 'This workflow needs an identifier.', 400); if (id) assertId(id, 'WORKFLOW_ID', 'Workflow ID');
  const rawSlots = Array.isArray(input.slots) ? input.slots : [];
  if (rawSlots.length > 16) throw fail('WF_SLOT_LIMIT', 'A workflow can expose at most 16 model slots.', 400);
  const slotIds = new Set();
  const slots = rawSlots.map((raw, index) => {
    const slotId = text(raw?.id || `slot-${index + 1}`, 80); assertId(slotId, 'WF_SLOT_ID', 'Workflow slot ID');
    if (slotIds.has(slotId)) throw fail('WF_SLOT_ID', `Duplicate workflow slot “${slotId}”.`, 400); slotIds.add(slotId);
    return {
      id: slotId,
      label: text(raw?.label || `Model ${index + 1}`, 100),
      role: text(raw?.role || 'Workflow model', 120),
      capabilityRequirements: normalizeCapabilities(raw?.capabilityRequirements || {}),
      targetPolicy: normalizeTargetPolicy(raw?.targetPolicy || {}),
      fallbackPolicy: normalizeFallbackPolicy(raw?.fallbackPolicy || {}),
    };
  });
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  if (!rawNodes.length) throw fail('WORKFLOW_EMPTY', 'Add at least one workflow node.', 400);
  if (rawNodes.length > 48) throw fail('WORKFLOW_TOO_LARGE', 'A workflow can contain at most 48 nodes.', 400);
  const nodeIds = new Set();
  const nodes = rawNodes.map((raw, index) => {
    const nodeId = text(raw?.id || generatedId('node'), 80); assertId(nodeId, 'WF_NODE_ID', 'Workflow node ID');
    if (nodeIds.has(nodeId)) throw fail('WF_NODE_ID', `Duplicate workflow node “${nodeId}”.`, 400); nodeIds.add(nodeId);
    const type = NODE_TYPES.has(String(raw?.type)) ? String(raw.type) : 'model';
    const slotId = type === 'model' ? text(raw?.slotId, 80) || null : null;
    if (slotId && !slotIds.has(slotId)) throw fail('WF_NODE_SLOT', `Node “${nodeId}” refers to missing slot “${slotId}”.`, 400, { nodeId, slotId });
    const joinPolicy = JOIN_POLICIES.has(String(raw?.joinPolicy)) ? String(raw.joinPolicy) : 'all';
    const quorum = joinPolicy === 'quorum' ? int(raw?.quorum, 1, 1, 40) : null;
    const visibility = VISIBILITY.has(String(raw?.visibility)) ? String(raw.visibility) : 'public';
    const contextPolicy = normalizeContextPolicy(raw?.contextPolicy || {});
    return {
      id: nodeId,
      type,
      label: text(raw?.label || `${type.replaceAll('-', ' ')} ${index + 1}`, 120),
      role: text(raw?.role || (type === 'research' ? 'Researcher' : type === 'ask-user' ? 'User input' : 'Workflow model'), 120),
      instruction: text(raw?.instruction, 5000),
      slotId,
      joinPolicy,
      quorum,
      capabilityRequirements: normalizeCapabilities(raw?.capabilityRequirements || {}),
      webPolicy: normalizeWebPolicy(raw?.webPolicy || {}, type === 'research' ? 'required' : 'inherit'),
      contextPolicy,
      fallbackPolicy: normalizeFallbackPolicy(raw?.fallbackPolicy || {}),
      visibility,
      final: Boolean(raw?.final),
      question: type === 'ask-user' ? normalizeQuestion(raw?.question, nodeId) : null,
      condition: normalizeCondition(raw?.condition, nodeId),
      metadata: raw?.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata) ? clone(raw.metadata) : {},
    };
  });
  const modelPasses = nodes.filter(node => node.type === 'model').length;
  if (modelPasses > 40) throw fail('WORKFLOW_PASS_LIMIT', 'This workflow exceeds the hard 40-model-pass ceiling.', 400, { modelPasses });
  const rawEdges = Array.isArray(input.edges) ? input.edges : [];
  if (rawEdges.length > 160) throw fail('WF_EDGE_LIMIT', 'A workflow can contain at most 160 edges.', 400);
  const edgeKeys = new Set();
  const edges = rawEdges.map(raw => {
    const from = text(raw?.from, 80); const to = text(raw?.to, 80);
    if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) throw fail('WF_EDGE_NODE', 'Workflow edge must connect two different existing nodes.', 400, { from, to });
    const key = `${from}\u0000${to}`; if (edgeKeys.has(key)) throw fail('WF_EDGE_DUPLICATE', `Duplicate workflow edge ${from} → ${to}.`, 400); edgeKeys.add(key);
    return { from, to, optional: Boolean(raw?.optional) };
  });
  for (const node of nodes) {
    if (node.condition && !nodeIds.has(node.condition.sourceNodeId)) throw fail('WF_CONDITION_SOURCE', `Node “${node.id}” refers to missing condition source.`, 400, { nodeId: node.id, sourceNodeId: node.condition.sourceNodeId });
    for (const ref of node.contextPolicy.artifacts.nodeIds) if (!nodeIds.has(ref)) throw fail('WF_CONTEXT_SOURCE', `Node “${node.id}” refers to missing artifact source “${ref}”.`, 400, { nodeId: node.id, sourceNodeId: ref });
  }
  cycleCheck(nodeIds, edges);
  const finalNodeId = text(input.finalNodeId, 80) || nodes.find(node => node.final)?.id || null;
  if (!finalNodeId || !nodeIds.has(finalNodeId)) throw fail('WORKFLOW_FINAL_STAGE', 'A workflow must declare one final model node.', 400);
  const finalNodes = nodes.filter(node => node.final || node.id === finalNodeId);
  if (new Set(finalNodes.map(node => node.id)).size !== 1) throw fail('WORKFLOW_FINAL_STAGE', 'A workflow must have exactly one final node.', 400);
  const finalNode = nodes.find(node => node.id === finalNodeId);
  if (finalNode.type !== 'model') throw fail('WORKFLOW_FINAL_INTERACTIVE', 'The final workflow node must be a model node.', 400);
  finalNode.final = true;
  if (edges.some(edge => edge.from === finalNodeId)) throw fail('WORKFLOW_FINAL_ORDER', 'The final node cannot have downstream dependents.', 400, { finalNodeId });
  return {
    version: WORKFLOW_SCHEMA_VERSION,
    id,
    modeId: text(input.modeId, 80) || null,
    family: text(input.family, 80) || 'CustomGraph',
    name: text(input.name || 'Custom workflow', 120),
    description: text(input.description, 700),
    webPolicy: normalizeWebPolicy(input.webPolicy || {}, 'inherit'),
    visibility: { showIntermediate: input?.visibility?.showIntermediate !== false },
    slots,
    nodes,
    edges,
    finalNodeId,
    createdAt: input.createdAt || null,
    updatedAt: input.updatedAt || null,
  };
}

export function workflowSchemaDescription() {
  return {
    version: WORKFLOW_SCHEMA_VERSION,
    nodeTypes: [...WORKFLOW_NODE_TYPES], joinPolicies: [...WORKFLOW_JOIN_POLICIES], webPolicies: [...WORKFLOW_WEB_POLICIES],
    contextConversation: [...WORKFLOW_CONTEXT_CONVERSATION], artifactPolicies: [...WORKFLOW_ARTIFACT_POLICIES], targetModes: [...WORKFLOW_TARGET_MODES],
    limits: { nodes: 48, modelPasses: 40, edges: 160, slots: 16 },
  };
}
