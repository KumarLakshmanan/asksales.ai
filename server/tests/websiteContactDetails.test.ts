import { describe, expect, it } from "@jest/globals";
import { extractWebsiteContactDetails } from "../utils/websiteContactDetails";

describe("public website contact extraction", () => {
  it("reads mailto and tel links without relying on generated text", () => {
    expect(
      extractWebsiteContactDetails([
        {
          html: '<a href="mailto:hello%40example.com?subject=Hello">Email</a><a href="tel:+91 6361666629">Call</a>',
        },
      ]),
    ).toEqual({ email: "hello@example.com", phone: "+91 6361666629" });
  });
  it("decodes public protected-email markup and labeled contact text", () => {
    const email = "support@example.com";
    const encoded =
      "42" +
      Array.from(email)
        .map((c) => (c.charCodeAt(0) ^ 0x42).toString(16).padStart(2, "0"))
        .join("");
    expect(
      extractWebsiteContactDetails([
        {
          html: `<span data-cfemail="${encoded}">[email protected]</span><p>Call us: +91 6361666629 (Mon-Sat, 10 am - 7 pm)</p>`,
        },
      ]),
    ).toEqual({ email, phone: "+91 6361666629" });
  });
  it("ignores malformed data and unrelated numbers", () => {
    expect(
      extractWebsiteContactDetails([
        {
          html: '<a href="mailto:%GG">Email</a><span data-cfemail="oops"></span><p>Founded 2023, 100000 subscribers</p>',
        },
      ]),
    ).toEqual({});
  });
});
