import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('support widget privacy persistence contract', () => {
  it('keeps raw retrieval evidence out of both new and replayed public responses', () => {
    const source = readFileSync(resolve(process.cwd(), 'controllers/supportWidgetController.ts'), 'utf8');
    expect(source).not.toContain('sources: existingAssistant.sources');
    expect(source).toContain('response: { answer, confidence, sources: [], media, choices }');
    expect(source).toContain("message.role !== 'assistant' || message.processingStatus === 'completed'");
    expect(source).toContain('.map(publicWidgetMessage)');
  });
  it('isolates polling from the write/download abuse budget', () => {
    const source = readFileSync(resolve(process.cwd(),'routes/supportWidget.routes.ts'),'utf8');
    expect(source).toContain("router.get('/session/:sessionId/messages', publicWidgetReadRateLimiter, widgetBusinessScope, getWidgetSessionMessages)");
    expect(source).toContain("router.post('/chat', publicWidgetRateLimiter, widgetBusinessScope, widgetChat)");
    expect(source).toContain("documents/:documentId', publicWidgetRateLimiter, widgetBusinessScope, getWidgetSessionDocument)");
  });
  it('qualifies message metadata in the joined widget update', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'services/agents/orchestration/PrivacyVaultService.ts'),
      'utf8',
    );

    expect(source).toContain("metadata = COALESCE(scm.metadata, '{}'::jsonb)");
    expect(source).not.toContain("metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({");
  });

  it('matches the partial widget request idempotency index when persisting replies', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'services/SupportReplyDeliveryService.ts'),
      'utf8',
    );

    expect(source).toContain(
      'ON CONFLICT (session_id, request_id) WHERE request_id IS NOT NULL DO NOTHING',
    );
  });
});
