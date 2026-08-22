import { fail } from '../lib/errors.js';
import { normalizeWorkflowDefinitionV2 } from './schema-v2.js';

const safe = value => String(value ?? '').trim();
function v1StageId(stage, index) { return safe(stage?.id) || `stage-${index + 1}`; }

export function isWorkflowV1(value) { return value && typeof value === 'object' && !Array.isArray(value) && Number(value.version || 1) === 1 && Array.isArray(value.stages); }

export function migrateWorkflowV1(input = {}) {
  if (!isWorkflowV1(input)) throw fail('WF_MIGRATION_SOURCE', 'This recipe is not a supported Workflow v1 definition.', 400);
  if (!input.stages.length) throw fail('WF_MIGRATION_EMPTY', 'This Workflow v1 recipe has no stages.', 400);
  if (input.stages.some(stage => Number(stage?.repeat || 1) !== 1)) {
    // Repeats had generated IDs and subtle condition semantics in v1. Refuse silent reinterpretation.
    throw fail('WF_MIGRATION_INCOMPATIBLE', 'This saved recipe uses repeated stages. Open it in the older build, expand the repeated stages explicitly, then import it again.', 409, { reason: 'repeat-semantics' });
  }
  const ids = input.stages.map(v1StageId);
  if (new Set(ids).size !== ids.length) throw fail('WF_MIGRATION_INCOMPATIBLE', 'This saved recipe contains duplicate stage IDs and cannot be migrated safely.', 409, { reason: 'duplicate-stage-id' });
  const slots = [];
  const slotForTarget = new Map();
  const slotIdFor = (targetId, index) => {
    const key = targetId ? `explicit:${targetId}` : 'auto';
    if (slotForTarget.has(key)) return slotForTarget.get(key);
    const id = targetId ? `slot-${index + 1}` : 'auto';
    if (!slotForTarget.has(key)) {
      slotForTarget.set(key, id);
      slots.push({ id, label: targetId ? `Saved target ${slots.length + 1}` : 'Current model', role: 'Workflow model', targetPolicy: targetId ? { mode: 'explicit', targetId } : { mode: 'auto' }, fallbackPolicy: { allowFallback: true }, capabilityRequirements: { inputModalities: ['text'] } });
    }
    return id;
  };
  const nodes = input.stages.map((stage, index) => {
    const id = ids[index]; const type = stage?.type === 'ask-user' ? 'ask-user' : 'model';
    const context = ['original','previous','all'].includes(String(stage?.context)) ? String(stage.context) : (index ? 'all' : 'original');
    const artifactPolicy = context === 'original' ? { mode: 'none', nodeIds: [] }
      : context === 'previous' ? { mode: 'explicit', nodeIds: index ? [ids[index - 1]] : [] }
      : { mode: 'explicit', nodeIds: ids.slice(0, index) };
    return {
      id, type, label: safe(stage?.label) || id, role: safe(stage?.role) || 'Workflow model', instruction: safe(stage?.instruction),
      slotId: type === 'model' ? slotIdFor(safe(stage?.targetId) || null, index) : null,
      joinPolicy: 'all', capabilityRequirements: { inputModalities: ['text'] }, webPolicy: { mode: 'inherit' }, fallbackPolicy: { allowFallback: true },
      contextPolicy: { conversation: 'base', artifacts: artifactPolicy, research: 'shared', includeAttachments: true },
      visibility: stage?.visibility === 'hidden' ? 'hidden' : 'public', final: Boolean(stage?.final),
      question: type === 'ask-user' ? { prompt: safe(stage?.question?.prompt || stage?.instruction || stage?.label), options: Array.isArray(stage?.question?.options) ? stage.question.options : [], allowOther: stage?.question?.allowOther !== false, allowSkip: stage?.question?.allowSkip !== false } : null,
      condition: stage?.condition?.sourceStageId && stage?.condition?.contains ? { sourceNodeId: safe(stage.condition.sourceStageId), contains: safe(stage.condition.contains), negate: Boolean(stage.condition.negate) } : null,
      metadata: { migratedFrom: 'workflow-v1', originalContext: context, originalIndex: index },
    };
  });
  const edges = [];
  const addEdge = (from, to) => { if (from && to && !edges.some(edge => edge.from === from && edge.to === to)) edges.push({ from, to }); };
  // P3 executed saved custom workflows sequentially. Preserve scheduling independently from artifact visibility.
  for (let index = 1; index < ids.length; index += 1) addEdge(ids[index - 1], ids[index]);
  for (const node of nodes) if (node.condition?.sourceNodeId) addEdge(node.condition.sourceNodeId, node.id);
  const finals = nodes.filter(node => node.final);
  if (finals.length !== 1) throw fail('WF_MIGRATION_INCOMPATIBLE', 'This saved recipe does not contain exactly one final stage and cannot be migrated safely.', 409, { reason: 'final-stage' });
  const migrated = normalizeWorkflowDefinitionV2({ version: 2, id: input.id || null, name: input.name || 'Migrated workflow', description: input.description || '', family: 'MigratedV1', slots, nodes, edges, finalNodeId: finals[0].id, webPolicy: { mode: 'inherit' }, visibility: { showIntermediate: true }, createdAt: input.createdAt || null, updatedAt: input.updatedAt || null });
  return { workflow: migrated, migration: { fromVersion: 1, toVersion: 2, preservedSequentialScheduling: true, warnings: [] } };
}

export function normalizeOrMigrateWorkflow(input = {}) {
  if (Number(input?.version) === 2) return { workflow: normalizeWorkflowDefinitionV2(input), migration: null };
  if (isWorkflowV1(input)) return migrateWorkflowV1(input);
  throw fail('WORKFLOW_VERSION', 'Only Workflow v2 definitions or compatible Workflow v1 recipes can be loaded.', 400, { receivedVersion: input?.version ?? null });
}
