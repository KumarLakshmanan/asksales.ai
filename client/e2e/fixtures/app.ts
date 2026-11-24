import { expect, test as base, type Page, type Route } from '@playwright/test';
import { DEFAULT_CRM_CONFIGURATION } from '../../../shared/crmConfiguration';

export type BrowserAudit = {
  consoleErrors: string[];
  failedRequests: string[];
  blockedMutations: string[];
};

type Fixtures = { audit: BrowserAudit };

const modules = [
  'campaigns', 'lead_generation', 'content', 'performance_marketing', 'ai_visibility',
  'outreach', 'crm', 'support', 'support_ai', 'proposals', 'knowledge_base',
  'integrations', 'billing', 'storage',
].map((key) => ({ key, name: key, description: '', status: 'available', message: null, mode: 'enabled', enabled: true }));

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

export async function installAppShellMocks(page: Page) {
  await page.route('**/api/auth/me', route => json(route, {
    user: {
      id: 4101,
      email: 'regression-alpha@example.test',
      name: 'Regression Alpha',
      isSetupComplete: true,
      isApproved: true,
      hasBusinessProfile: true,
      hasBrandToolkit: true,
    },
  }));
  await page.route('**/api/platform/access', route => json(route, { maintenance: { enabled: false, message: '' }, modules }));
  await page.route('**/api/settings/preferences', route => json(route, { theme: 'light', language: 'en', timezone: 'UTC' }));
  await page.route('**/api/settings/outreach/assistants/catalog', route => json(route, {
    runtimeEnabled: false, presets: [], accounts: [], models: [], knowledge: [], playbooks: [], templates: [], documents: [], galleries: [], tools: [],
    permissions: { canManage: false, description: 'Read-only app shell fixture.' },
  }));
  await page.route('**/api/organizations', route => json(route, { organizations: [] }));
  await page.route('**/api/settings/business-profiles', route => json(route, [
    { id: 4102, name: 'Regression Business', companyName: 'Regression Company', isDefault: true, role: 'owner' },
  ]));
  await page.route('**/api/crm/configuration', route => json(route, { success: true, data: DEFAULT_CRM_CONFIGURATION }));
  await page.route('**/api/wallet', route => json(route, { balance: 10_000 }));
  await page.route('**/api/chat/threads?*', route => json(route, { threads: [], total: 0 }));
  await page.route('**/api/notifications/unread/count', route => json(route, { count: 0 }));
}

export const test = base.extend<Fixtures>({
  audit: [async ({ page }, use) => {
    const audit: BrowserAudit = { consoleErrors: [], failedRequests: [], blockedMutations: [] };
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      class RegressionWebSocket extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readonly CONNECTING = 0;
        readonly OPEN = 1;
        readonly CLOSING = 2;
        readonly CLOSED = 3;
        readyState = RegressionWebSocket.OPEN;
        bufferedAmount = 0;
        extensions = '';
        protocol = '';
        binaryType: BinaryType = 'blob';
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        constructor(readonly url: string | URL) {
          super();
          queueMicrotask(() => {
            const event = new Event('open');
            this.dispatchEvent(event);
            this.onopen?.(event);
          });
        }
        send() {}
        close() {
          this.readyState = RegressionWebSocket.CLOSED;
        }
      }
      class RoutedWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;

        constructor(url: string | URL, protocols?: string | string[]) {
          const target = new URL(String(url), window.location.href);
          // Keep Next.js development reloads real; application sockets must use
          // the same mocked identity as the HTTP fixture, including on staging.
          if (target.host === window.location.host && target.pathname.startsWith('/_next/')) {
            return new NativeWebSocket(url, protocols);
          }
          return new RegressionWebSocket(url);
        }
      }
      Object.defineProperty(window, 'WebSocket', { configurable: true, value: RoutedWebSocket });
    });
    page.on('console', message => {
      if (message.type() === 'error') audit.consoleErrors.push(message.text());
    });
    page.on('requestfailed', request => {
      if (!/\/_next\/(?:webpack-hmr|hmr)/.test(request.url())) audit.failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
    });
    await page.route('**/api/**', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const isMutation = request.method() !== 'GET' && request.method() !== 'HEAD';
      const isExternalEffect = /\/api\/(?:campaigns\/autonomous|lead-workflow\/execute|whatsapp\/templates\/sync|outreach\/.*(?:send|launch))$/i.test(pathname);
      if (isMutation && isExternalEffect) {
        audit.blockedMutations.push(`${request.method()} ${pathname}`);
        await json(route, { error: 'Blocked by the regression provider guard.' }, 409);
        return;
      }
      await route.fallback();
    });
    await installAppShellMocks(page);
    await use(audit);
  }, { auto: true }],
});

export { expect };

export async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}
