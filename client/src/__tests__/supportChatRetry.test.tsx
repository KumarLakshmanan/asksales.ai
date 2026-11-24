import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OwnerChat from '@/app/dashboard/(main)/support-ai/chat/page';
import MemberChat from '@/app/support/chat/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), push: vi.fn(), member: { id: 1, name: 'Support Member' } }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('@/lib/support-api', () => ({ supportApi: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-outreach-assistants', () => ({
  useAssistantWorkspace: () => ({ profileId: 1, scopeKey: ['outreach-assistants', 1, 1], requestOptions: { headers: { 'X-Business-Profile-Id': '1' } }, profiles: { isLoading: false, refetch: vi.fn() }, catalog: { data: { runtimeEnabled: true } } }),
  useAssistantList: () => ({ data: { runtimeEnabled: true, assistants: [{ id: 'test-assistant', draft: { name: 'Test assistant' }, draftVersion: 1 }] }, isError: false, isFetching: false, refetch: vi.fn() }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/contexts/SupportAuthContext', () => ({ useSupportAuth: () => ({ member: mocks.member, isLoading: false, logout: vi.fn() }) }));

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ data: [], total: 0 });
  Element.prototype.scrollIntoView = vi.fn();
});

describe('support chat retry experience', () => {
  it.each(['owner', 'member'])('restores a failed question in the %s assistant and displays the server error', async surface => {
    mocks.post.mockImplementation((url: string) => url.endsWith('/sessions')
      ? Promise.resolve({ id: 1, title: 'New Chat' })
      : Promise.reject(new Error('Support is temporarily unavailable. Please retry.')));
    render(surface === 'owner' ? <OwnerChat /> : <MemberChat />);
    if (surface === 'owner') fireEvent.change(screen.getByRole('combobox', { name: 'Assistant for this chat' }), { target: { value: 'test-assistant' } });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'When do you open?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'Support is temporarily unavailable. Please retry.' })));
    expect(input).toHaveValue('When do you open?');
    expect(input).not.toBeDisabled();
  });

  it('locks the member composer while creating its first session', async () => {
    let reject!: (reason: Error) => void;
    mocks.post.mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    render(<MemberChat />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'When do you open?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    reject(new Error('Unavailable'));
    await waitFor(() => expect(input).not.toBeDisabled());
    expect(input).toHaveValue('When do you open?');
  });
});
