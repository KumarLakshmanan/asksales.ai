import { db } from "../db.js";
import { agentAuditLogsTable } from "./schema.js";

export async function createAgentAuditLog(values: typeof agentAuditLogsTable.$inferInsert) {
  try {
    const result = await db.insert(agentAuditLogsTable).values(values).returning();
    return result[0];
  } catch (err) {
    // Audit logs should be robust and not crash request thread if db fails
    console.error("Failed to write agent audit log", err);
    return null;
  }
}

