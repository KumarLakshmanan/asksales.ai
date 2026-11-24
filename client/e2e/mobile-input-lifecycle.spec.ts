import { test, expect, expectNoHorizontalOverflow } from './fixtures/mobile-input';

const home = '/dashboard/home';
const conversation = '/dashboard/conversations/42';
const briefLabel = 'What should the team accomplish?';

test('authenticated mobile brief keeps keyboard controls usable after viewport changes', async ({ page }, info) => {
  await page.goto(home);
  const brief = page.getByRole('textbox', { name: briefLabel });
  await expect(brief).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('user')!).email)).toBe('regression-alpha@example.test');
  await brief.fill('Prepare a synthetic local draft');
  await brief.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Start voice input' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Plan this work' })).toBeFocused();
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await brief.scrollIntoViewIfNeeded();
  await expect(brief).toBeInViewport();
  await expect(brief).toHaveValue('Prepare a synthetic local draft');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('authenticated-mobile-brief.png') });
});

test('Home IME Enter and keyCode 229 keep the draft; committed Enter submits once', async ({ page, inputRuntime }) => {
  await page.goto(home);
  const brief = page.getByRole('textbox', { name: briefLabel });
  const text = 'தமிழில் வாடிக்கையாளர் தகவல்';
  await brief.fill(text);
  await brief.dispatchEvent('compositionstart', { data: '' });
  await brief.dispatchEvent('compositionupdate', { data: text });
  await brief.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await brief.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  await expect(brief).toHaveValue(text);
  await expect(page).toHaveURL(/\/dashboard\/home$/);
  expect(inputRuntime.threadCreates).toEqual([]);
  await brief.dispatchEvent('compositionend', { data: text });
  await brief.press('Shift+Enter');
  await expect(brief).toHaveValue(text + '\n');
  expect(inputRuntime.threadCreates).toEqual([]);
  await brief.press('Enter');
  await expect(page.getByText('Conversation could not be started', { exact: true })).toBeVisible();
  expect(inputRuntime.threadCreates).toEqual([{ title: text, businessProfileId: 4102 }]);
  await expect(brief).toHaveValue(text + '\n');
});

for (const api of ['standard', 'webkit'] as const) {
  test(`Home ${api} voice appends a final transcript without submitting`, async ({ page, inputRuntime }) => {
    await page.goto(home);
    if (api === 'webkit') await inputRuntime.speech({ action: 'webkit' });
    const brief = page.getByRole('textbox', { name: briefLabel });
    await brief.fill('Existing draft');
    await page.getByRole('button', { name: 'Start voice input' }).click();
    await expect(page.getByRole('button', { name: 'Stop voice input' })).toHaveAttribute('aria-pressed', 'true');
    await inputRuntime.speech({ action: 'result', parts: [{ text: 'Hello Hello customer', final: true }] });
    await expect(brief).toHaveValue('Existing draft Hello customer');
    await expect(page.getByRole('button', { name: 'Start voice input' })).toHaveAttribute('aria-pressed', 'false');
    expect((await inputRuntime.snapshot()).recognition).toEqual([
      { starts: 1, aborts: 1, stops: 0, lang: 'en-US', continuous: false, interimResults: false },
    ]);
    expect(inputRuntime.threadCreates).toEqual([]);
  });
}

