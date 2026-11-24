/**
 * llmUsages schema
 *
 * Backward-compatible re-export from openaiUsages. The model is provider-agnostic
 * ("LLM") but the underlying table and types live in openaiUsages for historical
 * reasons. Phase 3.3 stub — keeps the import in allSchemas.ts valid.
 */
export * from '../openaiUsages/schema';
