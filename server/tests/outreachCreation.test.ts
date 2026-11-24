import { installReadyCustomerDeliveryMock, installReadyCustomerJobMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock(); installReadyCustomerJobMock();
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { withBusinessScope } from "../tenancy/businessContext.js";

const select = jest.fn<(...args: unknown[]) => unknown>();
const execute = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
const sender = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const provider = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const window = jest.fn<(...args: unknown[]) => Promise<Set<number>>>();
const createdContactLead = jest.fn<(values: unknown) => void>();
const selectionTemplates = jest.fn<(...args: unknown[]) => Promise<unknown[]>>();
const freshTemplates = jest.fn<(...args: unknown[]) => Promise<unknown[]>>();
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({ whatsappApiService: { listTemplatesForSelection: selectionTemplates, listApprovedTemplates: freshTemplates } }));
const linkedContact = jest.fn<(values: unknown) => void>();
const contactDb = {
  select,
  execute,
  insert: () => ({
    values: (values: unknown) => {
      createdContactLead(values);
      return { returning: async () => [{ id: 55 }] };
    },
  }),
  update: () => ({
    set: (values: unknown) => {
      linkedContact(values);
      return { where: async () => undefined };
    },
  }),
  transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(contactDb),
};
let leadRows: unknown[] = [];
const chain: Record<string, unknown> = {};
for (const method of ["from", "where", "orderBy", "limit"])
  chain[method] = jest.fn(() => chain);
chain.then = (resolve: (rows: unknown[]) => unknown) =>
  Promise.resolve(leadRows).then(resolve);
jest.unstable_mockModule("../models/db.js", () => ({
  db: contactDb,
}));
jest.unstable_mockModule("../models/emailSenders/functions.js", () => ({
  getById: sender,
  getDefault: sender,
  listByUser: jest.fn(),
}));
jest.unstable_mockModule(
  "../services/outreach/ProviderBindingService.js",
  () => ({ resolveOfficialProviderBinding: provider }),
);
jest.unstable_mockModule("../services/whatsappServiceWindow.js", () => ({
  activeWhatsAppWindows: window,
}));
const {
  getCreationRecipients,
  getCreationTemplates,
  resolveCreationAccount,
  validateCreationTemplate,
  validateOutreachTiming,
  prepareCreationContact,
} = await import("../services/outreach/CreationService.js");
const scope = <T>(work: () => T) =>
  withBusinessScope({ userId: 1, businessProfileId: 10 }, work);
const lead = {
  id: 3,
  fullName: "Ada Lovelace",
  name: null,
  firstName: "Ada",
  lastName: "Lovelace",
  company: "Engines",
  companyName: null,
  email: "ada@example.com",
  phone: "919876543210",
  whatsapp: "919876543211",
  blacklisted: false,
  doNotContact: false,
  emailUnsubscribed: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  selectionTemplates.mockResolvedValue([{ id: 'approved', name: 'welcome', language: 'en', body: 'Hello' }]);
  freshTemplates.mockResolvedValue([]);
  select.mockReturnValue(chain);
  execute.mockResolvedValue({ rows: [] });
  sender.mockResolvedValue({
    id: 7,
    type: "gmail",
    email: "sales@example.com",
    isVerified: true,
    credentialId: 14,
  });
  provider.mockResolvedValue({
    providerAccountId: "account-1",
    credentialId: 14,
    platform: "gmail_api",
  });
  window.mockResolvedValue(new Set());
  leadRows = [lead];
});

