import { installReadyCustomerDeliveryMock, installReadyCustomerJobMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock(); installReadyCustomerJobMock();
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { withBusinessScope } from '../tenancy/businessContext.js';

const quota = jest.fn<() => Promise<number>>();

jest.unstable_mockModule("../models/db.js", () => ({ db: {} }));
jest.unstable_mockModule("../models/adminApiCredentials/functions.js", () => ({
  getActiveAdminCredential: jest.fn(),
}));
jest.unstable_mockModule("../infrastructure/redis.js", () => ({
  getRedisConnection: () => ({ incr: quota, expire: async () => 1 }),
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));
const { WhatsAppApiService } =
  await import("../services/whatsappApiService.js");
let service: InstanceType<typeof WhatsAppApiService>;
const item = (id: string, language: string, status = "APPROVED") => ({
  id,
  name: "welcome",
  language,
  status,
  components: [
    { type: "HEADER", format: "TEXT", text: "For {{1}}" },
    { type: "BODY", text: "Hello {{1}}" },
    { type: "FOOTER", text: "Orchid Labs" },
    {
      type: "BUTTONS",
      buttons: [
        {
          type: "URL",
          text: "View proposal",
          url: "https://example.test/{{1}}",
        },
      ],
    },
  ],
});
beforeEach(() => {
  quota.mockReset().mockResolvedValue(1);
  service = new WhatsAppApiService();
  jest
    .spyOn(service, "resolveCreds")
    .mockResolvedValue({
      source: "channel_credentials",
      credId: 7,
      phoneNumberId: "phone-7",
      businessAccountId: "waba-7",
      apiVersion: "v25.0",
      accessToken: "test-only-token",
      isManual: true,
    });
  jest
    .spyOn(service, "ensureTokenValidity")
    .mockResolvedValue("test-only-token");
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("selected WhatsApp account template catalog", () => {
  it("uses the selected number’s WABA, preserves language variants, filters unapproved templates and follows account-scoped pagination", async () => {
    const fetch = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [item("en", "en_US"), item("draft", "en_US", "PENDING")],
            paging: {
              next: "https://untrusted.example/cursor",
              cursors: { after: "next-page" },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [item("es", "es")] })),
      );
    const validate = jest.spyOn(service as unknown as { resolveAndValidate: (...args: unknown[]) => Promise<unknown> }, 'resolveAndValidate');
    const templates = await service.listApprovedTemplates(1, "phone-7");
    expect(validate).toHaveBeenCalledWith(1, "phone-7", false, true);
    expect(service.resolveCreds).toHaveBeenCalledWith(1, "phone-7");
    expect(templates).toHaveLength(2);
    expect(templates.map((template) => template.language)).toEqual([
      "en_US",
      "es",
    ]);
    expect(templates[0]).toMatchObject({
      headerType: "TEXT",
      header: "For {{1}}",
      body: "Hello {{1}}",
      footer: "Orchid Labs",
      buttons: [{ type: "URL", url: "https://example.test/{{1}}" }],
    });
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).toMatch(
        /^https:\/\/graph.facebook.com\/v25.0\/waba-7\/message_templates\?/,
      );
      expect(init?.method).not.toBe("POST");
      expect(init?.headers).toEqual({
        Authorization: "Bearer test-only-token",
      });
    }
    expect(
      new URL(String(fetch.mock.calls[1][0])).searchParams.get("after"),
    ).toBe("next-page");
  });
  it("fails without an approved catalog when the selected account cannot be read", async () => {
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: "OAuth permission missing" } }),
          { status: 403 },
        ),
      );
    await expect(service.listApprovedTemplates(1, "phone-7")).rejects.toThrow();
  });
  it("does not fetch a catalog using credentials without their Business Account", async () => {
    jest
      .mocked(service.resolveCreds)
      .mockResolvedValue({
        source: "channel_credentials",
        credId: 7,
        phoneNumberId: "phone-7",
        apiVersion: "v25.0",
        accessToken: "test-only-token",
        isManual: true,
      });
    const fetch = jest.spyOn(globalThis, "fetch");
    await expect(service.listApprovedTemplates(1, "phone-7")).rejects.toThrow(
      /Business Account/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

const select = (businessProfileId = 10, actorUserId = 1, userId = 1, phone = 'phone-7') =>
  withBusinessScope({ userId, businessProfileId, actorUserId }, () => service.listTemplatesForSelection(userId, phone));

describe('fast catalog reads for template selection', () => {
  it('requires the verified owning business before reading or reusing catalog data', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    await expect(service.listTemplatesForSelection(1, 'phone-7')).rejects.toThrow(/verified business/);
    await expect(withBusinessScope({ userId: 2, businessProfileId: 10 }, () => service.listTemplatesForSelection(1, 'phone-7'))).rejects.toThrow(/verified business/);
    expect(service.resolveCreds).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('coalesces simultaneous reads and returns independent copies of the cached catalog', async () => {
    let finish!: () => void, started!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      started(); await pending;
      return Response.json({ data: [item('approved', 'en')] });
    });
    const reads = Promise.all([select(), select()]);
    await began;
    finish();
    const [one, two] = await reads;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(one).toEqual(two);
    one[0].body = 'Changed by caller';
    one[0].buttons![0].text = 'Changed button';
    expect((await select())[0]).toMatchObject({ body: 'Hello {{1}}', buttons: [{ text: 'View proposal' }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(quota).not.toHaveBeenCalled();
  });

  it.each(['business', 'actor', 'owner', 'phone', 'waba', 'credential', 'token', 'version'] as const)('isolates the catalog when the %s changes', async dimension => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: [item('approved', 'en')] }));
    await select();
    const creds = await service.resolveCreds(1, 'phone-7');
    if (dimension === 'phone') jest.mocked(service.resolveCreds).mockResolvedValue({ ...creds!, phoneNumberId: 'phone-8' });
    if (dimension === 'waba') jest.mocked(service.resolveCreds).mockResolvedValue({ ...creds!, businessAccountId: 'waba-8' });
    if (dimension === 'credential') jest.mocked(service.resolveCreds).mockResolvedValue({ ...creds!, credId: 8 });
    if (dimension === 'token') jest.mocked(service.resolveCreds).mockResolvedValue({ ...creds!, accessToken: 'rotated-test-only-token' });
    if (dimension === 'version') jest.mocked(service.resolveCreds).mockResolvedValue({ ...creds!, apiVersion: 'v26.0' });
    await select(dimension === 'business' ? 11 : 10, dimension === 'actor' || dimension === 'owner' ? 2 : 1,
      dimension === 'owner' ? 2 : 1, dimension === 'phone' ? 'phone-8' : 'phone-7');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refreshes expired snapshots and never reuses a disconnected or expired credential', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: [item('approved', 'en')] }));
    await select();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 60_001);
    await select();
    expect(fetch).toHaveBeenCalledTimes(2);
    const creds = await service.resolveCreds(1, 'phone-7');
    jest.mocked(service.resolveCreds).mockResolvedValue({ ...creds!, expiresAt: new Date(now).toISOString() });
    await expect(select()).rejects.toThrow(/refresh its authorization/);
    jest.mocked(service.resolveCreds).mockResolvedValue(null);
    await expect(select()).rejects.toThrow(/Connect this WhatsApp number/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a different phone number even when the requested catalog was cached', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [item('approved', 'en')] }));
    await select();
    const creds = await service.resolveCreds(1, 'phone-7');
    jest.mocked(service.resolveCreds).mockResolvedValue({ ...creds!, phoneNumberId: 'phone-8' });
    await expect(select()).rejects.toThrow(/Connect this WhatsApp number/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retain a failed or partial provider response', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: [item('partial', 'en')], paging: { next: 'ignored', cursors: { after: 'page-2' } } }))
      .mockResolvedValueOnce(Response.json({ error: { message: 'Provider temporarily unavailable' } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: [item('complete', 'en')] }));
    await expect(select()).rejects.toThrow(/temporarily unavailable/);
    expect((await select()).map(template => template.id)).toEqual(['complete']);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][1]?.signal).toBe(fetch.mock.calls[1][1]?.signal);
  });

  it('keeps fresh approval validation separate from the selector cache', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: [item('approved', 'en')] }))
      .mockResolvedValueOnce(Response.json({ data: [item('approved', 'en', 'PAUSED')] }));
    expect(await select()).toHaveLength(1);
    expect(await service.listApprovedTemplates(1, 'phone-7')).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(quota).toHaveBeenCalledTimes(2);
  });

  it('can browse without consuming message quota while the delivery path still enforces it', async () => {
    quota.mockRejectedValue(new Error('Sending quota unavailable'));
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [item('approved', 'en')] }));
    expect(await select()).toHaveLength(1);
    expect(quota).not.toHaveBeenCalled();
    await expect(service.listApprovedTemplates(1, 'phone-7')).rejects.toThrow('Sending quota unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
