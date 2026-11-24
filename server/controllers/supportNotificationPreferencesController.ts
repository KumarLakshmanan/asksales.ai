import { businessOwnerUserId } from '../tenancy/businessContext.js';
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../models/db.js';
import { teamMembersTable } from '../models/teamMembers/schema.js';
import { supportTeamsTable } from '../models/supportTeams/schema.js';
import { decryptValue, encryptValue } from '../services/SecretsManager.js';
import {
  SupportMemberNotificationService, isSupportNotificationDeliveryRetryable, supportMemberNotificationService,
  supportNotificationDestinationHint, withSupportNotificationTenant,
  type SupportNotificationEvent,
} from '../services/SupportMemberNotificationService.js';
import { logger } from '../utils/logger.js';
import { whatsappApiService } from '../services/whatsappApiService.js';
import { supportNotificationTemplateCompatibility } from './whatsappTemplateController.js';
import {
  ensureManagedAssignmentEmailTemplate,
  supportNotificationAllowedVariablesSql,
} from '../services/SupportNotificationConfigurationService.js';

const CHANNELS = ['email', 'whatsapp', 'slack', 'teams'] as const;
const EVENTS = [
  'ticket_created_unassigned', 'ticket_assigned', 'ticket_reassigned', 'human_handoff',
  'customer_replied', 'ticket_reopened', 'sla_at_risk', 'sla_breached',
  'approval_required', 'delivery_failed', 'ticket_resolved',
] as const satisfies readonly SupportNotificationEvent[];
const EVENT_FIELDS: Record<SupportNotificationEvent, string> = {
  ticket_created_unassigned: 'ticketCreatedUnassigned', ticket_assigned: 'ticketAssigned',
  ticket_reassigned: 'ticketReassigned', human_handoff: 'humanHandoff',
  customer_replied: 'customerReplied', ticket_reopened: 'ticketReopened',
  sla_at_risk: 'slaAtRisk', sla_breached: 'slaBreached', approval_required: 'approvalRequired',
  delivery_failed: 'deliveryFailed', ticket_resolved: 'ticketResolved',
};
const eventSchema = z.object({
  ticketCreatedUnassigned: z.boolean().optional(), ticketAssigned: z.boolean().optional(),
  ticketReassigned: z.boolean().optional(), humanHandoff: z.boolean().optional(),
  customerReplied: z.boolean().optional(), ticketReopened: z.boolean().optional(),
  slaAtRisk: z.boolean().optional(), slaBreached: z.boolean().optional(),
  approvalRequired: z.boolean().optional(), deliveryFailed: z.boolean().optional(),
  ticketResolved: z.boolean().optional(),
}).strict().transform((v) => ({
  ticketCreatedUnassigned: v.ticketCreatedUnassigned ?? false, ticketAssigned: v.ticketAssigned ?? true,
  ticketReassigned: v.ticketReassigned ?? true, humanHandoff: v.humanHandoff ?? true,
  customerReplied: v.customerReplied ?? true, ticketReopened: v.ticketReopened ?? true,
  slaAtRisk: v.slaAtRisk ?? true, slaBreached: v.slaBreached ?? true,
  approvalRequired: v.approvalRequired ?? true, deliveryFailed: v.deliveryFailed ?? true,
  ticketResolved: v.ticketResolved ?? false,
}));
const channelSchema = z.object({ enabled: z.boolean(), recipient: z.string().trim().max(2000), events: eventSchema }).strict();
export const supportMemberNotificationPreferencesSchema = z.object({
  email: channelSchema, whatsapp: channelSchema, slack: channelSchema, teams: channelSchema,
}).strict().superRefine((value, ctx) => {
  if (value.email.enabled && !z.string().email().safeParse(value.email.recipient).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['email', 'recipient'], message: 'Enter a valid email address.' });
  }
  if (value.whatsapp.enabled && !/^\+?[1-9]\d{7,14}$/.test(value.whatsapp.recipient.replace(/[\s()-]/g, ''))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['whatsapp', 'recipient'], message: 'Enter a valid WhatsApp number with country code.' });
  }
  for (const channel of ['slack', 'teams'] as const) {
    if (!value[channel].enabled) continue;
    try { const url = new URL(value[channel].recipient); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); }
    catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: [channel, 'recipient'], message: 'Enter a credential-free HTTPS webhook URL.' }); }
  }
});
type ParsedPreferences = z.infer<typeof supportMemberNotificationPreferencesSchema>;
type Member = typeof teamMembersTable.$inferSelect;

export function normalizeSupportMemberNotificationPreferences(input: ParsedPreferences): ParsedPreferences {
  return {
    ...input,
    email: { ...input.email, recipient: input.email.recipient.trim().toLowerCase() },
    whatsapp: { ...input.whatsapp, recipient: input.whatsapp.recipient.replace(/[^\d+]/g, '').replace(/^\+/, '') },
    slack: { ...input.slack, recipient: input.slack.recipient.trim() },
    teams: { ...input.teams, recipient: input.teams.recipient.trim() },
  };
}
function defaultEvents() {
  return Object.fromEntries(EVENTS.map((event) => [EVENT_FIELDS[event], !['ticket_created_unassigned', 'ticket_resolved'].includes(event)])) as ParsedPreferences['email']['events'];
}
function emptyPreferences() {
  const availability = supportMemberNotificationService.platformAvailability();
  return Object.fromEntries(CHANNELS.map((channel) => [channel, {
    enabled: false, recipient: '', destinationHint: '', verificationStatus: 'unverified',
    availability: availability[channel], events: defaultEvents(),
  }])) as Record<typeof CHANNELS[number], ParsedPreferences['email'] & { destinationHint: string; verificationStatus: string; availability: string }>;
}
function currentMember(req: Request) { return (req as Request & { supportMember?: Member }).supportMember; }
async function ownedMember(userId: number, teamId: number, memberId: number) {
  const [record] = await db.select({ member: teamMembersTable }).from(teamMembersTable)
    .innerJoin(supportTeamsTable, eq(teamMembersTable.teamId, supportTeamsTable.id))
    .where(and(eq(teamMembersTable.id, memberId), eq(teamMembersTable.teamId, teamId), eq(supportTeamsTable.userId, userId))).limit(1);
  return record?.member || null;
}
async function audit(tx: typeof db, input: { userId: number; memberId?: number | null; actorMemberId?: number | null;
  actorType: 'owner' | 'member' | 'system'; action: string; entityType: string; entityId?: number | null; metadata?: Record<string, unknown> }) {
  await tx.execute(sql`INSERT INTO support_notification_audit_logs
    (user_id, member_id, actor_member_id, actor_type, action, entity_type, entity_id, metadata, expires_at)
    VALUES (${input.userId}, ${input.memberId || null}, ${input.actorMemberId || null}, ${input.actorType}, ${input.action},
      ${input.entityType}, ${input.entityId || null}, ${JSON.stringify(input.metadata || {})}::jsonb, NOW() + INTERVAL '365 days')`);
}

