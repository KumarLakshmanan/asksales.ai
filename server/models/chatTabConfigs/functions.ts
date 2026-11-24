import { db } from "../db";
import { chatTabConfigsTable } from "./schema";
import { and, eq, sql } from "drizzle-orm";
import { logger } from '../../utils/logger.js';

/**
 * Save tab configuration for a chat thread
 * Uses upsert (INSERT ... ON CONFLICT DO UPDATE) to handle race conditions
 */
export async function saveChatTabConfig(
  threadId: number,
  tabId: string,
  tabType: string,
  tabLabel: string,
  tabOrder: number,
  isActive: boolean,
  tabData: Record<string, unknown> = {},
) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT id FROM chat_threads WHERE id = ${threadId} FOR UPDATE`);
      if (isActive) {
        await tx
          .update(chatTabConfigsTable)
          .set({ isActive: 0, updatedAt: new Date() })
          .where(eq(chatTabConfigsTable.threadId, threadId));
      }

      return tx
        .insert(chatTabConfigsTable)
        .values({
          threadId,
          tabId,
          tabType,
          tabLabel,
          tabOrder,
          isActive: isActive ? 1 : 0,
          tabData,
        })
        .onConflictDoUpdate({
          target: [chatTabConfigsTable.threadId, chatTabConfigsTable.tabId],
          set: {
            tabType,
            tabLabel,
            tabOrder,
            isActive: isActive ? 1 : 0,
            tabData,
            updatedAt: new Date(),
          },
        })
        .returning();
    });
  } catch (error) {
    logger.error({ err: error }, "Error saving chat tab config:");
    throw error;
  }
}

/**
 * Get all tab configurations for a chat thread
 */
export async function getChatTabConfigs(threadId: number) {
  try {
    const configs = await db
      .select()
      .from(chatTabConfigsTable)
      .where(eq(chatTabConfigsTable.threadId, threadId))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .orderBy((t: any) => t.tabOrder);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const legacyAliases: Record<string, string> = {
      'lead-config': 'leadconfig',
      leadInputs: 'lead-inputs',
      contentstudio: 'content-studio',
      'content-media': 'content-image',
    };
    return configs.map((config: any) => ({
      tabId: config.tabId,
      tabType: legacyAliases[config.tabType] || config.tabType,
      tabLabel: config.tabLabel,
      tabOrder: config.tabOrder,
      isActive: config.isActive === 1,
      tabData: config.tabData || {},
      closeable: true, // All tabs are closeable by default
    }));
  } catch (error) {
    logger.error({ err: error }, "Error getting chat tab configs:");
    throw error;
  }
}

/**
 * Delete tab configuration
 */
export async function deleteChatTabConfig(threadId: number, tabId: string) {
  try {
    return await db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT id FROM chat_threads WHERE id = ${threadId} FOR UPDATE`);
      return tx
        .delete(chatTabConfigsTable)
        .where(and(
          eq(chatTabConfigsTable.threadId, threadId),
          eq(chatTabConfigsTable.tabId, tabId),
        ))
        .returning();
    });
  } catch (error) {
    logger.error({ err: error }, "Error deleting chat tab config:");
    throw error;
  }
}

/**
 * Replace all tab configurations for a thread with new ones
 */
export async function replaceChatTabConfigs(threadId: number, tabs: Array<{
  tabId: string;
  tabType: string;
  tabLabel: string;
  tabOrder: number;
  isActive: boolean;
  tabData?: Record<string, unknown>;
}>) {
  try {
    // Use a transaction to ensure atomicity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT id FROM chat_threads WHERE id = ${threadId} FOR UPDATE`);
      // Delete all existing tabs for this thread
      await tx
        .delete(chatTabConfigsTable)
        .where(eq(chatTabConfigsTable.threadId, threadId));

      // Insert new tabs
      if (tabs.length > 0) {
        const requestedActiveTab = tabs.find(tab => tab.isActive)?.tabId || tabs[0].tabId;
        const values = tabs.map(tab => ({
          threadId,
          tabId: tab.tabId,
          tabType: tab.tabType,
          tabLabel: tab.tabLabel,
          tabOrder: tab.tabOrder,
          isActive: tab.tabId === requestedActiveTab ? 1 : 0,
          tabData: tab.tabData || {},
        }));

        return await tx
          .insert(chatTabConfigsTable)
          .values(values)
          .returning();
      }

      return [];
    });
  } catch (error) {
    logger.error({ err: error }, "Error replacing chat tab configs:");
    throw error;
  }
}

/**
 * Update active tab for a thread
 */
export async function updateActiveTab(threadId: number, activeTabId: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT id FROM chat_threads WHERE id = ${threadId} FOR UPDATE`);
      const [existing] = await tx
        .select({ id: chatTabConfigsTable.id })
        .from(chatTabConfigsTable)
        .where(and(
          eq(chatTabConfigsTable.threadId, threadId),
          eq(chatTabConfigsTable.tabId, activeTabId),
        ))
        .limit(1);

      if (!existing) return null;

      await tx
        .update(chatTabConfigsTable)
        .set({ isActive: 0, updatedAt: new Date() })
        .where(eq(chatTabConfigsTable.threadId, threadId));

      return tx
        .update(chatTabConfigsTable)
        .set({ isActive: 1, updatedAt: new Date() })
        .where(eq(chatTabConfigsTable.id, existing.id))
        .returning();
    });
  } catch (error) {
    logger.error({ err: error }, "Error updating active tab:");
    throw error;
  }
}
