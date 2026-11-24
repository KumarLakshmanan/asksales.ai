import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import Home from '@/app/admin/dashboard/home/page';
import Credit from '@/app/admin/dashboard/credit-analytics/page';

const state = vi.hoisted(() => ({ get: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ api: { get: state.get } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/contexts/AdminAuthContext', () => ({ useAdminAuth: () => ({ admin: { role: 'super_admin' } }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));

beforeEach(() => { state.get.mockReset(); state.toast.mockReset(); });
afterEach(cleanup);
const card = (label: string) => screen.getByText(label, { exact: true }).closest('.shadcn-card') as HTMLElement;

it('control: a complete successful zero-count home response is still measured zero', async () => {
  state.get.mockResolvedValue({ totalUsers: 0, totalAdmins: 0, totalLeads: 0, totalCampaigns: 0, systemHealth: 'Healthy' });
  render(<Home />);
  await screen.findByText('Administration overview');
  expect(within(card('Total Users')).getByText('0')).toBeVisible();
  expect(within(card('System Health')).getByText('Healthy')).toBeVisible();
});

it('ADM-02 regression: a malformed successful home response must not invent healthy status', async () => {
  state.get.mockResolvedValue({});
  render(<Home />);
  await screen.findByText('Administration overview');
  expect(within(card('System Health')).getByText('Unavailable')).toBeVisible();
  expect(within(card('Total Users')).getByText('Unavailable')).toBeVisible();
});

it('ADM-16 regression: failed daily credit data must not claim no recorded activity', async () => {
  state.get.mockImplementation(async (url: string) => {
    if (url.includes('/summary') || url.includes('/daily')) throw new Error('Synthetic reporting read failed');
    return [];
  });
  render(<Credit />);
  await screen.findByText('Some credit analytics are unavailable');
  expect(screen.queryByText('No credit activity in this period')).not.toBeInTheDocument();
  expect(within(card('Total Credits Used')).getByText('Unavailable')).toBeVisible();
  expect(screen.getByText('Daily credit activity is unavailable.')).toBeVisible();
});

it('control: four failed credit requests show the existing full error view', async () => {
  state.get.mockRejectedValue(new Error('Synthetic reporting read failed'));
  render(<Credit />);
  await screen.findByText('Credit analytics could not be loaded');
  expect(screen.queryByText('Total Credits Used')).not.toBeInTheDocument();
});

it('preserves known zero credit totals and a successful empty daily result', async () => {
  state.get.mockImplementation(async (url: string) => url.includes('/summary')
    ? { summary: [], totals: { totalCredits: 0, totalEvents: 0, totalApiCostINR: 0 } } : []);
  render(<Credit />);
  await screen.findByText('No credit activity in this period');
  expect(within(card('Total Credits Used')).getByText('0')).toBeVisible();
});

it('hides formerly successful credit values when a refresh loses summary and daily availability', async () => {
  state.get.mockImplementation(async (url: string) => url.includes('/summary')
    ? { summary: [], totals: { totalCredits: 17, totalEvents: 4, totalApiCostINR: 2 } } : []);
  render(<Credit />);
  await screen.findByText('17');
  state.get.mockImplementation(async (url: string) => {
    if (url.includes('/summary') || url.includes('/daily')) throw new Error('Synthetic refresh failure');
    return [];
  });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('Some credit analytics are unavailable');
  expect(within(card('Total Credits Used')).getByText('Unavailable')).toBeVisible();
  expect(screen.queryByText('17')).not.toBeInTheDocument();
  expect(screen.queryByText('No credit activity in this period')).not.toBeInTheDocument();
});

it('keeps successful zero summary data while failed provider and user sections stay unavailable', async () => {
  state.get.mockImplementation(async (url: string) => {
    if (url.includes('/top-users') || url.includes('/providers')) throw new Error('Synthetic read failure');
    return url.includes('/summary') ? { summary: [], totals: { totalCredits: 0, totalEvents: 0, totalApiCostINR: 0 } } : [];
  });
  render(<Credit />);
  await screen.findByText('Some credit analytics are unavailable');
  expect(within(card('Total Credits Used')).getByText('0')).toBeVisible();
  expect(screen.queryByText('No spending data yet')).not.toBeInTheDocument();
  expect(screen.queryByText('No provider data yet')).not.toBeInTheDocument();
  expect(screen.getAllByText('Provider usage is unavailable.')).toHaveLength(2);
  expect(screen.getByText('Top credit consumers are unavailable.')).toBeVisible();
});
