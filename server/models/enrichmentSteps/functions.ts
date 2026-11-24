import { db } from '../db.js';
import { enrichmentStepsTable } from './schema.js';
import { eq } from 'drizzle-orm';

export async function createEnrichmentStep(data: {
  runId: number;
  stepNumber: number;
  stepType: string;
  platform?: string;
  actorId?: string;
  subType?: string;
  identifier?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: any;
}) {
  const [step] = await db.insert(enrichmentStepsTable).values({
    runId: data.runId,
    stepNumber: data.stepNumber,
    stepType: data.stepType,
    platform: data.platform ?? null,
    actorId: data.actorId ?? null,
    subType: data.subType ?? null,
    identifier: data.identifier ?? null,
    status: 'running',
    input: data.input ?? null,
  }).returning();
  return step;
}

export async function updateEnrichmentStep(id: number, data: Partial<{
  status: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output: any;
  itemsCount: number;
  durationMs: number;
  errorMessage: string;
}>) {
  const [updated] = await db.update(enrichmentStepsTable)
    .set(data)
    .where(eq(enrichmentStepsTable.id, id))
    .returning();
  return updated;
}

