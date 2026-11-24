import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, back() {} }) }));
vi.mock('@/contexts/AdminAuthContext', () => ({ useAdminAuth: () => ({ admin: { role: 'super_admin' } }) }));
import Page from '@/app/admin/dashboard/settings/page';
afterEach(cleanup);
it('names operations navigation controls by destination', () => {
  render(<Page />);
  screen.getByRole('button', { name: 'Open System Logs settings' }).click();
  expect(push).toHaveBeenCalledWith('/admin/dashboard/system-logs');
  expect(screen.getByRole('button', { name: 'Open Queue Operations settings' })).toBeVisible();
});
