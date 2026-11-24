import { describe, expect, it } from "vitest";
import {
  curatedWhatsAppTemplates,
  replaceTemplateVariables,
} from "@/components/whatsapp-templates/templateData";
import {
  applyWhatsAppExamples,
  normalizeWhatsAppExamples,
  whatsappVariableError,
} from "@/lib/whatsapp-template-variables";

describe("WhatsApp template library data", () => {
  it("keeps every preset addressable by a unique route id", () => {
    const ids = curatedWhatsAppTemplates.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes presets for all Meta template categories", () => {
    const categories = new Set(curatedWhatsAppTemplates.map((template) => template.category));
    expect(categories).toEqual(new Set(["MARKETING", "UTILITY", "AUTHENTICATION"]));
  });

  it("renders numbered WhatsApp variables as readable preview values", () => {
    expect(replaceTemplateVariables("Hi {{1}}, order {{2}} arrives {{3}}."))
      .toBe("Hi Alex, order AskSales arrives Friday.");
  });

  it("tracks header and body examples independently", () => {
    const examples = normalizeWhatsAppExamples(
      { "header:1": "Customer", "body:1": "ORDER-42" },
      "Hello {{1}}",
      "Order {{1}} is ready",
    );
    expect(applyWhatsAppExamples("Hello {{1}}", examples, "header")).toBe("Hello Customer");
    expect(applyWhatsAppExamples("Order {{1}} is ready", examples, "body")).toBe("Order ORDER-42 is ready");
  });

  it("rejects named, malformed, and non-contiguous variables", () => {
    expect(whatsappVariableError("Hi {{name}}", "Body")).toMatch(/numbered format/);
    expect(whatsappVariableError("Hi {{2}}", "Body")).toMatch(/without gaps/);
    expect(whatsappVariableError("Hi {{1}} and {{2}}", "Body")).toBeNull();
  });
});
