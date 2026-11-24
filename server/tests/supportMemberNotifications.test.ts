import { describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  normalizeSupportMemberNotificationPreferences,
  supportMemberNotificationPreferencesSchema,
} from '../controllers/supportNotificationPreferencesController.js';
import {
  buildSupportMemberNotificationMessage,
  isSupportNotificationDeliveryRetryable,
  SupportMemberNotificationService,
  supportNotificationBackoffMs,
  supportNotificationDestinationHint,
  supportNotificationQuietHoursDelayMs,
  shouldCreateSupportNotificationEmailFallback,
} from '../services/SupportMemberNotificationService.js';
import { canManageTeamDefaults } from '../controllers/supportNotificationPreferencesController.js';
import { extractKnowledgeBaseEmbeddingChunks } from '../services/KnowledgeBaseEmbeddingRepairService.js';
import { isNormalizedOptOutRequest } from '../services/agents/pipeline/stages/OptOutStage.js';
import { supportNotificationAllowedVariablesSql } from '../services/SupportNotificationConfigurationService.js';
// @ts-expect-error JS migrations intentionally expose no TypeScript declarations.
import { up as notificationMigration } from '../migrations/148_add_support_member_channel_notifications.js';
// @ts-expect-error JS migrations intentionally expose no TypeScript declarations.
import { up as reliabilityMigration } from '../migrations/150_repair_support_ai_reliability.js';
// @ts-expect-error JS migrations intentionally expose no TypeScript declarations.
import { up as notificationReliabilityMigration } from '../migrations/220_harden_support_notification_delivery.js';

const events = {
  ticketCreatedUnassigned: true, ticketAssigned: true, ticketReassigned: true, humanHandoff: true,
  customerReplied: true, ticketReopened: true, slaAtRisk: true, slaBreached: true,
  approvalRequired: true, deliveryFailed: true, ticketResolved: false,
};

describe('support member notification preferences', () => {
  it('serializes allowed template variables as a PostgreSQL text array', () => {
    const query = new PgDialect().sqlToQuery(supportNotificationAllowedVariablesSql());
    expect(query.sql).toBe('ARRAY[$1, $2, $3, $4, $5, $6, $7, $8]::text[]');
    expect(query.params).toEqual(SupportMemberNotificationService.allowedTemplateVariables());
  });

  it('requires a destination for every enabled channel', () => {
    const result = supportMemberNotificationPreferencesSchema.safeParse({
      email: { enabled: false, recipient: '', events },
      whatsapp: { enabled: false, recipient: '', events },
      slack: { enabled: true, recipient: '', events },
      teams: { enabled: false, recipient: '', events },
    });
    expect(result.success).toBe(false);
  });

  it('normalizes email, webhooks, and WhatsApp phone numbers', () => {
    expect(normalizeSupportMemberNotificationPreferences({
      email: { enabled: true, recipient: ' Agent@Example.COM ', events },
      whatsapp: { enabled: true, recipient: '+91 98765-43210', events },
      slack: { enabled: true, recipient: ' https://hooks.slack.com/services/test ', events },
      teams: { enabled: true, recipient: ' https://example.webhook.office.com/test ', events },
    })).toEqual({
      email: { enabled: true, recipient: 'agent@example.com', events },
      whatsapp: { enabled: true, recipient: '919876543210', events },
      slack: { enabled: true, recipient: 'https://hooks.slack.com/services/test', events },
      teams: { enabled: true, recipient: 'https://example.webhook.office.com/test', events },
    });
  });

  it('masks destinations exposed in delivery history', () => {
    expect(supportNotificationDestinationHint('email', 'agent@example.com')).toMatch(/^ag\*+@example\.com$/);
    expect(supportNotificationDestinationHint('whatsapp', '919876543210')).toBe('••••3210');
    expect(supportNotificationDestinationHint('slack', 'https://hooks.slack.com/services/test')).toBe('configured Slack webhook');
  });

  it('uses tenant-bound secret HMAC fingerprints for destinations', () => {
    const first = SupportMemberNotificationService.destinationDigest('email', 'agent@example.com', 9);
    expect(first).toHaveLength(64);
    expect(first).not.toBe(SupportMemberNotificationService.destinationDigest('email', 'agent@example.com', 10));
  });
});

