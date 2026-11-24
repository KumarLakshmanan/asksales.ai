import { describe, expect, it, jest } from "@jest/globals";
const create = jest.fn<any>(async (data: any) => ({
  id: 77,
  version: 1,
  ...data,
}));
jest.unstable_mockModule("../models/contentTemplates/functions.js", () => ({
  createContentTemplate: create,
  ContentTemplateVersionConflictError: class extends Error {},
}));
jest.unstable_mockModule("../models/brandToolkits/functions.js", () => ({
  BrandToolkitModel: {},
}));
jest.unstable_mockModule(
  "../services/content/ContentBrandContextService.js",
  () => ({
    ContentBrandContextError: class extends Error {},
    resolveContentBrandContext: async () => ({
      businessProfile: { id: 10, version: 1 },
      brandToolkit: { id: 20, version: 1 },
    }),
    brandContextSnapshot: () => ({
      provenance: {
        businessProfile: { version: 1 },
        brandToolkit: { version: 1 },
      },
    }),
  }),
);
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: { error: jest.fn() },
}));
const { createContentTemplate } =
  await import("../controllers/contentTemplatesController.js");
const { mockAuthRequest, mockResponse } =
  await import("../tests/helpers/mockHelpers.js");
describe("audit: actual content-template save controller", () => {
  it.each(["{{1}}", "{{ unknown label }}", "{{}}"])(
    "rejects unsupported placeholder %s before approval",
    async (token) => {
      const res = mockResponse();
      await createContentTemplate(
        mockAuthRequest(1, {
          body: {
            name: "Synthetic unsupported variable",
            type: "email",
            content: "Hello " + token,
          },
        }),
        res,
      );
      expect(res._status).toBe(400);
      expect(res._json.code).toBe("INVALID_TEMPLATE_VARIABLE");
    },
  );
});