async function loadPreferences(member: Member, reveal: boolean, teamDefaults = false) {
  return withSupportNotificationTenant(member.userId, async (tx) => {
    const output = emptyPreferences();
    const result = await tx.execute(sql`SELECT d.channel, d.destination_ciphertext, d.destination_hint, d.verification_status,
      p.event_type, p.enabled FROM support_notification_destinations d
      LEFT JOIN support_notification_preferences p ON p.destination_id = d.id
      WHERE d.user_id = ${member.userId} AND d.team_id = ${member.teamId}
        AND ${teamDefaults ? sql`d.member_id IS NULL` : sql`d.member_id = ${member.id}`}
      ORDER BY d.channel, p.event_type`);
    for (const row of result.rows as Array<Record<string, unknown>>) {
      const channel = String(row.channel) as typeof CHANNELS[number];
      if (!CHANNELS.includes(channel)) continue;
      if (reveal) { try { output[channel].recipient = decryptValue(String(row.destination_ciphertext || '')); } catch { output[channel].recipient = ''; } }
      output[channel].destinationHint = String(row.destination_hint || '');
      output[channel].verificationStatus = String(row.verification_status || 'unverified');
      const event = String(row.event_type || '') as SupportNotificationEvent;
      if (EVENTS.includes(event)) {
        const field = EVENT_FIELDS[event] as keyof ParsedPreferences['email']['events'];
        output[channel].events[field] = Boolean(row.enabled);
        output[channel].enabled ||= Boolean(row.enabled);
      }
    }
    return output;
  });
}

async function savePreferences(input: { member: Member; preferences: ParsedPreferences; actorType: 'owner' | 'member'; actorMemberId?: number | null; teamDefaults?: boolean; ownerConsentAcknowledged?: boolean }) {
  const preferences = normalizeSupportMemberNotificationPreferences(input.preferences);
  await withSupportNotificationTenant(input.member.userId, async (tx) => {
    for (const channel of CHANNELS) {
      const preference = preferences[channel];
      const ownerVerified = input.actorType === 'owner' && !input.teamDefaults && (channel === 'email' || channel === 'whatsapp');
      if (ownerVerified && channel === 'whatsapp' && preference.enabled && !input.ownerConsentAcknowledged) {
        throw new Error('Confirm that this member agreed to receive operational WhatsApp alerts.');
      }
      const existingResult = await tx.execute(sql`SELECT id, destination_hash FROM support_notification_destinations
        WHERE user_id=${input.member.userId} AND team_id=${input.member.teamId}
          AND ${input.teamDefaults ? sql`member_id IS NULL` : sql`member_id=${input.member.id}`} AND channel=${channel} LIMIT 1`);
      const existingDestination = existingResult.rows[0] as { id?: number; destination_hash?: string } | undefined;
      let destinationId = Number(existingDestination?.id || 0);
      if (preference.recipient && (preference.enabled || destinationId > 0)) {
        const digest = SupportMemberNotificationService.destinationDigest(channel, preference.recipient, input.member.userId);
        const duplicate = await tx.execute(sql`SELECT id FROM support_notification_destinations
          WHERE user_id=${input.member.userId} AND channel=${channel} AND destination_hash=${digest}
            AND member_id IS DISTINCT FROM ${input.teamDefaults ? null : input.member.id} LIMIT 1`);
        if (duplicate.rows[0]) throw new Error(`This ${channel} notification destination is already assigned to another support member.`);
        const inserted = await tx.execute(sql`INSERT INTO support_notification_destinations
          (user_id, team_id, member_id, channel, destination_ciphertext, destination_hash, destination_hint,
           verification_status, verification_source, verified_by_user_id, owner_consent_at,
           owner_consent_version, verified_at, fingerprint_version, created_by_member_id, updated_at)
          VALUES (${input.member.userId}, ${input.member.teamId}, ${input.teamDefaults ? null : input.member.id}, ${channel},
            ${encryptValue(preference.recipient)}, ${digest}, ${supportNotificationDestinationHint(channel, preference.recipient)},
            ${ownerVerified ? 'owner_verified' : 'unverified'}, ${ownerVerified ? 'owner_attestation' : null},
            ${ownerVerified ? input.member.userId : null}, ${ownerVerified ? sql`NOW()` : null},
            ${ownerVerified ? 'support-notifications-v1' : null}, ${ownerVerified ? sql`NOW()` : null},
            2, ${input.actorMemberId || null}, NOW())
          ON CONFLICT ${input.teamDefaults ? sql`(team_id, channel) WHERE member_id IS NULL` : sql`(member_id, channel) WHERE member_id IS NOT NULL`}
          DO UPDATE SET destination_ciphertext=EXCLUDED.destination_ciphertext, destination_hash=EXCLUDED.destination_hash,
            destination_hint=EXCLUDED.destination_hint, fingerprint_version=2,
            verification_status=CASE WHEN ${ownerVerified} THEN 'owner_verified'
              WHEN support_notification_destinations.destination_hash=EXCLUDED.destination_hash
              THEN support_notification_destinations.verification_status ELSE 'unverified' END,
            verification_source=CASE WHEN ${ownerVerified} THEN 'owner_attestation'
              WHEN support_notification_destinations.destination_hash=EXCLUDED.destination_hash
              THEN support_notification_destinations.verification_source ELSE NULL END,
            verified_by_user_id=CASE WHEN ${ownerVerified} THEN ${input.member.userId}
              WHEN support_notification_destinations.destination_hash=EXCLUDED.destination_hash
              THEN support_notification_destinations.verified_by_user_id ELSE NULL END,
            owner_consent_at=CASE WHEN ${ownerVerified} THEN NOW()
              WHEN support_notification_destinations.destination_hash=EXCLUDED.destination_hash
              THEN support_notification_destinations.owner_consent_at ELSE NULL END,
            owner_consent_version=CASE WHEN ${ownerVerified} THEN 'support-notifications-v1'
              WHEN support_notification_destinations.destination_hash=EXCLUDED.destination_hash
              THEN support_notification_destinations.owner_consent_version ELSE NULL END,
            verification_code_hash=CASE WHEN support_notification_destinations.destination_hash=EXCLUDED.destination_hash
              THEN support_notification_destinations.verification_code_hash ELSE NULL END,
            verification_expires_at=CASE WHEN support_notification_destinations.destination_hash=EXCLUDED.destination_hash
              THEN support_notification_destinations.verification_expires_at ELSE NULL END,
            verified_at=CASE WHEN ${ownerVerified} THEN NOW()
              WHEN support_notification_destinations.destination_hash=EXCLUDED.destination_hash
              THEN support_notification_destinations.verified_at ELSE NULL END, updated_at=NOW() RETURNING id`);
        destinationId = Number((inserted.rows[0] as { id?: number } | undefined)?.id || 0);
        if (existingDestination?.id && existingDestination.destination_hash !== digest) {
          await tx.execute(sql`UPDATE support_member_notification_deliveries
            SET status='cancelled',updated_at=NOW(),error_code='DESTINATION_CHANGED',last_error='Notification destination changed before delivery.'
            WHERE user_id=${input.member.userId} AND destination_id=${Number(existingDestination.id)}
              AND status IN('pending','retry')`);
        }
      }
      if (!destinationId) continue;
      for (const event of EVENTS) {
        const field = EVENT_FIELDS[event] as keyof ParsedPreferences['email']['events'];
        await tx.execute(sql`INSERT INTO support_notification_preferences
          (user_id, team_id, member_id, event_type, channel, enabled, destination_id, updated_at)
          VALUES (${input.member.userId}, ${input.member.teamId}, ${input.teamDefaults ? null : input.member.id}, ${event}, ${channel},
            ${preference.enabled && preference.events[field]}, ${destinationId}, NOW())
          ON CONFLICT ${input.teamDefaults ? sql`(team_id, event_type, channel) WHERE member_id IS NULL` : sql`(member_id, event_type, channel) WHERE member_id IS NOT NULL`}
          DO UPDATE SET enabled=EXCLUDED.enabled, destination_id=EXCLUDED.destination_id, updated_at=NOW()`);
      }
      if (!preference.enabled) {
        await tx.execute(sql`
          UPDATE support_member_notification_deliveries
          SET status='cancelled',updated_at=NOW(),error_code='CHANNEL_DISABLED',
            last_error='Notification channel was disabled before delivery.'
          WHERE user_id=${input.member.userId} AND destination_id=${destinationId}
            AND status IN('pending','retry')
        `);
      }
    }
    await audit(tx, { userId: input.member.userId, memberId: input.teamDefaults ? null : input.member.id,
      actorMemberId: input.actorMemberId, actorType: input.actorType, action: 'preferences.updated',
      entityType: input.teamDefaults ? 'support_team' : 'team_member', entityId: input.teamDefaults ? input.member.teamId : input.member.id,
      metadata: { channels: CHANNELS, ownerAttested: input.actorType === 'owner' && input.ownerConsentAcknowledged === true } });
  });
}
function parsePreferences(body: unknown) {
  const parsed = supportMemberNotificationPreferencesSchema.safeParse(body);
  return parsed.success ? { preferences: parsed.data, error: null }
    : { preferences: null, error: parsed.error.issues[0]?.message || 'Invalid notification preferences.' };
}

