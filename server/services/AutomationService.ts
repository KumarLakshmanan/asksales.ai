import { db } from '../models/db';
import { crmPipelineAutomationsTable } from '../models/crmPipelineAutomations/schema';
import { crmAutomationLogsTable } from '../models/crmAutomationLogs/schema';
import { crmContactsTable } from '../models/crmContacts/schema';
import { eq, and, desc, sql, count, max, isNull } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { supportService } from './SupportService';
import { legacyAutomationDefinition, validateAutomationDefinition, type AutomationDefinition } from '../../shared/crmAutomations.js';
import { automationScope, automationRuntimeEnabled, legacyAutomationEvaluationAllowed, AutomationConfigurationError, protectAutomationDefinition, publicAutomationDefinition, validateAutomationForSave } from './automations/AutomationConfiguration.js';
import { getCrmConfiguration } from './CRMConfigurationService.js';

interface AutomationInput {
  name: string; description?: string; definition?: AutomationDefinition; revision?: number;
  triggerType?: string; triggerConfig?: Record<string,unknown>; action?: string; actionConfig?: Record<string,unknown>;
  condition?: Record<string,unknown>; conditions?: Record<string,unknown>; priority?: number; isActive?: boolean;
}
function exposeAutomation(row: typeof crmPipelineAutomationsTable.$inferSelect) {
  const definition=publicAutomationDefinition(row.definition || legacyAutomationDefinition(row));
  return {...row,definition,triggerConfig:definition.trigger.config,actionConfig:definition.actions[0]?.config || {}};
}

class AutomationService {
  private static instance: AutomationService;

  static getInstance(): AutomationService {
    if (!this.instance) this.instance = new AutomationService();
    return this.instance;
  }

  async createAutomation(userId: number, data: AutomationInput) {
    const scope=automationScope(userId);
    const definition=data.definition || legacyAutomationDefinition({triggerType:data.triggerType || '',triggerConfig:data.triggerConfig,
      action:data.action || '',actionConfig:data.actionConfig,condition:data.condition || data.conditions});
    const errors=validateAutomationDefinition(definition);
    if (errors.length) throw new AutomationConfigurationError(errors.join(' '));
    const automation=await db.transaction(async(tx:typeof db)=>{
      await getCrmConfiguration(userId,tx,true);
      await validateAutomationForSave(userId,definition,false);
      const protectedDefinition=protectAutomationDefinition(definition);
      const [created]=await tx.insert(crmPipelineAutomationsTable).values({
      userId,businessProfileId:scope.businessProfileId,
      name: data.name,
      description: data.description || null,
      triggerType: definition.trigger.type,
      triggerConfig: definition.trigger.config,
      action: definition.actions[0].type,
      actionConfig: protectedDefinition.actions[0].config,
      condition: data.condition || data.conditions || {},
      definition:protectedDefinition,revision:1,
      priority: data.priority || 0,
      isActive: false,
    }).returning();
      return created;
    });

    logger.info({ userId, automationId: automation.id }, 'Pipeline automation created');
    return exposeAutomation(automation);
  }

