import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../models/db';
import { supportTeamsTable } from '../models/supportTeams/schema';
import { teamMembersTable } from '../models/teamMembers/schema';
import { supportTicketsTable } from '../models/supportTickets/schema';
import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { passwordSchema } from '../middleware/schemas.js';
import { supportPresenceService } from '../services/SupportPresenceService.js';
import { supportService } from '../services/SupportService.js';
import { syncOwnerVerifiedMemberNotificationContact } from '../services/SupportNotificationConfigurationService.js';
import { firstIssueMessage as issue } from '../utils/zodIssue.js';

const memberPublicFields = {
  id: teamMembersTable.id,
  teamId: teamMembersTable.teamId,
  userId: teamMembersTable.userId,
  role: teamMembersTable.role,
  name: teamMembersTable.name,
  email: teamMembersTable.email,
  isActive: teamMembersTable.isActive,
  isOnCall: teamMembersTable.isOnCall,
  locale: teamMembersTable.locale,
  timezone: teamMembersTable.timezone,
  quietHours: teamMembersTable.quietHours,
  createdAt: teamMembersTable.createdAt,
  passwordChangedAt: teamMembersTable.passwordChangedAt,
};
const teamSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2_000).optional().nullable(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  icon: z.string().trim().regex(/^[a-z0-9_-]+$/i).max(50).optional(),
}).strict();
const updateTeamSchema = teamSchema.partial().extend({ isActive: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, 'No team changes provided.');
const memberSchema = z.object({
  role: z.enum(['member', 'lead', 'admin']).default('member'),
  name: z.string().trim().min(1).max(255),
  email: z.string().trim().email().max(255),
  password: passwordSchema,
  whatsappNumber: z.string().trim().max(24).optional().default(''),
  notificationChannels: z.object({
    email: z.boolean().default(false),
    whatsapp: z.boolean().default(false),
  }).strict().default({ email: false, whatsapp: false }),
  notificationEvents: z.object({
    ticketAssigned: z.boolean().default(true),
    ticketReassigned: z.boolean().default(true),
    humanHandoff: z.boolean().default(true),
    customerReplied: z.boolean().default(true),
    ticketReopened: z.boolean().default(true),
    slaAtRisk: z.boolean().default(true),
    slaBreached: z.boolean().default(true),
  }).strict().default({
    ticketAssigned: true, ticketReassigned: true, humanHandoff: true,
    customerReplied: true, ticketReopened: true, slaAtRisk: true, slaBreached: true,
  }),
  whatsappConsentAcknowledged: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  const normalized = value.whatsappNumber.replace(/[\s()-]/g, '');
  if ((value.whatsappNumber || value.notificationChannels.whatsapp) && !/^\+?[1-9]\d{7,14}$/.test(normalized)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['whatsappNumber'], message: 'Enter a valid WhatsApp number with country code.' });
  }
  if (value.whatsappNumber && !value.whatsappConsentAcknowledged) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['whatsappConsentAcknowledged'], message: 'Confirm WhatsApp notification consent.' });
  }
});
const updateMemberSchema = z.object({
  role: z.enum(['member', 'lead', 'admin']).optional(),
  name: z.string().trim().min(1).max(255).optional(),
  email: z.string().trim().email().max(255).optional(),
  isActive: z.boolean().optional(),
  isOnCall: z.boolean().optional(),
  locale: z.string().trim().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).max(24).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  quietHours: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }).strict().optional(),
  whatsappNumber: z.string().trim().max(24).optional(),
  whatsappConsentAcknowledged: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  const normalized = value.whatsappNumber?.replace(/[\s()-]/g, '') || '';
  if (normalized && !/^\+?[1-9]\d{7,14}$/.test(normalized)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['whatsappNumber'], message: 'Enter a valid WhatsApp number with country code.' });
  }
  if (value.whatsappNumber !== undefined && !value.whatsappConsentAcknowledged) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['whatsappConsentAcknowledged'], message: 'Confirm WhatsApp notification authorization.' });
  }
}).refine((value) => Object.keys(value).length > 0, 'No member changes provided.');

