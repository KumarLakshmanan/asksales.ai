import type { WhatsAppTemplateButton } from "@/components/whatsapp-templates/templateData";

export const WHATSAPP_MAX_VARIABLE_EXAMPLES = 20;

export function whatsappButtonErrors(button: WhatsAppTemplateButton): Partial<Record<"text" | "url" | "phone_number", string>> {
  const errors: Partial<Record<"text" | "url" | "phone_number", string>> = {};
  if (!button.text.trim()) errors.text = "Add a label for this button.";
  else if (button.text.length > 25) errors.text = "Use 25 characters or fewer.";
  if (button.type === "URL") {
    try {
      if (!["http:", "https:"].includes(new URL(button.url || "").protocol)) throw new Error("protocol");
    } catch { errors.url = "Enter a complete website URL, such as https://example.com."; }
  }
  if (button.type === "PHONE_NUMBER" && !/^\+?[0-9 ()-]{7,24}$/.test(button.phone_number?.trim() || "")) {
    errors.phone_number = "Enter a phone number with its country code, such as +1 415 555 0123.";
  }
  return errors;
}
