import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrandToolkitModal from '@/components/BrandToolkitModal';
import { selectBusinessProfile } from '@/lib/business-profile';
import { ApiError } from '@/lib/api';

const mocks = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn(), postForm: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({
  default: { post: mocks.post, put: mocks.put, postForm: mocks.postForm },
  ApiError: class extends Error {},
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.setItem('user', JSON.stringify({ id: 4101 }));
  selectBusinessProfile(11);
});
afterEach(cleanup);

const valuesInput = () => screen.getByPlaceholderText('e.g., Innovation, Trust, Quality');
const keywordsInput = () => screen.getByPlaceholderText('e.g., SaaS, AI, Marketing');

describe('Campaign BrandToolkitModal form session', () => {
  it('blocks save until a selected logo upload is attached to the draft', async () => {
    let release!: (value: { url: string }) => void;
    const upload = new Promise<{ url: string }>(resolve => { release = resolve; });
    mocks.postForm.mockReturnValueOnce(upload);
    mocks.post.mockResolvedValueOnce({ id: 83 });
    render(<BrandToolkitModal isOpen onClose={vi.fn()} initialData={{ brandName: 'Upload fixture' }} />);
    try {
      await userEvent.click(screen.getByRole('button', { name: 'Visual Identity' }));
      await userEvent.upload(screen.getByLabelText('Logo'), new File(['fixture'], 'logo.png', { type: 'image/png' }));
      await userEvent.click(screen.getByRole('button', { name: 'Target Audience' }));
      expect(screen.getByRole('button', { name: 'Save Toolkit' })).toHaveAttribute('aria-disabled', 'true');
      expect(mocks.post).not.toHaveBeenCalled();
      await act(async () => release({ url: '/uploads/selected.png' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save Toolkit' }));
      expect(mocks.post).toHaveBeenCalledWith('/api/content/brand-toolkits', expect.objectContaining({ logoUrls: ['/uploads/selected.png'] }));
    } finally { await act(async () => release({ url: '/uploads/selected.png' })); }
  });

  it('reuses the creation receipt after a transport-uncertain save', async () => {
    mocks.post.mockRejectedValueOnce(new ApiError('Lost response'));
    mocks.post.mockResolvedValueOnce({ id: 82 });
    render(<BrandToolkitModal isOpen onClose={vi.fn()} initialData={{ brandName: 'Receipt fixture' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Target Audience' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Toolkit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Toolkit' }));
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[0][1].idempotencyKey).toEqual(expect.any(String));
    expect(mocks.post.mock.calls[1][1].idempotencyKey).toBe(mocks.post.mock.calls[0][1].idempotencyKey);
  });

  it('serializes hashtag and CTA values with the strict API field names', async () => {
    mocks.post.mockResolvedValueOnce({ id: 81 });
    render(<BrandToolkitModal isOpen onClose={vi.fn()} initialData={{ brandName: 'Canonical fixture', hashtags: ['#fixture'], ctas: ['Read the fixture'] }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Target Audience' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Toolkit' }));
    expect(mocks.post).toHaveBeenCalledWith('/api/content/brand-toolkits', expect.objectContaining({
      name: 'Canonical fixture', defaultHashtags: ['#fixture'], defaultCtas: ['Read the fixture'],
    }));
    expect(mocks.post.mock.calls[0][1]).not.toHaveProperty('hashtags');
    expect(mocks.post.mock.calls[0][1]).not.toHaveProperty('ctas');
  });

  it('preserves pending Brand Values while unrelated fields and the parent rerender', async () => {
    const props = { isOpen: true, onClose: vi.fn() };
    const { rerender } = render(<BrandToolkitModal {...props} />);
    const input = valuesInput();
    await userEvent.type(input, 'Uncommitted trust');
    await userEvent.type(screen.getByPlaceholderText('e.g., Acme Inc.'), 'Synthetic Studio');
    expect(valuesInput()).toBe(input);
    expect(input).toHaveValue('Uncommitted trust');
    await userEvent.type(screen.getByPlaceholderText('A brief description of your brand...'), 'Description edit');
    await userEvent.click(input);
    rerender(<BrandToolkitModal {...props} onSave={vi.fn()} />);
    expect(valuesInput()).toBe(input);
    expect(input).toHaveValue('Uncommitted trust');
    expect(input).toHaveFocus();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('preserves pending Brand Values when another tag is added or removed', async () => {
    render(<BrandToolkitModal isOpen onClose={vi.fn()} />);
    await userEvent.type(valuesInput(), 'Pending value');
    await userEvent.type(keywordsInput(), '  SaaS  ');
    await userEvent.keyboard('{Enter}');
    expect(valuesInput()).toHaveValue('Pending value');
    expect(keywordsInput()).toHaveValue('');
    expect(keywordsInput()).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Remove SaaS from Brand Keywords' }));
    expect(valuesInput()).toHaveValue('Pending value');
    expect(keywordsInput()).toHaveFocus();
  });

  it('keeps independent pending text when navigating all five steps', async () => {
    render(<BrandToolkitModal isOpen onClose={vi.fn()} />);
    const steps = [
      ['Brand Identity', 'Brand Values'],
      ['Voice & Tone', 'Personality Traits'],
      ['Content Style', 'Content Pillars'],
      ['Target Audience', 'Pain Points'],
    ];
    for (const [step, label] of steps) {
      await userEvent.click(screen.getByRole('button', { name: step }));
      await userEvent.type(screen.getByRole('textbox', { name: label }), `Pending ${label}`);
    }
    await userEvent.click(screen.getByRole('button', { name: 'Visual Identity' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Primary Colors' }));
    for (const [step, label] of steps) {
      await userEvent.click(screen.getByRole('button', { name: step }));
      expect(screen.getByRole('textbox', { name: label })).toHaveValue(`Pending ${label}`);
    }
  });

  it('adds and removes tags with Enter and Space without committing blanks or composition text', async () => {
    render(<BrandToolkitModal isOpen onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Brand Values' });
    await userEvent.type(input, '   ');
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('button', { name: /Remove .* from Brand Values/ })).not.toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, '  Trust  ');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(input).toHaveValue('  Trust  ');
    await userEvent.keyboard('{Enter}');
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    await userEvent.type(input, 'Quality');
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Add Brand Values' })).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Remove Quality from Brand Values' })).toBeInTheDocument();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Remove Trust from Brand Values' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(input).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Remove Trust from Brand Values' })).not.toBeInTheDocument();
  });

  it('preserves color picker identity and focus across unrelated updates and supports keyboard removal', async () => {
    const props = { isOpen: true, onClose: vi.fn() };
    const { rerender } = render(<BrandToolkitModal {...props} />);
    await userEvent.click(screen.getByRole('button', { name: 'Visual Identity' }));
    const picker = screen.getByLabelText('Primary Colors 1 color picker');
    fireEvent.change(picker, { target: { value: '#112233' } });
    await userEvent.type(screen.getByRole('textbox', { name: 'Image Style Reference' }), 'Minimalist');
    await userEvent.click(picker);
    rerender(<BrandToolkitModal {...props} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Primary Colors 1 color picker')).toBe(picker);
    expect(picker).toHaveValue('#112233');
    expect(picker).toHaveFocus();
    const add = screen.getByRole('button', { name: 'Add Primary Colors' });
    await userEvent.click(add);
    await userEvent.keyboard('{Enter}');
    expect(screen.getByLabelText('Primary Colors 3 color picker')).toHaveValue('#000000');
    await userEvent.click(screen.getByRole('button', { name: 'Remove Primary Colors color 2 (#000000)' }));
    expect(add).toHaveFocus();
    expect(screen.queryByLabelText('Primary Colors 3 color picker')).not.toBeInTheDocument();
    expect(picker).toHaveValue('#112233');
  });

  it('retains edits for the same record and resets on a different record', async () => {
    const props = { isOpen: true, onClose: vi.fn() };
    const initialData = { id: 71, brandName: 'Record A', brandValues: ['Saved A'] };
    const { rerender } = render(<BrandToolkitModal {...props} initialData={initialData} />);
    await userEvent.type(valuesInput(), 'Draft A');
    await userEvent.clear(screen.getByRole('textbox', { name: /Brand Name/ }));
    await userEvent.type(screen.getByRole('textbox', { name: /Brand Name/ }), 'Edited A');
    rerender(<BrandToolkitModal {...props} initialData={{ ...initialData }} />);
    expect(valuesInput()).toHaveValue('Draft A');
    expect(screen.getByRole('textbox', { name: /Brand Name/ })).toHaveValue('Edited A');
    rerender(<BrandToolkitModal {...props} initialData={{ id: 72, brandName: 'Record B', brandValues: ['Saved B'] }} />);
    expect(valuesInput()).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /Brand Name/ })).toHaveValue('Record B');
    expect(screen.queryByRole('button', { name: 'Remove Saved A from Brand Values' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Saved B from Brand Values' })).toBeInTheDocument();
  });

  it('resets pending and committed values, colors and step on repeated close/reopen', async () => {
    const props = { onClose: vi.fn() };
    const { rerender } = render(<BrandToolkitModal {...props} isOpen />);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(valuesInput()).toHaveValue('');
      expect(screen.getByRole('textbox', { name: /Brand Name/ })).toHaveValue('');
      await userEvent.type(valuesInput(), 'Committed{Enter}Pending');
      await userEvent.type(screen.getByRole('textbox', { name: /Brand Name/ }), 'Unsaved Studio');
      await userEvent.click(screen.getByRole('button', { name: 'Visual Identity' }));
      await userEvent.click(screen.getByRole('button', { name: 'Add Primary Colors' }));
      rerender(<BrandToolkitModal {...props} isOpen={false} />);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      rerender(<BrandToolkitModal {...props} isOpen />);
      expect(screen.queryByRole('button', { name: 'Remove Committed from Brand Values' })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Visual Identity' }));
      expect(screen.queryByLabelText('Primary Colors 2 color picker')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Primary Colors 1 color picker')).toHaveValue('#3b82f6');
      await userEvent.click(screen.getByRole('button', { name: 'Brand Identity' }));
    }
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.postForm).not.toHaveBeenCalled();
  });

  it('preserves same-workspace events and starts a clean create form when the workspace changes', async () => {
    render(<BrandToolkitModal isOpen onClose={vi.fn()} />);
    await userEvent.type(valuesInput(), 'Trust{Enter}Pending A');
    await userEvent.type(screen.getByRole('textbox', { name: /Brand Name/ }), 'Workspace A');
    act(() => selectBusinessProfile(11));
    expect(valuesInput()).toHaveValue('Pending A');
    act(() => selectBusinessProfile(22));
    expect(valuesInput()).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /Brand Name/ })).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Remove Trust from Brand Values' })).not.toBeInTheDocument();
  });

  it('returns to the required name error without losing pending tags on any step or sending a request', async () => {
    render(<BrandToolkitModal isOpen onClose={vi.fn()} />);
    await userEvent.type(valuesInput(), 'Pending brand value');
    await userEvent.click(screen.getByRole('button', { name: 'Target Audience' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Pain Points' }), 'Pending pain point');
    await userEvent.click(screen.getByRole('button', { name: 'Save Toolkit' }));
    const name = screen.getByRole('textbox', { name: /Brand Name/ });
    expect(name).toBeRequired();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('Please enter a brand name.');
    expect(name).toHaveFocus();
    expect(valuesInput()).toHaveValue('Pending brand value');
    await userEvent.type(name, 'Synthetic Studio');
    expect(name).not.toHaveAttribute('aria-invalid', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Target Audience' }));
    expect(screen.getByRole('textbox', { name: 'Pain Points' })).toHaveValue('Pending pain point');
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('preserves drafts through a mocked rejected save and sends only committed arrays', async () => {
    mocks.put.mockRejectedValueOnce(new ApiError('Synthetic validation failure'));
    const onClose = vi.fn();
    render(<BrandToolkitModal isOpen onClose={onClose} initialData={{ id: 71, brandName: 'Synthetic Studio' }} />);
    await userEvent.type(valuesInput(), 'Trust{Enter}Still pending');
    await userEvent.click(screen.getByRole('button', { name: 'Target Audience' }));
    const input = screen.getByRole('textbox', { name: 'Pain Points' });
    await userEvent.type(input, 'Uncommitted audience text');
    await userEvent.click(screen.getByRole('button', { name: 'Save Toolkit' }));
    expect(mocks.put).toHaveBeenCalledWith('/api/content/brand-toolkits/71', expect.objectContaining({
      brandName: 'Synthetic Studio', name: 'Synthetic Studio', brandValues: ['Trust'],
    }));
    expect(mocks.put.mock.calls[0][1]).not.toHaveProperty('tagDrafts');
    expect(input).toHaveValue('Uncommitted audience text');
    expect(screen.getByRole('button', { name: 'Save Toolkit' })).toBeEnabled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'Synthetic validation failure' }));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Brand Identity' }));
    expect(valuesInput()).toHaveValue('Still pending');
  });

  it('links every visible field label and names every button on all five steps', async () => {
    render(<BrandToolkitModal isOpen onClose={vi.fn()} />);
    for (const step of ['Brand Identity', 'Visual Identity', 'Voice & Tone', 'Content Style', 'Target Audience']) {
      await userEvent.click(screen.getByRole('button', { name: step }));
      for (const label of document.querySelectorAll('label')) {
        expect(label.htmlFor).not.toBe('');
        expect(document.getElementById(label.htmlFor)).not.toBeNull();
      }
      for (const button of screen.getAllByRole('button')) expect(button).toHaveAccessibleName();
      for (const field of screen.queryAllByRole('textbox')) expect(field).toHaveAccessibleName();
      const ids = Array.from(document.querySelectorAll('[id]'), node => node.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