export async function getMemberNotificationPreferences(req: Request, res: Response) {
  try {
    const userId = Number(businessOwnerUserId(req));
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const member = await ownedMember(userId, Number(req.params.teamId), Number(req.params.memberId));
    if (!member) return res.status(404).json({ error: 'Support member not found.' });
    return res.json({ success: true, data: await loadPreferences(member, false) });
  } catch (error) { logger.error({ err: error }, '[SupportNotifications] Owner preference read failed'); return res.status(500).json({ error: 'Failed to load notification preferences.' }); }
}
export async function updateMemberNotificationPreferences(req: Request, res: Response) {
  try {
    const userId = Number((req as Request & { user?: { id?: number } }).user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const member = await ownedMember(userId, Number(req.params.teamId), Number(req.params.memberId));
    if (!member) return res.status(404).json({ error: 'Support member not found.' });
    const current = await loadPreferences(member, true);
    const requestBody = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const ownerConsentAcknowledged = requestBody.ownerConsentAcknowledged === true;
    const merged = Object.fromEntries(CHANNELS.map((channel) => {
      const requested = requestBody[channel] as Record<string, unknown> | undefined;
      return [channel, requested ? { ...requested, recipient: String(requested.recipient || '').trim() || current[channel].recipient } : requested];
    }));
    const parsed = parsePreferences(merged); if (!parsed.preferences) return res.status(400).json({ error: parsed.error });
    await savePreferences({ member, preferences: parsed.preferences, actorType: 'owner', ownerConsentAcknowledged });
    return res.json({ success: true, data: await loadPreferences(member, false) });
  } catch (error) {
    logger.error({ err: error }, '[SupportNotifications] Owner preference update failed');
    const message = error instanceof Error && /^(Confirm that|This (email|whatsapp))/.test(error.message)
      ? error.message
      : 'Failed to update notification preferences.';
    return res.status(400).json({ error: message });
  }
}
export async function getMyNotificationPreferences(req: Request, res: Response) {
  try { const member=currentMember(req); if (!member) return res.status(401).json({error:'Unauthorized'}); return res.json({success:true,data:await loadPreferences(member,true)}); }
  catch(error){logger.error({err:error},'[SupportNotifications] Member preference read failed');return res.status(500).json({error:'Failed to load notification preferences.'});}
}
export async function updateMyNotificationPreferences(req: Request, res: Response) {
  try { const member=currentMember(req); if (!member) return res.status(401).json({error:'Unauthorized'}); const parsed=parsePreferences(req.body);
    if(!parsed.preferences)return res.status(400).json({error:parsed.error}); await savePreferences({member,preferences:parsed.preferences,actorType:'member',actorMemberId:member.id});
    return res.json({success:true,data:await loadPreferences(member,true)}); }
  catch(error){logger.error({err:error},'[SupportNotifications] Member preference update failed');return res.status(500).json({error:'Failed to update notification preferences.'});}
}

const verificationRequestSchema=z.object({channel:z.enum(CHANNELS),scope:z.enum(['member','team']).default('member')}).strict();
const verificationConfirmSchema=verificationRequestSchema.extend({code:z.string().regex(/^\d{6}$/)}).strict();
export function canManageTeamDefaults(member:Pick<Member,'role'>){return member.role==='lead'||member.role==='admin';}
async function requestVerification(member:Member,channel:typeof CHANNELS[number],scope:'member'|'team',actorType:'owner'|'member'){
  const code=String(crypto.randomInt(100_000,1_000_000));const codeHash=crypto.createHash('sha256').update(code).digest('hex');
  const destination=await withSupportNotificationTenant(member.userId,async(tx)=>{
    const result=await tx.execute(sql`UPDATE support_notification_destinations SET verification_status='pending',
      verification_code_hash=${codeHash},verification_expires_at=NOW()+INTERVAL '10 minutes',updated_at=NOW()
      WHERE user_id=${member.userId} AND team_id=${member.teamId}
        AND ${scope==='team'?sql`member_id IS NULL`:sql`member_id=${member.id}`} AND channel=${channel}
      RETURNING id,destination_hint,destination_ciphertext`);
    const row=result.rows[0] as {id?:number;destination_hint?:string;destination_ciphertext?:string}|undefined;
    if(row?.id)await audit(tx,{userId:member.userId,memberId:scope==='team'?null:member.id,actorMemberId:actorType==='member'?member.id:null,
      actorType,action:'destination.verification_requested',entityType:'support_notification_destination',entityId:row.id,metadata:{channel,scope}});
    return row;
  });
  if(!destination?.id||!destination.destination_ciphertext)return null;
  try{await supportMemberNotificationService.sendVerification(member.userId,channel,decryptValue(destination.destination_ciphertext),code);}
  catch(error){await withSupportNotificationTenant(member.userId,async(tx)=>{await tx.execute(sql`UPDATE support_notification_destinations SET verification_status='failed',last_test_status='failed',updated_at=NOW() WHERE id=${destination.id}`);});throw error;}
  return{channel,destinationHint:destination.destination_hint,expiresInSeconds:600,...(process.env.NODE_ENV!=='production'?{developmentCode:code}:{})};
}
async function confirmVerification(member:Member,channel:typeof CHANNELS[number],scope:'member'|'team',code:string,actorType:'owner'|'member'){
  const codeHash=crypto.createHash('sha256').update(code).digest('hex');
  return withSupportNotificationTenant(member.userId,async(tx)=>{
    const result=await tx.execute(sql`UPDATE support_notification_destinations SET verification_status='verified',verified_at=NOW(),
      verification_code_hash=NULL,verification_expires_at=NULL,last_test_status='delivered',last_tested_at=NOW(),updated_at=NOW()
      WHERE user_id=${member.userId} AND team_id=${member.teamId}
        AND ${scope==='team'?sql`member_id IS NULL`:sql`member_id=${member.id}`} AND channel=${channel}
        AND verification_status='pending' AND verification_code_hash=${codeHash} AND verification_expires_at>NOW() RETURNING id`);
    const id=Number((result.rows[0]as{id?:number}|undefined)?.id||0);
    if(id)await audit(tx,{userId:member.userId,memberId:scope==='team'?null:member.id,actorMemberId:actorType==='member'?member.id:null,
      actorType,action:'destination.verified',entityType:'support_notification_destination',entityId:id,metadata:{channel,scope}});
    return Boolean(id);
  });
}
export async function requestMyDestinationVerification(req:Request,res:Response){try{const member=currentMember(req);if(!member)return res.status(401).json({error:'Unauthorized'});
  const parsed=verificationRequestSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Invalid notification channel.'});
  if(parsed.data.scope==='team'&&!canManageTeamDefaults(member))return res.status(403).json({error:'Team lead or admin role required.'});
  const data=await requestVerification(member,parsed.data.channel,parsed.data.scope,'member');if(!data)return res.status(404).json({error:'Save a destination before requesting verification.'});return res.json({success:true,data});}
  catch(error){logger.error({err:error},'[SupportNotifications] Verification delivery failed');return res.status(502).json({error:error instanceof Error?error.message:'Failed to deliver verification.'});}}
export async function confirmMyDestinationVerification(req:Request,res:Response){try{const member=currentMember(req);if(!member)return res.status(401).json({error:'Unauthorized'});
  const parsed=verificationConfirmSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Enter the six-digit verification code.'});
  if(parsed.data.scope==='team'&&!canManageTeamDefaults(member))return res.status(403).json({error:'Team lead or admin role required.'});
  if(!await confirmVerification(member,parsed.data.channel,parsed.data.scope,parsed.data.code,'member'))return res.status(400).json({error:'The verification code is invalid or expired.'});
  return res.json({success:true,data:await loadPreferences(member,true,parsed.data.scope==='team')});}
  catch(error){logger.error({err:error},'[SupportNotifications] Verification confirmation failed');return res.status(500).json({error:'Failed to verify destination.'});}}

export async function requestOwnerDestinationVerification(req:Request,res:Response){try{const userId=Number((req as Request&{user?:{id?:number}}).user?.id);if(!userId)return res.status(401).json({error:'Unauthorized'});
  const member=await ownedMember(userId,Number(req.params.teamId),Number(req.params.memberId));if(!member)return res.status(404).json({error:'Support member not found.'});
  const parsed=verificationRequestSchema.safeParse({...req.body,scope:'member'});if(!parsed.success)return res.status(400).json({error:'Invalid notification channel.'});
  const data=await requestVerification(member,parsed.data.channel,'member','owner');if(!data)return res.status(404).json({error:'Save a destination before requesting verification.'});return res.json({success:true,data});}
  catch(error){logger.error({err:error},'[SupportNotifications] Owner verification delivery failed');return res.status(502).json({error:error instanceof Error?error.message:'Failed to deliver verification.'});}}
export async function confirmOwnerDestinationVerification(req:Request,res:Response){try{const userId=Number((req as Request&{user?:{id?:number}}).user?.id);if(!userId)return res.status(401).json({error:'Unauthorized'});
  const member=await ownedMember(userId,Number(req.params.teamId),Number(req.params.memberId));if(!member)return res.status(404).json({error:'Support member not found.'});
  const parsed=verificationConfirmSchema.safeParse({...req.body,scope:'member'});if(!parsed.success)return res.status(400).json({error:'Enter the six-digit verification code.'});
  if(!await confirmVerification(member,parsed.data.channel,'member',parsed.data.code,'owner'))return res.status(400).json({error:'The verification code is invalid or expired.'});return res.json({success:true,data:await loadPreferences(member,false)});}
  catch(error){logger.error({err:error},'[SupportNotifications] Owner verification confirmation failed');return res.status(500).json({error:'Failed to verify destination.'});}}

export async function getTeamNotificationDefaults(req:Request,res:Response){try{const member=currentMember(req);if(!member)return res.status(401).json({error:'Unauthorized'});if(!canManageTeamDefaults(member))return res.status(403).json({error:'Team lead or admin role required.'});return res.json({success:true,data:await loadPreferences(member,true,true)});}
catch(error){logger.error({err:error},'[SupportNotifications] Team defaults read failed');return res.status(500).json({error:'Failed to load team notification defaults.'});}}
export async function updateTeamNotificationDefaults(req:Request,res:Response){try{const member=currentMember(req);if(!member)return res.status(401).json({error:'Unauthorized'});if(!canManageTeamDefaults(member))return res.status(403).json({error:'Team lead or admin role required.'});
  const parsed=parsePreferences(req.body);if(!parsed.preferences)return res.status(400).json({error:parsed.error});await savePreferences({member,preferences:parsed.preferences,actorType:'member',actorMemberId:member.id,teamDefaults:true});return res.json({success:true,data:await loadPreferences(member,true,true)});}
catch(error){logger.error({err:error},'[SupportNotifications] Team defaults update failed');return res.status(500).json({error:'Failed to update team notification defaults.'});}}
const availabilitySchema=z.object({isOnCall:z.boolean(),locale:z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).max(24),timezone:z.string().trim().min(1).max(100),
  quietHours:z.object({enabled:z.boolean(),start:z.string().regex(/^\d{2}:\d{2}$/),end:z.string().regex(/^\d{2}:\d{2}$/)}).strict()}).strict();
