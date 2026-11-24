import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import Llm from '@/app/admin/dashboard/usage/llms/page';
import Provider0 from '@/app/admin/dashboard/usage/openai/page';
import Provider1 from '@/app/admin/dashboard/usage/openrouter/page';
import Provider2 from '@/app/admin/dashboard/usage/gemini/page';
import Provider3 from '@/app/admin/dashboard/usage/gemini-image/page';
import Provider4 from '@/app/admin/dashboard/usage/gemini-video/page';

const state = vi.hoisted(() => ({ get: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ api: { get: state.get } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/contexts/AdminAuthContext', () => ({ useAdminAuth: () => ({ admin: { role: 'super_admin' } }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));

beforeEach(() => { state.get.mockReset(); state.toast.mockReset(); });
afterEach(cleanup);
// Summary tiles are StatCards (<article>); other panels are shadcn Cards.
const card = (label: string) => screen.getByText(label, { exact: true }).closest('article, .shadcn-card') as HTMLElement;

it('ADM-15 regression: all-provider latency must include the measured Gemini population', async () => {
  state.get.mockImplementation(async (url: string) => ({ summary: url.includes('/gemini')
    ? { totalCalls: 3, totalTokens: 30, totalCost: 0.3, avgLatency: 300, measuredDurationCount: 3, totalDurationMs: 900 }
    : { totalCalls: 1, totalTokens: 10, totalCost: 0.1, avgLatency: 100, measuredDurationCount: 1, totalDurationMs: 100 } }));
  render(<Llm />);
  await screen.findByText('Avg Latency');
  expect(within(card('Total Calls')).getByText('4')).toBeVisible();
  expect(within(card('Avg Latency')).getByText('250ms')).toBeVisible();
});

it('control: one rejected LLM source already has an explicit incomplete-total warning', async () => {
  state.get.mockImplementation(async (url: string) => {
    if (url.includes('/gemini')) throw new Error('Synthetic Gemini read failed');
    return { summary: { totalCalls: 1, totalTokens: 10, totalCost: 0.1, avgLatency: 100, measuredDurationCount: 1, totalDurationMs: 100 } };
  });
  render(<Llm />);
  await screen.findByText('Some provider data is unavailable');
  expect(screen.getByText(/not a complete total/)).toBeVisible();
});

it('does not infer duration coverage from a legacy average or total call count', async () => {
  state.get.mockResolvedValue({ summary: { totalCalls: 3, totalTokens: null, totalCost: null, avgLatency: 100 } });
  render(<Llm />);
  await screen.findByText('Avg Latency');
  expect(within(card('Avg Latency')).getByText('Unavailable')).toBeVisible();
  expect(within(card('Total Tokens')).getByText('Unavailable')).toBeVisible();
  expect(within(card('Total Cost')).getByText('Unavailable')).toBeVisible();
});

it('combines measured zero durations and excludes unmeasured Gemini requests', async () => {
  state.get.mockImplementation(async (url: string) => ({ summary: url.includes('/gemini')
    ? { totalCalls: 3, totalTokens: 0, totalCost: 0, avgLatency: null, measuredDurationCount: 0, totalDurationMs: 0 }
    : { totalCalls: 2, totalTokens: 0, totalCost: 0, avgLatency: 100, measuredDurationCount: 2, totalDurationMs: 200 } }));
  render(<Llm />);
  await screen.findByText('Avg Latency');
  expect(within(card('Avg Latency')).getByText('100ms')).toBeVisible();
  expect(screen.getByText('2 of 5 calls have measured duration')).toBeVisible();
  expect(within(card('Total Cost')).getByText('$0.00')).toBeVisible();
});

it.each([Provider0, Provider1, Provider2, Provider3, Provider4])('renders missing measurements safely on individual provider pages', async Page => {
  state.get.mockResolvedValue({ summary: { totalCalls: 1, totalRequests: 1, totalTokens: null, totalCost: null, totalCostCents: null, avgLatency: null, totalImages: 0, totalVideos: 0, successRate: 100 }, breakdown: [{ model: 'fixture-model', calls: 1, tokens: null, cost: null }] });
  render(<Page />);
  await screen.findByText('Total Cost');
  expect(within(card('Total Cost')).getByText('Unavailable')).toBeVisible();
  expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(1);
});
