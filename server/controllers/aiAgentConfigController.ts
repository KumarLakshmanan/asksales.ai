import { assertBusinessConfigurationOwner } from '../tenancy/businessContext.js';
import { readFile } from 'node:fs/promises';
import { withDemoParseCredits } from '../services/agents/demoParseCredits.js';
import { authorizeBusinessOwner } from '../middleware/businessPermissions.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { Request, Response } from "express";
import { getAiAgentConfigs, getAiAgentConfigByType, upsertAiAgentConfig } from "../models/aiAgentConfigs/functions.js";
import { isHighRiskSupportTool, SUPPORT_TOOL_NAMES } from "../services/agents/orchestration/SafeToolExecutor.js";
import { db } from "../models/db.js";
import { aiAgentConfigsTable, supportAgentTemplatesTable } from "../models/aiAgentConfigs/schema.js";
import { and, eq, sql } from "drizzle-orm";
import { toolApprovalsTable } from "../models/toolApprovals/schema.js";
import { recordSupportAdminAudit } from "../services/agents/orchestration/SupportAdminAuditService.js";
import { enforceMandatoryAgentControls, SUPPORT_AGENT_TYPES } from "../services/agents/orchestration/DefaultSupportConfiguration.js";
import { ensureDefaultSupportConfiguration } from "../services/agents/orchestration/DefaultSupportProvisioningService.js";
import { resetTenantAgentToTemplate } from "../services/agents/orchestration/SupportAgentTemplateService.js";
import { logger } from "../utils/logger.js";
import { SUPPORT_POLICY_CHANNELS, validatePolicyRules } from '../services/agents/pipeline/PolicyRuleSchema.js';
import { validateSupportAgentMetadata } from '../services/agents/orchestration/SupportAgentConfigurationSchema.js';
import { isDeepStrictEqual } from 'node:util';
import { asRecord as metadataRecord } from "../../shared/records.js";

const SUPPORTED_AGENT_TYPES = new Set<string>(SUPPORT_AGENT_TYPES);

/** Treat metadata saves as patches and ignore unchanged legacy fields. */
function metadataPatchFrom(existingValue: unknown, incomingValue: unknown): Record<string, unknown> {
  const existing = metadataRecord(existingValue);
  const incoming = metadataRecord(incomingValue);
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'platformAutoReplies' && value && typeof value === 'object' && !Array.isArray(value)) {
      const currentPlatforms = metadataRecord(existing.platformAutoReplies);
      const changedPlatforms = Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([platform, enabled]) => !isDeepStrictEqual(currentPlatforms[platform], enabled)),
      );
      if (Object.keys(changedPlatforms).length) patch[key] = changedPlatforms;
      continue;
    }
    if (!isDeepStrictEqual(existing[key], value)) patch[key] = value;
  }
  return patch;
}

function mergeAgentMetadata(
  existingValue: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const existing = metadataRecord(existingValue);
  const platformPatch = patch.platformAutoReplies;
  return {
    ...existing,
    ...patch,
    ...(platformPatch && typeof platformPatch === 'object' && !Array.isArray(platformPatch)
      ? {
          platformAutoReplies: {
            ...metadataRecord(existing.platformAutoReplies),
            ...metadataRecord(platformPatch),
          },
        }
      : {}),
  };
}