function publicMember<T extends Record<string, unknown>>(member: T) {
  const { passwordHash: _passwordHash, ...safe } = member;
  return safe;
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}

async function getOwnedTeamMember(userId: number, memberId: number) {
  const [member] = await db.select({ member: teamMembersTable, teamId: supportTeamsTable.id })
    .from(teamMembersTable)
    .innerJoin(supportTeamsTable, eq(teamMembersTable.teamId, supportTeamsTable.id))
    .where(and(eq(teamMembersTable.id, memberId), eq(supportTeamsTable.userId, userId)));
  return member?.member ?? null;
}

// ─── Teams ──────────────────────────────────────────────────────────

export const getTeams = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const teams = await db.select().from(supportTeamsTable)
      .where(eq(supportTeamsTable.userId, userId))
      .orderBy(desc(supportTeamsTable.createdAt));

    const ticketPipelineRows = await db.select({
      teamId: supportTicketsTable.teamId,
      assignedMemberId: supportTicketsTable.assignedMemberId,
      status: supportTicketsTable.status,
      count: sql<number>`count(*)::int`,
    }).from(supportTicketsTable)
      .where(and(eq(supportTicketsTable.userId, userId), isNull(supportTicketsTable.deletedAt)))
      .groupBy(supportTicketsTable.teamId, supportTicketsTable.assignedMemberId, supportTicketsTable.status);
    type TicketPipeline = { open: number; inProgress: number; waitingOnCustomer: number; resolved: number; closed: number; total: number };
    const emptyPipeline = (): TicketPipeline => ({ open: 0, inProgress: 0, waitingOnCustomer: 0, resolved: 0, closed: 0, total: 0 });
    const addPipelineStatus = (pipeline: TicketPipeline, status: string, count: number) => {
      if (status === 'open') pipeline.open += count;
      if (status === 'in_progress') pipeline.inProgress += count;
      if (status === 'waiting_on_customer') pipeline.waitingOnCustomer += count;
      if (status === 'resolved') pipeline.resolved += count;
      if (status === 'closed') pipeline.closed += count;
      pipeline.total += count;
    };
    const pipelineByTeam = new Map<number, TicketPipeline>();
    const pipelineByMember = new Map<number, TicketPipeline>();
    for (const row of ticketPipelineRows) {
      const count = Number(row.count || 0);
      if (row.teamId) {
        const pipeline = pipelineByTeam.get(row.teamId) || emptyPipeline();
        addPipelineStatus(pipeline, row.status, count);
        pipelineByTeam.set(row.teamId, pipeline);
      }
      if (row.assignedMemberId) {
        const pipeline = pipelineByMember.get(row.assignedMemberId) || emptyPipeline();
        addPipelineStatus(pipeline, row.status, count);
        pipelineByMember.set(row.assignedMemberId, pipeline);
      }
    }

    // Fetch members for each team
    const teamsWithMembers = await Promise.all(
      teams.map(async (team: typeof teams[number]) => {
        const members = await db.select(memberPublicFields).from(teamMembersTable)
          .where(eq(teamMembersTable.teamId, team.id));
        const summaries = await supportPresenceService.listTeamSummaries(userId, team.id);
        const summaryByMember = new Map(summaries.map((summary) => [summary.memberId, summary]));
        const enrichedMembers: Array<(typeof members)[number] & { presenceState?: string; unrepliedWorkload?: number }> = members.map((member: { id: number } & Record<string, unknown>) => ({
          ...member,
          ...(summaryByMember.get(member.id) || {}),
          ticketPipeline: pipelineByMember.get(member.id) || emptyPipeline(),
        }));
        return {
          ...team,
          members: enrichedMembers,
          activeMemberCount: enrichedMembers.filter((member) => member.presenceState === 'active').length,
          unrepliedWorkload: enrichedMembers.reduce((sum, member) => sum + Number(member.unrepliedWorkload || 0), 0),
          ticketPipeline: pipelineByTeam.get(team.id) || { open: 0, inProgress: 0, waitingOnCustomer: 0, resolved: 0, closed: 0, total: 0 },
        };
      })
    );

    return res.json({ success: true, data: teamsWithMembers });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get support teams');
    return res.status(500).json({ error: 'Failed to fetch teams' });
  }
};