function notificationAvailability(member: Member) {
  const quietHours = member.quietHours as { enabled?: unknown; start?: unknown; end?: unknown } | null;
  return {
    isOnCall: member.isOnCall,
    locale: member.locale || 'en-IN',
    timezone: member.timezone || 'Asia/Kolkata',
    quietHours: {
      enabled: typeof quietHours?.enabled === 'boolean' ? quietHours.enabled : false,
      start: typeof quietHours?.start === 'string' && /^\d{2}:\d{2}$/.test(quietHours.start) ? quietHours.start : '22:00',
      end: typeof quietHours?.end === 'string' && /^\d{2}:\d{2}$/.test(quietHours.end) ? quietHours.end : '08:00',
    },
  };
}
export async function getMyNotificationAvailability(req:Request,res:Response){const member=currentMember(req);if(!member)return res.status(401).json({error:'Unauthorized'});
  return res.json({success:true,data:notificationAvailability(member)});}
export async function updateMyNotificationAvailability(req:Request,res:Response){try{const member=currentMember(req);if(!member)return res.status(401).json({error:'Unauthorized'});const parsed=availabilitySchema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message});const [updated]=await db.update(teamMembersTable).set(parsed.data).where(and(eq(teamMembersTable.id,member.id),eq(teamMembersTable.userId,member.userId))).returning();
  return res.json({success:true,data:notificationAvailability(updated)});}