describe('template selection binding', () => {
  it('uses the fast catalog only after the exact sending-account binding is verified', async () => {
    expect(await scope(() => getCreationTemplates(1, 'account-1', { forSelection: true }))).toEqual([{ id: 'approved', name: 'welcome', language: 'en', body: 'Hello' }]);
    expect(provider).toHaveBeenCalledWith(1, 'whatsapp', { providerAccountId: 'account-1' });
    expect(selectionTemplates).toHaveBeenCalledWith(1, 'account-1');
    expect(freshTemplates).not.toHaveBeenCalled();
  });
  it('rejects a removed or unready account before reading a cached catalog', async () => {
    provider.mockResolvedValue(null);
    await expect(scope(() => getCreationTemplates(1, 'removed-account', { forSelection: true }))).rejects.toThrow(/Connect this WhatsApp number/);
    expect(selectionTemplates).not.toHaveBeenCalled();
  });
  it('keeps bulk-send and follow-up approval checks fresh by default', async () => {
    expect(await scope(() => getCreationTemplates(1, 'account-1'))).toEqual([]);
    expect(freshTemplates).toHaveBeenCalledWith(1, 'account-1');
    expect(selectionTemplates).not.toHaveBeenCalled();
  });
});

describe("outreach creation account and recipient checks", () => {
  it('uses the explicitly selected MSG91 sender and its SMS recipient numbers', async () => {
    provider.mockResolvedValueOnce({ credentialId: 31, platform: 'msg91_sms', providerAccountId: 'ABCDEF', accountName: 'MSG91 sender' });
    const account = await scope(() => resolveCreationAccount(1, 'sms', { providerAccountId: 'ABCDEF' }));
    expect(account.account).toMatchObject({ ready: true, providerAccountId: 'ABCDEF' });
    expect(provider).toHaveBeenCalledWith(1, 'sms', { providerAccountId: 'ABCDEF' });
    leadRows = [{ ...lead, phone: '9198765432', whatsapp: '447700900123' }, { ...lead, id: 4, phone: 'bad' }, { ...lead, id: 5, doNotContact: true }];
    const recipients = await scope(() => getCreationRecipients(1, 'sms', { providerAccountId: 'ABCDEF' }, { ids: [3, 4, 5] }));
    expect(recipients.recipients[0]).toMatchObject({ eligible: true, recipient: '919198765432' });
    expect(recipients.recipients.map(item => item.eligible)).toEqual([true, false, false]);
    expect(window).not.toHaveBeenCalled();
  });
  it("binds Gmail to the explicitly selected verified sender credential", async () => {
    const result = await scope(() =>
      resolveCreationAccount(1, "email", { senderId: 7 }),
    );
    expect(sender).toHaveBeenCalledWith(1, 7);
    expect(provider).toHaveBeenCalledWith(1, "email", {
      providerVariant: "gmail",
      credentialId: 14,
    });
    expect(result.account).toMatchObject({
      ready: true,
      senderId: 7,
      providerAccountId: "account-1",
    });
  });
  it("does not fall back to a different sender when the selected sender is missing", async () => {
    sender.mockResolvedValue(undefined);
    expect(
      (await scope(() => resolveCreationAccount(1, "email", { senderId: 777 })))
        .binding,
    ).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });
  it("rejects unverified senders before resolving a provider", async () => {
    sender.mockResolvedValue({
      id: 7,
      type: "resend",
      isVerified: false,
      email: "sales@example.com",
    });
    expect(
      (await scope(() => resolveCreationAccount(1, "email", { senderId: 7 })))
        .account.ready,
    ).toBe(false);
    expect(provider).not.toHaveBeenCalled();
  });
  it("does not choose an implicit Meta account", async () => {
    expect(
      (await scope(() => resolveCreationAccount(1, "instagram", {}))).binding,
    ).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });
  it("blocks opt-outs and invalid email addresses before queueing", async () => {
    leadRows = [
      { ...lead, doNotContact: true },
      { ...lead, id: 4, email: "invalid" },
    ];
    const result = await scope(() =>
      getCreationRecipients(1, "email", { senderId: 7 }, { ids: [3, 4] }),
    );
    expect(result.recipients.map((item) => item.eligible)).toEqual([
      false,
      false,
    ]);
    expect(result.recipients[0].reason).toMatch(/opted out/);
    expect(result.recipients[1].reason).toMatch(/valid email/);
  });
  it("keeps unnamed contacts recognizable without substituting their address for personal name variables", async () => {
    leadRows = [
      { ...lead, fullName: "", name: "", firstName: "", lastName: "" },
    ];
    const result = await scope(() =>
      getCreationRecipients(1, "email", { senderId: 7 }, { ids: [3] }),
    );
    expect(result.recipients[0]).toMatchObject({
      name: "ada@example.com",
      fullName: "",
      firstName: "",
      eligible: true,
    });
  });
  it("uses the WhatsApp address and checks the window for the selected number", async () => {
    const result = await scope(() =>
      getCreationRecipients(
        1,
        "whatsapp",
        { providerAccountId: "account-1" },
        { ids: [3] },
      ),
    );
    expect(result.recipients[0]).toMatchObject({
      recipient: "919876543211",
      requiresTemplate: true,
      eligible: true,
    });
    expect(window).toHaveBeenCalledWith(1, [3], "account-1");
  });
  it('checks a full WhatsApp recipient page with one batch lookup', async () => {
    leadRows = Array.from({ length: 50 }, (_, index) => ({ ...lead, id: index + 1 }));
    window.mockResolvedValue(new Set([3, 8]));
    const result = await scope(() => getCreationRecipients(1, 'whatsapp', { providerAccountId: 'account-1' }));
    expect(window).toHaveBeenCalledTimes(1);
    expect(window.mock.calls[0][1]).toHaveLength(50);
    expect(result.recipients.filter(recipient => !recipient.requiresTemplate).map(recipient => recipient.id)).toEqual([3, 8]);
  });
  it.each(["instagram", "facebook"] as const)(
    "requires an account-scoped inbound conversation for %s",
    async (channel) => {
      let result = await scope(() =>
        getCreationRecipients(
          1,
          channel,
          { providerAccountId: "account-1" },
          { ids: [3] },
        ),
      );
      expect(result.recipients[0].eligible).toBe(false);
      execute.mockResolvedValue({
        rows: [
          {
            lead_id: 3,
            id: 81,
            external_thread_id: "123456",
            last_inbound_at: new Date(Date.now() - 1000),
          },
        ],
      });
      result = await scope(() =>
        getCreationRecipients(
          1,
          channel,
          { providerAccountId: "account-1" },
          { ids: [3] },
        ),
      );
      expect(result.recipients[0]).toMatchObject({
        eligible: true,
        recipient: "123456",
        conversationId: 81,
      });
      execute.mockResolvedValue({
        rows: [
          {
            lead_id: 3,
            id: 81,
            external_thread_id: "123456",
            last_inbound_at: new Date(Date.now() - 25 * 3600000),
          },
        ],
      });
      result = await scope(() =>
        getCreationRecipients(
          1,
          channel,
          { providerAccountId: "account-1" },
          { ids: [3] },
        ),
      );
      expect(result.recipients[0].reason).toMatch(/window has closed/);
    },
  );
});