export const getTeam = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const teamId = parseInt(req.params.id);
    const [team] = await db.select().from(supportTeamsTable)
      .where(and(eq(supportTeamsTable.id, teamId), eq(supportTeamsTable.userId, userId)));

    if (!team) return res.status(404).json({ error: 'Team not found' });

    const members = await db.select(memberPublicFields).from(teamMembersTable)
      .where(eq(teamMembersTable.teamId, teamId));

    const summaries = await supportPresenceService.listTeamSummaries(userId, teamId);
    const summaryByMember = new Map(summaries.map((summary) => [summary.memberId, summary]));
    return res.json({
      success: true,
      data: { ...team, members: members.map((member: { id: number } & Record<string, unknown>) => ({ ...member, ...(summaryByMember.get(member.id) || {}) })) },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get support team');
    return res.status(500).json({ error: 'Failed to fetch team' });
  }
};

export const createTeam = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const parsed = teamSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: issue(parsed.error) });
    const { name, description, color, icon } = parsed.data;

    const [team] = await db.insert(supportTeamsTable).values({
      userId,
      name,
      description: description || null,
      color: color || '#6366f1',
      icon: icon || 'users',
    }).returning();

    // Return team with members
    const teamMembers = await db.select(memberPublicFields).from(teamMembersTable)
      .where(eq(teamMembersTable.teamId, team.id));

    logger.info({ userId, teamId: team.id }, 'Support team created');
    return res.status(201).json({ success: true, data: { ...team, members: teamMembers } });
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, 'Failed to create support team');
    return res.status(500).json({ error: 'Failed to create team' });
  }
};

export const updateTeam = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const teamId = parseInt(req.params.id);
    const parsed = updateTeamSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: issue(parsed.error) });
    const { name, description, color, icon, isActive } = parsed.data;

    const [updated] = await db.update(supportTeamsTable)
      .set({
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(color !== undefined && { color }),
        ...(icon !== undefined && { icon }),
        ...(isActive !== undefined && { isActive }),
        updatedAt: new Date(),
      })
      .where(and(eq(supportTeamsTable.id, teamId), eq(supportTeamsTable.userId, userId)))
      .returning();

    if (!updated) return res.status(404).json({ error: 'Team not found' });

    const members = await db.select(memberPublicFields).from(teamMembersTable)
      .where(eq(teamMembersTable.teamId, teamId));

    return res.json({ success: true, data: { ...updated, members } });
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, 'Failed to update support team');
    return res.status(500).json({ error: 'Failed to update team' });
  }
};

export const deleteTeam = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const teamId = parseInt(req.params.id);
    const [deleted] = await db.delete(supportTeamsTable)
      .where(and(eq(supportTeamsTable.id, teamId), eq(supportTeamsTable.userId, userId)))
      .returning({ id: supportTeamsTable.id });
    if (!deleted) return res.status(404).json({ error: 'Team not found' });

    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete support team');
    return res.status(500).json({ error: 'Failed to delete team' });
  }
};

// ─── Team Members ───────────────────────────────────────────────────