catch(error){logger.error({err:error},'[SupportNotifications] Availability update failed');return res.status(500).json({error:'Failed to update availability.'});}}

export async function listMySupportNotifications(req:Request,res:Response){try{const member=currentMember(req);if(!member)return res.status(401).json({error:'Unauthorized'});
  const limit=Math.min(100,Math.max(1,Number(req.query.limit)||30));const offset=Math.max(0,Number(req.query.offset)||0);
  const data=await withSupportNotificationTenant(member.userId,async(tx)=>{const rows=await tx.execute(sql`SELECT r.id,r.read_at,r.acknowledged_at,r.claimed_at,r.escalation_level,r.created_at,
    e.event_type,e.ticket_id,e.severity,e.safe_summary,e.required_action,e.sla_deadline,e.payload,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',d.id,'channel',d.channel,'status',d.status,'destinationHint',d.destination_hint,
      'attemptCount',d.attempt_count,'providerStatus',d.provider_status,'errorCode',d.error_code,'lastError',d.last_error,
      'acceptedAt',d.accepted_at,'deliveredAt',d.delivered_at) ORDER BY d.created_at)
      FROM support_member_notification_deliveries d WHERE d.event_id=e.id AND d.member_id=r.member_id),'[]'::jsonb) deliveries
    FROM support_notification_receipts r JOIN support_notification_events e ON e.id=r.event_id
    WHERE r.user_id=${member.userId} AND r.member_id=${member.id} ${req.query.unread==='true'?sql`AND r.read_at IS NULL`:sql``}
    ORDER BY r.created_at DESC LIMIT ${limit} OFFSET ${offset}`);
    const counts=await tx.execute(sql`SELECT COUNT(*) FILTER(WHERE read_at IS NULL)::int unread_count,
      COUNT(*) FILTER(WHERE acknowledged_at IS NULL)::int unacknowledged_count,COUNT(*)::int total
      FROM support_notification_receipts WHERE user_id=${member.userId} AND member_id=${member.id}`);
    return{notifications:rows.rows,...(counts.rows[0]as {unread_count?:number;unacknowledged_count?:number;total?:number})};});
  return res.json({success:true,data:{...data,unreadCount:Number(data.unread_count||0),unacknowledgedCount:Number(data.unacknowledged_count||0),total:Number(data.total||0)}});}
catch(error){logger.error({err:error},'[SupportNotifications] Notification center read failed');return res.status(500).json({error:'Failed to load notifications.'});}}
export async function markMySupportNotificationRead(req:Request,res:Response){try{const member=currentMember(req);if(!member)return res.status(401).json({error:'Unauthorized'});const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<=0)return res.status(400).json({error:'Invalid notification.'});const row=await withSupportNotificationTenant(member.userId,async(tx)=>(await tx.execute(sql`UPDATE support_notification_receipts
    SET read_at=COALESCE(read_at,NOW()) WHERE id=${id} AND user_id=${member.userId} AND member_id=${member.id} RETURNING id,read_at`)).rows[0]);
  return row?res.json({success:true,data:row}):res.status(404).json({error:'Notification not found.'});}
catch(error){logger.error({err:error},'[SupportNotifications] Notification read update failed');return res.status(500).json({error:'Failed to update notification.'});}}
export async function markAllMySupportNotificationsRead(req:Request,res:Response){try{const member=currentMember(req);if(!member)return res.status(401).json({error:'Unauthorized'});
  const count=await withSupportNotificationTenant(member.userId,async(tx)=>(await tx.execute(sql`UPDATE support_notification_receipts SET read_at=NOW()
    WHERE user_id=${member.userId} AND member_id=${member.id} AND read_at IS NULL RETURNING id`)).rows.length);return res.json({success:true,data:{updated:count}});}
catch(error){logger.error({err:error},'[SupportNotifications] Mark-all failed');return res.status(500).json({error:'Failed to update notifications.'});}}
export async function acknowledgeMySupportNotification(req:Request,res:Response){const member=currentMember(req);if(!member)return res.status(401).json({error:'Unauthorized'});
  return await supportMemberNotificationService.acknowledgeReceipt(member.userId,member.id,Number(req.params.id))?res.json({success:true}):res.status(404).json({error:'Notification not found.'});}
