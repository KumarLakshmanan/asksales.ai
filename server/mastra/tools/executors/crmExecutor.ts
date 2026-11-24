/**
 * CRM Tool Executors
 * Handles CRM reminder creation and pipeline status updates.
 */

import type { ToolContext } from '../toolRegistry.js';
import type { ToolResult } from '../../state';
import { logger } from '../../../utils/logger.js';
import { sql } from 'drizzle-orm';
import { db } from '../../../models/db';

/**
 * Resolve a contact ID from either contactId or leadId.
 * If leadId is provided, looks up or auto-creates a CRM contact.
 */
async function resolveContactId(
  userId: number,
  contactId?: number,
  leadId?: number
): Promise<number | null> {
  if (contactId) {
    const { crmService } = await import('../../../services/CRMService.js');
    const contact = await crmService.materializeContactReference(userId, contactId, 'agent_tool');
    return contact?.id || null;
  }

  if (leadId) {
    // Look up existing CRM contact by leadId
    const result = await db.execute(sql`
      SELECT id FROM crm_contacts
      WHERE lead_id = ${leadId} AND user_id = ${userId} AND deleted_at IS NULL
      LIMIT 1
    `);
    if (result.rows.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (result.rows[0] as any).id;
    }

    // Auto-create CRM contact from lead
    const { crmService } = await import('../../../services/CRMService.js');
    const created = await crmService.materializeContactReference(userId, -Math.abs(leadId), 'agent_tool');
    return created?.id || null;
  }

  return null;
}

export async function executeCreateCrmReminder(
  input: {
    contact_id?: number;
    lead_id?: number;
    title: string;
    reminder_due_at: string;
    reminder_type?: string;
    description?: string;
  },
  context: ToolContext
): Promise<ToolResult> {
  try {
    const { reminderService } = await import('../../../services/ReminderService.js');

    const contactId = await resolveContactId(context.userId, input.contact_id, input.lead_id);

    const reminder = await reminderService.createActivityReminder(context.userId, {
      contactId: contactId || undefined,
      reminderDueAt: new Date(input.reminder_due_at),
      reminderType: input.reminder_type || 'followup',
      title: input.title,
      description: input.description,
    });

    logger.info(
      { userId: context.userId, reminderId: reminder.id, type: input.reminder_type },
      '[CRMExecutor] CRM reminder created'
    );

    return {
      success: true,
      toolName: 'create_crm_reminder',
      output: {
        reminderId: reminder.id,
        title: input.title,
        dueAt: input.reminder_due_at,
        type: input.reminder_type || 'followup',
        message: `Reminder "${input.title}" created for ${new Date(input.reminder_due_at).toLocaleString()}.`,
      },
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error, userId: context.userId }, '[CRMExecutor] Failed to create CRM reminder');
    return {
      success: false,
      toolName: 'create_crm_reminder',
      error: error.message || 'Failed to create CRM reminder',
    };
  }
}

export async function executeUpdatePipelineStatus(
  input: {
    contact_id?: number;
    lead_id?: number;
    pipeline_status: string;
    reason?: string;
  },
  context: ToolContext
): Promise<ToolResult> {
  try {
    const { crmService } = await import('../../../services/CRMService.js');

    const contactId = await resolveContactId(context.userId, input.contact_id, input.lead_id);
    if (!contactId) {
      return {
        success: false,
        toolName: 'update_pipeline_status',
        error: 'Could not resolve a CRM contact. Provide either contact_id or lead_id.',
      };
    }

    const updated = await crmService.updatePipelineStatus(
      context.userId,
      contactId,
      input.pipeline_status
    );

    if (!updated) {
      return {
        success: false,
        toolName: 'update_pipeline_status',
        error: `CRM contact ${contactId} not found or could not be updated.`,
      };
    }

    logger.info(
      { userId: context.userId, contactId: updated.id, newStatus: updated.pipelineStatus, reason: input.reason },
      '[CRMExecutor] Pipeline status updated'
    );

    return {
      success: true,
      toolName: 'update_pipeline_status',
      output: {
        contactId: updated.id,
        pipelineStatus: updated.pipelineStatus,
        reason: input.reason,
        message: `Pipeline status updated to "${updated.pipelineStatus}" for contact ${updated.id}.`,
      },
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error, userId: context.userId }, '[CRMExecutor] Failed to update pipeline status');
    return {
      success: false,
      toolName: 'update_pipeline_status',
      error: error.message || 'Failed to update pipeline status',
    };
  }
}
