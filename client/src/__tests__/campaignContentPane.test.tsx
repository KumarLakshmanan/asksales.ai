import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContentStudioTab from '@/components/tabs/ContentStudioTab';

vi.mock('@/hooks/use-platform-access', () => ({ usePlatformAccess: () => ({ data: { modules: [{ key: 'content', enabled: true }] } }) }));
vi.mock('@/components/content-library', () => ({
  useContentLibrary: () => ({ activeTab: 'sms', refreshKey: 1, filterThreadId: 214, setActiveTab: vi.fn(), handleContentCreated: vi.fn() }),
  ContentTabBar: () => null,
  ContentTabContent: () => <div>SMS Templates</div>,
}));
afterEach(cleanup);
describe('campaign result pane', () => {
  it('shows the saved library without a duplicate Latest AI result container', () => {
    render(<ContentStudioTab threadId={214} context="campaign_details" initialTab="sms" hideTabBar previewData={{ type: 'sms', template: { message: 'NimbusFlow QA message.' } }} />);
    expect(screen.getByText('SMS Templates')).toBeInTheDocument();
    expect(screen.queryByText('Latest AI result')).not.toBeInTheDocument();
    expect(screen.queryByText('Generated copy')).not.toBeInTheDocument();
  });
});
