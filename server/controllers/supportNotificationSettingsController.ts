import { businessOwnerUserId } from '../tenancy/businessContext.js';
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../models/db.js';
import {
  renderSupportNotificationTemplate,
  supportNotificationDestinationHint,
  supportMemberNotificationService,
  withSupportNotificationTenant,
} from '../services/SupportMemberNotificationService.js';
import {
  ensureManagedAssignmentEmailTemplate,
  supportNotificationAllowedVariablesSql,
  syncOwnerVerifiedMemberNotificationContact,
} from '../services/SupportNotificationConfigurationService.js';
import { whatsappApiService } from '../services/whatsappApiService.js';
import { supportNotificationTemplateCompatibility } from './whatsappTemplateController.js';
import { logger } from '../utils/logger.js';
import { getSupportNotificationEmailSender } from '../services/SupportNotificationEmailConfiguration.js';

const DEFAULT_SUBJECT = '{{event_title}} · {{ticket_number}}';
const DEFAULT_TEXT = `{{event_title}}

Ticket: {{ticket_number}}
Priority: {{priority}}
Source: {{source_channel}}
Issue: {{safe_summary}}
Required action: {{required_action}}
Response target: {{response_target}}

Open ticket: {{ticket_url}}`;

const SAMPLE = {
  event_title: 'Ticket assignment', ticket_number: 'TKT-EXAMPLE', priority: 'HIGH',
  source_channel: 'WhatsApp', safe_summary: 'A customer needs help choosing the right room.',
  required_action: 'Review the conversation and reply in the support portal.',
  response_target: '20 minutes remaining', ticket_url: 'https://asksales.ai/support/tickets/123',
};
const EMAIL_VARIABLES = new Set(Object.keys(SAMPLE));
const WHATSAPP_MAPPING = {
  '1': 'ticket_number', '2': 'priority', '3': 'source_channel', '4': 'safe_summary',
  '5': 'required_action', '6': 'response_target', '7': 'ticket_url',
} as const;

const emailSettingsSchema = z.object({
  enabled: z.boolean(),
  subject: z.string().trim().min(1).max(500),
  text: z.string().trim().min(1).max(10_000),
}).strict();
const whatsappSettingsSchema = z.object({
  enabled: z.boolean(),
  whatsappTemplateId: z.number().int().positive().nullable().optional(),
}).strict();

function ownerId(req: Request): number {
  return Number(businessOwnerUserId(req) || 0);
}

function validateEmailTemplate(subject: string, text: string): void {
  const tokens = [...`${subject}\n${text}`.matchAll(/{{\s*([a-z0-9_]+)\s*}}/gi)].map((match) => match[1]);
  const unsupported = tokens.filter((token) => !EMAIL_VARIABLES.has(token));
  if (unsupported.length) throw new Error(`Unsupported notification variable: ${unsupported[0]}.`);
}

async function whatsappProviderState(userId: number): Promise<'connected' | 'not_connected' | 'provider_unavailable'> {
  try {
    const creds = await whatsappApiService.resolveCreds(userId);
    return creds?.accessToken && creds.businessAccountId ? 'connected' : 'not_connected';
  } catch {
    return 'provider_unavailable';
  }
}

