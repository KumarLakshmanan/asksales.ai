import { and, eq } from 'drizzle-orm';
import { db } from '../../models/db.js';
import {
  aiVisibilityAuditStagesTable,
  aiVisibilityCompetitorsTable,
  type AiVisibilityAuditRecord,
} from '../../models/aiVisibility/schema.js';
import {
  buildCompetitorSuggestions,
  type ProviderCompetitorObservation,
} from './CompetitorSuggestionService.js';

export const AUTOMATIC_COMPETITOR_LIMIT = 5;

type Competitor = typeof aiVisibilityCompetitorsTable.$inferSelect;

/** Discovered competitors are audit outputs; the original configuration snapshot stays immutable. */
export async function auditCompetitors(
  audit: AiVisibilityAuditRecord,
  fallback: Competitor[] = [],
) {
  const [stage] = await db
    .select({ output: aiVisibilityAuditStagesTable.output })
    .from(aiVisibilityAuditStagesTable)
    .where(
      and(
        eq(aiVisibilityAuditStagesTable.auditId, audit.id),
        eq(aiVisibilityAuditStagesTable.stageKey, 'competitor_analysis'),
      ),
    )
    .limit(1);
  const tracked = Array.isArray(audit.inputSnapshot.competitors)
    ? (audit.inputSnapshot.competitors as Competitor[])
    : fallback;
  const discovered = Array.isArray(stage?.output?.discoveredCompetitors)
    ? (stage.output.discoveredCompetitors as Competitor[])
    : [];
  return [
    ...new Map(
      [...tracked, ...discovered].filter((item) => item.active).map((item) => [item.id, item]),
    ).values(),
  ];
}

/** Only candidates with evidenced domains are tracked; name-only suggestions remain for manual review. */
export async function discoverAuditCompetitors(input: {
  audit: AiVisibilityAuditRecord;
  project: { domain: string; name: string; brandAliases: string[] };
  referenceAccounts?: string | null;
  observations: ProviderCompetitorObservation[];
}) {
  return db.transaction(async (tx: typeof db) => {
    const [stage] = await tx
      .select()
      .from(aiVisibilityAuditStagesTable)
      .where(
        and(
          eq(aiVisibilityAuditStagesTable.auditId, input.audit.id),
          eq(aiVisibilityAuditStagesTable.stageKey, 'competitor_analysis'),
        ),
      )
      .for('update');
    if (!stage) throw new Error('Competitor analysis stage not found.');
    // Durable checkpoint makes worker retries idempotent, including partial crawl retries.
    if (Array.isArray(stage.output?.discoveredCompetitors)) return stage.output;
    const existing: Competitor[] = await tx
      .select()
      .from(aiVisibilityCompetitorsTable)
      .where(
        and(
          eq(aiVisibilityCompetitorsTable.projectId, input.audit.projectId),
          eq(aiVisibilityCompetitorsTable.userId, input.audit.userId),
        ),
      );
    const suggestions = buildCompetitorSuggestions({
      referenceAccounts: input.referenceAccounts,
      observations: input.observations,
      projectDomain: input.project.domain,
      projectNames: [input.project.name, ...input.project.brandAliases],
      existingCompetitors: existing, // Includes disabled competitors: never re-enable a user's exclusion.
    });
    const discoveredCompetitors: Competitor[] = [];
    const discoveryLimit = Math.min(
      AUTOMATIC_COMPETITOR_LIMIT,
      Math.max(0, Number(input.audit.inputSnapshot.competitorDiscoveryLimit) || 0),
    );
    for (const suggestion of suggestions.filter((item) => item.domain).slice(0, discoveryLimit)) {
      const [competitor] = await tx
        .insert(aiVisibilityCompetitorsTable)
        .values({
          userId: input.audit.userId,
          projectId: input.audit.projectId,
          name: suggestion.name,
          domain: suggestion.domain!,
          aliases: suggestion.aliases,
        })
        .onConflictDoNothing()
        .returning();
      if (competitor) discoveredCompetitors.push(competitor);
    }
    const output = {
      ...stage.output,
      discoveredCompetitors,
      discoverySuggestions: suggestions,
      discovery: discoveredCompetitors.length ? 'discovered' : 'no_verified_candidates',
      discoveryLimit,
    };
    await tx
      .update(aiVisibilityAuditStagesTable)
      .set({ output })
      .where(eq(aiVisibilityAuditStagesTable.id, stage.id));
    return output;
  });
}
