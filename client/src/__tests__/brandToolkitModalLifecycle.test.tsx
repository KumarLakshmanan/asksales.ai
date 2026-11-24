import { StrictMode, useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrandToolkitModal from '@/components/BrandToolkitModal';
import { selectBusinessProfile } from '@/lib/business-profile';
import { ApiError } from '@/lib/api';

const mocks = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn(), postForm: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { post: mocks.post, put: mocks.put, postForm: mocks.postForm }, ApiError: class extends Error {} }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

type Operation = 'post' | 'put' | 'upload';
type Outcome = 'success' | 'rejection';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const initialData = (operation: Operation) => ({
  ...(operation === 'post' ? {} : { id: 71 }), brandName: 'Original Studio', logoUrls: ['/uploads/existing.png'],
});
const outcomes: Outcome[] = ['success', 'rejection'];
const operations: Operation[] = ['post', 'put', 'upload'];
const cases = operations.flatMap(operation => outcomes.map(outcome => ({ operation, outcome })));

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  localStorage.setItem('user', JSON.stringify({ id: 4101 }));
  selectBusinessProfile(11);
});
afterEach(cleanup);

async function startOperation(operation: Operation) {
  if (operation === 'upload') {
    await userEvent.click(screen.getByRole('button', { name: 'Visual Identity' }));
    await userEvent.upload(screen.getByLabelText('Logo'), new File(['synthetic'], 'old.png', { type: 'image/png' }));
    expect(mocks.postForm).toHaveBeenCalledOnce();
  } else {
    await userEvent.click(screen.getByRole('button', { name: 'Target Audience' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Toolkit' }));
    expect(mocks[operation]).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Save Toolkit' })).toHaveAttribute('aria-disabled', 'true');
  }
}

async function settle(request: ReturnType<typeof deferred<{ url: string }>>, outcome: Outcome) {
  await act(async () => {
    if (outcome === 'success') request.resolve({ url: '/uploads/retired.png' });
    else request.reject(new ApiError('Retired request failure'));
    await request.promise.catch(() => {});
  });
}

function ReopenHarness({ operation, onSaved, onClosed }: { operation: Operation; onSaved: () => void; onClosed: () => void }) {
  const [open, setOpen] = useState(true);
  return <>
    <button onClick={() => setOpen(true)}>Reopen editor</button>
    <BrandToolkitModal isOpen={open} initialData={initialData(operation)} onSave={onSaved} onClose={() => { onClosed(); setOpen(false); }} />
  </>;
}

describe('Brand Toolkit editor request generations', () => {
  it.each(cases)('ignores deferred $operation $outcome after Cancel/reopen with the same parent setter', async ({ operation, outcome }) => {
    const request = deferred<{ url: string }>();
    mocks[operation === 'upload' ? 'postForm' : operation].mockReturnValueOnce(request.promise);
    const onSaved = vi.fn();
    const onClosed = vi.fn();
    render(<StrictMode><ReopenHarness operation={operation} onSaved={onSaved} onClosed={onClosed} /></StrictMode>);
    await startOperation(operation);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClosed).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Reopen editor' }));
    const name = screen.getByRole('textbox', { name: /Brand Name/ });
    await userEvent.clear(name);
    await userEvent.type(name, 'Current Studio');
    const draft = screen.getByRole('textbox', { name: 'Brand Values' });
    await userEvent.type(draft, 'Current pending text');
    await settle(request, outcome);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(name).toHaveValue('Current Studio');
    expect(draft).toHaveValue('Current pending text');
    expect(draft).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Visual Identity' }));
    expect(screen.getAllByAltText('Logo').map(image => image.getAttribute('src'))).toEqual(['/api/uploads/existing.png']);
    await userEvent.click(screen.getByRole('button', { name: 'Target Audience' }));
    expect(screen.getByRole('button', { name: 'Save Toolkit' })).toBeEnabled();
  });

  describe.each(['record change', 'workspace change', 'unmount'] as const)('%s', retirement => {
    it.each(cases)('retires deferred $operation $outcome before any toast or callback', async ({ operation, outcome }) => {
      const request = deferred<{ url: string }>();
      mocks[operation === 'upload' ? 'postForm' : operation].mockReturnValueOnce(request.promise);
      const props = { isOpen: true, onSave: vi.fn(), onClose: vi.fn(), initialData: initialData(operation) };
      const { rerender, unmount } = render(<StrictMode><BrandToolkitModal {...props} /></StrictMode>);
      await startOperation(operation);
      if (retirement === 'record change') rerender(<StrictMode><BrandToolkitModal {...props} initialData={{ id: 72, brandName: 'Current Record' }} /></StrictMode>);
      else if (retirement === 'workspace change') act(() => selectBusinessProfile(22));
      else unmount();
      const currentName = retirement === 'unmount' ? null : screen.getByRole('textbox', { name: /Brand Name/ });
      const currentValue = currentName && (currentName as HTMLInputElement).value;
      await settle(request, outcome);
      expect(mocks.toast).not.toHaveBeenCalled();
      expect(props.onSave).not.toHaveBeenCalled();
      expect(props.onClose).not.toHaveBeenCalled();
      if (currentName) {
        expect(currentName).toHaveValue(currentValue);
        await userEvent.click(screen.getByRole('button', { name: 'Visual Identity' }));
        expect(screen.queryAllByAltText('Logo').map(image => image.getAttribute('src'))).not.toContain('/api/uploads/retired.png');
      }
    });
  });

  it.each(outcomes)('retires an externally closed editor before a deferred POST %s', async outcome => {
    const request = deferred<{ url: string }>();
    mocks.post.mockReturnValueOnce(request.promise);
    const props = { onSave: vi.fn(), onClose: vi.fn(), initialData: initialData('post') };
    const { rerender } = render(<BrandToolkitModal {...props} isOpen />);
    await startOperation('post');
    rerender(<BrandToolkitModal {...props} isOpen={false} />);
    await settle(request, outcome);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('retires on Escape and leaves a reopened editor intact', async () => {
    const request = deferred<{ url: string }>();
    mocks.post.mockReturnValueOnce(request.promise);
    const onSaved = vi.fn();
    const onClosed = vi.fn();
    render(<ReopenHarness operation="post" onSaved={onSaved} onClosed={onClosed} />);
    await startOperation('post');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Reopen editor' }));
    await settle(request, 'success');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('retires synchronously on Cancel even before the parent commits its closed prop', async () => {
    const request = deferred<{ url: string }>();
    mocks.post.mockReturnValueOnce(request.promise);
    const onSaved = vi.fn();
    const onClosed = vi.fn();
    render(<BrandToolkitModal isOpen initialData={initialData('post')} onSave={onSaved} onClose={onClosed} />);
    await startOperation('post');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle(request, 'success');
    expect(onClosed).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save Toolkit' })).toHaveAttribute('aria-disabled', 'true');
  });

  it.each(['post', 'put'] as const)('allows the current %s success to notify and close exactly once', async operation => {
    const request = deferred<{ url: string }>();
    mocks[operation].mockReturnValueOnce(request.promise);
    const onSaved = vi.fn();
    const onClosed = vi.fn();
    render(<StrictMode><ReopenHarness operation={operation} onSaved={onSaved} onClosed={onClosed} /></StrictMode>);
    await startOperation(operation);
    await settle(request, 'success');
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('skips the remaining close callback when onSave switches workspace synchronously', async () => {
    const request = deferred<{ url: string }>();
    mocks.post.mockReturnValueOnce(request.promise);
    const onSaved = vi.fn(() => selectBusinessProfile(22));
    const onClosed = vi.fn();
    render(<BrandToolkitModal isOpen initialData={initialData('post')} onSave={onSaved} onClose={onClosed} />);
    await startOperation('post');
    await settle(request, 'success');
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClosed).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it.each(['first then second', 'second then first'])('merges overlapping upload results in %s completion order', async order => {
    const first = deferred<{ url: string }>();
    const second = deferred<{ url: string }>();
    mocks.postForm.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<BrandToolkitModal isOpen initialData={initialData('upload')} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Visual Identity' }));
    await userEvent.upload(screen.getByLabelText('Logo'), new File(['first'], 'first.png', { type: 'image/png' }));
    await userEvent.upload(screen.getByLabelText('Logo'), new File(['second'], 'second.png', { type: 'image/png' }));
    await userEvent.click(screen.getByRole('button', { name: 'Brand Identity' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Brand Values' }), 'Pending during upload');
    const completeFirst = () => first.resolve({ url: '/uploads/first.png' });
    const completeSecond = () => second.resolve({ url: '/uploads/second.png' });
    await act(async () => { if (order === 'first then second') completeFirst(); else completeSecond(); });
    await act(async () => { if (order === 'first then second') completeSecond(); else completeFirst(); });
    expect(screen.getByRole('textbox', { name: 'Brand Values' })).toHaveValue('Pending during upload');
    await userEvent.click(screen.getByRole('button', { name: 'Visual Identity' }));
    const sources = screen.getAllByAltText('Logo').map(image => image.getAttribute('src'));
    expect(sources).toHaveLength(3);
    expect(sources).toEqual(expect.arrayContaining(['/api/uploads/existing.png', '/api/uploads/first.png', '/api/uploads/second.png']));
    expect(mocks.toast).toHaveBeenCalledTimes(2);
  });

  it('does not restore an attachment removed while another upload was pending', async () => {
    const request = deferred<{ url: string }>();
    mocks.postForm.mockReturnValueOnce(request.promise);
    render(<BrandToolkitModal isOpen initialData={initialData('upload')} onClose={vi.fn()} />);
    await startOperation('upload');
    await userEvent.click(screen.getByRole('button', { name: 'Remove logo 1' }));
    await settle(request, 'success');
    expect(screen.getAllByAltText('Logo').map(image => image.getAttribute('src'))).toEqual(['/api/uploads/retired.png']);
  });
});
