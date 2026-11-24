import React, { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrandToolkitForm, type BrandToolkitFormHandle } from '@/components/BrandToolkitForm';
import { confirmUnsavedNavigation } from '@/hooks/use-unsaved-changes';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), postForm: vi.fn(), toast: vi.fn(), saved: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

function editor(id = 42, create = false) {
  const ref = createRef<BrandToolkitFormHandle>();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = (toolkitId: number) => <QueryClientProvider client={client}><BrandToolkitForm ref={ref} toolkitId={toolkitId} isCreateMode={create} onSaveSuccess={mocks.saved} /></QueryClientProvider>;
  return { ...render(content(id)), ref, content };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ id: 42, name: 'Saved brand', version: 4 });
  mocks.put.mockResolvedValue({ id: 42, name: 'Saved brand', version: 5 });
});
afterEach(cleanup);

describe('ongoing brand editor recovery', () => {
  it('keeps uncommitted tag text through sections, guards it, and requires explicit addition before saving', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      const view = editor(); await screen.findByDisplayValue('Saved brand');
      fireEvent.click(screen.getByRole('button', { name: 'Voice & Values' }));
      fireEvent.change(await screen.findByLabelText('Brand Values'), { target: { value: 'Uncommitted value' } });
      expect(confirmUnsavedNavigation('workspace')).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Social Media' }));
      await screen.findByRole('heading', { name: 'Social Media' });
      await act(() => view.ref.current!.triggerSave());
      expect(mocks.put).not.toHaveBeenCalled();
      const draft = await screen.findByLabelText('Brand Values');
      expect(draft).toHaveValue('Uncommitted value');
      fireEvent.click(screen.getByRole('button', { name: 'Add Brand Values' }));
      await act(() => view.ref.current!.triggerSave());
      expect(mocks.put).toHaveBeenCalledWith('/api/content/brand-toolkits/42', expect.objectContaining({ brandValues: ['Uncommitted value'] }));
    } finally { confirm.mockRestore(); }
  });

  it('returns to and focuses the required brand name without rejecting a user save', async () => {
    const view = editor(0, true);
    fireEvent.click(screen.getByRole('button', { name: 'Social Media' }));
    await screen.findByRole('heading', { name: 'Social Media' });
    let saveError: unknown;
    await act(async () => { try { await view.ref.current!.triggerSave(); } catch (error) { saveError = error; } });
    const input = await screen.findByLabelText(/Brand Name/);
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(saveError).toBeUndefined();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('uses the existing navigation guard for edits and releases it only after confirmed save', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      const view = editor();
      const input = await screen.findByDisplayValue('Saved brand');
      expect(confirmUnsavedNavigation('workspace')).toBe(true);
      fireEvent.change(input, { target: { value: 'Unsaved workspace draft' } });
      expect(confirmUnsavedNavigation('workspace')).toBe(false);
      expect(input).toHaveValue('Unsaved workspace draft');
      expect(mocks.put).not.toHaveBeenCalled();
      await act(() => view.ref.current!.triggerSave());
      confirm.mockClear();
      expect(confirmUnsavedNavigation('workspace')).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    } finally { confirm.mockRestore(); }
  });

  it('guards pending logo work without calling an already committed upload an unsaved edit', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    let release!: (value: unknown) => void;
    mocks.postForm.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    try {
      editor(); await screen.findByDisplayValue('Saved brand');
      fireEvent.change(screen.getByLabelText('Brand Logo'), { target: { files: [new File(['fixture'], 'logo.png', { type: 'image/png' })] } });
      expect(confirmUnsavedNavigation('workspace')).toBe(false);
      await act(async () => release({ url: '/uploads/committed.png', toolkit: { version: 5 } }));
      await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Logo Uploaded' })));
      confirm.mockClear();
      expect(confirmUnsavedNavigation('workspace')).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    } finally { confirm.mockRestore(); }
  });

  it('sends the loaded version and adopts each committed version for later saves', async () => {
    const view = editor();
    await screen.findByDisplayValue('Saved brand');
    await act(() => view.ref.current!.triggerSave());
    expect(mocks.put).toHaveBeenLastCalledWith('/api/content/brand-toolkits/42', expect.objectContaining({ expectedVersion: 4 }));
    await act(() => view.ref.current!.triggerSave());
    expect(mocks.put).toHaveBeenLastCalledWith('/api/content/brand-toolkits/42', expect.objectContaining({ expectedVersion: 5 }));
  });

  it('keeps unsaved edits after a conflict and requires an explicit reload before retry', async () => {
    const view = editor();
    const input = await screen.findByDisplayValue('Saved brand');
    fireEvent.change(input, { target: { value: 'My unsaved draft' } });
    mocks.put.mockRejectedValueOnce(Object.assign(new Error('This brand toolkit changed. Reload it before saving.'), { status: 409 }));
    await act(() => view.ref.current!.triggerSave());
    await waitFor(() => expect(screen.getByDisplayValue('My unsaved draft')).toBeVisible());
    expect(mocks.saved).not.toHaveBeenCalled();
    const reload = screen.getByRole('button', { name: 'Reload saved toolkit' });
    await act(() => view.ref.current!.triggerSave());
    expect(mocks.put).toHaveBeenCalledTimes(1);
    mocks.get.mockResolvedValueOnce({ id: 42, name: 'Latest saved brand', version: 6 });
    fireEvent.click(reload);
    await screen.findByDisplayValue('Latest saved brand');
    await act(() => view.ref.current!.triggerSave());
    expect(mocks.put).toHaveBeenLastCalledWith('/api/content/brand-toolkits/42', expect.objectContaining({ expectedVersion: 6 }));
  });

  it('ignores a late response for the previously selected toolkit', async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.get.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    const view = editor(41);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/content/brand-toolkits/41'));
    view.rerender(view.content(42));
    await screen.findByDisplayValue('Saved brand');
    await act(async () => resolveOld({ id: 41, name: 'Old late brand', version: 1 }));
    await waitFor(() => expect(screen.getByDisplayValue('Saved brand')).toBeVisible());
    expect(screen.queryByDisplayValue('Old late brand')).not.toBeInTheDocument();
    await act(() => view.ref.current!.triggerSave());
    expect(mocks.put).toHaveBeenLastCalledWith('/api/content/brand-toolkits/42', expect.anything());
  });

  it('ignores a late error from a previously selected toolkit', async () => {
    let rejectOld!: (value: unknown) => void;
    mocks.get.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectOld = reject; }));
    const view = editor(41);
    view.rerender(view.content(42));
    await screen.findByDisplayValue('Saved brand');
    await act(async () => rejectOld(new Error('Old toolkit unavailable')));
    expect(screen.queryByText('Unable to load this brand toolkit')).not.toBeInTheDocument();
    expect(screen.queryByText('Old toolkit unavailable')).not.toBeInTheDocument();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('does not let a previous toolkit save replace the next toolkit or navigate away', async () => {
    let resolveSave!: (value: unknown) => void;
    mocks.put.mockReturnValueOnce(new Promise(resolve => { resolveSave = resolve; }));
    const view = editor();
    await screen.findByDisplayValue('Saved brand');
    let save!: Promise<void>;
    act(() => { save = view.ref.current!.triggerSave(); });
    mocks.get.mockResolvedValueOnce({ id: 43, name: 'Next selected brand', version: 7 });
    view.rerender(view.content(43));
    await screen.findByDisplayValue('Next selected brand');
    await act(async () => { resolveSave({ id: 42, name: 'Old committed brand', version: 5 }); await save; });
    expect(screen.getByDisplayValue('Next selected brand')).toBeInTheDocument();
    expect(mocks.saved).not.toHaveBeenCalled();
  });

  it('binds inline logo uploads to the loaded version and adopts the committed logo version', async () => {
    const view = editor();
    const input = await screen.findByDisplayValue('Saved brand');
    fireEvent.change(input, { target: { value: 'Unsaved brand name' } });
    mocks.postForm.mockResolvedValueOnce({ url: '/uploads/new.png', toolkit: { id: 42, version: 5 } });
    fireEvent.change(screen.getByLabelText('Brand Logo'), { target: { files: [new File(['png fixture'], 'logo.png', { type: 'image/png' })] } });
    await waitFor(() => expect(mocks.postForm).toHaveBeenCalled());
    expect(mocks.postForm.mock.calls[0][1].get('expectedVersion')).toBe('4');
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Logo Uploaded' })));
    await act(() => view.ref.current!.triggerSave());
    expect(mocks.put).toHaveBeenCalledWith('/api/content/brand-toolkits/42', expect.objectContaining({ name: 'Unsaved brand name', logoUrl: '/uploads/new.png', expectedVersion: 5 }));
  });

  it('retains the draft and blocks saving when a logo upload detects a stale toolkit', async () => {
    const view = editor(); await screen.findByDisplayValue('Saved brand');
    mocks.postForm.mockRejectedValueOnce(Object.assign(new Error('This brand toolkit changed. Reload it before uploading.'), { status: 409 }));
    fireEvent.change(screen.getByLabelText('Brand Logo'), { target: { files: [new File(['png fixture'], 'logo.png', { type: 'image/png' })] } });
    await screen.findByRole('button', { name: 'Reload saved toolkit' });
    await act(() => view.ref.current!.triggerSave());
    expect(mocks.put).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Saved brand')).toBeInTheDocument();
  });

  it('reuses one creation key after a lost response instead of creating another toolkit', async () => {
    const view = editor(0, true);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Brand Name' }), { target: { value: 'New brand' } });
    mocks.post.mockRejectedValueOnce(new Error('Connection lost after the server may have saved'));
    mocks.post.mockResolvedValueOnce({ id: 88, name: 'New brand', version: 1 });
    await act(() => view.ref.current!.triggerSave());
    expect(mocks.saved).not.toHaveBeenCalled();
    await act(() => view.ref.current!.triggerSave());
    const first = mocks.post.mock.calls[0][1], retry = mocks.post.mock.calls[1][1];
    expect(first.idempotencyKey).toEqual(expect.any(String));
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(mocks.saved).toHaveBeenCalledWith(expect.objectContaining({ id: 88, version: 1, brandName: 'New brand' }));
  });

  it('keeps a conflicting creation draft and links to the list instead of loading an unrelated toolkit', async () => {
    const view = editor(0, true);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Brand Name' }), { target: { value: 'Changed draft' } });
    mocks.post.mockRejectedValueOnce(Object.assign(new Error('This request key was already used for different brand details.'), { status: 409 }));
    await act(() => view.ref.current!.triggerSave());
    expect(screen.getByRole('link', { name: 'Review saved toolkits' })).toHaveAttribute('href', '/dashboard/brand-toolkit');
    expect(screen.queryByRole('button', { name: 'Reload saved toolkit' })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Changed draft')).toBeInTheDocument();
    await act(() => view.ref.current!.triggerSave());
    expect(mocks.post).toHaveBeenCalledTimes(1); expect(mocks.get).not.toHaveBeenCalled();
  });

  it('ignores website analysis completed for the previously selected toolkit', async () => {
    let resolveAnalysis!: (value: unknown) => void;
    mocks.post.mockReturnValueOnce(new Promise(resolve => { resolveAnalysis = resolve; }));
    const view = editor(); await screen.findByDisplayValue('Saved brand');
    fireEvent.change(screen.getByLabelText('Auto-fill from Website'), { target: { value: 'https://previous.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/setup/analyze-website', { url: 'https://previous.example' }));
    mocks.get.mockResolvedValueOnce({ id: 43, name: 'Next selected brand', version: 7 });
    view.rerender(view.content(43));
    await screen.findByDisplayValue('Next selected brand');
    await act(async () => resolveAnalysis({ data: { companyName: 'Previous analysis result' } }));
    expect(screen.getByDisplayValue('Next selected brand')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Previous analysis result')).not.toBeInTheDocument();
  });

});