async function loadSettings(userId: number) {
  const whatsappState = await whatsappProviderState(userId);
  const emailSender = await getSupportNotificationEmailSender().catch(() => null);
  return withSupportNotificationTenant(userId, async (tx) => {
    const [channels, emailTemplate, providerTemplates, binding, recipients] = await Promise.all([
      tx.execute(sql`SELECT channel,enabled FROM support_notification_channel_settings WHERE user_id=${userId}`),
      tx.execute(sql`
        SELECT v.subject_template,v.text_template
        FROM support_notification_templates t
        JOIN support_notification_template_versions v ON v.template_id=t.id AND v.version=t.active_version
        WHERE t.user_id=${userId} AND t.team_id IS NULL AND t.event_type='ticket_assigned'
          AND t.channel='email' AND t.status='published'
        ORDER BY t.updated_at DESC LIMIT 1
      `),
      tx.execute(sql`
        SELECT id,name,language,category,status,meta_status,waba_template_id,last_synced_at,
          submission_status,meta_rejection_reason,has_local_changes,body,header,header_type,buttons
        FROM whatsapp_templates WHERE user_id=${userId} ORDER BY updated_at DESC
      `),
      tx.execute(sql`
        SELECT whatsapp_template_id,language,enabled
        FROM support_notification_provider_bindings
        WHERE user_id=${userId} AND team_id IS NULL AND event_type='ticket_assigned'
          AND channel='whatsapp' LIMIT 1
      `),
      tx.execute(sql`
        SELECT tm.id member_id,tm.name member_name,tm.email member_email,tm.is_active,st.id team_id,st.name team_name,
          whatsapp_destination.destination_hint whatsapp_hint,
          whatsapp_destination.verification_status whatsapp_verification
        FROM team_members tm
        JOIN support_teams st ON st.id=tm.team_id AND st.user_id=tm.user_id
        LEFT JOIN support_notification_destinations whatsapp_destination
          ON whatsapp_destination.member_id=tm.id AND whatsapp_destination.user_id=tm.user_id
            AND whatsapp_destination.team_id=tm.team_id AND whatsapp_destination.channel='whatsapp'
        WHERE tm.user_id=${userId} ORDER BY st.name,tm.name
      `),
    ]);
    const switches = new Map((channels.rows as Array<{ channel: string; enabled: boolean }>).map((row) => [row.channel, row.enabled]));
    const email = emailTemplate.rows[0] as { subject_template?: string; text_template?: string } | undefined;
    const currentBinding = binding.rows[0] as { whatsapp_template_id?: number; language?: string; enabled?: boolean } | undefined;
    const templates: Array<Record<string, unknown> & { compatible: boolean; reasons: string[]; parameterCount: number }> =
      (providerTemplates.rows as Array<Record<string, unknown>>).map((record) => {
      const compatibility = supportNotificationTemplateCompatibility({
        category: String(record.category || ''), body: String(record.body || ''),
        header: String(record.header || ''), headerType: String(record.header_type || 'NONE'),
        buttons: record.buttons, wabaTemplateId: record.waba_template_id ? String(record.waba_template_id) : null,
          metaStatus: record.meta_status ? String(record.meta_status) : null, status: String(record.status || ''),
          hasLocalChanges: record.has_local_changes === true,
      });
        return { ...record, ...compatibility };
      });
    const selected = templates.find((template) => Number(template['id']) === Number(currentBinding?.whatsapp_template_id));
    const subject = email?.subject_template || DEFAULT_SUBJECT;
    const text = email?.text_template || DEFAULT_TEXT;
    const emailPreview = renderSupportNotificationTemplate(subject, text, SAMPLE);
    const selectedBody = selected ? String(selected['body'] || '') : '';
    const whatsappPreview = selectedBody
      ? Object.entries(WHATSAPP_MAPPING).reduce((output, [position, variable]) =>
        output.replaceAll(`{{${position}}}`, SAMPLE[variable]), selectedBody)
      : null;
    return {
      email: {
        enabled: switches.get('email') === true,
        providerState: supportMemberNotificationService.platformAvailability().email !== 'available'
          ? supportMemberNotificationService.platformAvailability().email
          : emailSender ? 'available' : 'configuration_required',
        subject, text,
        preview: emailPreview,
      },
      whatsapp: {
        enabled: switches.get('whatsapp') === true,
        providerState: whatsappState,
        templateId: currentBinding?.whatsapp_template_id || null,
        templateName: selected ? String(selected['name'] || '') : null,
        language: currentBinding?.language || null,
        preview: whatsappPreview,
        templates,
      },
      recipients: (recipients.rows as Array<Record<string, unknown>>).map((row) => {
        // Email contact readiness comes from the saved support login address.
        // Enabling Email synchronizes it to the encrypted delivery destination;
        // destination verification and provider availability are separate concerns.
        const memberEmail = z.string().trim().email().max(255).safeParse(row.member_email);
        return {
          memberId: Number(row.member_id), memberName: String(row.member_name), teamName: String(row.team_name),
          active: row.is_active === true,
          emailReady: memberEmail.success,
          emailHint: memberEmail.success ? supportNotificationDestinationHint('email', memberEmail.data.toLowerCase()) : null,
          whatsappReady: ['verified', 'owner_verified'].includes(String(row.whatsapp_verification || '')),
          whatsappHint: row.whatsapp_hint ? String(row.whatsapp_hint) : null,
          memberProfileUrl: `/dashboard/support/teams/${Number(row.team_id)}/members/${Number(row.member_id)}`,
        };
      }),
    };
  });
}

