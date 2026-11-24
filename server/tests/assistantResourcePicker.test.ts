import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { assistantResourceFilters, assistantResourcePage } from '../services/assistants/AssistantResourcePicker.js';
import { AssistantManagementError } from '../services/assistants/AssistantManagementError.js';
import { requireBusinessScope, withBusinessScope } from '../tenancy/businessContext.js';
import type { AssistantCatalog } from '../../shared/outreachAssistants.js';

const catalog: AssistantCatalog = { runtimeEnabled: false, presets: [], accounts: [], models: [],
  knowledge: Array.from({ length: 25 }, (_, index) => ({ id: index + 1, name: `Guest guide ${String(index + 1).padStart(2, '0')}`, channels: ['whatsapp'], preview: 'Approved guest information' })),
  documents: [], galleries: [], templates: [], playbooks: [{ id: 90, name: 'Hotel booking', agentType: 'hotel_sales', channels: ['whatsapp'] }, { id: 91, name: 'Technical help', agentType: 'technical_support', channels: ['email'] }],
  tools: [{ name: 'create_proposal', label: 'Create proposal', approvalRequired: true }],
  unavailableResources: [{ id: 900, name: 'Internal discount policy', channels: ['whatsapp'], category: 'knowledge', status: 'unavailable' }],
  permissions: { canManage: true, description: '' },
};
const loadCatalog = jest.fn(async () => ({ ...catalog, documents: [{ id: requireBusinessScope().businessProfileId, name: 'Current business document', channels: ['web'] }] }));
jest.unstable_mockModule('../middleware/platformAccess.js', () => ({ requireModuleAccess: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
jest.unstable_mockModule('../services/assistants/AssistantService.js', () => ({ assistantService: {}, AssistantManagementError }));
jest.unstable_mockModule('../services/assistants/AssistantCatalogService.js', () => ({ assistantCatalog: loadCatalog }));
jest.unstable_mockModule('../services/assistants/AssistantPreviewSession.js', () => ({ assistantPreviewSession: {} }));
jest.unstable_mockModule('../services/assistants/AssistantOperationsService.js', () => ({ assistantOperations: {} }));
jest.unstable_mockModule('../services/agents/pipeline/ChannelGateway.js', () => ({ channelGateway: {} }));
const { default: router } = await import('../routes/outreachAssistants.routes.js');
function app(profile = 501) {
  const instance = express();
  instance.use((_req, _res, next) => withBusinessScope({ userId: 101, businessProfileId: profile }, next));
  instance.use('/assistants', router);
  return instance;
}
beforeEach(() => { loadCatalog.mockClear(); });
describe('assistant resource drawer API', () => {
  it('paginates only permitted published resources and never includes unavailable entries', () => {
    const first = assistantResourcePage(catalog, assistantResourceFilters('knowledge', { pageSize: '20' }));
    const second = assistantResourcePage(catalog, assistantResourceFilters('knowledge', { pageSize: '20', page: '2' }));
    expect(first).toMatchObject({ total: 25, page: 1, hasMore: true });
    expect(second.items).toHaveLength(5); expect(second.hasMore).toBe(false);
    expect([...first.items, ...second.items].map(item => item.id)).not.toContain('900');
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(25);
  });
  it('searches current resources and filters playbooks to the selected preset and channels', () => {
    expect(assistantResourcePage(catalog, assistantResourceFilters('knowledge', { search: 'guide 02' })).items.map(item => item.id)).toEqual(['2']);
    expect(assistantResourcePage(catalog, assistantResourceFilters('playbooks', { agentType: 'hotel_sales', channels: 'whatsapp' })).items.map(item => item.id)).toEqual(['90']);
    expect(assistantResourcePage(catalog, assistantResourceFilters('tools', {})).items[0]).toMatchObject({ id: 'create_proposal', approvalRequired: true });
  });
  it('lists the selected role default tools first and marks them recommended', () => {
    const roles = { ...catalog, presets: [{ agentType: 'tech_support', name: 'Tech', description: '', instructions: '', tools: ['get_ticket_status'], policies: {} }],
      tools: [{ name: 'check_room_availability', label: 'check room availability', approvalRequired: false }, { name: 'get_ticket_status', label: 'get ticket status', approvalRequired: false }] };
    const items = assistantResourcePage(roles, assistantResourceFilters('tools', { agentType: 'tech_support' })).items;
    expect(items.map(item => [item.id, item.recommended ?? false])).toEqual([['get_ticket_status', true], ['check_room_availability', false]]);
  });
  it('does not offer a comments-only playbook for a private receiving account', () => {
    const scoped = { ...catalog, playbooks: [{ id: 92, name: 'Comment response', agentType: 'hotel_sales', channels: ['instagram_comment'] }] };
    expect(assistantResourcePage(scoped, assistantResourceFilters('playbooks', { bindings: 'instagram:private' })).items).toEqual([]);
    expect(assistantResourcePage(scoped, assistantResourceFilters('playbooks', { bindings: 'instagram:public_comment' })).items.map(item => item.id)).toEqual(['92']);
  });
  it.each([['private', {}], ['knowledge', { page: '0' }], ['knowledge', { pageSize: '999' }], ['knowledge', { search: ['one', 'two'] }], ['knowledge', { channels: 'other' }]])('rejects invalid category and unbounded query inputs: %s %j', (category, query) => {
    expect(() => assistantResourceFilters(category as string, query as Record<string, unknown>)).toThrow(AssistantManagementError);
  });
  it('serves the resource route with the active business scope', async () => {
    const one = await request(app(501)).get('/assistants/resources/documents');
    const two = await request(app(502)).get('/assistants/resources/documents');
    expect(one.status).toBe(200); expect(two.status).toBe(200);
    expect(one.body.items.map((item: { id: string }) => item.id)).toEqual(['501']);
    expect(two.body.items.map((item: { id: string }) => item.id)).toEqual(['502']);
  });
  it('validates queries before loading the business catalog', async () => {
    const response = await request(app()).get('/assistants/resources/knowledge?pageSize=1000');
    expect(response.status).toBe(400); expect(loadCatalog).not.toHaveBeenCalled();
  });
});
