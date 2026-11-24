import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import KnowledgeBaseFormPage from '@/app/dashboard/(main)/knowledge-base/[id]/page';
import KnowledgeBasePage from '@/app/dashboard/(main)/knowledge-base/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), postForm: vi.fn(), toast: vi.fn(), push: vi.fn(), id: 'new' }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }), useParams: () => ({ id: mocks.id }) }));

const profiles = [{ id: 4102, companyName: 'Fixture workspace' }];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.id = 'new';
  mocks.get.mockImplementation(async (path: string) => path === '/api/settings/business-profiles' ? profiles : []);
  mocks.post.mockResolvedValue({ success: true });
  mocks.put.mockResolvedValue({ success: true });
  mocks.postForm.mockResolvedValue({ success: true });
});
afterEach(cleanup);

function renderPage(page = <KnowledgeBaseFormPage />) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{page}</QueryClientProvider>);
}
const textbox = (name: string) => screen.getByRole('textbox', { name });
function expectAssociations() {
  const ids = Array.from(document.querySelectorAll('[id]'), element => element.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const element of document.querySelectorAll('[aria-describedby], [aria-labelledby]')) {
    for (const attribute of ['aria-describedby', 'aria-labelledby']) {
      for (const id of element.getAttribute(attribute)?.split(' ') ?? []) expect(document.getElementById(id)).not.toBeNull();
    }
  }
  for (const field of document.querySelectorAll('input, textarea')) {
    expect(document.querySelector(`label[for="${field.id}"]`)).not.toBeNull();
  }
}
function expectNoWrites() {
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.put).not.toHaveBeenCalled();
  expect(mocks.postForm).not.toHaveBeenCalled();
}