export async function getGlobalSupportNotificationSettings(req: Request, res: Response) {
  const userId = ownerId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    return res.json({ success: true, data: await loadSettings(userId) });
  } catch (error) {
    logger.error({ err: error, userId }, '[SupportNotifications] Global settings read failed');
    return res.status(500).json({ error: 'Failed to load support notification settings.' });
  }
}

export async function updateGlobalEmailNotificationSettings(req: Request, res: Response) {
  const userId = ownerId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const parsed = emailSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid email settings.' });
  try {
    if (parsed.data.enabled && supportMemberNotificationService.platformAvailability().email !== 'available') {
      throw new Error('Configure the Email provider before enabling assigned-member notifications.');
    }
    validateEmailTemplate(parsed.data.subject, parsed.data.text);
    await withSupportNotificationTenant(userId, async (tx) => {
      await ensureManagedAssignmentEmailTemplate(tx, userId);
      const template = await tx.execute(sql`
        SELECT id,COALESCE((SELECT MAX(version) FROM support_notification_template_versions WHERE template_id=t.id),0)::int max_version
        FROM support_notification_templates t
        WHERE t.user_id=${userId} AND t.team_id IS NULL AND t.event_type='ticket_assigned'
          AND t.channel='email' AND t.locale='en-IN' AND t.audience='member' LIMIT 1
      `);
      const row = template.rows[0] as { id?: number; max_version?: number } | undefined;
      if (!row?.id) throw new Error('The assignment email template could not be prepared.');
      const version = Number(row.max_version || 0) + 1;
      const checksum = crypto.createHash('sha256').update(`${parsed.data.subject}\n${parsed.data.text}`).digest('hex');
      await tx.execute(sql`
        INSERT INTO support_notification_template_versions (
          user_id,template_id,version,subject_template,text_template,allowed_variables,checksum,published_at,created_at
        ) VALUES (${userId},${Number(row.id)},${version},${parsed.data.subject},${parsed.data.text},
          ${supportNotificationAllowedVariablesSql()},${checksum},NOW(),NOW())
      `);
      await tx.execute(sql`
        UPDATE support_notification_templates SET status='published',active_version=${version},updated_at=NOW()
        WHERE id=${Number(row.id)} AND user_id=${userId}
      `);
      await tx.execute(sql`
        INSERT INTO support_notification_channel_settings (user_id,channel,enabled,enabled_by_user_id,enabled_at,updated_at)
        VALUES (${userId},'email',${parsed.data.enabled},${userId},CASE WHEN ${parsed.data.enabled} THEN NOW() ELSE NULL END,NOW())
        ON CONFLICT (business_profile_id, user_id,channel) DO UPDATE SET enabled=EXCLUDED.enabled,
          enabled_by_user_id=EXCLUDED.enabled_by_user_id,
          enabled_at=CASE WHEN EXCLUDED.enabled THEN COALESCE(support_notification_channel_settings.enabled_at,NOW()) ELSE NULL END,
          updated_at=NOW()
      `);
      const members = await tx.execute(sql`SELECT id,team_id,email FROM team_members WHERE user_id=${userId}`);
      for (const member of members.rows as Array<{ id: number; team_id: number; email: string }>) {
        await syncOwnerVerifiedMemberNotificationContact(tx as typeof db, {
          userId, teamId: Number(member.team_id), memberId: Number(member.id), ownerUserId: userId,
          channel: 'email', destination: member.email,
        });
      }
    });
    return res.json({ success: true, data: await loadSettings(userId) });
  } catch (error) {
    logger.error({ userId, errorName: error instanceof Error ? error.name : 'UnknownError' },
      '[SupportNotifications] Email settings update failed');
    return res.status(400).json({ error: 'Unable to save email notifications. Please try again.' });
  }
}

