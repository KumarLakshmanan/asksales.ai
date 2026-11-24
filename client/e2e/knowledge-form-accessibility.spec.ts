import type { Page, TestInfo } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';
import { installKnowledgeDiagnostics } from './helpers/knowledge-diagnostics';

const entries = [
  { id: 501, title: 'Fixture document', description: 'Fixture description', type: 'document', content: 'Saved fixture content', businessProfileId: 4102, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
  { id: 502, title: 'Fixture FAQ', type: 'qa', question: 'Fixture question', answer: 'Fixture answer', businessProfileId: 4102, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
];
const shellReads = new Set(['/api/auth/me', '/api/platform/access', '/api/settings/preferences', '/api/settings/business-profiles',
  '/api/organizations', '/api/wallet', '/api/crm/configuration', '/api/notifications/unread/count',
  '/api/settings/outreach/assistants/catalog']);

let writes: string[];
let reads: { url: string; profile: string | undefined }[];
let diagnostics: Awaited<ReturnType<typeof installKnowledgeDiagnostics>> | undefined;
test.beforeEach(async ({ page }, testInfo) => {
  writes = [];
  reads = [];
  diagnostics = undefined;
  if (process.env.KNOWLEDGE_DIAGNOSTICS === '1' || process.env.KNOWLEDGE_ISOLATION === '1') {
    // Page API mocks take precedence; every remaining external request is blocked.
    const origin = new URL(testInfo.project.use.baseURL as string).origin;
    await page.context().route('**/*', route => {
      const request = route.request();
      if (new URL(request.url()).origin !== origin || !['GET', 'HEAD'].includes(request.method())) {
        writes.push(`Blocked unmocked request: ${request.method()} ${new URL(request.url()).pathname}`);
        return route.fulfill({ status: 409, body: 'Knowledge diagnostic isolation guard' });
      }
      return route.continue();
    });
  }
  if (process.env.KNOWLEDGE_DIAGNOSTICS === '1') diagnostics = await installKnowledgeDiagnostics(page, testInfo);
  // Disposable fixtures only. Every API request is fulfilled locally; every mutation is rejected.
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 409, json: { error: 'Knowledge accessibility fixture blocks every mutation.' } });
    }
    if (shellReads.has(url.pathname)) return route.fallback();
    if (url.pathname === '/api/knowledge-base') {
      reads.push({ url: url.pathname + url.search, profile: request.headers()['x-business-profile-id'] });
      return route.fulfill({ json: entries });
    }
    if (url.pathname === '/api/knowledge-base/501') return route.fulfill({ json: { success: true, entry: entries[0] } });
    if (url.pathname === '/api/chat/threads') return route.fulfill({ json: { threads: [], total: 0 } });
    return route.fulfill({ json: {} });
  });
});
test.afterEach(async ({ audit }, testInfo) => {
  try {
    expect(writes).toEqual([]);
    expect(audit.blockedMutations).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
    expect(audit.failedRequests).toEqual([]);
  } finally {
    if (diagnostics) await diagnostics.finish();
    if (process.env.KNOWLEDGE_DIAGNOSTICS === '1' || process.env.KNOWLEDGE_ISOLATION === '1') {
      await testInfo.attach('knowledge-strict-audit', { body: JSON.stringify({ writes, reads, ...audit }), contentType: 'application/json' });
    }
  }
  // Requests remain subject to the same strict audit while evidence is collected.
  expect(writes).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
  expect(audit.failedRequests).toEqual([]);
});

