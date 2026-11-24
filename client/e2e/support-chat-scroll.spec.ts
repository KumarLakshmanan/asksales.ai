import { expect, test } from './fixtures/app';

// Browser geometry, not jsdom scrollTop stubs: catches focus/scrollIntoView
// moving overflow-hidden ancestors while the inner viewport keeps its height.
test('multi-turn chat keeps the viewport visible after evidence expansion and composer focus', async ({ page }) => {
  await page.route('**/api/auth/csrf-token', route => route.fulfill({ json: { csrfToken: 'test-only' } }));
  await page.route('**/api/support/ai/sessions**', route => route.fulfill({ json: { data: [], total: 0 } }));
  let id = 1;
  await page.route('**/api/support/ai/chat', async route => {
    const { message, channel } = route.request().postDataJSON();
    const content = Array.from({ length: 12 }, (_, i) => `Published fact ${i + 1}: this is a complete test sentence.`).join('\n\n');
    await route.fulfill({ json: {
      sessionId: 99001,
      userMessage: { id: id++, sessionId: 99001, role: 'user', content: message, createdAt: new Date().toISOString(), metadata: { channel } },
      assistantMessage: { id: id++, sessionId: 99001, role: 'assistant', content, createdAt: new Date().toISOString(), metadata: { channel }, confidence: 0.99 },
      response: { answer: content, sources: [{ title: 'Synthetic published guide', excerpt: content.repeat(4), similarity: 0.99 }] },
    } });
  });
  await page.goto('/dashboard/support-ai/chat');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  // Mobile history defaults open; use the visible new-chat control if needed.
  if (!await composer.isVisible()) await page.getByRole('button', { name: 'New', exact: true }).click();
  const viewport = page.getByRole('region', { name: 'Support messages', exact: true });
  for (let turn = 0; turn < 6; turn++) {
    await composer.fill(`Synthetic regression turn ${turn}`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(viewport.getByRole('listitem')).toHaveCount((turn + 1) * 2);
    await expect(composer).toBeEnabled();
    await page.getByRole('button', { name: /1 knowledge source/ }).last().click();
    await composer.focus();
    await expect.poll(() => viewport.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const parent = el.parentElement!;
      return rect.top >= parent.getBoundingClientRect().top - 1
        && rect.height > 150 && parent.scrollTop === 0;
    })).toBe(true);
    await expect(composer).toBeInViewport();
  }
});