export const addTeamMember = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const teamId = parseInt(req.params.id);
    if (isNaN(teamId)) return res.status(400).json({ error: 'Invalid team ID' });

    // Verify team ownership
    const [team] = await db.select().from(supportTeamsTable)
      .where(and(eq(supportTeamsTable.id, teamId), eq(supportTeamsTable.userId, userId)));
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const parsed = memberSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: issue(parsed.error) });
    const { role, name, email, password, whatsappNumber, whatsappConsentAcknowledged } = parsed.data;
    const passwordHash = await bcrypt.hash(password, 12);

    const member = await db.transaction(async (tx: typeof db) => {
      const [created] = await tx.insert(teamMembersTable).values({
        teamId,
        // A support member belongs to the current workspace. Do not let a
        // caller attach an arbitrary platform user ID to their team.
        userId,
        role,
        name,
        email: email.toLowerCase(),
        passwordHash,
      }).returning();
      await syncOwnerVerifiedMemberNotificationContact(tx as typeof db, {
        userId, teamId, memberId: created.id, ownerUserId: userId,
        channel: 'email', destination: email,
      });
      if (whatsappNumber) await syncOwnerVerifiedMemberNotificationContact(tx as typeof db, {
        userId, teamId, memberId: created.id, ownerUserId: userId,
        channel: 'whatsapp', destination: whatsappNumber, consentAcknowledged: whatsappConsentAcknowledged,
      });
      return created;
    });

    return res.status(201).json({ success: true, data: publicMember(member) });
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: 'A support member with this email already exists' });
    }
    logger.error({ err: error }, 'Failed to add team member');
    const message = error instanceof Error && /^(Confirm that|This (email|whatsapp)|Unable to save)/.test(error.message)
      ? error.message
      : 'Failed to add member';
    return res.status(400).json({ error: message });
  }
};

export const updateTeamMember = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const memberId = parseInt(req.params.memberId);
    if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ error: 'Invalid member ID' });
    const parsed = updateMemberSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: issue(parsed.error) });
    const { role, name, email, isActive, isOnCall, locale, timezone, quietHours,
      whatsappNumber, whatsappConsentAcknowledged } = parsed.data;

    const member = await getOwnedTeamMember(userId, memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const updated = await db.transaction(async (tx: typeof db) => {
      const [next] = await tx.update(teamMembersTable)
        .set({
          ...(role !== undefined && { role }),
          ...(name !== undefined && { name }),
          ...(email !== undefined && { email: email ? email.toLowerCase().trim() : email }),
          ...(isActive !== undefined && { isActive }),
          ...(isOnCall !== undefined && { isOnCall }),
          ...(locale !== undefined && { locale }),
          ...(timezone !== undefined && { timezone }),
          ...(quietHours !== undefined && { quietHours }),
        })
        .where(eq(teamMembersTable.id, memberId))
        .returning();
      if (!next) return undefined;
      if (email !== undefined) await syncOwnerVerifiedMemberNotificationContact(tx as typeof db, {
        userId, teamId: next.teamId, memberId, ownerUserId: userId,
        channel: 'email', destination: email,
      });
      if (whatsappNumber !== undefined) await syncOwnerVerifiedMemberNotificationContact(tx as typeof db, {
        userId, teamId: next.teamId, memberId, ownerUserId: userId,
        channel: 'whatsapp', destination: whatsappNumber || null,
        consentAcknowledged: whatsappConsentAcknowledged,
      });
      return next;
    });

    if (!updated) return res.status(404).json({ error: 'Member not found' });
    if (isActive === false) await supportPresenceService.endAllForMember(userId, memberId, 'disabled');
    return res.json({ success: true, data: publicMember(updated) });
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: 'A support member with this email already exists' });
    }
    logger.error({ err: error }, 'Failed to update team member');
    const message = error instanceof Error && /^(Confirm that|This (email|whatsapp)|Unable to save)/.test(error.message)
      ? error.message
      : 'Failed to update member';
    return res.status(message === 'Failed to update member' ? 500 : 400).json({ error: message });
  }
};

export const removeTeamMember = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const memberId = parseInt(req.params.memberId);
    if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ error: 'Invalid member ID' });
    const member = await getOwnedTeamMember(userId, memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    await db.delete(teamMembersTable).where(eq(teamMembersTable.id, memberId));

    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to remove team member');
    return res.status(500).json({ error: 'Failed to remove member' });
  }
};

// ─── Team Tickets ───────────────────────────────────────────────────