async function associations(page: Page) {
  expect(await page.locator('[id]').evaluateAll(elements => {
    const ids = elements.map(element => element.id);
    return ids.length === new Set(ids).size;
  })).toBe(true);
  expect(await page.locator('[aria-describedby], [aria-labelledby]').evaluateAll(elements => elements.every(element =>
    ['aria-describedby', 'aria-labelledby'].every(attribute => (element.getAttribute(attribute)?.split(' ') || []).every(id => document.getElementById(id)))
  ))).toBe(true);
  expect(await page.locator('input[id^="knowledge-"], textarea[id^="knowledge-"]').evaluateAll(elements =>
    elements.every(element => document.querySelector(`label[for="${element.id}"]`))
  )).toBe(true);
}
async function evidence(page: Page, testInfo: TestInfo, state: string) {
  await expectNoHorizontalOverflow(page);
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: visualViewport?.scale,
    zoom: getComputedStyle(document.documentElement).zoom, scrollWidth: document.documentElement.scrollWidth }));
  expect(dimensions.width).toBe(page.viewportSize()?.width);
  expect(dimensions.height).toBe(page.viewportSize()?.height);
  expect(dimensions.scale).toBe(1);
  await testInfo.attach(`${state}-dimensions`, { body: JSON.stringify(dimensions), contentType: 'application/json' });
  await testInfo.attach(`${state}-accessibility`, { body: await page.getByRole('main').ariaSnapshot(), contentType: 'text/plain' });
  await page.screenshot({ path: testInfo.outputPath(`${state}.png`), fullPage: true });
}

test('Knowledge Base → Add entry names controls and associates empty-invalid submission with keyboard recovery', async ({ page }, testInfo) => {
  await page.goto('/dashboard/knowledge-base');
  await page.getByRole('button', { name: 'Add entry', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/knowledge-base\/new$/);
  const title = page.getByRole('textbox', { name: 'Title', exact: true });
  const description = page.getByRole('textbox', { name: 'Description', exact: true });
  const content = page.getByRole('textbox', { name: 'Document Content', exact: true });
  for (const control of [title, description, content]) await expect(control).toBeVisible();
  await expect(title).toHaveAttribute('required', '');
  await expect(content).toHaveAttribute('required', '');
  await expect(description).not.toHaveAttribute('required');
  await expect(description).toHaveAccessibleDescription('Optional brief description.');
  await expect(page.getByRole('combobox', { name: 'Business Profile' })).toBeDisabled();
  await expect(page.getByText('This entry belongs to the current business workspace.')).toBeVisible();
  await evidence(page, testInfo, 'document-empty');

  const save = page.getByRole('button', { name: 'Save', exact: true });
  if (diagnostics) await diagnostics.armSave();
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(title).toBeFocused();
  await expect(title).toHaveAttribute('aria-invalid', 'true');
  await expect(title).toHaveAccessibleDescription('Title is required');
  await associations(page);
  await title.pressSequentially('Fixture draft');
  await expect(title).not.toHaveAttribute('aria-invalid', 'true');
  await page.keyboard.press('Tab');
  await expect(description).toBeFocused();
  await description.pressSequentially('Disposable description');
  await page.keyboard.press('Tab');
  await expect(content).toBeFocused();
  if (diagnostics) await diagnostics.armSave();
  await save.click();
  await expect(content).toBeFocused();
  await expect(content).toHaveAccessibleDescription(/Content is required for document entries/);
  await evidence(page, testInfo, 'document-invalid');
  await content.pressSequentially('Disposable draft content');
  await expect(content).not.toHaveAttribute('aria-invalid', 'true');
  const titleId = await title.getAttribute('id');
  await page.getByRole('button', { name: 'Website URL', exact: true }).click();
  await page.getByRole('button', { name: 'Document', exact: true }).click();
  await expect(title).toHaveAttribute('id', titleId!);
  await expect(title).toHaveValue('Fixture draft');
  await expect(description).toHaveValue('Disposable description');
  await expect(content).toHaveValue('Disposable draft content');
  await associations(page);
  const back = page.getByRole('button', { name: 'Back to Knowledge Base', exact: true });
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/dashboard\/knowledge-base$/);
});