test('Home stop ignores late callbacks from a prior voice session during a new one', async ({ page, inputRuntime }) => {
  await page.goto(home);
  const brief = page.getByRole('textbox', { name: briefLabel });
  await brief.fill('Preserve this draft');
  await page.getByRole('button', { name: 'Start voice input' }).click();
  await page.getByRole('button', { name: 'Stop voice input' }).click();
  await page.getByRole('button', { name: 'Start voice input' }).click();
  for (const action of ['start', 'result', 'error', 'end'] as const) {
    await inputRuntime.speech({ action, instance: 0, parts: [{ text: 'Stale transcript', final: true }], error: 'not-allowed' });
  }
  await expect(brief).toHaveValue('Preserve this draft');
  await expect(page.getByRole('button', { name: 'Stop voice input' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Voice Error', { exact: true })).toHaveCount(0);
  await inputRuntime.speech({ action: 'result', instance: 1, parts: [{ text: 'Current transcript', final: true }] });
  await expect(brief).toHaveValue('Preserve this draft Current transcript');
});

test('Home start failure, asynchronous error, and unsupported browser preserve editable drafts', async ({ page, inputRuntime }) => {
  await page.goto(home);
  const brief = page.getByRole('textbox', { name: briefLabel });
  await brief.fill('Recoverable draft');
  await inputRuntime.speech({ action: 'fail-next-start' });
  await page.getByRole('button', { name: 'Start voice input' }).click();
  await expect(page.getByText('Voice input could not start. Please check microphone permissions and try again.')).toBeVisible();
  await expect(brief).toBeEditable();
  await page.getByRole('button', { name: 'Start voice input' }).click();
  await inputRuntime.speech({ action: 'error', error: 'not-allowed' });
  await expect(page.getByText('Failed to recognize speech. Please try again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start voice input' })).toHaveAttribute('aria-pressed', 'false');
  await inputRuntime.speech({ action: 'unsupported' });
  await page.getByRole('button', { name: 'Start voice input' }).click();
  await expect(page.getByText('Voice recognition is not supported in this browser. Please use Chrome or Edge.')).toBeVisible();
  await expect(brief).toHaveValue('Recoverable draft');
  expect(inputRuntime.threadCreates).toEqual([]);
});

test('Home changing views aborts recognition and late results cannot change the brief', async ({ page, inputRuntime }) => {
  await page.goto(home);
  await page.getByRole('textbox', { name: briefLabel }).fill('Keep on view change');
  await page.getByRole('button', { name: 'Start voice input' }).click();
  await page.getByRole('button', { name: 'Performance', exact: true }).click();
  expect((await inputRuntime.snapshot()).recognition[0].aborts).toBe(1);
  await inputRuntime.speech({ action: 'result', parts: [{ text: 'Late on hidden view', final: true }] });
  await page.getByRole('button', { name: 'Brief an agent', exact: true }).click();
  await expect(page.getByRole('textbox', { name: briefLabel })).toHaveValue('Keep on view change');
});

test('Home returning to the brief clears the cancelled voice indicator', async ({ page, inputRuntime }) => {
  await page.goto(home);
  await page.getByRole('button', { name: 'Start voice input' }).click();
  await page.getByRole('button', { name: 'Performance', exact: true }).click();
  expect((await inputRuntime.snapshot()).recognition[0].aborts).toBe(1);
  await page.getByRole('button', { name: 'Brief an agent', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start voice input' })).toHaveAttribute('aria-pressed', 'false');
});

test('mobile conversation keeps a multiline draft and controls visible as viewport height shrinks', async ({ page }, info) => {
  await page.goto(conversation);
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  const draft = Array.from({ length: 12 }, (_, i) => `Synthetic line ${i + 1}`).join('\n');
  await message.fill(draft);
  await expectNoHorizontalOverflow(page);
  const width = page.viewportSize()!.width;
  await page.setViewportSize({ width, height: 360 });
  await message.focus();
  await expect(message).toHaveValue(draft);
  await info.attach('viewport-metrics', { contentType: 'application/json', body: JSON.stringify({
    viewport: page.viewportSize(), ancestors: await message.evaluate(el => { const rows = []; for (let p: Element | null = el; p; p = p.parentElement) { const r = p.getBoundingClientRect(); const css = getComputedStyle(p); rows.push({ c: p.className, y: r.y, h: r.height, scroll: p.scrollHeight, top: p.scrollTop, overflow: css.overflowY }); } return rows; }), textarea: await message.boundingBox(),
    voice: await page.getByRole('button', { name: 'Start dictation' }).boundingBox(),
    send: await page.getByRole('button', { name: 'Send message' }).boundingBox(),
  }) });
  await expect(message).toBeInViewport({ ratio: 1, timeout: 1_000 });
  await expect(page.getByRole('button', { name: 'Start dictation' })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Send message' })).toBeInViewport({ ratio: 1 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('conversation-short-viewport.png') });
});

test('conversation voice merges interim and final results; stopped callbacks cannot overwrite a newer edit', async ({ page, inputRuntime }) => {
  await page.goto(conversation);
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Prefix');
  await page.getByRole('button', { name: 'Start dictation' }).click();
  await expect(message).toBeDisabled();
  const stop = page.getByRole('button', { name: 'Stop recording' });
  await expect(stop).toBeEnabled();
  await expect(stop).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await inputRuntime.speech({ action: 'result', parts: [{ text: 'First', final: true }, { text: 'draft', final: false }] });
  await expect(message).toHaveValue('Prefix First draft');
  await inputRuntime.speech({ action: 'result', parts: [{ text: 'First', final: true }, { text: 'final', final: true }] });
  await expect(message).toHaveValue('Prefix First final');
  await stop.click();
  await expect(message).toBeEditable();
  expect((await inputRuntime.snapshot()).recognition[0]).toMatchObject({ starts: 1, stops: 1, continuous: true, interimResults: true });
  await message.fill('New manual edit');
  await inputRuntime.speech({ action: 'result', parts: [{ text: 'Stale final', final: true }] });
  await expect(message).toHaveValue('New manual edit');
  await page.getByRole('button', { name: 'Start dictation' }).click();
  await inputRuntime.speech({ action: 'error', instance: 0, error: 'not-allowed' });
  await inputRuntime.speech({ action: 'end', instance: 0 });
  await expect(page.getByRole('button', { name: 'Stop recording' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Microphone access denied', { exact: true })).toHaveCount(0);
  await inputRuntime.speech({ action: 'end', instance: 1 });
  await expect(message).toBeEditable();
  expect((await inputRuntime.snapshot()).sends.filter(send => send.type === 'send_chat_message')).toEqual([]);
});

for (const [error, title] of [['not-allowed', 'Microphone access denied'], ['audio-capture', 'No microphone found'], ['no-speech', 'No speech detected'], ['network', 'Dictation stopped']]) {
  test(`conversation recovers from mocked ${error} and permits retry`, async ({ page, inputRuntime }) => {
    await page.goto(conversation);
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    await message.fill('Draft after voice error');
    await page.getByRole('button', { name: 'Start dictation' }).click();
    await inputRuntime.speech({ action: 'error', error });
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await expect(message).toBeEditable();
    await expect(message).toHaveValue('Draft after voice error');
    await page.getByRole('button', { name: 'Start dictation' }).click();
    await expect(page.getByRole('button', { name: 'Stop recording' })).toHaveAttribute('aria-pressed', 'true');
    await inputRuntime.speech({ action: 'end' });
    await expect(message).toBeEditable();
  });
}

test('conversation navigation aborts recognition and a late callback cannot affect Home', async ({ page, inputRuntime }) => {
  await page.goto(conversation);
  await page.getByRole('button', { name: 'Start dictation' }).click();
  // Native app navigation keeps the old JS callback available for this check.
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('textbox', { name: briefLabel })).toBeVisible();
  expect((await inputRuntime.snapshot()).recognition[0].aborts).toBe(1);
  await inputRuntime.speech({ action: 'result', parts: [{ text: 'Stale conversation transcript', final: true }] });
  await expect(page.getByRole('textbox', { name: briefLabel })).toHaveValue('');
});

for (const [variant, event] of [
  ['isComposing', { isComposing: true }],
  ['keyCode 229', { keyCode: 229 }],
] as const) {
  test(`conversation IME ${variant} confirmation does not send an unfinished message`, async ({ page, inputRuntime }, info) => {
    await page.goto(conversation);
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    await message.fill('編集中のメッセージ');
    await message.dispatchEvent('compositionstart', { data: '' });
    await message.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ...event });
    await info.attach('synthetic-send-state', { contentType: 'application/json', body: JSON.stringify(await inputRuntime.snapshot()) });
    await expect(message).toHaveValue('編集中のメッセージ', { timeout: 1_000 });
    expect((await inputRuntime.snapshot()).sends.filter(send => send.type === 'send_chat_message')).toEqual([]);
    await message.dispatchEvent('compositionend', { data: '編集中のメッセージ' });
    await message.press('Shift+Enter');
    await expect(message).toHaveValue('編集中のメッセージ\n');
    await message.press('Enter');
    await expect(message).toHaveValue('');
    expect((await inputRuntime.snapshot()).sends.filter(send => send.type === 'send_chat_message')).toHaveLength(1);
  });
}
