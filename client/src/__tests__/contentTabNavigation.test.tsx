import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContentTabBar from '@/components/content-library/ContentTabBar';
import { tabConfig } from '@/components/content-library/types';

afterEach(cleanup);

describe('content type navigation', () => {
  it('keeps all ten content categories selectable with one active type', () => {
    const onTabChange = vi.fn();
    render(<ContentTabBar activeTab="ad_copy" onTabChange={onTabChange} contentCounts={{ ad_copy: 3 }} />);
    expect(screen.getAllByRole('button')).toHaveLength(tabConfig.length);
    expect(screen.getByRole('button', { pressed: true })).toHaveTextContent('Ad Copy');
    for (const tab of tabConfig) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(tab.label) }));
      expect(onTabChange).toHaveBeenLastCalledWith(tab.id);
    }
  });

  it('distinguishes known zero counts from counts that have not loaded', () => {
    render(<ContentTabBar activeTab="all" onTabChange={vi.fn()} contentCounts={{ image: 0 }} />);
    expect(screen.getByRole('button', { name: /Images/ })).toHaveTextContent('0');
    expect(screen.getByRole('button', { name: /Videos/ })).toHaveTextContent(/^Videos$/);
  });
});
