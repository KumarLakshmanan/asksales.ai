import { describe, expect, it } from "vitest";
import { shouldSkipOwnerAuthCheck } from "@/lib/authSurface";

describe("support auth surface isolation", () => {
  it.each([
    "/support",
    "/support/login",
    "/support/dashboard",
    "/support/settings",
    "/support-widget",
    "/support-widget/widget-token",
  ])("skips the owner auth probe on %s", (pathname) => {
    expect(shouldSkipOwnerAuthCheck(pathname)).toBe(true);
  });

  it.each([
    "/",
    "/login",
    "/dashboard/support",
    "/dashboard/support/analytics",
    "/admin",
  ])("keeps the owner auth probe on %s", (pathname) => {
    expect(shouldSkipOwnerAuthCheck(pathname)).toBe(false);
  });
});
