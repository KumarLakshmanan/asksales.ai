import { db } from "../db";
import { strategyOptionsTable, type StrategyOptionRecord, type InsertStrategyOption } from "./schema";
import { and, eq, getTableColumns } from "drizzle-orm";
import { workflowSessionsTable } from "../workflowSessions/schema";

export class StrategyOptionModel {
  static async findAllForUser(userId: number): Promise<StrategyOptionRecord[]> {
    return await db
      .select({ ...getTableColumns(strategyOptionsTable) })
      .from(strategyOptionsTable)
      .innerJoin(workflowSessionsTable, eq(strategyOptionsTable.workflowId, workflowSessionsTable.id))
      .where(eq(workflowSessionsTable.userId, userId));
  }

  static async findByIdForUser(id: number, userId: number): Promise<StrategyOptionRecord | undefined> {
    const result = await db
      .select({ ...getTableColumns(strategyOptionsTable) })
      .from(strategyOptionsTable)
      .innerJoin(workflowSessionsTable, eq(strategyOptionsTable.workflowId, workflowSessionsTable.id))
      .where(and(eq(strategyOptionsTable.id, id), eq(workflowSessionsTable.userId, userId)))
      .limit(1);
    return result[0];
  }

  static async findByWorkflowIdForUser(workflowId: string, userId: number): Promise<StrategyOptionRecord[]> {
    return await db
      .select({ ...getTableColumns(strategyOptionsTable) })
      .from(strategyOptionsTable)
      .innerJoin(workflowSessionsTable, eq(strategyOptionsTable.workflowId, workflowSessionsTable.id))
      .where(and(eq(strategyOptionsTable.workflowId, workflowId), eq(workflowSessionsTable.userId, userId)));
  }

  static async createForUser(userId: number, data: InsertStrategyOption): Promise<StrategyOptionRecord | undefined> {
    if (!data.workflowId) return undefined;

    const [workflow] = await db
      .select({ id: workflowSessionsTable.id })
      .from(workflowSessionsTable)
      .where(and(eq(workflowSessionsTable.id, data.workflowId), eq(workflowSessionsTable.userId, userId)))
      .limit(1);
    if (!workflow) return undefined;

    const result = await db.insert(strategyOptionsTable).values(data).returning();
    return result[0];
  }

  static async updateForUser(
    id: number,
    userId: number,
    data: Partial<InsertStrategyOption>,
  ): Promise<StrategyOptionRecord | undefined> {
    const current = await this.findByIdForUser(id, userId);
    if (!current) return undefined;

    const targetWorkflowId = data.workflowId ?? current.workflowId;
    if (!targetWorkflowId) return undefined;

    const [workflow] = await db
      .select({ id: workflowSessionsTable.id })
      .from(workflowSessionsTable)
      .where(and(eq(workflowSessionsTable.id, targetWorkflowId), eq(workflowSessionsTable.userId, userId)))
      .limit(1);
    if (!workflow) return undefined;

    const result = await db.update(strategyOptionsTable).set(data).where(eq(strategyOptionsTable.id, id)).returning();
    return result[0];
  }
}