  async getAutomations(userId: number) {
    const scope=automationScope(userId);
    const [automations, executionStats] = await Promise.all([
      db.select().from(crmPipelineAutomationsTable)
      .where(and(eq(crmPipelineAutomationsTable.userId, userId),eq(crmPipelineAutomationsTable.businessProfileId,scope.businessProfileId),isNull(crmPipelineAutomationsTable.deletedAt)))
      .orderBy(desc(crmPipelineAutomationsTable.priority)),
      db.select({
        automationId: crmAutomationLogsTable.automationId,
        executionCount: count(),
        lastRunAt: max(crmAutomationLogsTable.executedAt),
      }).from(crmAutomationLogsTable)
        .where(and(eq(crmAutomationLogsTable.userId, userId),eq(crmAutomationLogsTable.businessProfileId,scope.businessProfileId)))
        .groupBy(crmAutomationLogsTable.automationId),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statsByAutomation = new Map(executionStats.map((row: any) => [row.automationId, row]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return automations.map((automation: any) => ({
      ...exposeAutomation(automation),
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      executionCount: Number(statsByAutomation.get(automation.id)?.executionCount ?? 0),
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      lastRunAt: statsByAutomation.get(automation.id)?.lastRunAt ?? null,
    }));
  }

  async updateAutomation(userId: number, automationId: number, data: Partial<AutomationInput>) {
    const scope=automationScope(userId);
    return db.transaction(async(tx:typeof db)=>{
      await getCrmConfiguration(userId,tx,true);
      const [existing]=await tx.select().from(crmPipelineAutomationsTable).where(and(eq(crmPipelineAutomationsTable.id,automationId),
        eq(crmPipelineAutomationsTable.userId,userId),eq(crmPipelineAutomationsTable.businessProfileId,scope.businessProfileId),isNull(crmPipelineAutomationsTable.deletedAt))).limit(1).for('update');
      if (!existing) return null;
      if (data.revision!==undefined && data.revision!==existing.revision) throw new AutomationConfigurationError('This automation changed. Reload it before saving.',409);
      const legacyChanged=['triggerType','triggerConfig','action','actionConfig','condition','conditions'].some(key=>Object.hasOwn(data,key));
      let definition=data.definition || existing.definition || legacyAutomationDefinition(existing);
      if (!data.definition && legacyChanged) {
        definition=structuredClone(definition);
        if (data.triggerType!==undefined) definition.trigger.type=data.triggerType;
        if (data.triggerConfig!==undefined) definition.trigger.config=legacyAutomationDefinition({...existing,triggerConfig:data.triggerConfig}).trigger.config;
        if (data.action!==undefined) definition.actions[0].type=data.action as typeof definition.actions[0]['type'];
        if (data.actionConfig!==undefined) definition.actions[0].config=data.actionConfig;
      }
      const errors=validateAutomationDefinition(data.definition || publicAutomationDefinition(definition));
      if (errors.length) throw new AutomationConfigurationError(errors.join(' '));
      const active=data.isActive ?? existing.isActive ?? false;
      if (active && !await automationRuntimeEnabled()) {
        if (data.definition || legacyChanged) throw new AutomationConfigurationError('Pause this automation before changing its steps. The new engine is not enabled yet.');
        if (data.isActive===true && !existing.isActive) throw new AutomationConfigurationError('Automation execution is not available yet. Your saved rule can remain paused.');
      }
      await validateAutomationForSave(userId,definition,active);
      if (data.definition || legacyChanged) definition=protectAutomationDefinition(data.definition ? definition : publicAutomationDefinition(definition),existing.definition || undefined);
      const [updated]=await tx.update(crmPipelineAutomationsTable).set({name:data.name ?? existing.name,description:data.description ?? existing.description,
        priority:data.priority ?? existing.priority,isActive:active,definition,revision:existing.revision+1,
        triggerType:definition.trigger.type,triggerConfig:definition.trigger.config,action:definition.actions[0].type,actionConfig:definition.actions[0].config,
        condition:data.condition || data.conditions || existing.condition,updatedAt:new Date()}).where(eq(crmPipelineAutomationsTable.id,automationId)).returning();
      return exposeAutomation(updated);
    });
  }

  async deleteAutomation(userId: number, automationId: number) {
    const scope=automationScope(userId);
    const deleted = await db.update(crmPipelineAutomationsTable).set({isActive:false,deletedAt:new Date(),updatedAt:new Date()})
      .where(and(eq(crmPipelineAutomationsTable.id, automationId), eq(crmPipelineAutomationsTable.userId, userId),eq(crmPipelineAutomationsTable.businessProfileId,scope.businessProfileId),isNull(crmPipelineAutomationsTable.deletedAt)))
      .returning({ id: crmPipelineAutomationsTable.id });
    return deleted.length > 0;
  }

  async getAutomation(userId:number,id:number) {
    const scope=automationScope(userId);
    const [row]=await db.select().from(crmPipelineAutomationsTable).where(and(eq(crmPipelineAutomationsTable.id,id),eq(crmPipelineAutomationsTable.userId,userId),
      eq(crmPipelineAutomationsTable.businessProfileId,scope.businessProfileId),isNull(crmPipelineAutomationsTable.deletedAt))).limit(1);
    return row ? exposeAutomation(row) : null;
  }

  // Trigger evaluation on status change
  async evaluateTriggers(userId: number, contactId: number, event: {
    type: string; // 'status_change' | 'sentiment_change' | 'deal_value_change'
    oldValue?: string;
    newValue?: string;
  }, recovery?: { beforeActions: () => Promise<boolean> }) {
    // The committed database event replaces inline evaluation at the cutover.
    if (!await legacyAutomationEvaluationAllowed()) return { mode: 'durable' as const };
    const scope=automationScope(userId);
    const automations = await db.select().from(crmPipelineAutomationsTable)
      .where(and(
        eq(crmPipelineAutomationsTable.userId, userId),
        eq(crmPipelineAutomationsTable.businessProfileId, scope.businessProfileId),
        eq(crmPipelineAutomationsTable.isActive, true),
        eq(crmPipelineAutomationsTable.triggerType, event.type)
      ))
      .orderBy(desc(crmPipelineAutomationsTable.priority));

    if (recovery && !await recovery.beforeActions()) return { mode: 'claimed' as const };
    let failed = false;
    for (const automation of automations) {
      const matches = this.matchesTrigger(automation, event);
      if (!matches) continue;

      try {
        await this.executeAction(userId, contactId, automation);
        await this.logExecution(automation.id, userId, contactId, automation.action, 'success');
      } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ err: error, automationId: automation.id }, 'Automation execution failed');
        await this.logExecution(automation.id, userId, contactId, automation.action, 'failed', message);
      }
    }
    return { mode: 'legacy' as const, failed };
  }

  private matchesTrigger(automation: typeof crmPipelineAutomationsTable.$inferSelect, event: {
    type: string;
    oldValue?: string;
    newValue?: string;
  }): boolean {
    const config = automation.triggerConfig as Record<string, unknown>;

    // Check if trigger config specifies particular from/to values
    if (config.fromStatus && config.fromStatus !== event.oldValue) return false;
    if (config.toStatus && config.toStatus !== event.newValue) return false;
    if (config.sentiment && config.sentiment !== event.newValue) return false;

    // Check condition if present
    const condition = automation.condition as Record<string, unknown>;
    if (condition.minDealValue != null && event.type === 'deal_value_change') {
      // Reject the event if the new value is below the configured floor.
      const floor = Number(condition.minDealValue);
      const newValue = Number((event as { newValue?: unknown }).newValue);
      if (Number.isFinite(floor) && Number.isFinite(newValue) && newValue < floor) {
        return false;
      }
    }

    return true;
  }

  private async executeAction(userId: number, contactId: number, automation: typeof crmPipelineAutomationsTable.$inferSelect) {
    const actionConfig = automation.actionConfig as Record<string, unknown>;

    switch (automation.action) {
      case 'update_status': {
        const newStatus = actionConfig.status as string;
        if (newStatus) {
          await db.update(crmContactsTable)
            .set({ status: newStatus, updatedAt: new Date() })
            .where(and(eq(crmContactsTable.id, contactId), eq(crmContactsTable.userId, userId)));
        }
        break;
      }
      case 'update_pipeline_status': {
        const pipelineStatus = actionConfig.pipelineStatus as string;
        if (pipelineStatus) {
          // Use the same path as manual moves so lead status, activity and alerts
          // stay consistent. Trigger evaluation remains in the controller to
          // prevent rule actions from recursively invoking themselves.
          const { crmService } = await import('./CRMService.js');
          const contact = await crmService.updatePipelineStatus(userId, contactId, pipelineStatus);
          if (!contact) throw new Error('Contact not found');
        }
        break;
      }
      case 'create_ticket': {
        const subject = (actionConfig.subject as string) || 'Auto-generated support ticket';
        await supportService.createTicket(userId, {
          contactId,
          subject,
          description: (actionConfig.description as string) || undefined,
          priority: (actionConfig.priority as string) || 'medium',
          tags: ['automation-created'],
        });
        break;
      }
      case 'update_tags': {
        const tags = actionConfig.tags as string[] | undefined;
        if (tags && tags.length > 0) {
          // Phase 5.13 / SERV-004: dedupe before merging so the JSONB array
          // doesn't accumulate duplicates on repeated automation runs.
          const uniqueTags = Array.from(new Set(tags));
          await db.update(crmContactsTable)
            .set({
              tags: sql`(
                SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
                FROM jsonb_array_elements(COALESCE(${crmContactsTable.tags}, '[]'::jsonb) || ${JSON.stringify(uniqueTags)}::jsonb) AS v
              )`,
              updatedAt: new Date(),
            })
            .where(and(eq(crmContactsTable.id, contactId), eq(crmContactsTable.userId, userId)));
        }
        break;
      }
      case 'assign_user': {
        const assignedTo = actionConfig.assignedTo as number;
        if (assignedTo) {
          await db.update(crmContactsTable)
            .set({ assignedTo, updatedAt: new Date() })
            .where(and(eq(crmContactsTable.id, contactId), eq(crmContactsTable.userId, userId)));
        }
        break;
      }
      default:
        throw new Error(`Unsupported automation action: ${automation.action}`);
    }
  }

  private async logExecution(automationId: number, userId: number, contactId: number, action: string, result: string, errorMessage?: string) {
    await db.insert(crmAutomationLogsTable).values({
      automationId,
      userId,
      contactId,
      actionTaken: action,
      result,
      errorMessage: errorMessage || null,
    });
  }

  async getAutomationLogs(userId: number, automationId?: number) {
    const scope=automationScope(userId);
    const conditions = [eq(crmAutomationLogsTable.userId, userId),eq(crmAutomationLogsTable.businessProfileId,scope.businessProfileId)];
    if (automationId) conditions.push(eq(crmAutomationLogsTable.automationId, automationId));

    return db.select({
      id: crmAutomationLogsTable.id,
      automationId: crmAutomationLogsTable.automationId,
      automationName: sql<string>`COALESCE(${crmAutomationLogsTable.metadata}->>'automationName',${crmPipelineAutomationsTable.name})`,
      triggerType: crmPipelineAutomationsTable.triggerType,
      action: crmAutomationLogsTable.actionTaken,
      contactId: crmAutomationLogsTable.contactId,
      contactName: sql<string>`TRIM(CONCAT(COALESCE(${crmContactsTable.firstName}, ''), ' ', COALESCE(${crmContactsTable.lastName}, '')))`,
      success: sql<boolean>`${crmAutomationLogsTable.result} = 'success'`,
      status:crmAutomationLogsTable.result,
      runId:sql<number>`(${crmAutomationLogsTable.metadata}->>'runId')::integer`,
      errorMessage: crmAutomationLogsTable.errorMessage,
      executedAt: crmAutomationLogsTable.executedAt,
    }).from(crmAutomationLogsTable)
      .innerJoin(crmPipelineAutomationsTable, eq(crmPipelineAutomationsTable.id, crmAutomationLogsTable.automationId))
      .leftJoin(crmContactsTable, and(
        eq(crmContactsTable.id, crmAutomationLogsTable.contactId),
        eq(crmContactsTable.userId, userId),
      ))
      .where(and(...conditions))
      .orderBy(desc(crmAutomationLogsTable.executedAt))
      .limit(100);
  }
}

export const automationService = AutomationService.getInstance();