export async function claimMySupportNotificationTicket(req:Request,res:Response){try{const member=currentMember(req);if(!member)return res.status(401).json({error:'Unauthorized'});const receiptId=Number(req.params.id);
  const claimed=await withSupportNotificationTenant(member.userId,async(tx)=>{const receipt=await tx.execute(sql`SELECT r.id,e.ticket_id FROM support_notification_receipts r JOIN support_notification_events e ON e.id=r.event_id
    WHERE r.id=${receiptId} AND r.user_id=${member.userId} AND r.member_id=${member.id} FOR UPDATE`);const row=receipt.rows[0]as{id:number;ticket_id:number}|undefined;if(!row)return false;
    const ticket=await tx.execute(sql`UPDATE support_tickets SET assigned_member_id=${member.id},team_id=${member.teamId},status=CASE WHEN status='open' THEN 'in_progress' ELSE status END,updated_at=NOW()
      WHERE id=${row.ticket_id} AND user_id=${member.userId} AND assigned_member_id IS NULL AND deleted_at IS NULL RETURNING id`);if(!ticket.rows[0])return false;
    await tx.execute(sql`UPDATE support_notification_receipts SET claimed_at=NOW(),acknowledged_at=COALESCE(acknowledged_at,NOW()),read_at=COALESCE(read_at,NOW()) WHERE id=${receiptId}`);return true;});
  if(!claimed)return res.status(409).json({error:'This ticket is already assigned or unavailable.'});await supportMemberNotificationService.processPendingEvents(10);return res.json({success:true});}
catch(error){logger.error({err:error},'[SupportNotifications] Ticket claim failed');return res.status(500).json({error:'Failed to claim ticket.'});}}
export async function retryMySupportNotificationDelivery(req:Request,res:Response){const member=currentMember(req);if(!member)return res.status(401).json({error:'Unauthorized'});const id=Number(req.params.deliveryId);
  const owns=await withSupportNotificationTenant(member.userId,async(tx)=>(await tx.execute(sql`SELECT id FROM support_member_notification_deliveries WHERE id=${id} AND user_id=${member.userId} AND member_id=${member.id}`)).rows.length===1);
  if(!owns)return res.status(404).json({error:'Delivery not found.'});return await supportMemberNotificationService.retryDelivery(member.userId,id)?res.json({success:true}):res.status(409).json({error:'This delivery cannot be retried.'});}

export async function getOwnerNotificationHealth(req:Request,res:Response){try{const userId=Number(businessOwnerUserId(req));if(!userId)return res.status(401).json({error:'Unauthorized'});
  const health=await withSupportNotificationTenant(userId,async(tx)=>{const metrics=(await tx.execute(sql`SELECT
    (SELECT COUNT(*)::int FROM support_tickets WHERE user_id=${userId} AND assigned_member_id IS NULL AND status IN('open','in_progress')) unassigned_tickets,
    (SELECT COUNT(*)::int FROM support_notification_receipts r JOIN support_notification_events e ON e.id=r.event_id WHERE r.user_id=${userId} AND r.acknowledged_at IS NULL AND e.severity='urgent') unacknowledged_urgent,
    (SELECT COUNT(*)::int FROM support_member_notification_deliveries WHERE user_id=${userId} AND status IN('failed','dead_letter')) failed_deliveries,
    (SELECT COUNT(*)::int FROM support_member_notification_deliveries WHERE user_id=${userId} AND status='uncertain') uncertain_deliveries,
    (SELECT COUNT(*)::int FROM support_notification_destinations WHERE user_id=${userId} AND verification_status IN('verified','owner_verified')) verified_destinations`)).rows[0];
    const failures=await tx.execute(sql`SELECT d.id,d.channel,d.status,d.error_code,d.destination_hint,d.updated_at,e.ticket_id,e.event_type
      FROM support_member_notification_deliveries d LEFT JOIN support_notification_events e ON e.id=d.event_id
      WHERE d.user_id=${userId} AND d.status IN('failed','dead_letter','uncertain','retry') ORDER BY d.updated_at DESC LIMIT 25`);
    const recent=await tx.execute(sql`SELECT d.id,d.member_id,d.channel,d.status,d.provider_status,d.destination_hint,d.updated_at,e.ticket_id,e.event_type
      FROM support_member_notification_deliveries d LEFT JOIN support_notification_events e ON e.id=d.event_id
      WHERE d.user_id=${userId} ORDER BY d.updated_at DESC LIMIT 30`);return{...metrics,recentFailures:failures.rows,recentDeliveries:recent.rows};});
  return res.json({success:true,data:{...health,platforms:supportMemberNotificationService.platformAvailability()}});}
catch(error){logger.error({err:error},'[SupportNotifications] Health read failed');return res.status(500).json({error:'Failed to load notification health.'});}}

export async function retryOwnerSupportNotificationDelivery(req: Request, res: Response) {
  try {
    const userId = Number((req as Request & { user?: { id?: number } }).user?.id);
    const deliveryId = Number(req.params.deliveryId);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!Number.isInteger(deliveryId) || deliveryId <= 0) return res.status(400).json({ error: 'Invalid delivery ID.' });
    const delivery = await withSupportNotificationTenant(userId, async (tx) => {
      const result = await tx.execute(sql`
        SELECT id,status FROM support_member_notification_deliveries
        WHERE id=${deliveryId} AND user_id=${userId} LIMIT 1
      `);
      return result.rows[0] as { id?: number; status?: string } | undefined;
    });
    if (!delivery?.id) return res.status(404).json({ error: 'Notification delivery not found.' });
    if (delivery.status === 'uncertain') {
      return res.status(409).json({ error: 'Uncertain provider outcomes must be reconciled before retrying.' });
    }
    if (!isSupportNotificationDeliveryRetryable(String(delivery.status || ''))) {
      return res.status(409).json({ error: 'Only failed or dead-letter deliveries can be retried.' });
    }
    const retried = await supportMemberNotificationService.retryDelivery(userId, deliveryId);
    return retried
      ? res.json({ success: true })
      : res.status(409).json({ error: 'Only failed or dead-letter deliveries can be retried.' });
  } catch (error) {
    logger.error({ err: error }, '[SupportNotifications] Owner delivery retry failed');
    return res.status(500).json({ error: 'Failed to retry the notification delivery.' });
  }
}

const templateSchema=z.object({teamId:z.number().int().positive().nullable().optional(),eventType:z.enum(EVENTS),channel:z.enum(CHANNELS),
  locale:z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).default('en-IN'),name:z.string().trim().min(1).max(160),
  subjectTemplate:z.string().trim().max(500).optional(),textTemplate:z.string().trim().min(1).max(5000)}).strict();