test('related Q&A, File and URL forms expose accurate names, keyboard actions and existing validation', async ({ page }, testInfo) => {
  await page.goto('/dashboard/knowledge-base/new');
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Fixture entry');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await page.getByRole('button', { name: 'Q&A Pairs', exact: true }).click();
  const question = page.getByRole('textbox', { name: 'Question 1', exact: true });
  const answer = page.getByRole('textbox', { name: 'Answer 1', exact: true });
  await expect(question).toHaveAttribute('required', '');
  if (diagnostics) await diagnostics.armSave();
  await save.click();
  await expect(question).toBeFocused();
  await expect(question).toHaveAttribute('aria-invalid', 'true');
  await expect(question).toHaveAccessibleDescription(/At least one Q&A pair/);
  await question.pressSequentially('Fixture question');
  if (diagnostics) await diagnostics.armSave();
  await save.click();
  await expect(answer).toBeFocused();
  await expect(answer).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: /Add Another Q&A Pair/ }).click();
  await expect(question).not.toHaveAttribute('required');
  await expect(page.getByRole('textbox', { name: 'Question 2', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Answer 2', exact: true })).not.toHaveAttribute('required');
  await associations(page);
  await evidence(page, testInfo, 'qa-rows');
  const remove = page.getByRole('button', { name: 'Remove Q&A pair 2', exact: true });
  await remove.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Question 2', exact: true })).toHaveCount(0);
  await expect(question).toHaveValue('Fixture question');
  await expect(question).toBeFocused();

  await page.getByRole('button', { name: 'File Upload', exact: true }).click();
  const file = page.locator('#knowledge-file');
  await expect(file).toHaveAccessibleName('File Upload');
  await expect(file).toHaveAttribute('required', '');
  if (diagnostics) await diagnostics.armSave();
  await save.click();
  const choose = page.getByRole('button', { name: 'Choose file', exact: true });
  await expect(choose).toBeFocused();
  await expect(choose).toHaveAccessibleDescription(/Please upload a file/);
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles({ name: 'disposable.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic text') });
  const removeFile = page.getByRole('button', { name: 'Remove file' });
  await expect(removeFile).toBeFocused();
  await expect(file).not.toHaveAttribute('required');
  await associations(page);
  await evidence(page, testInfo, 'file-selected');
  await removeFile.press('Enter');
  await expect(choose).toBeFocused();
  await expect(file).toHaveAttribute('required', '');

  await page.getByRole('button', { name: 'Website URL', exact: true }).click();
  const url = page.getByRole('textbox', { name: 'Website URL', exact: true });
  await expect(url).toHaveAttribute('required', '');
  if (diagnostics) await diagnostics.armSave();
  await save.click();
  await expect(url).toBeFocused();
  await expect(url).toHaveAccessibleDescription(/URL is required/);
  await associations(page);
  await evidence(page, testInfo, 'url-invalid');
  await url.pressSequentially('https://fixture.example.test');
  await expect(url).not.toHaveAttribute('aria-invalid', 'true');
});

