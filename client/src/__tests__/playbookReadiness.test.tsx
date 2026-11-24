import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Playbooks from '@/app/dashboard/(main)/settings/outreach/playbooks/page';
import type { PlaybookGraph } from '@/components/support/PlaybookGraphEditor';
import { proposalGraphFixture } from './fixtures/playbook';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), toast: vi.fn() }));
const router = { push: vi.fn() };
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/dashboard/settings/outreach/playbooks' }));
vi.mock('@/components/support/PlaybookGraphEditor', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/support/PlaybookGraphEditor')>();
  return {
    ...actual,
    PlaybookGraphEditor: ({ graph, onChange }: { graph: PlaybookGraph; onChange: (graph: PlaybookGraph) => void }) => <div>
      {actual.getPlaybookGraphIssues(graph).map(issue => <p key={issue}>Editor: {issue}</p>)}
      <button onClick={() => onChange({ ...graph, nodes: graph.nodes.map(node => node.type === 'capability'
        ? { ...node, data: { ...node.data, capabilityName: 'unregistered.capability' } } : node) })}>Break capability</button>
      <button onClick={() => onChange({ ...graph, nodes: graph.nodes.map(node => node.type === 'capability'
        ? { ...node, data: { ...node.data, capabilityName: 'proposal.revision_request' } } : node) })}>Restore capability</button>
    </div>,
  };
});

const pass = { valid: true, errors: [], warnings: [] };
const failure = { valid: false, errors: ['Current draft failed server validation.'], warnings: [] };
let graph: PlaybookGraph;

beforeEach(() => {
  vi.clearAllMocks();
  graph = proposalGraphFixture();
  mocks.get.mockImplementation(async (url: string) => url.endsWith('/playbooks') ? [21, 20].map(id => ({
    id, name: `Proposal changes ${id}`, draftGraph: graph, status: 'published', enabled: true, activeVersion: 1,
    assignments: [], templateMode: 'custom',
  })) : []);
  mocks.post.mockResolvedValue(pass);
});

const status = () => screen.getByRole('status');
const publish = () => screen.getByRole('button', { name: 'Publish changes' });
const passed = () => waitFor(() => expect(status()).toHaveTextContent('Checks passed'), { timeout: 5000 });

describe('current draft readiness', () => {
  it('checks the saved draft independently from its live version and remains consistent across sections', async () => {
    render(<Playbooks />);
    await passed();
    expect(status()).toHaveTextContent('Draft saved · Checks passed');
    expect(publish()).toBeEnabled();
    expect(screen.getByText(/Published version 1/)).toBeVisible();
    for (const section of ['Graph', 'Questions', 'Channels', 'Settings', 'Conversation']) {
      fireEvent.click(screen.getByRole('button', { name: section }));
      expect(status()).toHaveTextContent('Draft saved · Checks passed');
    }
    const checkedGraph = mocks.post.mock.calls.at(-1)![1].graph;
    expect(checkedGraph.nodes.find((node: { id: string }) => node.id === 'record-changes').data.capabilityName)
      .toBe('proposal.revision_request');
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it.each(['', 'unregistered.capability'])('never shows an all-clear for an invalid saved capability (%s), even if the API passes', async capabilityName => {
    graph.nodes.find(node => node.id === 'record-changes')!.data.capabilityName = capabilityName;
    render(<Playbooks />);
    await waitFor(() => expect(status()).toHaveTextContent('Draft saved · Needs attention'));
    expect(screen.getByText('Record changes requires a registered capability.')).toBeVisible();
    expect(publish()).toBeDisabled();
    for (const section of ['Graph', 'Questions', 'Channels', 'Settings', 'Conversation']) {
      fireEvent.click(screen.getByRole('button', { name: section }));
      expect(status()).toHaveTextContent('Needs attention');
      expect(status()).not.toHaveTextContent('Checks passed');
    }
    fireEvent.click(publish());
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.post.mock.calls.every(([url]) => !String(url).endsWith('/publish'))).toBe(true);
  });

  it('keeps saved/dirty and valid/invalid independent and invalidates a passing result immediately on graph edits', async () => {
    render(<Playbooks />);
    await passed();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.change(screen.getByLabelText('Playbook name'), { target: { value: 'Changed name' } });
    expect(status()).toHaveTextContent('Unsaved changes · Checks passed');
    fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Break capability' }));
    expect(status()).toHaveTextContent('Unsaved changes · Checking flow');
    expect(publish()).toBeDisabled();
    await waitFor(() => expect(status()).toHaveTextContent('Unsaved changes · Needs attention'));
    fireEvent.click(screen.getByRole('button', { name: 'Restore capability' }));
    expect(status()).toHaveTextContent('Checking flow');
    await passed();
    expect(status()).toHaveTextContent('Unsaved changes · Checks passed');
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('rechecks when a quick edit is reverted before its debounced request starts', async () => {
    render(<Playbooks />);
    await passed();
    fireEvent.click(screen.getByRole('button', { name: 'Break capability' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore capability' }));
    expect(status()).toHaveTextContent('Checking flow');
    expect(publish()).toBeDisabled();
    await passed();
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it('does not reuse an all-clear when another playbook has identical graph content', async () => {
    render(<Playbooks />);
    await passed();
    let resolve!: (value: typeof failure) => void;
    mocks.post.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const selection = within(screen.getByRole('navigation', { name: 'Playbook selection' }));
    fireEvent.click(selection.getByRole('button', { name: /Proposal changes 20/ }));
    expect(status()).toHaveTextContent('Checking flow');
    expect(status()).not.toHaveTextContent('Checks passed');
    expect(publish()).toBeDisabled();
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    await act(async () => { resolve(failure); });
    expect(status()).toHaveTextContent('Needs attention');
    fireEvent.click(selection.getByRole('button', { name: /Proposal changes 21/ }));
    expect(status()).toHaveTextContent('Checking flow');
    await passed();
  });

  it('discards a late successful response from an older graph revision', async () => {
    let resolve!: (value: typeof pass) => void;
    mocks.post.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(<Playbooks />);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(status()).toHaveTextContent('Checking flow');
    mocks.post.mockResolvedValue(failure);
    fireEvent.click(screen.getByRole('button', { name: 'Break capability' }));
    await waitFor(() => expect(status()).toHaveTextContent('Needs attention'));
    await act(async () => { resolve(pass); });
    expect(status()).toHaveTextContent('Needs attention');
    expect(status()).not.toHaveTextContent('Checks passed');
    expect(screen.getByText(failure.errors[0])).toBeVisible();
    expect(publish()).toBeDisabled();
  });

  it('fails closed when checks are unavailable and when developer JSON is invalid', async () => {
    mocks.post.mockRejectedValue(new Error('Validation service unavailable.'));
    render(<Playbooks />);
    await waitFor(() => expect(status()).toHaveTextContent('Needs attention'));
    expect(screen.getByText('Validation service unavailable.')).toBeVisible();
    expect(publish()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByText('Developer tools', { exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Developer JSON' }));
    fireEvent.change(screen.getByLabelText('Playbook developer JSON'), { target: { value: '{' } });
    expect(status()).not.toHaveTextContent('Checks passed');
    await waitFor(() => expect(status()).toHaveTextContent('Unsaved changes · Needs attention'));
    expect(screen.getByText('Provide a valid playbook graph.')).toBeVisible();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