export async function updateGlobalWhatsappNotificationSettings(req: Request, res: Response) {
  const userId = ownerId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const parsed = whatsappSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid WhatsApp settings.' });
  try {
    if (parsed.data.enabled && await whatsappProviderState(userId) !== 'connected') {
      throw new Error('Connect WhatsApp before enabling assigned-member notifications.');
    }
    await withSupportNotificationTenant(userId, async (tx) => {
      let template: Record<string, unknown> | undefined;
      if (parsed.data.enabled) {
        if (!parsed.data.whatsappTemplateId) throw new Error('Select an approved WhatsApp utility template before enabling notifications.');
        const result = await tx.execute(sql`
          SELECT id,name,language,category,status,meta_status,waba_template_id,has_local_changes,body,header,header_type,buttons
          FROM whatsapp_templates WHERE id=${parsed.data.whatsappTemplateId} AND user_id=${userId} LIMIT 1
        `);
        template = result.rows[0] as Record<string, unknown> | undefined;
        if (!template) throw new Error('WhatsApp template not found.');
        const compatibility = supportNotificationTemplateCompatibility({
          category: String(template.category || ''), body: String(template.body || ''),
          header: String(template.header || ''), headerType: String(template.header_type || 'NONE'),
          buttons: template.buttons, wabaTemplateId: template.waba_template_id ? String(template.waba_template_id) : null,
          metaStatus: template.meta_status ? String(template.meta_status) : null, status: String(template.status || ''),
          hasLocalChanges: template.has_local_changes === true,
        });
        if (!compatibility.compatible || compatibility.parameterCount !== 7) {
          throw new Error(compatibility.reasons.join('. ') || 'The WhatsApp template must contain seven assignment parameters.');
        }
        await tx.execute(sql`
          INSERT INTO support_notification_provider_bindings (
            user_id,team_id,event_type,channel,whatsapp_template_id,language,variable_mapping,enabled,updated_at
          ) VALUES (${userId},NULL,'ticket_assigned','whatsapp',${parsed.data.whatsappTemplateId},
            ${String(template.language || 'en_US')},${JSON.stringify(WHATSAPP_MAPPING)}::jsonb,TRUE,NOW())
          ON CONFLICT (business_profile_id, user_id,team_id,event_type,channel)
          DO UPDATE SET whatsapp_template_id=EXCLUDED.whatsapp_template_id,language=EXCLUDED.language,
            variable_mapping=EXCLUDED.variable_mapping,enabled=TRUE,updated_at=NOW()
        `);
      }
      await tx.execute(sql`
        INSERT INTO support_notification_channel_settings (user_id,channel,enabled,enabled_by_user_id,enabled_at,updated_at)
        VALUES (${userId},'whatsapp',${parsed.data.enabled},${userId},CASE WHEN ${parsed.data.enabled} THEN NOW() ELSE NULL END,NOW())
        ON CONFLICT (business_profile_id, user_id,channel) DO UPDATE SET enabled=EXCLUDED.enabled,
          enabled_by_user_id=EXCLUDED.enabled_by_user_id,
          enabled_at=CASE WHEN EXCLUDED.enabled THEN COALESCE(support_notification_channel_settings.enabled_at,NOW()) ELSE NULL END,
          updated_at=NOW()
      `);
    });
    return res.json({ success: true, data: await loadSettings(userId) });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to save WhatsApp notifications.' });
  }
}
