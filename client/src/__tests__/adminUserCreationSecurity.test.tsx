import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CreateUserPage from '@/app/admin/dashboard/users/new/page';
import { PASSWORD_POLICY_MESSAGE } from '@/lib/password-policy';
const mocks = vi.hoisted(() => ({ post: vi.fn(), push: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ api: { post: mocks.post } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
afterEach(cleanup); beforeEach(() => vi.clearAllMocks());
function fill(password: string) {
  render(<CreateUserPage />);
  fireEvent.change(screen.getByLabelText('Name *'), { target: { name: 'name', value: 'Synthetic Local' } });
  fireEvent.change(screen.getByLabelText('Email *'), { target: { name: 'email', value: 'fixture@example.invalid' } });
  fireEvent.change(screen.getByLabelText('Password *'), { target: { name: 'password', value: password } });
}
describe('admin user creation password policy', () => {
  it.each(['NoSpecial123', 'x', 'a'.repeat(129)])('blocks a password outside the shared policy: %s', password => {
    fill(password); fireEvent.click(screen.getByRole('button', { name: 'Create User' }));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: PASSWORD_POLICY_MESSAGE }));
  });
  it('submits a valid initial password and navigates after the server accepts the account', async () => {
    mocks.post.mockResolvedValue({ user: { id: 11, name: 'Synthetic Local', email: 'fixture@example.invalid' } });
    fill('SyntheticValid123!'); fireEvent.click(screen.getByRole('button', { name: 'Create User' }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/admin/dashboard/users'));
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/users', expect.objectContaining({ password: 'SyntheticValid123!' }));
  });
});