describe('Knowledge entry accessible form', () => {
  it('links native labels, required fields and help, retaining IDs and values when switching types', async () => {
    renderPage();
    expect(textbox('Title')).toBeRequired();
    expect(textbox('Description')).not.toBeRequired();
    expect(textbox('Description')).toHaveAccessibleDescription('Optional brief description.');
    expect(textbox('Document Content')).toBeRequired();
    expect(textbox('Document Content')).toHaveAccessibleDescription('0 words, 0 characters.');
    const titleId = textbox('Title').id;
    await userEvent.type(textbox('Title'), 'Draft title');
    await userEvent.type(textbox('Document Content'), 'Original content');
    await userEvent.click(screen.getByRole('button', { name: 'File Upload' }));
    expect(screen.getByLabelText(/^File Upload/, { selector: 'input' })).toBeRequired();
    expect(screen.getByLabelText(/^File Upload/, { selector: 'input' })).toHaveAccessibleName('File Upload');
    expect(screen.getByRole('button', { name: 'Choose file' })).toHaveAccessibleDescription(/max 10MB/);
    expectAssociations();
    await userEvent.click(screen.getByRole('button', { name: 'Website URL' }));
    expect(textbox('Website URL')).toBeRequired();
    expect(textbox('Website URL')).toHaveAccessibleDescription(/automatically crawled/);
    expectAssociations();
    await userEvent.click(screen.getByRole('button', { name: 'Document' }));
    expect(textbox('Title')).toHaveAttribute('id', titleId);
    expect(textbox('Title')).toHaveValue('Draft title');
    expect(textbox('Document Content')).toHaveValue('Original content');
    expect(screen.getByRole('button', { name: 'Document', pressed: true })).toBeVisible();
    const profile = await screen.findByRole('combobox', { name: 'Business Profile' });
    expect(profile).toBeDisabled();
    expect(profile).toHaveAccessibleDescription('This entry belongs to the current business workspace.');
    expectAssociations();
    expectNoWrites();
  });

  it('focuses and associates existing empty/whitespace validation, then clears errors while editing', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(textbox('Title')).toHaveFocus();
    expect(textbox('Title')).toHaveAttribute('aria-invalid', 'true');
    expect(textbox('Title')).toHaveAccessibleDescription('Title is required');
    expect(screen.getByRole('alert')).toHaveTextContent('Title is required');
    expectNoWrites();
    await userEvent.type(textbox('Title'), '   ');
    expect(textbox('Title')).not.toHaveAttribute('aria-invalid', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Save Entry' }));
    expect(textbox('Title')).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(textbox('Title'));
    await userEvent.type(textbox('Title'), 'Fixture title');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(textbox('Document Content')).toHaveFocus();
    expect(textbox('Document Content')).toHaveAttribute('aria-invalid', 'true');
    expect(textbox('Document Content')).toHaveAccessibleDescription(/Content is required for document entries/);
    expectAssociations();
    expectNoWrites();
    await userEvent.type(textbox('Document Content'), 'Fixture document');
    expect(textbox('Document Content')).not.toHaveAttribute('aria-invalid', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/knowledge-base', {
      title: 'Fixture title', description: '', type: 'document', content: 'Fixture document', businessProfileId: null,
    }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/knowledge-base');
  });

  it('names every Q&A row without imposing requirements on optional rows or changing saved pairs', async () => {
    renderPage();
    await userEvent.type(textbox('Title'), 'FAQ');
    await userEvent.click(screen.getByRole('button', { name: 'Q&A Pairs' }));
    expect(textbox('Question 1')).toBeRequired();
    expect(textbox('Answer 1')).toBeRequired();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(textbox('Question 1')).toHaveFocus();
    expect(textbox('Question 1')).toHaveAccessibleDescription(/At least one Q&A pair/);
    expectNoWrites();
    await userEvent.type(textbox('Question 1'), 'When?');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(textbox('Answer 1')).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: /Add Another Q&A Pair/ }));
    expect(textbox('Question 1')).not.toBeRequired();
    expect(textbox('Answer 2')).not.toBeRequired();
    await userEvent.type(textbox('Question 2'), 'What?');
    await userEvent.type(textbox('Answer 2'), 'Fixture answer');
    expectAssociations();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/knowledge-base/qa', {
      qas: [{ question: 'What?', answer: 'Fixture answer', title: 'FAQ', description: '' }], businessProfileId: null,
      requestId:expect.stringMatching(/^[a-f0-9-]{36}$/),
    }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove Q&A pair 1' }));
    expect(textbox('Question 1')).toHaveFocus();
    expect(textbox('Question 1')).toHaveValue('What?');
    expect(textbox('Answer 1')).toHaveValue('Fixture answer');
    expect(textbox('Question 1')).toBeRequired();
    expectAssociations();
  });

  it('retains saved batch receipts and the same identity across a partial retry', async () => {
    mocks.post.mockResolvedValueOnce({success:false,message:'Saved entry IDs: 31, 32. Retry unchanged.',results:[{entryId:31,status:'completed'},{entryId:32,status:'failed'}]}).mockResolvedValueOnce({success:true});
    renderPage();
    await userEvent.type(textbox('Title'), 'Recovery fixture');
    await userEvent.click(screen.getByRole('button', {name:'Q&A Pairs'}));
    await userEvent.type(textbox('Question 1'), 'Reset?');
    await userEvent.type(textbox('Answer 1'), 'Blue button');
    await userEvent.click(screen.getByRole('button', {name:'Save'}));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({description:expect.stringContaining('31')})));
    expect(mocks.push).not.toHaveBeenCalled();
    const first=mocks.post.mock.calls[0][1];
    await userEvent.click(screen.getByRole('button', {name:'Save'}));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[1][1]).toEqual(first);
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/knowledge-base');
  });

  it('offers keyboard file choice and associated file/URL validation without calling providers', async () => {
    renderPage();
    await userEvent.type(textbox('Title'), 'Source');
    await userEvent.click(screen.getByRole('button', { name: 'File Upload' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const choose = screen.getByRole('button', { name: 'Choose file' });
    expect(choose).toHaveFocus();
    expect(choose).toHaveAccessibleDescription(/Please upload a file/);
    expect(screen.getByLabelText(/^File Upload/, { selector: 'input' })).toHaveAttribute('aria-invalid', 'true');
    const file = screen.getByLabelText(/^File Upload/, { selector: 'input' });
    const pickerClick = vi.spyOn(file, 'click');
    await userEvent.keyboard('{Enter}');
    expect(pickerClick).toHaveBeenCalledOnce();
    // Native picker completion dispatches change; userEvent.upload also restores
    // input focus afterward, which differs from the real browser chooser.
    fireEvent.change(file, { target: { files: [new File(['Fixture text'], 'fixture.txt', { type: 'text/plain' })] } });
    expect(screen.getByRole('button', { name: 'Remove file' })).toHaveFocus();
    expect(screen.getByLabelText(/^File Upload/, { selector: 'input' })).not.toBeRequired();
    await userEvent.click(screen.getByRole('button', { name: 'Remove file' }));
    expect(screen.getByRole('button', { name: 'Choose file' })).toHaveFocus();
    expect(screen.getByLabelText(/^File Upload/, { selector: 'input' })).toBeRequired();
    await userEvent.click(screen.getByRole('button', { name: 'Website URL' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Entry' }));
    expect(textbox('Website URL')).toHaveFocus();
    expect(textbox('Website URL')).toHaveAccessibleDescription(/URL is required/);
    expectAssociations();
    expectNoWrites();
  });

  it.each(['document', 'file', 'qa', 'url'])('preserves loaded %s values, disabled scope and Back navigation', async type => {
    mocks.id = '501';
    mocks.get.mockImplementation(async (path: string) => path === '/api/settings/business-profiles' ? profiles : {
      entry: { id: 501, title: 'Saved title', description: 'Saved description', type, content: 'Saved content',
        fileName: 'saved.txt', question: 'Saved question', answer: 'Saved answer', sourceUrl: 'https://fixture.example.test', businessProfileId: 4102 },
    });
    renderPage();
    await waitFor(() => expect(textbox('Title')).toHaveValue('Saved title'));
    expect(textbox('Description')).toHaveValue('Saved description');
    expect(screen.queryByRole('group', { name: 'Entry Type' })).not.toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: 'Business Profile' })).toBeDisabled();
    if (type === 'document') expect(textbox('Document Content')).toHaveValue('Saved content');
    if (type === 'file') expect(screen.getByLabelText(/^File Upload/, { selector: 'input' })).not.toBeRequired();
    if (type === 'qa') expect(textbox('Question 1')).toHaveValue('Saved question');
    if (type === 'url') {
      expect(textbox('Website URL')).toHaveValue('https://fixture.example.test');
      expect(textbox('Website URL')).toBeDisabled();
      expect(textbox('Website URL')).not.toBeRequired();
    }
    expectAssociations();
    await userEvent.click(screen.getByRole('button', { name: 'Back to Knowledge Base' }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/knowledge-base');
    expectNoWrites();
  });
});

it('recovers from no matching Knowledge entries repeatedly using keyboard Clear search', async () => {
  mocks.get.mockImplementation(async (path: string) => path === '/api/settings/business-profiles' ? profiles : [
    { id: 501, title: 'Fixture article', type: 'document', content: 'Synthetic content', createdAt: '2026-10-01', updatedAt: '2026-10-01' },
  ]);
  renderPage(<KnowledgeBasePage />);
  await screen.findByText('Fixture article');
  const search = textbox('Search knowledge base');
  for (let i = 0; i < 2; i++) {
    await userEvent.type(search, 'zz-no-matches');
    expect(screen.getByText('No entries match your search criteria')).toBeVisible();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Clear search' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.getByText('Fixture article')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
  }
  expectNoWrites();
});