describe('support notification event content and retry behavior', () => {
  it('does not include raw personal data in assignment alerts and includes the authenticated ticket link', () => {
    const message = buildSupportMemberNotificationMessage('new_ticket_assignment', {
      ticketId: 123,
      ticketNumber: 'TKT-123',
      subject: 'Call Lakshmi at +91 98765 43210 or lakshmi@example.com',
      priority: 'urgent',
      ticketPath: '/support/tickets/123',
    });
    expect(message).toContain('TKT-123');
    expect(message).toContain('A support request needs attention');
    expect(message).toContain('/support/tickets/123');
    expect(message).not.toContain('lakshmi@example.com');
    expect(message).not.toContain('98765');
  });

  it('builds a concise handoff alert without customer message content', () => {
    const message = buildSupportMemberNotificationMessage('human_handoff', {
      ticketId: 456,
      ticketNumber: 'TKT-456',
      priority: 'high',
      sourceChannel: 'instagram',
      ticketPath: '/support/tickets/456',
    });
    expect(message.toLowerCase()).toContain('human handoff');
    expect(message).toContain('instagram');
    expect(message).toContain('TKT-456');
  });

  it('uses bounded exponential retry backoff', () => {
    expect(supportNotificationBackoffMs(1)).toBe(3_000);
    expect(supportNotificationBackoffMs(2)).toBe(6_000);
    expect(supportNotificationBackoffMs(20)).toBe(15 * 60_000);
  });

  it('defers non-urgent external alerts during member quiet hours', () => {
    const delay = supportNotificationQuietHoursDelayMs(
      { enabled: true, start: '22:00', end: '08:00' },
      'Asia/Kolkata',
      new Date('2026-08-23T18:30:00.000Z'), // midnight in India
    );
    expect(delay).toBe(8 * 60 * 60 * 1000);
    expect(supportNotificationQuietHoursDelayMs({ enabled: false, start: '22:00', end: '08:00' }, 'Asia/Kolkata')).toBe(0);
  });

  it('keeps independently selected channels independent when another provider fails', () => {
    expect(shouldCreateSupportNotificationEmailFallback('instagram', 'permanent_failure')).toBe(false);
    expect(shouldCreateSupportNotificationEmailFallback('whatsapp', 'suppressed')).toBe(false);
    expect(shouldCreateSupportNotificationEmailFallback('email', 'permanent_failure')).toBe(false);
  });

  it('retries only definitive failures and reconciles uncertain provider outcomes', () => {
    expect(isSupportNotificationDeliveryRetryable('failed')).toBe(true);
    expect(isSupportNotificationDeliveryRetryable('dead_letter')).toBe(true);
    expect(isSupportNotificationDeliveryRetryable('uncertain')).toBe(false);
    expect(isSupportNotificationDeliveryRetryable('accepted')).toBe(false);
  });

  it('limits shared defaults to team leads and admins', () => {
    expect(canManageTeamDefaults({ role: 'lead' })).toBe(true);
    expect(canManageTeamDefaults({ role: 'admin' })).toBe(true);
    expect(canManageTeamDefaults({ role: 'member' })).toBe(false);
  });
});

describe('support notification and reliability migrations', () => {
  it('creates durable events, receipts, deliveries, verification, audit, and dedupe constraints idempotently', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (statement: string) => {
      statements.push(statement);
      return { rows: [], rowCount: 0 };
    });
    await notificationMigration({ query } as never);
    const sql = statements.join('\n');
    expect(sql).toContain('support_notification_destinations');
    expect(sql).toContain('destination_ciphertext');
    expect(sql).toContain('verification_code_hash');
    expect(sql).toContain('support_notification_events');
    expect(sql).toContain('UNIQUE(user_id, event_key)');
    expect(sql).toContain('support_notification_receipts');
    expect(sql).toContain('fallback_of_delivery_id');
    expect(sql).toContain('support_notification_audit_logs');
    expect(sql).toContain('IF NOT EXISTS');
  });

  it('repairs embedding identity/citations and partial delivery indexes', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (statement: string) => {
      statements.push(statement);
      return { rows: [], rowCount: 0 };
    });
    await reliabilityMigration({ query } as never);
    const sql = statements.join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS knowledge_base');
    expect(sql).toContain('NULLS NOT DISTINCT');
    expect(sql).toContain('source_type, source_id, content_hash');
    expect(sql).toContain('WHERE delivery_action_id IS NOT NULL');
    expect(sql).toContain('managedAssignmentAlignmentVersion');
  });

  it('adds a transactional outbox, RLS, provider reconciliation, templates, and escalation state', async () => {
    const statements: string[] = [];
    await notificationReliabilityMigration({ query: jest.fn(async (statement: string) => { statements.push(statement); return { rows: [], rowCount: 0 }; }) } as never);
    const sql = statements.join('\n');
    expect(sql).toContain('support_ticket_notification_event_trg');
    expect(sql).toContain('support_customer_reply_event_trg');
    expect(sql).toContain('support_delivery_failure_event_trg');
    expect(sql).toContain('support_notification_template_versions');
    expect(sql).toContain('reconcile_support_notification_provider_delivery');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('acknowledged_at');
  });
});

describe('support AI knowledge and guardrail repairs', () => {
  it('rebuilds citation chunks from Q&A and processed document content', () => {
    expect(extractKnowledgeBaseEmbeddingChunks({
      id: 1,
      title: 'Refunds',
      type: 'qa',
      content: null,
      question: 'Can I get a refund?',
      answer: 'Refunds require review.',
    })).toEqual(['Question: Can I get a refund?\nAnswer: Refunds require review.']);
    expect(extractKnowledgeBaseEmbeddingChunks({
      id: 2,
      title: 'Guide',
      type: 'file',
      content: JSON.stringify({ chunks: [{ text: 'First' }, { text: 'Second' }] }),
      question: null,
      answer: null,
    })).toEqual(['First', 'Second']);
  });

  it('recognizes normalized opt-out language without treating ordinary support text as an opt-out', () => {
    for (const phrase of ['STOP ALL', 'please unsubscribe me', "don't contact me", 'opt me out!', 'no more messages']) {
      expect(isNormalizedOptOutRequest(phrase)).toBe(true);
    }
    expect(isNormalizedOptOutRequest('Please stop the error messages in the app')).toBe(false);
  });
});