function agentConfigListItem(config: typeof aiAgentConfigsTable.$inferSelect, currentVersion?: number | null) {
  if (config.enabled) return { ...config, templateCurrentVersion: currentVersion ?? null };
  return {
    id: config.id,
    userId: config.userId,
    agentType: config.agentType,
    enabled: false,
    displayName: config.displayName,
    description: config.description,
    priority: config.priority,
    templateVersion: config.templateVersion,
    templateCurrentVersion: currentVersion ?? null,
    templateMode: config.templateMode,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

export async function activateAgentForUser(userId: number, agentType: string) {
  assertBusinessConfigurationOwner(userId);
  if (!SUPPORTED_AGENT_TYPES.has(agentType)) {
    const error = new Error('Unsupported agent type') as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  await ensureDefaultSupportConfiguration(userId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.transaction(async (tx: any) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20260813, ${userId})`);
    const configs = await tx.select().from(aiAgentConfigsTable)
      .where(eq(aiAgentConfigsTable.userId, userId));
    const target = configs.find((config: typeof aiAgentConfigsTable.$inferSelect) => config.agentType === agentType);
    if (!target) {
      const error = new Error('Agent config not found') as Error & { status?: number };
      error.status = 404;
      throw error;
    }
    const previous = configs.find((config: typeof aiAgentConfigsTable.$inferSelect) => config.enabled) || null;
    if (previous?.id === target.id) return target;

    // Clear first so the partial unique index remains valid throughout the
    // transaction, then enable the selected configuration.
    await tx.update(aiAgentConfigsTable).set({ enabled: false, updatedAt: new Date() })
      .where(and(eq(aiAgentConfigsTable.userId, userId), eq(aiAgentConfigsTable.enabled, true)));
    const [activated] = await tx.update(aiAgentConfigsTable).set({ enabled: true, updatedAt: new Date() })
      .where(eq(aiAgentConfigsTable.id, target.id)).returning();

    if (previous) {
      await tx.execute(sql`
        UPDATE support_playbook_runs run
        SET status = 'superseded',
            completed_at = COALESCE(completed_at, NOW()),
            state = COALESCE(state, '{}'::jsonb) || jsonb_build_object('supersededByAgentType', ${agentType}::text),
            updated_at = NOW()
        FROM support_playbooks playbook
        WHERE run.playbook_id = playbook.id
          AND run.user_id = ${userId}
          AND run.status = 'active'
          AND playbook.agent_type IS DISTINCT FROM ${agentType}
      `);
      await tx.update(toolApprovalsTable).set({
        status: 'expired', isExpired: true, resumeStatus: 'cancelled', updatedAt: new Date(),
      }).where(sql`
        ${toolApprovalsTable.userId} = ${userId}
        AND ${toolApprovalsTable.agentType} IS DISTINCT FROM ${agentType}
        AND ${toolApprovalsTable.status} IN ('pending', 'approved')
        AND ${toolApprovalsTable.consumedAt} IS NULL
      `);
      await recordSupportAdminAudit(tx, {
        userId, actorType: 'owner', actorId: userId,
        action: 'agent_config.deactivate', entityType: 'ai_agent_config', entityId: previous.id,
        beforeState: previous, afterState: { ...previous, enabled: false },
        metadata: { replacementAgentType: agentType },
      });
    }
    await recordSupportAdminAudit(tx, {
      userId, actorType: 'owner', actorId: userId,
      action: 'agent_config.activate', entityType: 'ai_agent_config', entityId: activated.id,
      beforeState: target, afterState: activated,
      metadata: { previousAgentType: previous?.agentType ?? null },
    });
    return activated;
  });
}

export async function activateAgentConfig(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const agentType = String(req.body?.agentType || '');
  try {
    const active = await activateAgentForUser(userId, agentType);
    const configs = await getAiAgentConfigs(userId);
    return res.json({ activeAgent: active, agents: configs.map((config) => agentConfigListItem(config)) });
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500;
    if (status < 500) return res.status(status).json({ error: error instanceof Error ? error.message : 'Unable to activate agent' });
    logger.error({ err: error }, '[AiAgentConfig] Failed to activate agent');
    return res.status(500).json({ error: 'Failed to activate AI agent' });
  }
}

export async function listAgentConfigs(req: Request, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    await ensureDefaultSupportConfiguration(userId);

    const [configs, templates] = await Promise.all([
      getAiAgentConfigs(userId),
      db.select({ agentType: supportAgentTemplatesTable.agentType, version: supportAgentTemplatesTable.version }).from(supportAgentTemplatesTable),
    ]);
    const versions = new Map<string, number>((templates as Array<{ agentType: string; version: number }>).map(
      (template: { agentType: string; version: number }) => [template.agentType, template.version],
    ));
    res.json(configs.map((config) => agentConfigListItem(config, versions.get(config.agentType))));
  } catch (error) {
    logger.error({ err: error }, "[AiAgentConfig] Failed to list agent configurations");
    res.status(500).json({ error: "Failed to fetch AI agent configs" });
  }
}

export async function getAgentConfig(req: Request, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const agentType = req.params.type;
    if (!SUPPORTED_AGENT_TYPES.has(agentType)) return res.status(400).json({ error: "Unsupported agent type" });
    await ensureDefaultSupportConfiguration(userId);
    const config = await getAiAgentConfigByType(userId, agentType);
    if (!config) {
      return res.status(404).json({ error: "Agent config not found" });
    }

    if (!config.enabled) {
      const active = (await getAiAgentConfigs(userId)).find((candidate) => candidate.enabled);
      return res.status(409).json({
        error: 'Only the active outreach agent can be customized.',
        code: 'INACTIVE_AGENT',
        activeAgentType: active?.agentType ?? null,
      });
    }
    const [template] = await db.select({ version: supportAgentTemplatesTable.version })
      .from(supportAgentTemplatesTable).where(eq(supportAgentTemplatesTable.agentType, agentType)).limit(1);
    res.json({ ...config, templateCurrentVersion: template?.version ?? null });
  } catch (error) {
    logger.error({ err: error }, "[AiAgentConfig] Failed to fetch agent configuration");
    res.status(500).json({ error: "Failed to fetch AI agent config" });
  }
}

export async function updateAgentConfig(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const agentType = req.params.type;
    const { enabled, displayName, description, systemPrompt, priority, modelOverride, channelScope, metadata, toolsEnabled, escalationRules } = req.body;
    if (!SUPPORTED_AGENT_TYPES.has(agentType)) {
      return res.status(400).json({ error: "Unsupported agent type" });
    }
    await ensureDefaultSupportConfiguration(userId);
    let existing = await getAiAgentConfigByType(userId, agentType);
    if (!existing) return res.status(404).json({ error: "Agent config not found" });
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    if (enabled === false && existing.enabled) {
      return res.status(409).json({
        error: 'Choose a replacement agent before disabling the active agent.',
        code: 'ACTIVE_AGENT_REPLACEMENT_REQUIRED',
      });
    }
    if (enabled === true && !existing.enabled) {
      await activateAgentForUser(userId, agentType);
      existing = await getAiAgentConfigByType(userId, agentType);
      if (!existing) return res.status(404).json({ error: 'Agent config not found' });
    }
    if (!existing.enabled) {
      const active = (await getAiAgentConfigs(userId)).find((candidate) => candidate.enabled);
      return res.status(409).json({
        error: 'Only the active outreach agent can be customized.',
        code: 'INACTIVE_AGENT',
        activeAgentType: active?.agentType ?? null,
      });
    }
    if (displayName !== undefined && (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 160)) {
      return res.status(400).json({ error: 'displayName must be between 1 and 160 characters' });
    }
    if (description !== undefined && (typeof description !== 'string' || description.length > 2000)) {
      return res.status(400).json({ error: 'description must be at most 2000 characters' });
    }
    if (systemPrompt !== undefined && (typeof systemPrompt !== 'string' || !systemPrompt.trim() || systemPrompt.length > 20_000)) {
      return res.status(400).json({ error: 'systemPrompt must be between 1 and 20000 characters' });
    }
    if (priority !== undefined && (!Number.isInteger(priority) || priority < 1 || priority > 1000)) {
      return res.status(400).json({ error: 'priority must be an integer between 1 and 1000' });
    }
    if (modelOverride !== undefined && modelOverride !== null && (
      typeof modelOverride !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(modelOverride)
    )) {
      return res.status(400).json({ error: 'modelOverride is not a valid provider model identifier' });
    }
    if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) {
      return res.status(400).json({ error: 'metadata must be an object' });
    }
    const currentMetadata = metadataRecord(existing.metadata);
    const metadataPatch = metadata === undefined ? undefined : metadataPatchFrom(currentMetadata, metadata);
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const candidate = metadataPatch || {};
      const metadataErrors = validateSupportAgentMetadata(candidate);
      if (metadataErrors.length) {
        return res.status(400).json({ error: 'Agent metadata is invalid', details: metadataErrors });
      }
      if (candidate.autoApproveTools !== undefined && (
        !Array.isArray(candidate.autoApproveTools)
        || candidate.autoApproveTools.some((tool) => typeof tool !== 'string' || !SUPPORT_TOOL_NAMES.has(tool))
      )) {
        return res.status(400).json({ error: 'metadata.autoApproveTools contains an unsupported support tool' });
      }
      if (Array.isArray(candidate.autoApproveTools)
        && candidate.autoApproveTools.some((tool) => typeof tool === 'string' && isHighRiskSupportTool(tool))) {
        return res.status(400).json({ error: 'High-risk support tools cannot be auto-approved' });
      }
      if (candidate.trainingConversations !== undefined) {
        if (!Array.isArray(candidate.trainingConversations) || candidate.trainingConversations.length > 20) {
          return res.status(400).json({ error: 'metadata.trainingConversations must contain at most 20 demonstrations' });
        }
        const invalidDemo = candidate.trainingConversations.some((demo) => {
          if (!demo || typeof demo !== 'object' || Array.isArray(demo)) return true;
          const item = demo as Record<string, unknown>;
          const invalidText = (value: unknown) => value !== undefined
            && (typeof value !== 'string' || value.length > 4000);
          if (invalidText(item.userMessage) || invalidText(item.agentReply)) return true;
          if (item.messages === undefined) return false;
          return !Array.isArray(item.messages)
            || item.messages.length > 20
            || item.messages.some((turn) => {
              if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return true;
              const value = turn as Record<string, unknown>;
              return !['user', 'agent', 'assistant'].includes(String(value.role || ''))
                || typeof value.content !== 'string'
                || value.content.length > 4000;
            });
        });
        if (invalidDemo) {
          return res.status(400).json({ error: 'Training demonstrations contain invalid roles or content over 4000 characters' });
        }
      }
    }
    const allowedChannels = new Set<string>(SUPPORT_POLICY_CHANNELS);
    if (channelScope !== undefined && (
      !Array.isArray(channelScope)
      || channelScope.some((channel: unknown) => typeof channel !== 'string' || !allowedChannels.has(channel))
    )) {
      return res.status(400).json({ error: 'channelScope contains an unsupported channel' });
    }
    if (toolsEnabled !== undefined && (
      !Array.isArray(toolsEnabled)
      || toolsEnabled.some((tool: unknown) => typeof tool !== 'string' || !SUPPORT_TOOL_NAMES.has(tool))
    )) {
      return res.status(400).json({ error: 'toolsEnabled contains an unsupported support tool' });
    }
    const updatedChannelScope = Array.isArray(channelScope)
      ? [...new Set(channelScope.filter((channel: unknown): channel is string => typeof channel === 'string' && allowedChannels.has(channel)))]
      : (Array.isArray(existing.channelScope) ? existing.channelScope : []);
    const mandatoryControls = enforceMandatoryAgentControls(
      agentType,
      Array.isArray(escalationRules) || (escalationRules && typeof escalationRules === 'object')
        ? escalationRules
        : existing.escalationRules ?? {},
      metadataPatch === undefined
        ? currentMetadata
        : mergeAgentMetadata(currentMetadata, metadataPatch),
    );
    const policyErrors = validatePolicyRules(mandatoryControls.escalationRules);
    if (policyErrors.length) {
      return res.status(400).json({
        error: 'Policy rules are invalid',
        details: policyErrors,
      });
    }

    const contentChanged = [displayName, description, systemPrompt, priority, modelOverride, channelScope, metadata, toolsEnabled, escalationRules]
      .some((value) => value !== undefined);
    const updateData = {
      userId,
      agentType,
      enabled: existing.enabled,
      displayName: displayName ?? existing.displayName,
      description: description ?? existing.description,
      systemPrompt: systemPrompt ?? existing.systemPrompt,
      priority: Number.isInteger(priority) ? priority : existing.priority,
      modelOverride: modelOverride ?? existing.modelOverride,
      channelScope: updatedChannelScope,
      metadata: mandatoryControls.metadata,
      toolsEnabled: Array.isArray(toolsEnabled)
        ? [...new Set(toolsEnabled.filter((tool: unknown): tool is string => typeof tool === 'string' && SUPPORT_TOOL_NAMES.has(tool)))]
        : existing.toolsEnabled ?? [],
      escalationRules: mandatoryControls.escalationRules,
      templateVersion: existing.templateVersion,
      templateMode: contentChanged && existing.templateMode === 'managed' ? 'customized' : existing.templateMode,
    };
    
    // Configuration and its immutable audit record commit together.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = await db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(20260813, ${userId})`);
      const [lockedCurrent] = await tx.select().from(aiAgentConfigsTable).where(and(
        eq(aiAgentConfigsTable.userId, userId),
        eq(aiAgentConfigsTable.agentType, agentType),
      )).limit(1);
      if (!lockedCurrent?.enabled) {
        const error = new Error('The active outreach agent changed. Reload before saving this configuration.') as Error & { status?: number };
        error.status = 409;
        throw error;
      }
      updateData.enabled = true;
      const row = await upsertAiAgentConfig(updateData, tx);
      await recordSupportAdminAudit(tx, {
        userId,
        actorType: 'owner',
        actorId: userId,
        action: 'agent_config.update',
        entityType: 'ai_agent_config',
        entityId: row.id,
        beforeState: lockedCurrent,
        afterState: row,
        metadata: { agentType },
      });
      return row;
    });
    res.json(updated);
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500;
    if (status < 500) return res.status(status).json({ error: error instanceof Error ? error.message : 'Unable to update agent' });
    logger.error({ err: error }, "[AiAgentConfig] Failed to update agent configuration");
    res.status(500).json({ error: "Failed to update AI agent config" });
  }
}

