import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({ scope: '7:9', params: new URLSearchParams(), push: vi.fn(), post: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push }), useSearchParams: () => state.params }));
vi.mock('@/hooks/use-outreach-draft-scope', () => ({ useOutreachDraftScope: () => state.scope }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/api', () => ({ api: { post: state.post } }));

import LeadNewPage from '@/app/dashboard/(main)/leads/new/page';
import { resetFormDraftsForTests } from '@/lib/form-draft-store';

const email = () => document.getElementById('lead-email') as HTMLInputElement;
const name = () => document.getElementById('lead-name') as HTMLInputElement;

describe('create lead keeps unsaved input across Back', () => {
  beforeEach(() => {
    resetFormDraftsForTests();
    state.scope = '7:9';
    state.params = new URLSearchParams();
    state.push.mockReset();
    state.post.mockReset();
  });

  it('restores typed details after the page unmounts and is opened again', () => {
    const first = render(<LeadNewPage />);
    fireEvent.change(name(), { target: { value: 'Ada Lovelace' } });
    fireEvent.change(email(), { target: { value: 'ada@example.com' } });
    first.unmount();

    render(<LeadNewPage />);
    expect(name().value).toBe('Ada Lovelace');
    expect(email().value).toBe('ada@example.com');
    expect(screen.getByText('Your unsaved lead details were restored.')).toBeTruthy();
  });

  it('does not restore into another business, another conversation or after a confirmed discard', () => {
    const first = render(<LeadNewPage />);
    fireEvent.change(name(), { target: { value: 'Ada' } });
    first.unmount();

    state.scope = '7:10';
    const other = render(<LeadNewPage />);
    expect(name().value).toBe('');
    other.unmount();

    state.scope = '7:9';
    state.params = new URLSearchParams('threadId=4');
    const thread = render(<LeadNewPage />);
    expect(name().value).toBe('');
    thread.unmount();

    state.params = new URLSearchParams();
    const back = render(<LeadNewPage />);
    expect(name().value).toBe('Ada');
    fireEvent.click(screen.getAllByRole('button', { name: /^Cancel$/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    back.unmount();
    render(<LeadNewPage />);
    expect(name().value).toBe('');
  });

  it('forgets the draft once the lead is created', async () => {
    state.post.mockResolvedValue({ id: 12 });
    const first = render(<LeadNewPage />);
    fireEvent.change(name(), { target: { value: 'Ada' } });
    fireEvent.change(email(), { target: { value: 'ada@example.com' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Create lead/ })[0]);
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/dashboard/leads/view/12'));
    first.unmount();
    render(<LeadNewPage />);
    expect(name().value).toBe('');
  });
});