test('Clear search recovers no matches repeatedly and preserves type, business filter and workspace scope', async ({ page }, testInfo) => {
  await page.goto('/dashboard/knowledge-base');
  await expect(page.getByText('Fixture document', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Entry type filter' }).click();
  await page.getByRole('option', { name: 'Documents', exact: true }).click();
  const business = page.getByRole('combobox', { name: 'Business profile filter' });
  await expect(business).toHaveText('Current business');
  await business.click();
  await page.getByRole('option', { name: 'Regression Company', exact: true }).click();
  await expect.poll(() => reads.some(read => read.url.endsWith('?businessProfileId=4102'))).toBe(true);
  const initialReads = [...reads];
  const search = page.getByRole('textbox', { name: 'Search knowledge base', exact: true });
  for (let i = 0; i < 3; i++) {
    await search.pressSequentially('zz-fixture-no-match');
    await expect(page.getByText('No entries match your search criteria', { exact: true })).toBeVisible();
    await expect(search).toBeFocused();
    await evidence(page, testInfo, `search-no-match-${i}`);
    await page.keyboard.press('Tab');
    const clear = page.getByRole('button', { name: 'Clear search', exact: true });
    await expect(clear).toBeFocused();
    await page.keyboard.press(i === 1 ? 'Space' : 'Enter');
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('');
    await expect(clear).toHaveCount(0);
    await expect(page.getByText('Fixture document', { exact: true })).toBeVisible();
    await expect(page.getByText('Fixture FAQ', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Entry type filter' })).toHaveText('Documents');
    await expect(business).toHaveText('Regression Company');
    expect(reads).toEqual(initialReads);
  }
  expect(reads.every(read => read.profile === '4102')).toBe(true);
  await evidence(page, testInfo, 'search-cleared');
});

test('editing preserves stored values and keyboard Update / Back controls without submitting', async ({ page }, testInfo) => {
  await page.goto('/dashboard/knowledge-base/501');
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Fixture document');
  await expect(page.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Fixture description');
  await expect(page.getByRole('textbox', { name: 'Document Content', exact: true })).toHaveValue('Saved fixture content');
  await expect(page.getByRole('combobox', { name: 'Business Profile' })).toBeDisabled();
  await expect(page.getByRole('group', { name: 'Entry Type' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
  await associations(page);
  await evidence(page, testInfo, 'edit-document');
  await page.getByRole('button', { name: 'Back to List', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/dashboard\/knowledge-base$/);
});

test('320×568 viewport keeps all Knowledge form types and Clear search usable at normal zoom', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/dashboard/knowledge-base/new');
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toBeVisible();
  for (const type of ['Document', 'Q&A Pairs', 'File Upload', 'Website URL']) {
    await page.getByRole('button', { name: type, exact: true }).click();
    await associations(page);
    await evidence(page, testInfo, `narrow-${type.replaceAll(/[^a-z]/gi, '-')}`);
  }
  await page.getByRole('button', { name: 'Back to Knowledge Base' }).click();
  const search = page.getByRole('textbox', { name: 'Search knowledge base', exact: true });
  await search.fill('zz-no-match');
  await expect(page.getByText('No entries match your search criteria', { exact: true })).toBeVisible();
  await search.press('Tab');
  await expect(page.getByRole('button', { name: 'Clear search', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(search).toBeFocused();
  await expect(page.getByText('Fixture document', { exact: true })).toBeVisible();
  await evidence(page, testInfo, 'narrow-search-cleared');
});

// This test intercepts its synthetic mutations locally before the default
// isolation guard. It never reaches an application API or database.
test('partial Q&A save preserves a stable retry identity and saved-entry receipt', async ({ page }) => {
  const requests: Array<{requestId:string;qas:unknown[]}> = [];
  await page.route('**/api/knowledge-base/qa', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({status:requests.length===1 ? 207 : 201,json:requests.length===1
      ? {success:false,message:'Saved entry IDs: 31, 32. Retry unchanged.',results:[{entryId:31,status:'completed'},{entryId:32,status:'failed'}]}
      : {success:true}});
  });
  await page.goto('/dashboard/knowledge-base/new');
  await page.getByRole('textbox',{name:'Title',exact:true}).fill('Synthetic recovery FAQ');
  await page.getByRole('button',{name:'Q&A Pairs',exact:true}).click();
  await page.getByRole('textbox',{name:'Question 1',exact:true}).fill('Reset?');
  await page.getByRole('textbox',{name:'Answer 1',exact:true}).fill('Blue button');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.locator('[data-description]').filter({hasText:/Saved entry IDs: 31, 32\./})).toBeVisible();
  await expect(page).toHaveURL(/knowledge-base\/new$/);
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page).toHaveURL(/knowledge-base$/);
  expect(requests).toHaveLength(2);
  expect(requests[0].requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(requests[1]).toEqual(requests[0]);
});
