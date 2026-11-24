import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageGenerationWidget } from '@/components/widgets/ImageGenerationWidget';
import { VideoGenerationWidget } from '@/components/widgets/VideoGenerationWidget';
import type { WidgetState } from '@/components/widgets/types';

const mocks = vi.hoisted(() => ({ post: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
// jsdom lacks the layout observer used by the unrelated image settings slider.
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); });

describe.each([
  { kind: 'image' as const, component: ImageGenerationWidget },
  { kind: 'video' as const, component: VideoGenerationWidget },
])('Content $kind widget enhancement connectivity', ({ kind, component: Component }) => {
  const fixture = () => {
    let resolve!: (result: unknown) => void;
    let reject!: (reason: unknown) => void;
    mocks.post.mockImplementation(() => new Promise((done, failed) => { resolve = done; reject = failed; }));
    const widget: WidgetState = {
      id: 100, threadId: 42, messageId: null, toolName: `generate_${kind}`, widgetType: `${kind}_generation`,
      formValues: { prompt: 'Original reviewed prompt' }, status: 'active', agentType: 'content_studio', createdAt: '', updatedAt: '',
    };
    const changed = vi.fn();
    const props = { widget, onClose: vi.fn(), onSubmit: vi.fn(), onFormChange: changed };
    const view = render(<Component {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enhance' }));
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/api/content/studio/magic-prompt', { currentPrompt: 'Original reviewed prompt', contentType: kind });
    const field = screen.getByPlaceholderText(`Describe the ${kind} to generate...`);
    return { view, props, field, changed, resolve: (value: unknown) => resolve(value), reject: (value: unknown) => reject(value) };
  };
  const result = { success: true, enhancedPrompt: 'Enhanced older prompt' };
  it('preserves a newer prompt edit when an older response arrives', async () => {
    const { field, changed, resolve } = fixture();
    fireEvent.change(field, { target: { value: 'Newer user edit while request runs' } });
    expect(field).toHaveValue('Newer user edit while request runs');
    await act(async () => { resolve(result); });
    expect(field).toHaveValue('Newer user edit while request runs');
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'Newer user edit while request runs' }));
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Prompt Enhanced' }));
  });
  it('keeps an edited-then-restored prompt rather than applying an obsolete response', async () => {
    const { field, resolve } = fixture();
    fireEvent.change(field, { target: { value: 'Temporary edit' } });
    fireEvent.change(field, { target: { value: 'Original reviewed prompt' } });
    await act(async () => { resolve(result); });
    expect(field).toHaveValue('Original reviewed prompt');
  });
  it('does not apply a prior widget response after the widget identity changes', async () => {
    const { view, props, field, resolve } = fixture();
    view.rerender(<Component {...props} widget={{ ...props.widget, id: 101 }} />);
    await act(async () => { resolve(result); });
    expect(field).toHaveValue('Original reviewed prompt');
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it('ignores completion after unmount', async () => {
    const { view, resolve } = fixture();
    view.unmount();
    await act(async () => { resolve(result); });
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it.each(['account', 'business'])('ignores completion after the selected %s changes even before a rerender', async scope => {
    localStorage.setItem('user', JSON.stringify({ id: 11 }));
    sessionStorage.setItem('active-business-profile:11', '101');
    const { field, resolve } = fixture();
    if (scope === 'account') localStorage.setItem('user', JSON.stringify({ id: 12 }));
    else sessionStorage.setItem('active-business-profile:11', '202');
    await act(async () => { resolve(result); });
    expect(field).toHaveValue('Original reviewed prompt');
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it('preserves existing enhancement behavior for an unchanged prompt', async () => {
    const { field, changed, resolve } = fixture();
    await act(async () => { resolve(result); });
    expect(field).toHaveValue('Enhanced older prompt');
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'Enhanced older prompt' }));
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Prompt Enhanced' }));
  });
  it('preserves the prompt and reports an enhancement failure', async () => {
    const { field, reject } = fixture();
    await act(async () => { reject(new Error('Synthetic failure')); });
    expect(field).toHaveValue('Original reviewed prompt');
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error' }));
  });
});
