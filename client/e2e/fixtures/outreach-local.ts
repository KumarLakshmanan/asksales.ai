import type { Page, Route } from '@playwright/test';

export async function installLibrary(page: Page) {
  await page.addInitScript(() => { localStorage.setItem('token', 'synthetic-local-outreach'); });
  const types = ['email', 'sms', 'social_message', 'social', 'blog', 'ad_copy'];
  const templates = types.map((type, index) => ({
    id: index + 1, userId: 4101, name: `Saved ${type} template`, type,
    subject: 'Welcome', content: 'Hello {{first_name}}, your proposal is ready.',
    htmlContent: type === 'email' ? '<p><b>Hello {{first_name}}</b>, your proposal is ready.</p>' : null,
    category: type === 'social_message' ? 'instagram' : null,
    usageCount: 0, isApproved: true, isPredefined: false, version: 1,
    createdAt: '2026-10-02T12:00:00.000Z', updatedAt: '2026-10-02T12:00:00.000Z',
  }));
  const state = { failAssets: false, followUpFailures: 0, followUpsEnabled: false, globalSettingsRequests: [] as string[], batches: [] as Record<string, unknown>[] };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (path === '/api/settings/outreach/email-designs') return json(route, { canManage: false, preferences: { outreach: 'classic', assistant: 'classic', revision: 'initial' }, brand: { companyName: 'Orchid Labs', logoUrl: null, primaryColor: '#2563eb' } });
    if (/csrf/.test(path)) return json(route, { csrfToken: 'library-test-csrf' });
    if (/^\/api\/settings\/integrations\/\w+\/follow-ups$/.test(path)) {
      state.globalSettingsRequests.push(request.method());
      if (state.followUpFailures-- > 0) return json(route, { error: 'Saved follow-up settings temporarily unavailable' }, 503);
      return json(route, { enableAutoFollowUp: state.followUpsEnabled, followUpSteps: [{ id: 1, delayValue: 2, delayUnit: 'hours', templateId: -1, templateName: 'Auto-generate' }] });
    }
    if (path === '/api/content/assets/counts') return json(route, {});
    if (path === '/api/content/templates/counts') return json(route, Object.fromEntries(types.map(type => [type, templates.filter(item => item.type === type).length])));
    if (path === '/api/content/templates/predefined') return json(route, []);
    if (path === '/api/content/assets') return json(route, state.failAssets ? { error: 'Saved drafts temporarily unavailable' } : [], state.failAssets ? 503 : 200);
    if (path === '/api/content/templates' && request.method() === 'POST') {
      const body = request.postDataJSON(); const saved = { ...templates[1], ...body, id: 100 };
      templates.push(saved); return json(route, saved, 201);
    }
    if (path === '/api/content/templates') {
      const matching = templates.filter(item => item.type === url.searchParams.get('type'));
      const offset = Number(url.searchParams.get('offset') || 0); const limit = Number(url.searchParams.get('limit') || 200);
      return json(route, { templates: matching.slice(offset, offset + limit), total: matching.length });
    }
    if (path === '/api/outreach-conversations/compose/import-sources') return json(route, { campaigns: [], crmImports: [] });
    if (path === '/api/outreach-conversations/compose/templates') return json(route, { templates: [{ id: 'welcome', name: 'welcome', language: 'en_US', body: 'Hello {{1}}' }] });
    if (path === '/api/outreach-conversations/compose/options') return json(route, { channel: url.searchParams.get('channel'), accounts: [{ id: 'sender-1', senderId: 3, providerAccountId: 'original-account', label: 'sales@orchid.test', ready: true, isDefault: true, reason: null }] });
    if (path === '/api/outreach-conversations/compose/recipients') return json(route, { recipients: [{ id: 1, name: 'Asha Raman', firstName: 'Asha', fullName: 'Asha Raman', company: 'Orchid Labs', email: 'asha@example.test', phone: '919876543210', eligible: true, recipient: url.searchParams.get('channel') === 'email' ? 'asha@example.test' : '919876543210', reason: null }], nextCursor: null });
    if (path === '/api/outreach-conversations/bulk') {
      state.batches.push(request.postDataJSON());
      return json(route, { success: true, total: 1, queued: 1, errors: 0, results: [{ leadId: 1, messageId: 10, conversationId: 7, status: 'queued' }] });
    }
    if (path === '/api/email-senders/sync') return json(route, {});
    if (path === '/api/email-senders') return json(route, []);
    if (/^\/api\/(?:auth\/me|platform\/access|settings\/preferences|settings\/business-profiles|organizations|wallet|chat\/threads|widgets|notifications\/unread\/count)(?:[/?]|$)/.test(path)) return route.fallback();
    return json(route, []);
  });
  return { templates, state };
}