describe("CRM contact preparation", () => {
  const contact = {
    id: 8,
    leadId: null,
    firstName: "Ada",
    lastName: "Lovelace",
    email: null,
    phone: "+91 98765 43210",
    company: "Orchid",
    role: null,
  };
  function reads(rows: unknown[][]) {
    select.mockImplementation(() => {
      const value = rows.shift() || [];
      return { from: () => ({ where: () => ({ limit: async () => value }) }) };
    });
  }
  it("prepares a phone-only WhatsApp contact without requiring an email address", async () => {
    reads([[contact], []]);
    expect(
      await scope(() =>
        prepareCreationContact(1, 8, "whatsapp", {
          providerAccountId: "account-1",
        }),
      ),
    ).toEqual({ leadId: 55 });
    expect(createdContactLead).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "919876543210",
        email: null,
        source: "crm_sync",
      }),
    );
    expect(linkedContact).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 55 }),
    );
  });
  it.each(["instagram", "facebook"] as const)(
    "reuses %s’s receiving-account conversation without changing a CRM-only contact’s permanent lead identity",
    async (channel) => {
      reads([[contact]]);
      execute
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ lead_id: 77 }] });
      expect(
        await scope(() =>
          prepareCreationContact(1, 8, channel, {
            providerAccountId: "account-1",
          }),
        ),
      ).toEqual({ leadId: 77 });
      expect(createdContactLead).not.toHaveBeenCalled();
      expect(linkedContact).not.toHaveBeenCalled();
    },
  );
  it("rejects a missing owned contact or an ambiguous phone match instead of creating a duplicate", async () => {
    reads([[]]);
    expect(
      await scope(() =>
        prepareCreationContact(1, 8, "whatsapp", {
          providerAccountId: "account-1",
        }),
      ),
    ).toMatchObject({ error: expect.stringContaining("unavailable") });
    reads([[contact], [{ id: 6 }, { id: 7 }]]);
    expect(
      await scope(() =>
        prepareCreationContact(1, 8, "whatsapp", {
          providerAccountId: "account-1",
        }),
      ),
    ).toMatchObject({
      error: expect.stringContaining("Several outreach contacts"),
    });
    expect(createdContactLead).not.toHaveBeenCalled();
  });
  it("does not create a lead for social outreach when the contact has no inbound conversation", async () => {
    reads([[contact]]);
    expect(
      await scope(() =>
        prepareCreationContact(1, 8, "instagram", {
          providerAccountId: "account-1",
        }),
      ),
    ).toMatchObject({
      error: expect.stringContaining("customer must message"),
    });
    expect(createdContactLead).not.toHaveBeenCalled();
  });
});

