import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KnowledgeReviewDialog, KnowledgeRetrievalTester, knowledgeBlockReasons } from '@/components/knowledge/KnowledgeReviewDialog';
import { KnowledgeReadinessDetails } from '@/components/knowledge/KnowledgeReadiness';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: api }));
// Profile options are restricted to the selected workspace on v8.
vi.mock('@/lib/business-profile', () => ({ selectedBusinessProfileId: () => 42 }));
afterEach(cleanup);
const metadata = { title: 'Hours', sourceUrl: null, businessProfileId: null, audience: 'customer', accessScope: 'tenant', usageScopes: ['support_answer'], allowedChannels: [], locale: null };
const entry = { id: 5, title: 'Hours' };
const versions = [{ id: 21, version_no: 2, status: 'ready_for_review', current_published_version_id: 20,
  normalized_content: 'Draft: opens at 10 AM', lexical_index_status: 'completed', vector_index_status: 'failed',
  audience: 'customer', usage_scopes: ['support_answer'], diagnostics: { publicationMetadata: metadata } },
{ id: 20, version_no: 1, status: 'published', current_published_version_id: 20,
  normalized_content: 'Live: opens at 9 AM', lexical_index_status: 'completed', vector_index_status: 'completed', audience: 'customer', usage_scopes: ['support_answer'] }];
beforeEach(() => { vi.clearAllMocks(); api.get.mockResolvedValue({ versions }); api.put.mockResolvedValue({}); api.post.mockResolvedValue({}); });

