import { describe, expect, it, jest } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isSocialFollowUpChannel,
  socialFollowUpDelayMinutes,
  socialFollowUpDueAt,
  socialFollowUpJobId,
  parseUtcDatabaseTimestamp,
} from '../services/socialFollowUpService.js';
// @ts-expect-error JS migrations intentionally expose no TypeScript declarations.
import { up } from '../migrations/154_create_social_follow_up_schedules.js';
// @ts-expect-error JS migrations intentionally expose no TypeScript declarations.
import { up as repairDueTimes } from '../migrations/288_repair_social_follow_up_timestamps.js';

describe('social follow-up behavior', () => {
  it('uses configured periods as deterministic absolute offsets from the latest anchor', () => {
    const sentAt = new Date('2026-07-01T10:00:00.000Z');
    const first = { id: 1, delayDays: 0, delayHours: 2, delayMinutes: 15 };
    const second = { id: 2, delayDays: 1, delayHours: 0, delayMinutes: 30 };

    expect(socialFollowUpDelayMinutes(first)).toBe(135);
    expect(socialFollowUpDueAt(sentAt, first).toISOString()).toBe('2026-07-01T12:15:00.000Z');
    expect(socialFollowUpDueAt(sentAt, second).toISOString()).toBe('2026-07-02T10:30:00.000Z');
    expect(socialFollowUpDueAt(sentAt, second)).toEqual(socialFollowUpDueAt(sentAt, second));
  });

  it('treats raw UTC database timestamps as UTC regardless of host timezone', () => {
    const anchor = parseUtcDatabaseTimestamp('2026-09-22 06:50:54.122532');
    expect(anchor.toISOString()).toBe('2026-09-22T06:50:54.122Z');
    expect(socialFollowUpDueAt(anchor, { id: 1, delayDays: 1 }).toISOString())
      .toBe('2026-09-23T06:50:54.122Z');
    expect(parseUtcDatabaseTimestamp(anchor)).toBe(anchor);
    expect(parseUtcDatabaseTimestamp('2026-09-22T06:50:54.122Z').toISOString())
      .toBe(anchor.toISOString());
  });

  it('repairs existing active schedule times from their UTC anchors and configured offsets', async () => {
    const statements: string[] = [];
    await repairDueTimes({ query: async (statement: string) => {
      statements.push(statement);
      return { rows: [], rowCount: 0 };
    } } as never);
    const repairSql = statements.join('\n');
    expect(repairSql).toContain('COALESCE(anchor.sent_at, anchor.created_at)');
    expect(repairSql).toContain("schedule.status = 'active'");
    expect(repairSql).toContain('schedule.next_step - 1');
  });

  it('limits conversation schedules to the three canonical social namespaces', () => {
    expect(isSocialFollowUpChannel('instagram')).toBe(true);
    expect(isSocialFollowUpChannel('facebook')).toBe(true);
    expect(isSocialFollowUpChannel('whatsapp')).toBe(true);
    expect(isSocialFollowUpChannel('email')).toBe(false);
    expect(isSocialFollowUpChannel('gmail')).toBe(false);
  });

  it('uses a stable queue identity for retries and concurrent scheduler scans', () => {
    expect(socialFollowUpJobId(12, 41, 2)).toBe('social-follow-up-12-41-2');
    expect(socialFollowUpJobId(12, 41, 2)).toBe(socialFollowUpJobId(12, 41, 2));
    expect(socialFollowUpJobId(12, 41, 2)).not.toBe(socialFollowUpJobId(12, 42, 2));
  });

  it('installs one schedule per conversation with explicit anchor and delivery ownership', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (statement: string) => {
      statements.push(statement);
      return { rows: [], rowCount: 0 };
    });

    await up({ query } as never);
    const migrationSql = statements.join('\n');
    expect(migrationSql).toContain('social_follow_up_schedules');
    expect(migrationSql).toContain('UNIQUE (conversation_id)');
    expect(migrationSql).toContain('anchor_message_id');
    expect(migrationSql).toContain('delivery_message_id');
    expect(migrationSql).toContain("channel IN ('instagram', 'facebook', 'whatsapp')");
    expect(migrationSql).toContain("status IN ('active', 'queued', 'sending', 'completed', 'cancelled')");
  });

  it('keeps reply, handoff, loop-prevention, and atomic provider-boundary guards in the durable path', async () => {
    const serviceSource = await readFile(
      join(process.cwd(), 'services/socialFollowUpService.ts'),
      'utf8',
    );
    const workerSource = await readFile(
      join(process.cwd(), 'workers/index.ts'),
      'utf8',
    );
    const conversationModelSource = await readFile(
      join(process.cwd(), 'models/outreachConversations/functions.ts'),
      'utf8',
    );
    const handoffSource = await readFile(
      join(process.cwd(), 'services/agents/pipeline/HandoffService.ts'),
      'utf8',
    );
    const whatsappSource = await readFile(
      join(process.cwd(), 'controllers/whatsappController.ts'),
      'utf8',
    );
    const whatsappWindowSource = await readFile(
      join(process.cwd(), 'services/whatsappServiceWindow.ts'),
      'utf8',
    );

    expect(serviceSource).toContain("anchor.message_kind IN ('outreach', 'reply')");
    expect(serviceSource).toContain("message.message_kind = 'follow_up'");
    expect(serviceSource).toContain("conversation.automation_mode NOT IN ('human_owned', 'approval_pending', 'resolved', 'closed', 'opted_out')");
    expect(serviceSource).toContain("['human_owned', 'approval_pending', 'resolved', 'closed', 'opted_out']");
    expect(serviceSource).toContain("reply.direction = 'inbound'");
    expect(serviceSource).toContain("schedule.status = 'queued'");
    expect(serviceSource).toContain('schedule.delivery_message_id');
    expect(serviceSource).toContain('export async function confirmSocialFollowUpDelivery');
    const atomicClaimIndex = workerSource.lastIndexOf('claimSocialFollowUpDelivery');
    expect(atomicClaimIndex).toBeGreaterThan(-1);
    expect(atomicClaimIndex).toBeLessThan(
      workerSource.indexOf('result = await processWhatsAppOutreach', atomicClaimIndex),
    );
    const whatsappProcessorIndex = workerSource.indexOf('async function processWhatsAppOutreach');
    const instagramProcessorIndex = workerSource.indexOf('async function processInstagramOutreach');
    const facebookProcessorIndex = workerSource.indexOf('async function processFacebookOutreach');
    expect(workerSource.indexOf('confirmManagedSocialFollowUp(job, userId)', whatsappProcessorIndex))
      .toBeLessThan(workerSource.indexOf('whatsappApiService.sendText', whatsappProcessorIndex));
    expect(workerSource.indexOf("hasActiveWhatsAppWindow(", whatsappProcessorIndex))
      .toBeLessThan(workerSource.indexOf('whatsappApiService.sendText', whatsappProcessorIndex));
    expect(workerSource).toContain("failSocialFollowUpDelivery(socialScheduleId, socialFollowUpMessageId, 'template_required')");
    expect(whatsappWindowSource).toContain('conversation.provider_account_id = ${providerAccountId}');
    expect(whatsappWindowSource).toContain('inbound.phone_number_id');
    expect(workerSource.indexOf('confirmManagedSocialFollowUp(job, userId)', instagramProcessorIndex))
      .toBeLessThan(workerSource.indexOf('routeInstagramMessage({', instagramProcessorIndex));
    expect(workerSource.indexOf('confirmManagedSocialFollowUp(job, userId)', facebookProcessorIndex))
      .toBeLessThan(workerSource.indexOf('sendFacebookDM({', facebookProcessorIndex));
    expect(workerSource).toContain("['whatsapp', 'facebook', 'instagram', 'twitter', 'linkedin'].includes(channel)");
    expect(workerSource).toContain("failSocialFollowUpDelivery(socialScheduleId, socialFollowUpMessageId, 'account_unavailable')");
    expect(workerSource).toContain('const deliveryUncertain = deliveryOutcomeIsUncertain(err)');
    expect(serviceSource).toContain("WHEN ${reason} = 'account_unavailable'");
    expect(serviceSource).toContain("WHEN ${reason} = 'template_required'");
    expect(serviceSource).toContain('Reconnect that same account, then create a new follow-up.');
    expect(conversationModelSource).toContain(
      "cancelSocialFollowUpsForConversation(data.conversationId, 'reply_received')",
    );
    expect(handoffSource).toContain(
      "cancelSocialFollowUpsForConversation(conversationId, 'human_takeover')",
    );
    expect(whatsappSource).toContain(
      "cancelSocialFollowUpsForConversation(conversationId, 'reply_received')",
    );
  });
});