export async function resetAgentConfigToAdminTemplate(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const agentType = req.params.type;
    if (!SUPPORTED_AGENT_TYPES.has(agentType)) return res.status(400).json({ error: "Unsupported agent type" });
    await ensureDefaultSupportConfiguration(userId);
    const existing = await getAiAgentConfigByType(userId, agentType);
    if (!existing) return res.status(404).json({ error: 'Agent config not found' });
    if (!existing.enabled) {
      const active = (await getAiAgentConfigs(userId)).find((candidate) => candidate.enabled);
      return res.status(409).json({
        error: 'Only the active outreach agent can be reset.',
        code: 'INACTIVE_AGENT',
        activeAgentType: active?.agentType ?? null,
      });
    }
    const updated = await resetTenantAgentToTemplate(userId, agentType);
    if (!updated) return res.status(404).json({ error: "Agent template not found" });
    return res.json(updated);
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, "[AiAgentConfig] Failed to reset agent configuration");
    return res.status(500).json({ error: "Failed to reset AI agent config" });
  }
}

export async function seedAgentConfigs(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const result = await ensureDefaultSupportConfiguration(userId);
    res.json({
      success: true,
      seeded: result.agentsCreated,
      safetyProfilesUpdated: result.agentsSafetyUpdated,
      templateLinksRepaired: result.agentsTemplateRepaired,
      playbooksSeeded: result.playbooksCreated,
      assignmentsSeeded: result.assignmentsCreated,
      skippedExistingPlaybooks: result.skippedExistingPlaybooks,
    });
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, "[AiAgentConfig] Failed to seed agent configurations");
    res.status(500).json({ error: "Failed to seed AI agent configs" });
  }
}

