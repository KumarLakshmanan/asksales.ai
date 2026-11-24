import { afterEach, describe, expect, it, jest } from "@jest/globals";
const template = {
  id: 77,
  userId: 1,
  type: "email",
  version: 1,
  isApproved: true,
  isPredefined: false,
  businessProfileId: 10,
  brandToolkitId: 20,
  content: "As of {{current_date}}, hello {{first_name}}",
  subject: null,
  htmlContent: null,
  brandContextSnapshot: {
    provenance: {
      businessProfile: { version: 1 },
      brandToolkit: { version: 1 },
    },
  },
};
jest.unstable_mockModule("../models/contentTemplates/functions.js", () => ({
  getContentTemplateById: async () => template,
}));
jest.unstable_mockModule(
  "../services/content/ContentBrandContextService.js",
  () => ({
    resolveContentBrandContext: async () => ({
      businessProfile: { id: 10, version: 1, timezone: "UTC" },
      brandToolkit: { id: 20, version: 1 },
    }),
  }),
);
const { resolveApprovedTemplate, assertApprovedTemplateDelivery } =
  await import("../services/content/ApprovedTemplateResolver.js");
afterEach(() => {
  jest.useRealTimers();
});
describe("audit: delayed approved template crossing midnight", () => {
  it("preserves the reviewed date across midnight while retaining signed context checks", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-23T23:59:00Z"));
    const rendered = await resolveApprovedTemplate(1, 77, {
      first_name: "Ada",
    });
    const snapshot = {
      sourceTemplateId: 77,
      sourceTemplateVersion: 1,
      templateRenderContext: rendered.templateRenderContext,
      content: rendered.content,
      subject: rendered.subject,
      htmlContent: rendered.htmlContent,
    };
    const recipient = {
      firstName: "Ada",
      lastName: "",
      fullName: "Ada",
      name: "Ada",
      company: "",
      email: "ada@example.test",
      phone: "",
    };
    await expect(
      assertApprovedTemplateDelivery(1, "email", snapshot, recipient),
    ).resolves.toBeUndefined();
    jest.setSystemTime(new Date("2026-10-24T00:01:00Z"));
    await expect(
      assertApprovedTemplateDelivery(1, "email", snapshot, recipient),
    ).resolves.toBeUndefined();
    const altered = {
      ...snapshot,
      templateRenderContext: {
        ...snapshot.templateRenderContext,
        renderedAt: "2030-01-01T00:00:00Z",
      },
    };
    await expect(
      assertApprovedTemplateDelivery(1, "email", altered, recipient),
    ).rejects.toMatchObject({ code: "INVALID_TEMPLATE_RENDER_CONTEXT" });
    template.version = 2;
    await expect(
      assertApprovedTemplateDelivery(1, "email", snapshot, recipient),
    ).rejects.toMatchObject({ code: "TEMPLATE_VERSION_CONFLICT" });
    template.version = 1;
  });
});
