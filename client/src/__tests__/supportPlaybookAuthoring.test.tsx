import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Playbooks from '@/app/dashboard/(main)/settings/outreach/playbooks/page';
import { SupportIntentSelect } from '@/components/support/SupportIntentSelect';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), toast: vi.fn(), push: vi.fn() }));
const router = { push: mocks.push };
vi.mock('@/lib/api', () => ({ default: { get: mocks.get, post: mocks.post, put: mocks.put } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/dashboard/support/playbooks' }));
vi.mock('@/components/support/PlaybookGraphEditor', async importOriginal => ({
  ...await importOriginal<typeof import('@/components/support/PlaybookGraphEditor')>(),
  PlaybookGraphEditor: () => <p>Local checks passed</p>,
}));

beforeEach(() => {
  vi.clearAllMocks();
  const graph = { entryNodeId: 'start', nodes: [{ id: 'start', type: 'complete', data: {} }], edges: [] };
  mocks.get.mockImplementation(async (url: string) => url.endsWith('/playbooks') ? [1, 2].map(id => ({ id, name: `Journey ${id}`, draftGraph: graph, status: 'draft', enabled: true, assignments: [] })) : []);
  mocks.post.mockResolvedValue({ valid: false, errors: ['The selected capability requires a verified field.'], warnings: [] });
});
afterEach(() => vi.restoreAllMocks());

describe('playbook authoring safeguards', () => {
  it.each([false, true])('opens Assistants and protects unsaved flow edits (allowLeave=%s)', async allowLeave => {
    vi.spyOn(window, 'confirm').mockReturnValue(allowLeave);
    render(<Playbooks />);
    await screen.findByText('Local checks passed');
    const assistants = screen.getByRole('button', { name: /^Assistants$/ });
    expect(assistants).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /^Settings$/ }));
    fireEvent.change(await screen.findByLabelText('Playbook name'), { target: { value: 'Unsaved flow' } });
    fireEvent.click(assistants);
    if (allowLeave) expect(mocks.push).toHaveBeenCalledWith('/dashboard/settings/outreach');
    else expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('labels the simulator as current routing rather than testing the selected draft', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Playbooks />);
    await screen.findByText('Local checks passed');
    const button = screen.getByRole('button', { name: 'Open routing simulator' });
    expect(button).toHaveAccessibleDescription('Tests published routing, not this draft.');
    expect(screen.queryByRole('button', { name: 'Test safely' })).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/settings/outreach/orchestration#simulator');
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.post.mock.calls.every(([url]) => !String(url).endsWith('/simulate') && !String(url).endsWith('/publish'))).toBe(true);
  });

  it.each([false, true])('preserves unsaved-draft navigation confirmation when opening routing simulation (%s)', async allowLeave => {
    const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(allowLeave);
    try {
      render(<Playbooks />);
      await screen.findByText('Local checks passed');
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
      const name = await screen.findByLabelText('Playbook name');
      fireEvent.change(name, { target: { value: 'Unsaved local journey' } });
      fireEvent.click(screen.getByRole('button', { name: 'Open routing simulator' }));
      expect(confirmation).toHaveBeenCalled();
      if (allowLeave) expect(mocks.push).toHaveBeenCalledWith('/dashboard/settings/outreach/orchestration#simulator');
      else {
        expect(mocks.push).not.toHaveBeenCalled();
        expect(name).toHaveValue('Unsaved local journey');
      }
      expect(mocks.put).not.toHaveBeenCalled();
      expect(mocks.post.mock.calls.every(([url]) => !String(url).endsWith('/simulate') && !String(url).endsWith('/publish'))).toBe(true);
    } finally {
      confirmation.mockRestore();
    }
  });

  it('shows server validation and refuses publication even when local checks pass', async () => {
    render(<Playbooks />);
    await screen.findByText('Local checks passed');
    expect(await screen.findByText('The selected capability requires a verified field.')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Draft saved · Needs attention');
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Publish changes' }));
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.post.mock.calls.every(([url]) => !String(url).endsWith('/publish'))).toBe(true);
  });

  it('independently revalidates before saving or publishing a previously passing draft', async () => {
    mocks.post.mockResolvedValueOnce({ valid: true, errors: [], warnings: [] });
    render(<Playbooks />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Checks passed'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish changes' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Fix the flow before publishing' })));
    expect(screen.getByRole('status')).toHaveTextContent('Needs attention');
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.post.mock.calls.every(([url]) => !String(url).endsWith('/publish'))).toBe(true);
  });

  it('keeps a dirty draft when switching journeys is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<Playbooks />);
    await screen.findByText('Local checks passed');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const name = await screen.findByLabelText('Playbook name');
    fireEvent.change(name, { target: { value: 'Unsaved journey' } });
    fireEvent.click(screen.getByRole('button', { name: /Journey 1/ }));
    expect(window.confirm).toHaveBeenCalled();
    expect(name).toHaveValue('Unsaved journey');
  });

  it('searches friendly labels but submits the exact supported intent', () => {
    const onChange = vi.fn();
    render(<SupportIntentSelect value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'booking request' } });
    expect(screen.getByRole('option', { name: 'booking request' })).toHaveValue('booking_request');
    expect(screen.queryByRole('option', { name: 'refund request' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'booking_request' } });
    expect(onChange).toHaveBeenCalledWith('booking_request');
  });
});