function validateTemplateText(...templates:(string|undefined)[]){
  const allowed=new Set(SupportMemberNotificationService.allowedTemplateVariables());
  for(const template of templates){if(!template)continue;if(template.includes('{{{')||/<\/?[a-z][^>]*>/i.test(template))throw new Error('Templates must be plain text and cannot contain raw HTML.');
    for(const match of template.matchAll(/{{\s*([^}\s]+)\s*}}/g)){if(!allowed.has(match[1]))throw new Error(`Unknown template variable: ${match[1]}`);}}
}
export async function listOwnerNotificationTemplates(req:Request,res:Response){try{const userId=Number(businessOwnerUserId(req));if(!userId)return res.status(401).json({error:'Unauthorized'});
  const rows=await withSupportNotificationTenant(userId,async(tx)=>(await tx.execute(sql`SELECT t.*,v.subject_template,v.text_template,v.published_at,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('version',history.version,'publishedAt',history.published_at,'createdAt',history.created_at) ORDER BY history.version DESC)
      FROM support_notification_template_versions history WHERE history.template_id=t.id),'[]'::jsonb) versions
    FROM support_notification_templates t LEFT JOIN support_notification_template_versions v ON v.template_id=t.id AND v.version=COALESCE(t.active_version,
      (SELECT MAX(v2.version) FROM support_notification_template_versions v2 WHERE v2.template_id=t.id)) WHERE t.user_id=${userId} ORDER BY t.updated_at DESC`)).rows);
  return res.json({success:true,data:{templates:rows,allowedVariables:SupportMemberNotificationService.allowedTemplateVariables()}});}
catch(error){logger.error({err:error},'[SupportNotifications] Template list failed');return res.status(500).json({error:'Failed to load notification templates.'});}}
export async function saveOwnerNotificationTemplate(req:Request,res:Response){try{const userId=Number((req as Request&{user?:{id?:number}}).user?.id);if(!userId)return res.status(401).json({error:'Unauthorized'});
  const parsed=templateSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message});validateTemplateText(parsed.data.subjectTemplate,parsed.data.textTemplate);
  if(parsed.data.teamId){const owned=(await db.execute(sql`SELECT id FROM support_teams WHERE id=${parsed.data.teamId} AND user_id=${userId}`)).rows[0];if(!owned)return res.status(400).json({error:'Invalid support team.'});}
  const saved=await withSupportNotificationTenant(userId,async(tx)=>{const template=await tx.execute(sql`INSERT INTO support_notification_templates
    (user_id,team_id,event_type,channel,locale,audience,name,status,updated_at) VALUES(${userId},${parsed.data.teamId||null},${parsed.data.eventType},${parsed.data.channel},${parsed.data.locale},'member',${parsed.data.name},'draft',NOW())
    ON CONFLICT(business_profile_id, user_id,team_id,event_type,channel,locale,audience) DO UPDATE SET name=EXCLUDED.name,status='draft',updated_at=NOW() RETURNING id`);
    const id=Number((template.rows[0]as{id:number}).id);const next=await tx.execute(sql`SELECT COALESCE(MAX(version),0)+1 version FROM support_notification_template_versions WHERE template_id=${id}`);
    const version=Number((next.rows[0]as{version:number}).version);const checksum=crypto.createHash('sha256').update(`${parsed.data.subjectTemplate||''}\n${parsed.data.textTemplate}`).digest('hex');
    await tx.execute(sql`INSERT INTO support_notification_template_versions(user_id,template_id,version,subject_template,text_template,allowed_variables,checksum)
      VALUES(${userId},${id},${version},${parsed.data.subjectTemplate||null},${parsed.data.textTemplate},${supportNotificationAllowedVariablesSql()},${checksum})`);
    await audit(tx,{userId,actorType:'owner',action:'template.version_created',entityType:'support_notification_template',entityId:id,metadata:{version}});return{id,version};});
  return res.status(201).json({success:true,data:saved});}
catch(error){logger.error({errorName:error instanceof Error?error.name:'UnknownError'},'[SupportNotifications] Template version save failed');return res.status(400).json({error:'Failed to save notification template. Please try again.'});}}
export async function publishOwnerNotificationTemplate(req:Request,res:Response){try{const userId=Number((req as Request&{user?:{id?:number}}).user?.id);if(!userId)return res.status(401).json({error:'Unauthorized'});const id=Number(req.params.id);const version=Number(req.body?.version);
  const published=await withSupportNotificationTenant(userId,async(tx)=>{const candidate=await tx.execute(sql`SELECT subject_template,text_template FROM support_notification_template_versions WHERE user_id=${userId} AND template_id=${id} AND version=${version}`);
    const row=candidate.rows[0]as{subject_template?:string;text_template?:string}|undefined;if(!row)return false;validateTemplateText(row.subject_template,row.text_template);
    await tx.execute(sql`UPDATE support_notification_template_versions SET published_at=NOW() WHERE user_id=${userId} AND template_id=${id} AND version=${version}`);
    const changed=await tx.execute(sql`UPDATE support_notification_templates SET status='published',active_version=${version},updated_at=NOW() WHERE id=${id} AND user_id=${userId} RETURNING id`);
    if(changed.rows[0])await audit(tx,{userId,actorType:'owner',action:'template.published',entityType:'support_notification_template',entityId:id,metadata:{version}});return Boolean(changed.rows[0]);});
  return published?res.json({success:true}):res.status(404).json({error:'Template version not found.'});}
catch(error){return res.status(400).json({error:error instanceof Error?error.message:'Failed to publish template.'});}}

