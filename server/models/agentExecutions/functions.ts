import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentExecutionsTable, type AgentExecution, type InsertAgentExecution } from "./schema";

export async function createAgentExecution(data: InsertAgentExecution): Promise<AgentExecution> {
  const [execution] = await db.insert(agentExecutionsTable).values(data).returning();
  return execution;
}

export async function updateAgentExecution(
  id: string,
  updates: Partial<InsertAgentExecution>
): Promise<AgentExecution | undefined> {
  const [updated] = await db
    .update(agentExecutionsTable)
    .set(updates)
    .where(eq(agentExecutionsTable.id, id))
    .returning();
  return updated;
}

