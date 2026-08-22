// Workflow v1 was removed in P4. This compatibility module intentionally exposes only
// the v2 contract so old imports cannot silently keep linear-stage semantics alive.
export {
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_NODE_TYPES,
  WORKFLOW_JOIN_POLICIES,
  WORKFLOW_WEB_POLICIES,
  normalizeWorkflowDefinitionV2 as normalizeWorkflowDefinition,
  workflowSchemaDescription,
} from '../workflows/schema-v2.js';
export { normalizeOrMigrateWorkflow, migrateWorkflowV1 } from '../workflows/migrate-v1.js';
