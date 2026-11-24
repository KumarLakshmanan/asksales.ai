import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOutreachDraftScope } from '@/hooks/use-outreach-draft-scope';
import { selectBusinessProfile } from '@/lib/business-profile';
const auth = vi.hoisted(() => ({ user: { id: 4101 } as { id: number } | null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
function Form() { const [draft, setDraft] = useState(''); return <input aria-label="Private synthetic draft" value={draft} onChange={event => setDraft(event.target.value)} />; }
function Workspace() { const scope = useOutreachDraftScope(); return <Form key={scope} />; }
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); auth.user = { id: 4101 }; localStorage.setItem('user', JSON.stringify(auth.user)); selectBusinessProfile(4102); });
afterEach(cleanup);
describe('private outreach draft identity', () => {
  it('keeps an in-memory draft on rerender and discards it on a business change', () => {
    const view = render(<Workspace />);
    fireEvent.change(screen.getByLabelText('Private synthetic draft'), { target: { value: 'Fictional account-private content' } });
    view.rerender(<Workspace />);
    expect(screen.getByLabelText('Private synthetic draft')).toHaveValue('Fictional account-private content');
    act(() => selectBusinessProfile(4103));
    expect(screen.getByLabelText('Private synthetic draft')).toHaveValue('');
    act(() => selectBusinessProfile(4102));
    expect(screen.getByLabelText('Private synthetic draft')).toHaveValue('');
    expect(JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })).not.toContain('Fictional account-private content');
  });
  it('discards private drafts on logout or a different authenticated account', () => {
    const view = render(<Workspace />);
    fireEvent.change(screen.getByLabelText('Private synthetic draft'), { target: { value: 'Fictional account-one content' } });
    auth.user = { id: 4201 }; localStorage.setItem('user', JSON.stringify(auth.user));
    view.rerender(<Workspace />);
    expect(screen.getByLabelText('Private synthetic draft')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Private synthetic draft'), { target: { value: 'Fictional account-two content' } });
    auth.user = null; localStorage.removeItem('user'); view.rerender(<Workspace />);
    expect(screen.getByLabelText('Private synthetic draft')).toHaveValue('');
  });
});
