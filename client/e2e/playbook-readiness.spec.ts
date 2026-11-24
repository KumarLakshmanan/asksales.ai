import { expect, installAppShellMocks, test } from './fixtures/app';
import { proposalGraphFixture } from '../src/__tests__/fixtures/playbook';

test('AS009: current draft readiness agrees with flow issues across sections and playbooks', async ({ page, audit }, testInfo) => {
  // Every API request is intercepted, including unanticipated reads or writes.
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await installAppShellMocks(page);
  const validGraph = proposalGraphFixture();
  const invalidGraph = structuredClone(validGraph);
  invalidGraph.nodes.find(node => node.id === 'record-changes')!.data!.capabilityName = 'unregistered.capability';
  const items = [
    { id: 21, name: 'Proposal changes — missing capability', draftGraph: invalidGraph },
    { id: 20, name: 'Proposal changes — registered capability', draftGraph: validGraph },
  ].map(item => ({ ...item, description: null, status: 'published', enabled: true, activeVersion: 1, assignments: [], templateMode: 'custom' }));
  await page.route('**/api/support/ai/playbooks', route => route.fulfill({ json: items }));
  await page.route('**/api/settings/ai-agents', route => route.fulfill({ json: [{ agentType: 'hotel_sales', displayName: 'Hotel Sales Agent', enabled: true }] }));
  await page.route('**/api/support/ai/playbook-templates', route => route.fulfill({ json: [] }));
  await page.route('**/api/auth/csrf-token', route => route.fulfill({ json: { csrfToken: 'synthetic-only' } }));
  let checks = 0;
  let holdChecks = false;
  let releaseCheck: (() => void) | undefined;
  const writes: string[] = [];
  await page.route('**/api/support/ai/playbooks/**', async route => {
    if (!route.request().url().endsWith('/validate')) {
      writes.push(route.request().method());
      await route.fulfill({ status: 409, json: { error: 'No writes allowed in readiness regression.' } });
      return;
    }
    checks++;
    if (holdChecks) await new Promise<void>(resolve => { releaseCheck = resolve; });
    // Deliberately simulate a stale/scope-limited server pass. Local issues
    // must still prevent an unqualified all-clear.
    await route.fulfill({ json: { valid: true, errors: [], warnings: [] } });
  });

  await page.goto('/dashboard/settings/outreach/playbooks');
  const status = page.getByRole('status').filter({ hasText: 'Draft' });
  const publish = page.getByRole('button', { name: 'Publish changes', exact: true });
  await expect(status).toContainText('Draft saved · Needs attention');
  await expect(page.getByText('Record changes requires a registered capability.', { exact: true })).toHaveCount(2);
  await expect(publish).toBeDisabled();
  for (const section of ['Graph', 'Questions', 'Channels', 'Settings', 'Conversation']) {
    await page.getByRole('button', { name: section, exact: true }).click();
    await expect(status).toContainText('Needs attention');
    await expect(status).not.toContainText('Checks passed');
  }
  await page.screenshot({ path: testInfo.outputPath('AS009-needs-attention.png'), fullPage: true });

  holdChecks = true;
  await page.getByRole('navigation', { name: 'Playbook selection' }).getByRole('button', { name: /registered capability/ }).click();
  await expect(status).toContainText('Checking flow');
  await expect(publish).toBeDisabled();
  await expect.poll(() => checks).toBe(2);
  holdChecks = false;
  releaseCheck!();
  await expect(status).toContainText('Draft saved · Checks passed');
  await expect(publish).toBeEnabled();
  await expect(page.getByText('Record changes requires a registered capability.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Playbook name').fill('Synthetic changed name');
  await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toContainText('Unsaved changes · Checks passed');
  await page.screenshot({ path: testInfo.outputPath('AS009-dirty-valid.png'), fullPage: true });
  expect(writes).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
});
