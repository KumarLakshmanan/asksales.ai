import type { Page, Route } from '@playwright/test';
import { emptyAssistantDraft } from '../../src/lib/outreach-assistants';

export const reviewContact = {
  id: 42, leadId: null, firstName: 'Ada', lastName: 'Lovelace',
  email: 'ada@example.test', phone: '+91 98765 43210', company: 'Analytical Engines',
  status: 'new', pipelineStatus: 'new', priority: 'medium', currency: 'USD',
  dealValue: '1250', tags: ['Outreach review'], source: 'manual',
  createdAt: '2026-10-01T10:00:00Z',
};

export async function installOutreachReview(page: Page, theme: 'light' | 'dark') {
  const state = {
    batches: [] as Record<string, unknown>[],
    settings: [] as { channel: string; body: Record<string, unknown> }[],
    templates: [] as Record<string, unknown>[],
    simulations: [] as Record<string, unknown>[],
    reconciliations: [] as Record<string, unknown>[],
    contactPreparations: [] as Record<string, unknown>[],
    uncertain: true,
    reportFailures: 0,
    followUpFailures: 0,
  };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({
    status, contentType: 'application/json', body: JSON.stringify(body),
  });
  const draft = {
    ...emptyAssistantDraft(), name: 'Sales assistant', agentType: 'hotel_sales',
    bindings: [{ channel: 'whatsapp', surface: 'private', accountId: 'account-1' }],
    replyModel: { provider: 'openai', model: 'configured-model' },
  };
  const report = {
    periodDays: 30,
    outcomes: [
      { channel: 'email', outcome: 'replied', count: 12, avg_confidence: 0.9, avg_duration_ms: 500 },
      { channel: 'whatsapp', outcome: 'handoff', count: 3, avg_confidence: 0.72, avg_duration_ms: 600 },
    ],
    delivery: [{ status: 'sent', count: 12 }],
    handoffs: [{ status: 'open', priority: 'normal', count: 3, avg_age_seconds: 60 }],
    playbooks: [], privacy: { retained_records: 0, expiring_within_7_days: 0, configured: true },
    tools: [], privacyAccess: [], privacyAccessHistory: [],
    knowledgeGaps: [], guardrails: [], adminAudit: [],
    csat: { responses: 0, average_rating: null, rating_1: 0, rating_2: 0, rating_3: 0, rating_4: 0, rating_5: 0 },
    readiness: { llm: true, email: true, whatsapp: true, instagram: true, facebook: true,
      privacyVault: true, moderationEnabled: false, moderationConfigured: false, moderationFailClosed: true },
  };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/settings/outreach/email-designs') return json(route, { canManage: false, preferences: { outreach: 'classic', assistant: 'classic', revision: 'initial' }, brand: { companyName: 'Orchid Labs', logoUrl: null, primaryColor: '#2563eb' } });
    const channel = url.searchParams.get('channel') || 'email';
    if (/csrf/.test(path)) return json(route, { csrfToken: 'outreach-review-csrf' });
    if (path === '/api/settings/preferences') return json(route, { theme, language: 'en', timezone: 'Asia/Kolkata' });
    if (path.endsWith('/compose/options')) return json(route, { channel, accounts: [{
      id: 'account-1', label: channel === 'email' ? 'sales@orchid.example' : channel === 'sms' ? 'MSG91 - ORCHID' : 'Orchid Labs',
      senderId: channel === 'email' ? 7 : undefined,
      providerAccountId: channel === 'sms' ? 'ORCHID' : 'account-1', isDefault: true, ready: true, reason: null,
    }] });
    if (path.endsWith('/compose/recipients')) return json(route, { recipients: [{
      id: 1, name: 'Ada Lovelace', fullName: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace',
      company: 'Analytical Engines', email: 'ada@example.test', phone: '919876543210',
      recipient: channel === 'email' ? 'ada@example.test' : ['whatsapp', 'sms'].includes(channel) ? '919876543210' : '12345678',
      eligible: true, reason: null, requiresTemplate: channel === 'whatsapp',
    }], nextCursor: null });
    if (path.endsWith('/compose/templates')) return json(route, { templates: [
      { id: 'welcome-en', name: 'welcome', language: 'en_US', body: 'Hello {{1}}, your proposal is ready.', headerType: 'TEXT', header: 'For {{1}}' },
      { id: 'welcome-es', name: 'welcome', language: 'es', body: 'Hola {{1}}, tu propuesta está lista.' },
    ] });
    if (path.endsWith('/compose/contact')) {
      state.contactPreparations.push(request.postDataJSON());
      return json(route, { leadId: 1 });
    }
    if (path === '/api/outreach-conversations/bulk') {
      state.batches.push(request.postDataJSON());
      return json(route, { success: true, total: 1, queued: 1, errors: 0, results: [
        { leadId: 1, messageId: 11, conversationId: 9, status: 'queued' },
      ] });
    }
    if (path === '/api/outreach-conversations/inbox') return json(route, { items: [], nextCursor: null,
      unreadThreads: { all: 0, email: 0, whatsapp: 0, instagram: 0, facebook: 0, sms: 0 } });
    if (path === '/api/outreach-conversations/unread/counts') return json(route, { email: 0, whatsapp: 0, instagram: 0, facebook: 0, sms: 0 });
    if (path === '/api/settings/outreach/assistants/catalog') return json(route, {
      runtimeEnabled: true, permissions: { canManage: true, description: 'Business owner.' },
      presets: [{ agentType: 'hotel_sales', name: 'Sales', description: '', instructions: '', tools: [], policies: {} }],
      accounts: [{ channel: 'whatsapp', surface: 'private', accountId: 'account-1', label: 'Orchid Labs', connected: true }],
      models: [{ provider: 'openai', model: 'configured-model', label: 'Configured model', controls: [] }],
      knowledge: [], playbooks: [], templates: [], documents: [], galleries: [], tools: [],
    });
    if (path === '/api/settings/outreach/assistants') return json(route, { runtimeEnabled: true, assistants: [{
      id: 'assistant-one', businessProfileId: 4102, state: 'draft', draft, draftVersion: 1,
      publishedRevision: null, published: null, readiness: { ready: false, checks: [] },
      updatedAt: '2026-10-01T10:00:00Z',
    }] });
    const followUps = path.match(/^\/api\/settings\/integrations\/(\w+)\/follow-ups$/);
    if (followUps) {
      if (request.method() === 'PUT') {
        state.settings.push({ channel: followUps[1], body: request.postDataJSON() });
        return json(route, { success: true });
      }
      if (state.followUpFailures-- > 0) return json(route, { error: 'Temporary follow-up settings failure' }, 503);
      return json(route, { enableAutoFollowUp: false, followUpSteps: [
        { id: 1, delayValue: 1, delayUnit: 'days', delayHours: 24, templateId: 77, templateName: 'Friendly check-in' },
      ] });
    }
    if (path === '/api/sent-messages') return json(route, [{
      id: 11, kind: 'conversation', leadName: 'Ada Lovelace', subject: channel === 'email' ? 'Your proposal' : null,
      message: 'Hello Ada, just checking whether you had a chance to review the proposal.',
      status: 'pending', deliveryStatus: null, followUpStep: 1,
      scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), createdAt: new Date().toISOString(),
    }]);
    if (path === '/api/content/templates' && request.method() === 'POST') {
      const body = request.postDataJSON(); state.templates.push(body);
      return json(route, { id: 78, ...body });
    }
    if (path === '/api/content/assets' || path === '/api/content/templates/predefined') return json(route, []);
    if (path === '/api/content/templates') {
      const templates = [{ id: 77, name: 'Friendly check-in', subject: 'Following up', content: 'Hi {{first_name}}, still need help?' }];
      return json(route, url.searchParams.has('limit') ? { templates, total: 1 } : templates);
    }
    if (path === '/api/support/ai/orchestration-report') {
      if (state.reportFailures-- > 0) return json(route, { error: 'Temporary operations failure' }, 503);
      return json(route, report);
    }
    if (path === '/api/support/ai/delivery-actions') return json(route, url.searchParams.get('status') === 'uncertain' && state.uncertain ? [{
      id: 1, conversationId: 9, channel: 'email', status: 'uncertain', attemptCount: 1,
      lastError: 'Provider outcome needs verification.', providerMessageId: null,
      createdAt: '2026-10-01T10:00:00Z', payload: { recipient: 'ada@example.test', text: 'Your proposal is ready.' },
    }] : []);
    if (path === '/api/support/ai/tool-executions') return json(route, []);
    if (path === '/api/support/ai/approval-recovery') return json(route, []);
    if (path === '/api/support/ai/conversation-recovery') return json(route, { replies: [], effects: [], turns: [] });
    if (path === '/api/support/ai/delivery-actions/1/reconcile') {
      state.reconciliations.push(request.postDataJSON()); state.uncertain = false;
      return json(route, { success: true });
    }
    if (path === '/api/support/ai/simulate') {
      state.simulations.push(request.postDataJSON());
      return json(route, { previewSessionId: 9001, success: true, outcome: 'replied',
        replyText: state.simulations.length === 1 ? 'Happy to help. What would you like to know?' : 'Your proposal includes the requested services.',
        redactedInput: request.postDataJSON().message, intent: 'sales_inquiry', riskLevel: 'low',
        classificationConfidence: 0.92, confidence: 0.92, agentType: 'hotel_sales',
        playbook: null, toolCalls: [], guardrail: null, policyViolations: [], piiTypes: [],
        handoffReason: null, sideEffectsSuppressed: true });
    }
    if (path === '/api/crm/contacts') return json(route, { success: true, contacts: [reviewContact], total: 1, totalPages: 1 });
    if (path === '/api/crm/analytics') return json(route, { totalContacts: 1, winRate: 0,
      pipelineValueByCurrency: { USD: '1250' }, totalPipelineValueByCurrency: { USD: '1250' } });
    if (path === '/api/crm/contacts/42') return json(route, reviewContact);
    if (path === '/api/crm/contacts/42/activities') return json(route, []);
    if (path === '/api/crm/contacts/42/conversations') return json(route, { conversations: [], sentMessages: [] });
    if (path === '/api/crm/contacts/42/tickets') return json(route, { tickets: [] });
    if (path === '/api/proposals/related') return json(route, []);
    if (path === '/api/proposals') return json(route, { proposals: [], total: 0 });
    if (/^\/api\/(?:auth\/me|platform\/access|settings\/business-profiles|crm\/configuration|wallet|chat\/threads|notifications\/unread\/count)$/.test(path)) return route.fallback();
    return json(route, {});
  });
  return state;
}
