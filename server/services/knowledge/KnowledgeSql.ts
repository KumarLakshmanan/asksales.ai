import { sql } from 'drizzle-orm';

/** Build a parameterized PostgreSQL text array without treating JS arrays as
 * row constructors. Values remain query parameters; no user text is inlined.
 */
export function knowledgeTextArray(values: readonly string[]) {
  if (values.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

function assertKnowledgeIds(values: readonly number[]): void {
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('INVALID_KNOWLEDGE_ID_ARRAY');
  }
}

/** Build parameterized PostgreSQL identifier arrays explicitly. Interpolating
 * a JavaScript array directly makes Drizzle emit a row constructor, which
 * PostgreSQL cannot cast to an integer array when more than one ID is present.
 */
export function knowledgeIntegerArray(values: readonly number[]) {
  assertKnowledgeIds(values);
  if (values.length === 0) return sql`ARRAY[]::integer[]`;
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::integer[]`;
}

export function knowledgeBigintArray(values: readonly number[]) {
  assertKnowledgeIds(values);
  if (values.length === 0) return sql`ARRAY[]::bigint[]`;
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::bigint[]`;
}
