import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCreatorPrompt } from '@/hooks/use-creator-prompt';
function Editor() {
  const { prompt, setPrompt, proposeEnhancement, enhancementReview } = useCreatorPrompt('test');
  return <><input aria-label="Prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} /><button onClick={() => proposeEnhancement('Suggested prompt')}>Enhance</button>{enhancementReview}</>;
}
describe('creator prompt review and recovery', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });
  it('does not replace text until Apply and supports Undo', () => {
    render(<Editor />); fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Original' } });
    fireEvent.click(screen.getByText('Enhance')); expect(screen.getByLabelText('Prompt')).toHaveValue('Original');
    fireEvent.click(screen.getByText('Apply')); expect(screen.getByLabelText('Prompt')).toHaveValue('Suggested prompt');
    fireEvent.click(screen.getByText('Undo')); expect(screen.getByLabelText('Prompt')).toHaveValue('Original');
  });
  it('restores unsent prompt on a new mount', () => {
    const first = render(<Editor />); fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Unsent draft' } }); first.unmount();
    render(<Editor />); expect(screen.getByLabelText('Prompt')).toHaveValue('Unsent draft');
  });
  it('clears an enhancement proposal on account switch without erasing the original account prompt', () => {
    localStorage.setItem('user', JSON.stringify({ id: 11 }));
    const view = render(<Editor />);
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Private original' } });
    fireEvent.click(screen.getByText('Enhance'));
    localStorage.setItem('user', JSON.stringify({ id: 12 }));
    view.rerender(<Editor />);
    expect(screen.getByLabelText('Prompt')).toHaveValue('');
    expect(screen.queryByText('Suggested prompt')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('asksales:creator:user-11:business-unselected:test:prompt')).toBe('Private original');
  });
});
