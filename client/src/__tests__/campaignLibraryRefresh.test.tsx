import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SocialTab from '@/components/tabs/content-studio/SocialTab';
import SmsTab from '@/components/tabs/content-studio/SmsTab';
import EmailTab from '@/components/tabs/content-studio/EmailTab';
import SocialMessageTab from '@/components/tabs/content-studio/SocialMessageTab';
import api from '@/lib/api';

vi.mock('@/lib/api', () => ({ default: { get: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => { const toast = vi.fn(); return { useToast: () => ({ toast }) }; });
vi.mock('@/contexts/WebSocketContext', () => { const subscribe = () => () => {}; return { useWebSocket: () => ({ subscribe }) }; });
vi.mock('@/components/MediaManager', () => ({ default: () => null }));
vi.mock('@/components/social-publishing/SocialPublisher', () => ({ SocialPublisher: () => null }));
vi.mock('@/components/modals', () => ({ SendSMSModal: () => null, SendEmailModal: () => null, InstagramDMModal: () => null, ContentFullscreenModal: () => null }));
vi.mock('@/components/content-cards', () => {
  const Card = ({ title }: { title: string }) => <p>{title}</p>;
  return { SocialPostCard: Card, SmsCard: Card, EmailCard: Card, SocialMessageCard: Card };
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const cases = [[SocialTab, 'social_post'], [SmsTab, 'sms_template'], [EmailTab, 'email_template'], [SocialMessageTab, 'social_dm']] as const;
const asset = (type: string, title: string) => ({ id: 134, type, title, content: '{}', createdAt: '2026-10-06T00:00:00Z' });

describe('campaign text library refresh', () => {
  it.each(cases)('shows saved %s assets when the result refresh changes', async (Component, type) => {
    vi.mocked(api.get).mockResolvedValueOnce([] as never).mockResolvedValueOnce([asset(type, 'NimbusFlow saved result')] as never);
    const view = render(<Component threadId={214} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    await act(async () => {});
    view.rerender(<Component threadId={214} refreshKey={1} />);
    expect(await screen.findByText('NimbusFlow saved result')).toBeInTheDocument();
    if (type === 'email_template') {
      expect(api.get).toHaveBeenLastCalledWith(expect.stringContaining('threadId=214'), { signal: expect.any(AbortSignal) });
      expect(vi.mocked(api.get).mock.lastCall?.[1]?.signal?.aborted).toBe(false);
    } else {
      expect(api.get).toHaveBeenLastCalledWith(expect.stringContaining('threadId=214'));
    }
  });

  it.each(cases)('rejects a delayed prior-campaign response for %s', async (Component, type) => {
    let resolveOld!: (value: unknown) => void;
    vi.mocked(api.get).mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }) as never).mockResolvedValueOnce([asset(type, 'Current campaign')] as never);
    const view = render(<Component threadId={213} />);
    const priorSignal = vi.mocked(api.get).mock.calls[0]?.[1]?.signal;
    view.rerender(<Component threadId={214} />);
    await screen.findByText('Current campaign');
    if (type === 'email_template') {
      expect(priorSignal).toBeInstanceOf(AbortSignal);
      expect(priorSignal?.aborted).toBe(true);
    }
    await act(async () => { resolveOld([asset(type, 'Previous campaign')]); });
    expect(screen.queryByText('Previous campaign')).not.toBeInTheDocument();
    expect(screen.getByText('Current campaign')).toBeInTheDocument();
  });
});

vi.mock('@/components/content-studio/ContentCreatorShell', () => {
  const Frame = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { ContentCreatorShell: Frame, ContentCreatorHeader: Frame, ContentCreatorBody: Frame, ContentCreatorComposer: Frame, ContentCreatorStage: Frame, CreatorResultsPane: Frame };
});

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-content-brand-context', () => ({ useContentBrandContext: () => ({ brandToolkitId: 7, businessProfileId: 9 }) }));
vi.mock('@/components/content-studio/GenerationEstimate', () => ({ GenerationEstimate: () => null }));

vi.mock('@/components/content-studio/SmsSendingEstimate', () => ({ SmsSendingEstimate: () => null }));
