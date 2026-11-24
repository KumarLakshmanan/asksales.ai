import { installReadyCustomerDeliveryMock } from "./helpers/readyCustomerDelivery.js";
installReadyCustomerDeliveryMock();
import {
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
const stored = new Map<string, string>();
let limiterCounts = [1, 1];
const limiterTtl = jest.fn<(key: string) => Promise<number>>();
jest.unstable_mockModule("../models/db.js", () => ({ db: {} }));
// Opt-out checks have their own tests; this suite is about media binding.
jest.unstable_mockModule("../services/outreach/RecipientSuppressionService.js", () => ({
  assertRecipientNotSuppressed: async () => undefined,
  RecipientSuppressedError: class RecipientSuppressedError extends Error {},
}));
jest.unstable_mockModule("../models/adminApiCredentials/functions.js", () => ({
  getActiveAdminCredential: jest.fn(),
}));
jest.unstable_mockModule("../infrastructure/redis.js", () => ({
  getRedisConnection: () => ({
    incr: async () => limiterCounts.shift() || 1,
    expire: async () => 1,
    pttl: limiterTtl,
    get: async (key: string) => stored.get(key),
    set: async (key: string, value: string) => stored.set(key, value),
  }),
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
const { WhatsAppApiService } =
  await import("../services/whatsappApiService.js");
let service: InstanceType<typeof WhatsAppApiService>;
beforeEach(() => {
  stored.clear();
  limiterCounts = [1, 1];
  limiterTtl.mockResolvedValue(42_000);
  service = new WhatsAppApiService();
  jest
    .spyOn(service, "resolveCreds")
    .mockImplementation(async (_user, account) => ({
      source: "channel_credentials",
      credId: 7,
      phoneNumberId: account || "111",
      businessAccountId: "waba",
      apiVersion: "v25.0",
      accessToken: "test-token",
      isManual: true,
    }));
  jest.spyOn(service, "ensureTokenValidity").mockResolvedValue("test-token");
});
afterEach(() => {
  jest.restoreAllMocks();
});
const components = [
  { type: "header", parameters: [{ type: "image", image: { id: "98765" } }] },
];
describe("template media sender binding", () => {
  it.each([[101, 1], [1, 61], [101, 61]])('returns a structured safe-to-delay rejection before HTTP when app capacity is exhausted: %j', async (tenant, phone) => {
    limiterCounts = [tenant, phone];
    const fetch = jest.spyOn(globalThis, 'fetch');
    await expect(service.sendTemplate({userId:9,phoneNumberId:'111',to:'919999999999',templateName:'2nightstay',language:'en'})).rejects.toMatchObject({
      code:'WHATSAPP_APP_RATE_LIMIT',retryable:true,retryAfterMs:43_000,deliveryAttempted:false,outcomeUncertain:false,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(service.ensureTokenValidity).not.toHaveBeenCalled();
  });
  it("uploads file bytes and sends the returned media ID for the same account", async () => {
    const fetch = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "98765" })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: "wamid.test" }] })),
      );
    await service.uploadTemplateMedia({
      userId: 9,
      phoneNumberId: "111",
      buffer: Buffer.from("image bytes"),
      mimeType: "image/png",
      fileName: "offer.png",
    });
    expect(String(fetch.mock.calls[0][0])).toContain("/111/media");
    const form = fetch.mock.calls[0][1]?.body as FormData;
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(form.get("type")).toBe("image/png");
    await service.sendTemplate({
      userId: 9,
      phoneNumberId: "111",
      to: "916382775774",
      templateName: "2nightstay",
      language: "en",
      components,
    });
    expect(
      JSON.parse(String(fetch.mock.calls[1][1]?.body)).template.components,
    ).toEqual(components);
  });
  it.each([
    { userId: 9, phoneNumberId: "222" },
    { userId: 10, phoneNumberId: "111" },
    { userId: 9, phoneNumberId: "111" },
  ])(
    "blocks uploads from another account, owner or expired session: %o",
    async (scope) => {
      stored.set("wa-template-media:9:111:98765", "image");
      if (scope.userId === 9 && scope.phoneNumberId === "111") stored.clear();
      const fetch = jest.spyOn(globalThis, "fetch");
      await expect(
        service.sendTemplate({
          ...scope,
          to: "916382775774",
          templateName: "2nightstay",
          language: "en",
          components,
        }),
      ).rejects.toThrow(/expired|another sending account/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
