import { describe, expect, it } from "vitest";
import { maskEmail } from "@/lib/mask-email";

describe("maskEmail", () => {
  it("keeps the first character and the domain of a personal email", () => {
    expect(maskEmail("person@gmail.com")).toBe("p***@gmail.com");
  });

  it("returns null for an empty value so the caller can fall back", () => {
    expect(maskEmail("  ")).toBeNull();
    expect(maskEmail(null)).toBeNull();
  });

  it("never returns the local part of a malformed address", () => {
    expect(maskEmail("@gmail.com")).toBe("***");
    expect(maskEmail("nodomain")).toBe("***");
  });
});
