import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { supportNotificationTemplateCompatibility } from '../controllers/whatsappTemplateController.js';
import { renderSupportNotificationTemplate, supportNotificationProviderAcknowledgement } from '../services/SupportMemberNotificationService.js';
// @ts-expect-error JavaScript migrations intentionally expose no TypeScript declarations.
import { up as assignedMemberNotificationMigration } from '../migrations/240_assign_support_member_notifications.js';
// @ts-expect-error JavaScript migrations intentionally expose no TypeScript declarations.
import { up as globalNotificationSettingsMigration } from '../migrations/241_global_support_notification_settings.js';

describe('assigned support member notification architecture', () => {
  it('does not record acceptance without a provider acknowledgement', () => {
    for (const id of [undefined, null, '', '  ', false, {}]) {
      expect(supportNotificationProviderAcknowledgement(id)).toEqual({
        outcome: 'uncertain', providerStatus: 'missing_acknowledgement', errorCode: 'PROVIDER_ACK_MISSING',
      });
    }
    expect(supportNotificationProviderAcknowledgement('provider-1')).toEqual({
      outcome: 'accepted', providerStatus: 'accepted', providerMessageId: 'provider-1',
    });
  });
  it('expands external deliveries only for the member actually assigned to the ticket', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'services/SupportMemberNotificationService.ts'), 'utf8');
    expect(source).toContain('if (!event.assigned_member_id) return []');
    expect(source).toContain("support_notification_channel_settings s");
    expect(source).toContain("['ticket_assigned', 'ticket_reassigned'].includes(event.event_type)");
    expect(source).toContain('AND d.member_id=tm.id AND d.channel=s.channel');
    expect(source).toContain('s.enabled IS TRUE');
    expect(source).toContain("'delivery.destination_missing'");
    expect(source).toContain("event.event_type === 'ticket_reassigned' ? 'ticket_assigned'");
    expect(source).toContain("ON CONFLICT (event_key, member_id, channel) DO NOTHING");
    expect(source).toContain('AND b.team_id IS NULL');
    expect(source).not.toContain('const needsLead = !event.assigned_member_id');
  });

  it('uses the same privacy-safe renderer for previews and delivered email', () => {
    const rendered = renderSupportNotificationTemplate(
      '{{event_title}} · {{ticket_number}}',
      'Contact {{safe_summary}} <script>alert(1)</script>',
      { event_title: 'Ticket assignment', ticket_number: 'TKT-1', safe_summary: 'person@example.com +91 98765 43210' },
    );
    expect(rendered.subject).toBe('Ticket assignment · TKT-1');
    expect(rendered.text).toContain('[EMAIL]');
    expect(rendered.text).toContain('[PHONE]');
    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.html).not.toContain('<script>');
    const controller = fs.readFileSync(path.resolve(process.cwd(), 'controllers/supportNotificationSettingsController.ts'), 'utf8');
    expect(controller).toContain('renderSupportNotificationTemplate(subject, text, SAMPLE)');
    expect(fs.readFileSync(path.resolve(process.cwd(), 'services/SupportMemberNotificationService.ts'), 'utf8'))
      .toContain('...renderSupportNotificationTemplate(');
  });

  it('adds tenant-wide email and WhatsApp switches defaulted off with forced RLS', async () => {
    const statements: string[] = [];
    await globalNotificationSettingsMigration({
      query: jest.fn(async (statement: string) => { statements.push(statement); return { rows: [], rowCount: 0 }; }),
    } as never);
    const migrationSql = statements.join('\n');
    expect(migrationSql).toContain('support_notification_channel_settings');
    expect(migrationSql).toContain("DEFAULT FALSE");
    expect(migrationSql).toContain("channel IN ('email', 'whatsapp')");
    expect(migrationSql).toContain('FORCE ROW LEVEL SECURITY');
  });

  it('adds owner verification, tenant template bindings, submission diagnostics, and forced RLS', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (statement: string) => {
      statements.push(statement);
      return { rows: [], rowCount: 0 };
    });
    await assignedMemberNotificationMigration({ query } as never);
    const migrationSql = statements.join('\n');
    expect(migrationSql).toContain("'owner_verified'");
    expect(migrationSql).toContain('support_notification_provider_bindings');
    expect(migrationSql).toContain('whatsapp_template_id');
    expect(migrationSql).toContain('submission_status');
    expect(migrationSql).toContain('meta_rejection_reason');
    expect(migrationSql).toContain('FORCE ROW LEVEL SECURITY');
    expect(migrationSql).toContain('Default ticket assignment email');
    expect(migrationSql).toContain('$1::TEXT');
    expect(migrationSql).toContain('$2::TEXT');
    expect(migrationSql).toContain("conrelid = 'whatsapp_templates'::regclass");
    expect(migrationSql).toContain("WHERE submission_status = 'local_draft'");
    expect(migrationSql).not.toContain('DROP CONSTRAINT IF EXISTS whatsapp_templates_submission_status_check');
  });

  it('accepts only Meta-linked approved utility templates for support alerts', () => {
    expect(supportNotificationTemplateCompatibility({
      category: 'UTILITY', status: 'APPROVED', metaStatus: 'APPROVED', wabaTemplateId: 'meta-1',
      headerType: 'NONE', body: 'Ticket {{1}} priority {{2}} source {{3}} summary {{4}} action {{5}} target {{6}} link {{7}}.', buttons: [],
    })).toEqual({ compatible: true, reasons: [], parameterCount: 7 });

    const incompatible = supportNotificationTemplateCompatibility({
      category: 'MARKETING', status: 'DRAFT', headerType: 'IMAGE',
      body: 'Ticket {{2}}', buttons: [{ type: 'URL', url: 'https://example.com/{{1}}' }],
    });
    expect(incompatible.compatible).toBe(false);
    expect(incompatible.reasons).toEqual(expect.arrayContaining([
      'Utility category required', 'Not linked to Meta', 'Meta approval required',
      'Dynamic media headers are not supported', 'Dynamic URL buttons are not supported',
      'Body parameters must be contiguous from {{1}}',
    ]));
  });

  it('keeps member contacts encrypted, owner-authorized, replace-safe, and outside team_members', () => {
    const configuration = fs.readFileSync(path.resolve(process.cwd(), 'services/SupportNotificationConfigurationService.ts'), 'utf8');
    const teams = fs.readFileSync(path.resolve(process.cwd(), 'controllers/supportTeamsController.ts'), 'utf8');
    const teamSchema = fs.readFileSync(path.resolve(process.cwd(), 'models/teamMembers/schema.ts'), 'utf8');
    expect(configuration).toContain("input.channel === 'whatsapp' && !input.consentAcknowledged");
    expect(configuration).toContain("status IN ('pending','retry')");
    expect(configuration).toContain("error_code='DESTINATION_CHANGED'");
    expect(configuration).toContain("error_code='DESTINATION_REMOVED'");
    expect(configuration).toContain("'destination.removed'");
    expect(configuration).toContain('encryptValue(destination)');
    expect(teams).toContain("value.whatsappNumber !== undefined && !value.whatsappConsentAcknowledged");
    expect(teamSchema).not.toMatch(/whatsapp(Number|Phone)|notificationPhone/i);
  });

  it('rejects locally edited copies even when their previous Meta version is approved', () => {
    const approved = {
      category: 'UTILITY', status: 'APPROVED', metaStatus: 'APPROVED', wabaTemplateId: 'meta-1',
      headerType: 'NONE', body: 'Ticket {{1}} priority {{2}} source {{3}} summary {{4}} action {{5}} target {{6}} link {{7}}.',
    };
    expect(supportNotificationTemplateCompatibility({ ...approved, hasLocalChanges: true }).compatible).toBe(false);
    expect(supportNotificationTemplateCompatibility({ ...approved, status: 'DRAFT' }).compatible).toBe(false);
    expect(supportNotificationTemplateCompatibility({ ...approved, hasLocalChanges: false }).compatible).toBe(true);
    const delivery = fs.readFileSync(path.resolve(process.cwd(), 'services/SupportMemberNotificationService.ts'), 'utf8');
    expect(delivery).toContain('AND wt.has_local_changes IS FALSE');
    expect(delivery).toContain("AND UPPER(wt.status)='APPROVED'");
    expect(delivery).toContain('AND wt.language=b.language');
  });

  it('marks rollback-only member preference APIs as deprecated', () => {
    const ownerRoutes = fs.readFileSync(path.resolve(process.cwd(), 'routes/support.routes.ts'), 'utf8');
    const memberRoutes = fs.readFileSync(path.resolve(process.cwd(), 'routes/supportMember.routes.ts'), 'utf8');
    expect(ownerRoutes).toContain("res.setHeader('Deprecation', 'true')");
    expect(ownerRoutes).toContain('deprecatedMemberNotificationPreferences, getMemberNotificationPreferences');
    expect(memberRoutes).toContain("res.setHeader('Deprecation', 'true')");
    expect(memberRoutes).toContain('deprecatedNotificationPreferences, getMyNotificationPreferences');
  });
});