export async function parseDemoFile(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { DemoParserService } = await import("../services/agents/DemoParserService.js");
    const readBuffer = req.file.buffer || await readFile(req.file.path);
    const messages = await withDemoParseCredits(userId, () => DemoParserService.parseFile(
      req.file!.buffer || readBuffer,
      req.file!.mimetype,
      req.file!.originalname
    ));

    res.json({
      success: true,
      messages,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[AiAgentConfig] Failed to parse training demo file");
    res.status(error.statusCode || 400).json({ error: error.message || "Failed to parse training demo file" });
  }
}

export async function parseKbEntry(req: Request, res: Response) {
  if (!authorizeBusinessOwner(req, res)) return;
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { kbEntryId } = req.body;
    if (!kbEntryId) {
      return res.status(400).json({ error: "kbEntryId is required" });
    }

    const { KnowledgeBaseModel } = await import('../models/knowledgeBase/functions.js');
    const entry = await KnowledgeBaseModel.findById(Number(kbEntryId), userId);
    if (!entry) {
      return res.status(404).json({ error: "Knowledge base entry not found" });
    }
    
    // Resolve content
    let textContent = "";
    if (entry.type === "qa") {
      textContent = `Question: ${entry.question || ""}\nAnswer: ${entry.answer || ""}`;
    } else {
      textContent = entry.content || "";
    }

    if (!textContent.trim()) {
      return res.status(400).json({ error: "Selected knowledge base entry contains no readable text content" });
    }

    const { DemoParserService } = await import("../services/agents/DemoParserService.js");
    const conversations = await withDemoParseCredits(userId, () => DemoParserService.parseTextMulti(textContent));

    res.json({
      success: true,
      conversations,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[AiAgentConfig] Failed to parse knowledge-base training entry");
    res.status(error.statusCode || 400).json({ error: error.message || "Failed to parse knowledge base entry" });
  }
}
