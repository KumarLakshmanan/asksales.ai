import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '@/lib/api';
import { resolveCampaignTemplate } from '@/lib/reusableTemplates';
import type { OutreachRecipient } from '../../../shared/outreachCompose';

vi.mock('@/lib/api', () => ({ default: { post: vi.fn() } }));
const recipient = (id: number, name: string): OutreachRecipient => ({ id, name, firstName: name, lastName: '', company: 'Example', email: `${id}@example.test`, phone: '', eligible: true, reason: null, recipient: `${id}@example.test` });
beforeEach(() => vi.clearAllMocks());

describe('approved campaign template snapshots', () => {
  it('resolves every recipient through owned lead context and retains exact source versions', async () => {
    vi.mocked(api.post).mockImplementation(async (_url, body) => {
      const { leadId } = body as { leadId: number };
      return { success: true, templateId: 17, templateVersion: 4, subject: `For ${leadId}`, content: JSON.stringify({ greeting: `Hi ${leadId},`, body: 'Notes', cta: 'Read', closing: 'Thanks', signature: 'Team' }), htmlContent: `<p>For ${leadId}</p>` } as never;
    });
    const result = await resolveCampaignTemplate(17, [recipient(1, 'Asha'), recipient(2, 'Bala')], 'email');
    expect(result[1]).toMatchObject({ sourceTemplateId: 17, sourceTemplateVersion: 4, subject: 'For 1', content: 'Hi 1,\n\nNotes\n\nRead\n\nThanks\n\nTeam', htmlContent: '<p>For 1</p>' });
    expect(result[2].subject).toBe('For 2');
    expect(api.post).toHaveBeenNthCalledWith(1, '/api/content/templates/17/use', expect.objectContaining({ leadId: 1, channel: 'email' }));
    expect(api.post).toHaveBeenNthCalledWith(2, '/api/content/templates/17/use', expect.objectContaining({ leadId: 2, channel: 'email' }));
  });
  it('rejects campaigns whose template changed during review', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ success: true, templateId: 17, templateVersion: 4, content: 'One' } as never).mockResolvedValueOnce({ success: true, templateId: 17, templateVersion: 5, content: 'Two' } as never);
    await expect(resolveCampaignTemplate(17, [recipient(1, 'Asha'), recipient(2, 'Bala')], 'sms')).rejects.toThrow('changed during review');
  });
});