export const getTeamTickets = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const teamId = parseInt(req.params.id);
    if (isNaN(teamId)) return res.status(400).json({ error: 'Invalid team ID' });

    const ticketRows = await db.select().from(supportTicketsTable)
      .where(and(
        eq(supportTicketsTable.teamId, teamId),
        eq(supportTicketsTable.userId, userId),
        isNull(supportTicketsTable.deletedAt),
      ))
      .orderBy(desc(supportTicketsTable.updatedAt));
    const tickets = await supportService.enrichTicketQueue(userId, ticketRows, { kind: 'owner', id: req.user!.id });

    return res.json({ success: true, data: tickets });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get team tickets');
    return res.status(500).json({ error: 'Failed to fetch team tickets' });
  }
};

export const getMemberTickets = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const memberId = parseInt(req.params.memberId);
    if (isNaN(memberId)) return res.status(400).json({ error: 'Invalid member ID' });

    // Get the member's userId
    const member = await getOwnedTeamMember(userId, memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const ticketRows = await db.select().from(supportTicketsTable)
      .where(and(
        eq(supportTicketsTable.assignedMemberId, member.id),
        eq(supportTicketsTable.userId, userId),
        isNull(supportTicketsTable.deletedAt),
      ))
      .orderBy(desc(supportTicketsTable.updatedAt));
    const tickets = await supportService.enrichTicketQueue(userId, ticketRows, { kind: 'owner', id: req.user!.id });

    return res.json({ success: true, data: tickets });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get member tickets');
    return res.status(500).json({ error: 'Failed to fetch member tickets' });
  }
};

// ─── Member Password & Active Status ───────────────────────────────

export const resetMemberPassword = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const memberId = parseInt(req.params.memberId);
    if (isNaN(memberId)) return res.status(400).json({ error: 'Invalid member ID' });

    const { newPassword } = req.body;
    if (!newPassword) {
      return res.status(400).json({ error: 'New password is required' });
    }

    // Verify member exists and belongs to a team owned by this user
    const [member] = await db.select().from(teamMembersTable)
      .where(eq(teamMembersTable.id, memberId));
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const [team] = await db.select().from(supportTeamsTable)
      .where(and(eq(supportTeamsTable.id, member.teamId), eq(supportTeamsTable.userId, userId)));
    if (!team) return res.status(403).json({ error: 'Not authorized to manage this member' });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.update(teamMembersTable)
      .set({ passwordHash, passwordChangedAt: new Date() })
      .where(eq(teamMembersTable.id, memberId));

    logger.info({ userId, memberId }, 'Support member password reset');
    return res.json({ success: true, message: 'Password has been reset' });
  } catch (error) {
    logger.error({ err: error }, 'Failed to reset member password');
    return res.status(500).json({ error: 'Failed to reset password' });
  }
};

export const toggleMemberActive = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const memberId = parseInt(req.params.memberId);
    if (isNaN(memberId)) return res.status(400).json({ error: 'Invalid member ID' });

    // Verify member exists and belongs to a team owned by this user
    const [member] = await db.select().from(teamMembersTable)
      .where(eq(teamMembersTable.id, memberId));
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const [team] = await db.select().from(supportTeamsTable)
      .where(and(eq(supportTeamsTable.id, member.teamId), eq(supportTeamsTable.userId, userId)));
    if (!team) return res.status(403).json({ error: 'Not authorized to manage this member' });

    const newActive = !member.isActive;
    const [updated] = await db.update(teamMembersTable)
      .set({ isActive: newActive })
      .where(eq(teamMembersTable.id, memberId))
      .returning();

    if (!newActive) await supportPresenceService.endAllForMember(userId, memberId, 'disabled');

    logger.info({ userId, memberId, isActive: newActive }, 'Support member active status toggled');
    return res.json({ success: true, data: publicMember(updated) });
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, 'Failed to toggle member status');
    return res.status(500).json({ error: 'Failed to toggle member status' });
  }
};
