import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../models/db.js';
import { sql } from 'drizzle-orm';
import { supportPresenceService } from '../services/SupportPresenceService.js';
import { logger } from '../utils/logger.js';

const rangeSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(90),
});
const capacitySchema = z.object({
  handlingMinutesPerTicket: z.number().int().min(1).max(120),
  socialFallbackSlaMinutes: z.number().int().min(1).max(1440),
  emailFallbackSlaMinutes: z.number().int().min(1).max(10080),
}).strict();
const routingEstimateSchema = z.object({
  channel: z.enum(['web', 'email', 'whatsapp', 'instagram', 'facebook']).default('web'),
  teamId: z.coerce.number().int().positive().optional(),
}).strict();

export async function heartbeat(req: Request, res: Response) {
  const member = (req as any).supportMember as { id: number; userId: number };
  const jti = String((req as any).supportSessionJti || '');
  await supportPresenceService.startOrTouch(member.userId, member.id, jti);
  const now = new Date();
  return res.json({ success: true, data: { presenceState: 'active', lastSeenAt: now.toISOString(), idleAfterSeconds: 300 } });
}

export async function getMyPresence(req: Request, res: Response) {
  const member = (req as any).supportMember as { id: number; userId: number };
  const parsed = rangeSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid range.' });
  const to = new Date();
  const from = new Date(to.getTime() - parsed.data.days * 86_400_000);
  const activity = await supportPresenceService.getMemberActivity(member.userId, member.id, from, to);
  return res.json({ success: true, data: activity });
}

export async function getOwnerMemberPresence(req: Request, res: Response) {
  try {
    const userId = Number(businessOwnerUserId(req));
    const teamId = Number(req.params.teamId);
    const memberId = Number(req.params.memberId);
    const parsed = rangeSchema.safeParse(req.query);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!Number.isInteger(teamId) || !Number.isInteger(memberId) || !parsed.success) {
      return res.status(400).json({ error: parsed.success ? 'Invalid team or member.' : parsed.error.issues[0]?.message });
    }
    const owned = await db.execute(sql`
      SELECT tm.id FROM team_members tm JOIN support_teams st ON st.id=tm.team_id
      WHERE tm.id=${memberId} AND tm.team_id=${teamId} AND tm.user_id=${userId} AND st.user_id=${userId} LIMIT 1
    `);
    if (!owned.rows[0]) return res.status(404).json({ error: 'Support member not found.' });
    const to = new Date();
    const from = new Date(to.getTime() - parsed.data.days * 86_400_000);
    const activity = await supportPresenceService.getMemberActivity(userId, memberId, from, to);
    return res.json({ success: true, data: activity });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load support member presence');
    return res.status(500).json({ error: 'Failed to load member activity.' });
  }
}

export async function getCapacitySettings(req: Request, res: Response) {
  const userId = Number(businessOwnerUserId(req));
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  return res.json({ success: true, data: await supportPresenceService.getCapacitySettings(userId) });
}

export async function updateCapacitySettings(req: Request, res: Response) {
  const userId = Number(businessOwnerUserId(req));
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const parsed = capacitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid capacity settings.' });
  return res.json({ success: true, data: await supportPresenceService.saveCapacitySettings(userId, parsed.data) });
}

export async function getRoutingEstimate(req: Request, res: Response) {
  const userId = Number(businessOwnerUserId(req));
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const parsed = routingEstimateSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid routing estimate request.' });
  if (parsed.data.teamId) {
    const ownedTeam = await db.execute(sql`
      SELECT id FROM support_teams
      WHERE id=${parsed.data.teamId} AND user_id=${userId} AND is_active IS TRUE
      LIMIT 1
    `);
    if (!ownedTeam.rows[0]) return res.status(404).json({ error: 'Enabled support team not found.' });
  }
  const estimate = await supportPresenceService.estimateRouting(userId, parsed.data.channel, parsed.data.teamId);
  return res.json({ success: true, data: estimate });
}
