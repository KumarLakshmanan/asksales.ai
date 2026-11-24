import { eq, and } from "drizzle-orm";
import { db } from "../db.js";
import { aiAgentConfigsTable, InsertAiAgentConfig, AiAgentConfigRecord } from "./schema.js";

export async function getAiAgentConfigs(userId: number): Promise<AiAgentConfigRecord[]> {
  return db
    .select()
    .from(aiAgentConfigsTable)
    .where(eq(aiAgentConfigsTable.userId, userId));
}

export async function getAiAgentConfigByType(userId: number, agentType: string): Promise<AiAgentConfigRecord | undefined> {
  const result = await db
    .select()
    .from(aiAgentConfigsTable)
    .where(and(eq(aiAgentConfigsTable.userId, userId), eq(aiAgentConfigsTable.agentType, agentType)))
    .limit(1);
  return result[0];
}

/** The account has one authoritative outreach agent at runtime. */
export async function getActiveAiAgentConfig(userId: number): Promise<AiAgentConfigRecord | undefined> {
  const result = await db
    .select()
    .from(aiAgentConfigsTable)
    .where(and(eq(aiAgentConfigsTable.userId, userId), eq(aiAgentConfigsTable.enabled, true)))
    .limit(1);
  return result[0];
}

export async function upsertAiAgentConfig(
  data: InsertAiAgentConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executor?: any,
): Promise<AiAgentConfigRecord> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const perform = async (tx: any) => {
    const result = await tx
      .insert(aiAgentConfigsTable)
      .values(data)
      .onConflictDoUpdate({
        target: [aiAgentConfigsTable.businessProfileId, aiAgentConfigsTable.userId, aiAgentConfigsTable.agentType],
        set: {
          enabled: data.enabled,
          displayName: data.displayName,
          description: data.description,
          systemPrompt: data.systemPrompt,
          toolsEnabled: data.toolsEnabled,
          escalationRules: data.escalationRules,
          modelOverride: data.modelOverride,
          channelScope: data.channelScope,
          priority: data.priority,
          metadata: data.metadata,
          templateVersion: data.templateVersion,
          templateMode: data.templateMode,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  };
  if (executor) return perform(executor);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.transaction(async (tx: any) => perform(tx));
}