export async function restoreOwnerAssignmentEmailTemplate(req: Request, res: Response) {
  try {
    const userId = Number((req as Request & { user?: { id?: number } }).user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const templateId = await withSupportNotificationTenant(userId, async (tx) => {
      await ensureManagedAssignmentEmailTemplate(tx, userId);
      const restored = await tx.execute(sql`
        UPDATE support_notification_templates SET status='published',active_version=1,
          name='Default ticket assignment email',managed_key='managed.support.ticket_assigned.email.v1',updated_at=NOW()
        WHERE user_id=${userId} AND team_id IS NULL AND event_type='ticket_assigned'
          AND channel='email' AND locale='en-IN' AND audience='member' RETURNING id
      `);
      const id = Number((restored.rows[0] as { id?: number } | undefined)?.id || 0);
      await audit(tx, { userId, actorType: 'owner', action: 'template.default_restored',
        entityType: 'support_notification_template', entityId: id, metadata: { version: 1 } });
      return id;
    });
    return res.json({ success: true, data: { id: templateId, version: 1 } });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to restore the managed default.' });
  }
}

const providerBindingSchema = z.object({
  teamId: z.number().int().positive().nullable().optional(),
  whatsappTemplateId: z.number().int().positive(),
  language: z.string().trim().min(2).max(50),
  variableMapping: z.record(z.string().regex(/^\d+$/), z.enum([
    'ticket_number', 'priority', 'source_channel', 'safe_summary',
    'required_action', 'response_target', 'ticket_url',
  ])).optional(),
  enabled: z.boolean().default(true),
}).strict();

const defaultWhatsappVariableMapping = {
  '1': 'ticket_number', '2': 'priority', '3': 'source_channel', '4': 'safe_summary',
  '5': 'required_action', '6': 'response_target', '7': 'ticket_url',
} as const;

export async function getOwnerNotificationProviderCapabilities(req: Request, res: Response) {
  try {
    const userId = Number(businessOwnerUserId(req));
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    let whatsappConnection: 'connected' | 'not_connected' | 'provider_unavailable' = 'not_connected';
    try {
      const creds = await whatsappApiService.resolveCreds(userId);
      whatsappConnection = creds?.accessToken && creds.businessAccountId ? 'connected' : 'not_connected';
    } catch { whatsappConnection = 'provider_unavailable'; }
    const data = await withSupportNotificationTenant(userId, async (tx) => {
      const templates = await tx.execute(sql`
        SELECT id,name,language,category,status,meta_status,waba_template_id,last_synced_at,
          submission_status,meta_rejection_reason,has_local_changes,body,header,header_type,buttons
        FROM whatsapp_templates WHERE user_id=${userId} ORDER BY updated_at DESC
      `);
      const bindings = await tx.execute(sql`
        SELECT id,team_id,event_type,whatsapp_template_id,language,variable_mapping,enabled,updated_at
        FROM support_notification_provider_bindings WHERE user_id=${userId} ORDER BY event_type,team_id NULLS LAST
      `);
      return {
        templates: (templates.rows as Array<Record<string, unknown>>).map((row) => {
          const record = row as Record<string, unknown>;
          const compatibility = supportNotificationTemplateCompatibility({
            category: String(record.category || ''), body: String(record.body || ''),
            header: String(record.header || ''), headerType: String(record.header_type || 'NONE'),
            buttons: record.buttons, wabaTemplateId: record.waba_template_id ? String(record.waba_template_id) : null,
            metaStatus: record.meta_status ? String(record.meta_status) : null, status: String(record.status || ''),
            hasLocalChanges: record.has_local_changes === true,
          });
          return { ...record, ...compatibility };
        }),
        bindings: bindings.rows,
      };
    });
    const platforms = supportMemberNotificationService.platformAvailability();
    return res.json({ success: true, data: {
      email: { state: platforms.email },
      whatsapp: { state: whatsappConnection },
      ...data,
    } });
  } catch (error) {
    logger.error({ err: error }, '[SupportNotifications] Provider capabilities failed');
    return res.status(500).json({ error: 'Failed to load notification provider readiness.' });
  }
}

export async function saveOwnerNotificationProviderBinding(req: Request, res: Response) {
  try {
    const userId = Number((req as Request & { user?: { id?: number } }).user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const eventType = req.params.eventType as SupportNotificationEvent;
    if (!EVENTS.includes(eventType)) return res.status(400).json({ error: 'Unsupported support notification event.' });
    const parsed = providerBindingSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid binding.' });
    const saved = await withSupportNotificationTenant(userId, async (tx) => {
      if (parsed.data.teamId) {
        const team = await tx.execute(sql`SELECT id FROM support_teams WHERE id=${parsed.data.teamId} AND user_id=${userId}`);
        if (!team.rows[0]) throw new Error('Invalid support team.');
      }
      const template = await tx.execute(sql`
        SELECT id,name,language,category,status,meta_status,waba_template_id,has_local_changes,body,header,header_type,buttons
        FROM whatsapp_templates WHERE id=${parsed.data.whatsappTemplateId} AND user_id=${userId} LIMIT 1
      `);
      const row = template.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new Error('WhatsApp template not found.');
      const compatibility = supportNotificationTemplateCompatibility({
        category: String(row.category || ''), body: String(row.body || ''), header: String(row.header || ''),
        headerType: String(row.header_type || 'NONE'), buttons: row.buttons,
        wabaTemplateId: row.waba_template_id ? String(row.waba_template_id) : null,
        metaStatus: row.meta_status ? String(row.meta_status) : null, status: String(row.status || ''),
        hasLocalChanges: row.has_local_changes === true,
      });
      if (!compatibility.compatible) throw new Error(compatibility.reasons.join('. '));
      if (String(row.language || '') !== parsed.data.language) {
        throw new Error('The binding language must match the approved Meta template language.');
      }
      const mapping = parsed.data.variableMapping || defaultWhatsappVariableMapping;
      const positions = Object.keys(mapping).map(Number).sort((left, right) => left - right);
      const variables = Object.values(mapping);
      if (positions.length !== compatibility.parameterCount
        || positions.some((position, index) => position !== index + 1)
        || new Set(variables).size !== variables.length) {
        throw new Error(`Map all ${compatibility.parameterCount} WhatsApp body parameters.`);
      }
      const result = await tx.execute(sql`
        INSERT INTO support_notification_provider_bindings (
          user_id,team_id,event_type,channel,whatsapp_template_id,language,variable_mapping,enabled,updated_at
        ) VALUES (${userId},${parsed.data.teamId || null},${eventType},'whatsapp',${parsed.data.whatsappTemplateId},
          ${parsed.data.language},${JSON.stringify(mapping)}::jsonb,${parsed.data.enabled},NOW())
        ON CONFLICT (business_profile_id, user_id,team_id,event_type,channel)
        DO UPDATE SET whatsapp_template_id=EXCLUDED.whatsapp_template_id,language=EXCLUDED.language,
          variable_mapping=EXCLUDED.variable_mapping,enabled=EXCLUDED.enabled,updated_at=NOW()
        RETURNING *
      `);
      const binding = result.rows[0] as { id?: number } | undefined;
      await audit(tx, { userId, actorType: 'owner', action: 'provider_binding.saved',
        entityType: 'support_notification_provider_binding', entityId: Number(binding?.id || 0),
        metadata: { eventType, teamId: parsed.data.teamId || null, templateId: parsed.data.whatsappTemplateId } });
      return binding;
    });
    return res.json({ success: true, data: saved });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to save provider binding.' });
  }
}

const previewSchema = z.object({
  eventType: z.enum(EVENTS).default('ticket_assigned'),
  channel: z.enum(['email', 'whatsapp']).default('email'),
  teamId: z.number().int().positive().nullable().optional(),
  memberId: z.number().int().positive().nullable().optional(),
}).strict();

export async function previewOwnerSupportNotification(req: Request, res: Response) {
  try {
    const userId = Number((req as Request & { user?: { id?: number } }).user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const parsed = previewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid preview.' });
    const rendered = await supportMemberNotificationService.previewForOwner(userId, parsed.data);
    return res.json({ success: true, data: rendered });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to preview notification.' });
  }
}

const testDeliverySchema = z.object({
  teamId: z.number().int().positive(),
  memberId: z.number().int().positive(),
  channel: z.enum(['email', 'whatsapp']),
}).strict();

export async function testOwnerSupportNotificationChannel(req: Request, res: Response) {
  try {
    const userId = Number((req as Request & { user?: { id?: number } }).user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const parsed = testDeliverySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid test notification.' });
    const member = await ownedMember(userId, parsed.data.teamId, parsed.data.memberId);
    if (!member) return res.status(404).json({ error: 'Support member not found.' });
    const deliveryId = await supportMemberNotificationService.queueOwnerTestDelivery(userId, member.id, parsed.data.channel);
    return res.status(202).json({ success: true, data: { deliveryId, status: 'pending' } });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to queue the test notification.' });
  }
}