describe('knowledge review and retrieval controls', () => {
  const readiness = { status: 'privacy_blocked', versionId: 20, versionNo: 1, isLive: true,
    privacyClassification: 'personal', chunkCount: 13, embeddedChunkCount: 13,
    activeIndexId: 2, embeddingModel: 'example-model', lexicalIndexStatus: 'completed', semanticIndexStatus: 'completed' };
  it('distinguishes complete embeddings from privacy-blocked retrieval', () => {
    render(<KnowledgeReadinessDetails readiness={readiness} />);
    expect(screen.getByText('Blocked by privacy review')).toBeVisible();
    expect(screen.getByText(/13\/13 chunks embedded in active index 2/)).toBeVisible();
    expect(screen.getByText(/Changing audience alone cannot clear/)).toBeVisible();
  });
  it('explains a blocked historical publication and prevents publishing a blocked draft', async () => {
    api.get.mockResolvedValue({ versions: [{ ...versions[0], readiness: { ...readiness, isLive: false, versionId: 21 } },
      { ...versions[1], readiness }] });
    render(<KnowledgeReviewDialog entry={entry} profiles={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByRole('link', { name: 'Review and correct source' });
    fireEvent.click(screen.getByRole('checkbox', { name: /Publish with keyword search only/ }));
    expect(screen.getByRole('button', { name: 'Publish v2' })).toBeDisabled();
    expect(screen.getAllByText('Blocked by privacy review')).toHaveLength(2);
    expect(api.post).not.toHaveBeenCalled();
  });
  it('shows owner scope diagnostics without claiming a blocked source matched the question', async () => {
    api.post.mockResolvedValue({ result: { status: 'insufficient', evidence: [], diagnostics: { degraded: true },
      ownerReadiness: { scopeOnly: true, privacyBlockedSources: 2, safetyBlockedSources: 0, indexingBlockedSources: 0 } } });
    render(<KnowledgeRetrievalTester profiles={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test retrieval' }));
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'AI agents' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run retrieval test' }));
    expect(await screen.findByText(/No usable evidence returned/)).toBeVisible();
    expect(screen.getByText(/2 privacy blocked/)).toBeVisible();
    expect(screen.getByText(/not matches to your question/)).toBeVisible();
    expect(screen.getByText(/does not mean stored source embeddings are missing/)).toBeVisible();
    expect(screen.queryByText(/No matching published evidence/)).not.toBeInTheDocument();
  });
  it('keeps genuine no-match separate when no blocked readiness is reported', async () => {
    api.post.mockResolvedValue({ result: { status: 'insufficient', evidence: [], diagnostics: {},
      ownerReadiness: { scopeOnly: true, privacyBlockedSources: 0, safetyBlockedSources: 0, indexingBlockedSources: 0 } } });
    render(<KnowledgeRetrievalTester profiles={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test retrieval' }));
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Unrelated topic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run retrieval test' }));
    expect(await screen.findByText(/No matching published evidence/)).toBeVisible();
    expect(screen.queryByText(/Owner diagnostics/)).not.toBeInTheDocument();
  });
  it('separates live and draft content and requires explicit degraded-publication consent', async () => {
    render(<KnowledgeReviewDialog entry={entry} profiles={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByText('Live: opens at 9 AM')).toBeVisible();
    expect(screen.getByText('Draft: opens at 10 AM')).toBeVisible();
    const publish = screen.getByRole('button', { name: 'Publish v2' });
    expect(publish).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Publish with keyword search only/ }));
    fireEvent.click(publish);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/knowledge-base/5/versions/21/publish', { authority: 'owner_authored', allowLexicalOnly: true }));
  });
  it('saves staff-only scope on the draft and guards accidental close', async () => {
    const close = vi.fn();
    render(<KnowledgeReviewDialog entry={entry} profiles={[]} onClose={close} onChanged={vi.fn()} />);
    await screen.findByText('Draft: opens at 10 AM');
    fireEvent.change(screen.getByLabelText('Access'), { target: { value: 'staff_only' } });
    expect(screen.getByLabelText('Audience')).toHaveValue('internal');
    expect(screen.getByText('Unsaved scope changes')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByText('Discard unsaved scope changes?')).toBeVisible();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft scope' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/knowledge-base/5/versions/21/scope', { metadata: { ...metadata, audience: 'internal', accessScope: 'staff_only' } }));
  });
  it('withdraws the live version only with an explicit reason', async () => {
    render(<KnowledgeReviewDialog entry={entry} profiles={[]} onClose={vi.fn()} onChanged={vi.fn()} />);
    const withdraw = await screen.findByRole('button', { name: 'Withdraw live version' });
    expect(withdraw).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Withdrawal reason'), { target: { value: 'Hours under review' } });
    fireEvent.click(withdraw);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/knowledge-base/5/withdraw', { reason: 'Hours under review' }));
  });
  it('runs scoped retrieval and explains provider unavailability instead of claiming no knowledge', async () => {
    api.post.mockResolvedValue({ result: { status: 'unavailable', evidence: [], diagnostics: {} } });
    render(<KnowledgeRetrievalTester profiles={[{ id: 42, companyName: 'Estate' }, { id: 43, companyName: 'Other workspace' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test retrieval' }));
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'When is check-in?' } });
    expect(screen.queryByRole('option', { name: 'Other workspace' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Business profile'), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'instagram' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run retrieval test' }));
    expect(await screen.findByText(/Search is temporarily unavailable/)).toBeVisible();
    expect(api.post).toHaveBeenCalledWith('/api/knowledge-base/test-retrieval', expect.objectContaining({ businessProfileId: 42, channel: 'instagram' }));
  });
});

describe('knowledge block reasons', () => {
  it('explains stored scan codes in owner language', () => {
    const messages = knowledgeBlockReasons(['personal_data_detected', 'personal_data:email', 'personal_data:phone', 'injection:ignore_instructions', 'ignore_instructions']);
    expect(messages[0]).toBe('Personal data found: an email address, a phone number. Remove it, or add your business phone, email or address in Business profile so it is treated as public.');
    expect(messages[1]).toBe('Unsafe instructions found: text telling the AI to ignore its instructions. Rewrite this text as plain information.');
    expect(messages).toHaveLength(2);
  });
  it('keeps older entries readable when only the generic code was stored', () => {
    expect(knowledgeBlockReasons(['personal_data_detected'])).toEqual(['Personal data found. Remove names, contact details or identifiers that belong to people.']);
    expect(knowledgeBlockReasons(['metadata:personal_data_detected', 'secret:api_secret'])).toEqual([
      'Sensitive value found: an API key or secret. Remove it before publishing.',
      'Personal data found in the title or link. Remove names, contact details or identifiers that belong to people.',
    ]);
  });
});
