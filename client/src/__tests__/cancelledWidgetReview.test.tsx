import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InlineWidgetCard } from '@/components/widgets/InlineWidgetCard';
import type { WidgetState } from '@/components/widgets/types';

const submit = vi.fn();
vi.mock('@/components/widgets/WidgetContext', () => ({ useWidgets: () => ({ submitWidget: submit, updateFormValues: vi.fn(), closeWidget: vi.fn() }) }));
vi.mock('@/components/widgets/registry', () => ({ widgetRegistry: Object.fromEntries(
  ['social_post', 'email_template', 'publish_post', 'publish_ads', 'send_outreach', 'lead_gen_config'].map(type => [type, {
    title: type, description: 'Review settings', component: () => <label>Settings<input defaultValue="Saved settings" /></label>,
  }]),
) }));

describe('cancelled review surfaces across specialist widgets', () => {
  it.each(['social_post', 'email_template', 'publish_post', 'publish_ads', 'send_outreach', 'lead_gen_config'])(
    '%s shows an inspectable cancelled receipt without any runnable controls', async widgetType => {
      const widget = { id: 42, widgetType, toolName: 'review', status: 'cancelled', formValues: {} } as WidgetState;
      render(<InlineWidgetCard widget={widget} />);
      expect(screen.getByText('Cancelled')).toBeInTheDocument();
      expect(screen.queryByText('Needs review')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Cancelled/ }));
      await waitFor(() => expect(screen.getByRole('textbox')).toBeDisabled());
      expect(screen.getByText('Cancelled before execution. This review is read-only and cannot run.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Confirm and run|Save draft|Retry safely/ })).not.toBeInTheDocument();
      expect(submit).not.toHaveBeenCalled();
    },
  );
});
