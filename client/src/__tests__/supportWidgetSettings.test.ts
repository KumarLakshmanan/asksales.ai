import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIDGET_SETTINGS,
  normalizeWidgetSettings,
  widgetSettingsError,
  widgetRequestOrigin,
  widgetColorForeground,
} from "@/lib/support-widget-settings";
describe("widget settings validation", () => {
  it("retains defaults for older teams and permits a complete appearance", () => {
    expect(normalizeWidgetSettings({})).toEqual(DEFAULT_WIDGET_SETTINGS);
    expect(
      widgetSettingsError({
        ...DEFAULT_WIDGET_SETTINGS,
        logoUrl: "https://cdn.example.com/logo.png",
        launcherPosition: "left",
      }),
    ).toBeNull();
  });
  it.each([
    "javascript:alert(1)",
    "http://example.com/logo.png",
    "https://user:password@example.com/logo.png",
  ])("rejects an unsafe logo URL: %s", (logoUrl) => {
    expect(
      widgetSettingsError({ ...DEFAULT_WIDGET_SETTINGS, logoUrl }),
    ).toBeTruthy();
  });
  it("rejects script interpolation, invalid positions and excessive greeting text", () => {
    expect(
      widgetSettingsError({
        ...DEFAULT_WIDGET_SETTINGS,
        primaryColor: "#fff;}</style>",
      }),
    ).toBeTruthy();
    expect(
      widgetSettingsError({
        ...DEFAULT_WIDGET_SETTINGS,
        launcherPosition: "top",
      }),
    ).toBeTruthy();
    expect(
      widgetSettingsError({
        ...DEFAULT_WIDGET_SETTINGS,
        greeting: "a".repeat(501),
      }),
    ).toBeTruthy();
  });
  it("accepts only actual origins, not a path or credentials", () => {
    expect(widgetRequestOrigin("https://customer.example")).toBe(
      "https://customer.example",
    );
    expect(widgetRequestOrigin("https://customer.example/path")).toBeNull();
    expect(widgetRequestOrigin("null")).toBeNull();
    expect(
      widgetRequestOrigin("https://user:secret@customer.example"),
    ).toBeNull();
  });
  it("chooses legible foregrounds for pale and dark colors", () => {
    expect(widgetColorForeground("#ffffff")).toBe("#111827");
    expect(widgetColorForeground("#000000")).toBe("#ffffff");
  });
});
