import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatsPage from '@/app/dashboard/(main)/chats/page';
import { RoomTypesTab } from '@/app/dashboard/(main)/hotel/components/RoomTypesTab';
import { campaignRecords, campaignTargets, roomRecords, roomTargets } from '../../e2e/fixtures/icon-actions';

const mocks = vi.hoisted(() => ({ get: vi.fn(), remove: vi.fn(), put: vi.fn(), push: vi.fn(), toast: vi.fn(), refresh: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, delete: mocks.remove, put: mocks.put } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-business-profiles', () => ({ useBusinessProfiles: () => ({ activeProfile: { id: 4102 }, isLoading: false }), businessProfileName: () => 'Synthetic business' }));
vi.mock('@/contexts/PreferencesContext', () => ({ usePreferences: () => ({ formatCurrency: (value: number) => `$${value}` }) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => {
    const params = new URL(url, 'http://localhost').searchParams;
    const offset = Number(params.get('offset'));
    const limit = Number(params.get('limit'));
    return { threads: campaignRecords.slice(offset, offset + limit), total: campaignRecords.length };
  });
  mocks.put.mockResolvedValue({});
  mocks.remove.mockResolvedValue({});
});
afterEach(cleanup);

async function tabTo(user: ReturnType<typeof userEvent.setup>, target: HTMLElement) {
  for (let steps = 0; steps < 60 && document.activeElement !== target; steps++) await user.tab();
  expect(target).toHaveFocus();
}

function rooms(onSubmit = vi.fn()) {
  render(<form onSubmit={event => { event.preventDefault(); onSubmit(); }}><RoomTypesTab roomTypes={roomRecords} currency="USD" onRefresh={mocks.refresh} /></form>);
  return onSubmit;
}

function roomCard(target: string) {
  const button = screen.getByRole('button', { name: `Save changes to room type ${target}` });
  return within(button.closest('.shadcn-card') as HTMLElement);
}

describe('AS018 campaign actions', () => {
  it.each(['grid', 'list'] as const)('names all %s triggers and preserves keyboard/dialog safeguards', async mode => {
    const user = userEvent.setup();
    render(<ChatsPage />);
    await screen.findByRole('button', { name: `Delete campaign ${campaignTargets[0]}` });
    if (mode === 'list') await user.click(screen.getByRole('button', { name: 'List view' }));
    const params = new URL(mocks.get.mock.calls.at(-1)![0], 'http://localhost').searchParams;
    const currentTargets = campaignTargets.slice(Number(params.get('offset')), Number(params.get('offset')) + Number(params.get('limit')));
    expect(screen.getAllByRole('button', { name: /^Delete campaign / })).toHaveLength(currentTargets.length);
    for (const target of currentTargets) {
      const trigger = screen.getByRole('button', { name: `Delete campaign ${target}` });
      expect(trigger).toHaveAttribute('type', 'button');
      expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
      expect(trigger.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
    const trigger = screen.getByRole('button', { name: `Delete campaign ${campaignTargets[2]}` });
    await tabTo(user, trigger);
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Campaign' });
    expect(dialog).toHaveAccessibleDescription(`Are you sure you want to delete ${campaignTargets[2]}? This action cannot be undone.`);
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toHaveFocus());
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.keyboard(' ');
    await screen.findByRole('alertdialog', { name: 'Delete Campaign' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('keeps stable target names after filtering/paging and deletes only the confirmed synthetic record', async () => {
    const user = userEvent.setup();
    render(<ChatsPage />);
    await screen.findByRole('button', { name: `Delete campaign ${campaignTargets[0]}` });
    const filter = screen.getByPlaceholderText('Filter this page by campaign title...');
    await user.type(filter, 'Duplicate synthetic campaign');
    expect(screen.getAllByRole('button', { name: /^Delete campaign / })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: `Delete campaign ${campaignTargets[1]}` }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.clear(filter);
    await user.click(screen.getByRole('button', { name: 'Page 2' }));
    const nextTrigger = await screen.findByRole('button', { name: `Delete campaign ${campaignTargets.at(-1)}` });
    await user.click(nextTrigger);
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(`Are you sure you want to delete ${campaignTargets.at(-1)}? This action cannot be undone.`);
    expect(mocks.remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('/api/chat/threads/911'));
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe('AS018 room actions', () => {
  it('names every Edit/Save/Cancel, including long, duplicate and missing names, and cancels without form submission', async () => {
    const user = userEvent.setup();
    const submit = rooms();
    expect(screen.getAllByRole('button', { name: /^Edit room type / })).toHaveLength(roomRecords.length);
    for (const [index, target] of roomTargets.entries()) {
      const edit = screen.getByRole('button', { name: `Edit room type ${target}` });
      expect(edit.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      await tabTo(user, edit);
      await user.keyboard(index % 2 === 0 ? '{Enter}' : ' ');
      const card = roomCard(target);
      expect(card.getByRole('textbox')).toHaveFocus();
      await user.clear(card.getByRole('textbox'));
      await user.type(card.getByRole('textbox'), 'Unsaved synthetic name');
      const save = card.getByRole('button', { name: `Save changes to room type ${target}` });
      const cancel = card.getByRole('button', { name: `Cancel editing room type ${target}` });
      for (const button of [save, cancel]) {
        expect(button).toHaveAttribute('type', 'button');
        expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      }
      await tabTo(user, cancel);
      await user.keyboard(' ');
      await waitFor(() => expect(screen.getByRole('button', { name: `Edit room type ${target}` })).toHaveFocus());
      expect(screen.queryByDisplayValue('Unsaved synthetic name')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: `Edit room type ${target}` }).closest('.shadcn-card')).toHaveTextContent(roomRecords[index].name.trim() || `Room type ${roomRecords[index].id}`);
    }
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('discards a filtered-out draft, supports repeated cancellation and does not edit another row', async () => {
    const user = userEvent.setup();
    rooms();
    await user.click(screen.getByRole('button', { name: `Edit room type ${roomTargets[1]}` }));
    await user.type(roomCard(roomTargets[1]).getByRole('textbox'), ' unsaved');
    const search = screen.getByPlaceholderText('Search room types...');
    fireEvent.change(search, { target: { value: 'Synthetic room with' } });
    expect(screen.queryByRole('button', { name: /^Save changes/ })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: '' } });
    for (let cycle = 0; cycle < 2; cycle++) {
      await user.click(screen.getByRole('button', { name: `Edit room type ${roomTargets[1]}` }));
      expect(roomCard(roomTargets[1]).getByRole('textbox')).toHaveValue(roomRecords[1].name);
      await user.click(screen.getByRole('button', { name: `Cancel editing room type ${roomTargets[1]}` }));
      expect(screen.getByRole('button', { name: `Edit room type ${roomTargets[1]}` })).toHaveFocus();
    }
    expect(screen.getByRole('button', { name: `Edit room type ${roomTargets[2]}` })).toBeInTheDocument();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('preserves validation and saves only the intended synthetic target through a mock', async () => {
    const user = userEvent.setup();
    const submit = rooms();
    await user.click(screen.getByRole('button', { name: `Edit room type ${roomTargets[2]}` }));
    const name = roomCard(roomTargets[2]).getByRole('textbox');
    const save = screen.getByRole('button', { name: `Save changes to room type ${roomTargets[2]}` });
    await user.clear(name);
    await user.click(save);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith({ title: 'Check the room name, capacity, prices, and discount', variant: 'destructive' });
    await user.type(name, 'Saved synthetic room');
    await user.click(save);
    await waitFor(() => expect(mocks.put).toHaveBeenCalledExactlyOnceWith('/api/hotel/room-types/803', { name: 'Saved synthetic room', capacity: 2, basePrice: 150, minPrice: 100, maxDiscountPct: 20, amenities: ['WiFi'] }));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });
});
