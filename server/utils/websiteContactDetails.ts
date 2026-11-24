import * as cheerio from "cheerio";
import { EMAIL_ADDRESS_PATTERN as EMAIL } from "../../shared/emailAddress.js";

const validPhone = (value: string) => {
  const count = value.replace(/\D/g, "").length;
  return count >= 7 && count <= 15;
};

/** Read public contact markup directly so it is not lost during text/LLM extraction. */
export function extractWebsiteContactDetails(pages: { html: string }[]): {
  email?: string;
  phone?: string;
} {
  const result: { email?: string; phone?: string } = {};
  for (const page of pages) {
    const $ = cheerio.load(page.html);
    if (!result.email) {
      $('a[href^="mailto:"]').each((_index, anchor) => {
        if (result.email) return;
        try {
          const email = decodeURIComponent(
            ($(anchor).attr("href") || "").slice(7).split("?")[0],
          ).trim();
          if (EMAIL.test(email)) result.email = email;
        } catch {
          /* Ignore malformed URI encoding. */
        }
      });
      $("[data-cfemail]").each((_index, element) => {
        if (result.email) return;
        const encoded = $(element).attr("data-cfemail") || "";
        if (!/^(?:[0-9a-f]{2}){2,}$/i.test(encoded)) return;
        const key = parseInt(encoded.slice(0, 2), 16);
        const email = Array.from({ length: encoded.length / 2 - 1 }, (_, i) =>
          String.fromCharCode(
            parseInt(encoded.slice((i + 1) * 2, (i + 2) * 2), 16) ^ key,
          ),
        ).join("");
        if (EMAIL.test(email)) result.email = email;
      });
    }
    if (!result.phone) {
      $('a[href^="tel:"]').each((_index, anchor) => {
        if (result.phone) return;
        const phone = ($(anchor).attr("href") || "").slice(4).trim();
        if (validPhone(phone)) result.phone = phone;
      });
      if (!result.phone) {
        const phone = $("body")
          .text()
          .match(
            /(?:call(?:\s+us)?|mobile|phone|telephone)[\s:.-]*(\+?\d[\d\s().-]{5,35}\d)/i,
          )?.[1]
          ?.trim();
        if (phone && validPhone(phone)) result.phone = phone;
      }
    }
  }
  return result;
}