describe("reviewed scheduling and templates", () => {
  it("accepts a future UTC send time and increasing follow-up offsets", () => {
    const date = new Date(Date.now() + 3600000).toISOString();
    expect(
      validateOutreachTiming(date, [
        { delayMinutes: 60, message: "Hello" },
        { delayMinutes: 1440, message: "Checking in" },
      ])?.toISOString(),
    ).toBe(date);
  });
  it.each([
    new Date(Date.now() - 1000).toISOString(),
    "2026-09-30T09:00",
    new Date(Date.now() + 100 * 86400000).toISOString(),
  ])("rejects unreviewable schedule %s", (value) =>
    expect(() => validateOutreachTiming(value, [])).toThrow(),
  );
  it("rejects duplicate delays and unresolved variables", () => {
    expect(() =>
      validateOutreachTiming(undefined, [
        { delayMinutes: 60, message: "Hello" },
        { delayMinutes: 60, message: "Hello again" },
      ]),
    ).toThrow(/times must increase/);
    expect(() =>
      validateOutreachTiming(undefined, [
        { delayMinutes: 60, message: "Hello {{first_name}}" },
      ]),
    ).toThrow(/personalization/);
  });
  it("rejects unresolved subject or HTML variables in follow-ups before creating a send intent", () => {
    for (const values of [
      { subject: "Hello {{first_name}}" },
      { htmlContent: "<p>{{company}}</p>" },
    ]) {
      expect(() =>
        validateOutreachTiming(undefined, [
          { delayMinutes: 60, message: "Hello Ada", ...values },
        ]),
      ).toThrow(/personalization/);
    }
  });
  it("requires all named template parameters and valid media", () => {
    const template = {
      id: "t",
      name: "welcome",
      language: "en_US",
      body: "Hi {{customer}}",
      headerType: "IMAGE",
    };
    expect(() =>
      validateCreationTemplate(template, [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Ada", parameter_name: "customer" },
          ],
        },
        {
          type: "header",
          parameters: [
            { type: "image", image: { link: "https://example.com/photo.jpg" } },
          ],
        },
      ]),
    ).not.toThrow();
    expect(() =>
      validateCreationTemplate(template, [
        { type: "body", parameters: [{ type: "text", text: "Ada" }] },
      ]),
    ).toThrow(/variable/);
    expect(() =>
      validateCreationTemplate(template, [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Ada", parameter_name: "customer" },
          ],
        },
      ]),
    ).toThrow(/HTTPS/);
  });
});
