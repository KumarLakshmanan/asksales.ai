import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdGenerationWidget } from '@/components/widgets/AdGenerationWidget';
import type { WidgetState } from '@/components/widgets/types';

describe('ad variation review widget', () => {
  afterEach(cleanup);
  it('submits the current server revision count after revising the same card', async () => {
    const submitted = vi.fn();
    let values: Record<string, unknown> = {};
    const widget: WidgetState = {
      id: 12, threadId: 25, messageId: 12, toolName: 'generate_ad', widgetType: 'ad_generation',
      formValues: { platform: 'google', number_of_variations: 3 }, status: 'active',
      createdAt: '', updatedAt: '', agentType: 'performance_marketing',
    };
    const onFormChange = (next: Record<string, unknown>) => { values = next; };
    const card = (current: WidgetState) => <><AdGenerationWidget widget={current} onClose={vi.fn()} onSubmit={submitted} onFormChange={onFormChange} />
      <button onClick={() => submitted(values)}>Confirm and run</button></>;
    const view = render(card(widget));
    fireEvent.click(view.getByText('Confirm and run'));
    expect(submitted).toHaveBeenLastCalledWith(expect.objectContaining({ number_of_variations: 3 }));
    view.rerender(card({ ...widget, formValues: { ...widget.formValues, number_of_variations: 2 } }));
    expect(view.getByLabelText('Ad-copy variations (1–5)')).toHaveValue(2);
    fireEvent.click(view.getByText('Confirm and run'));
    expect(submitted).toHaveBeenLastCalledWith(expect.objectContaining({ number_of_variations: 2 }));
  });
  it('shows and preserves the requested copy variation count independently of media counts', async () => {
    const onFormChange = vi.fn();
    const widget: WidgetState = {
      id: 12, threadId: 25, messageId: 12, toolName: 'generate_ad', widgetType: 'ad_generation',
      formValues: { platform: 'google', number_of_variations: 3, image_count: 1 },
      status: 'active', agentType: 'performance_marketing',
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    const view = render(<AdGenerationWidget widget={widget} onClose={vi.fn()} onSubmit={vi.fn()} onFormChange={onFormChange} />);
    expect(view.getByLabelText('Ad-copy variations (1–5)')).toHaveValue(3);
    await waitFor(() => expect(onFormChange).toHaveBeenCalled());
    expect(onFormChange.mock.calls.at(-1)?.[0]).toMatchObject({ number_of_variations: 3, image_count: 1 });
  });
});
