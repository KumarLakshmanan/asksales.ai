import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { agentsTable, type Agent, type InsertAgent } from "./schema";

export async function createAgent(data: InsertAgent): Promise<Agent> {
  const [agent] = await db.insert(agentsTable).values(data).returning();
  return agent;
}

export async function getAgentById(id: string): Promise<Agent | undefined> {
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
  return agent;
}

export async function getAgentsByUserId(userId: number): Promise<Agent[]> {
  return db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
}

export async function getAgentByTypeAndUserId(userId: number, agentType: string): Promise<Agent | undefined> {
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.userId, userId), eq(agentsTable.agentType, agentType)));
  return agent;
}

export async function updateAgentStatus(id: string, status: string): Promise<Agent> {
  const [agent] = await db
    .update(agentsTable)
    .set({ status })
    .where(eq(agentsTable.id, id))
    .returning();
  return agent;
}

export async function deleteAgent(id: string): Promise<void> {
  await db.delete(agentsTable).where(eq(agentsTable.id, id));
}
