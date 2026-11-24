export interface SupportWidgetSettings {
  displayName: string;
  greeting: string;
  primaryColor: string;
  logoUrl: string;
  launcherPosition: "left" | "right";
}
export interface WidgetInstallation {
  hostname: string;
  origin: string;
  lastSeenAt: string;
}
export const DEFAULT_WIDGET_SETTINGS: SupportWidgetSettings = {
  displayName: "",
  greeting: "Hi! How can we help you today?",
  primaryColor: "#6366f1",
  logoUrl: "",
  launcherPosition: "right",
};
export function normalizeWidgetSettings(value: unknown): SupportWidgetSettings {
  const settings =
    value && typeof value === "object"
      ? (value as Partial<SupportWidgetSettings>)
      : {};
  let logoUrl = typeof settings.logoUrl === "string" ? settings.logoUrl : "";
  try {
    const url = new URL(logoUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      logoUrl.length > 2000
    )
      logoUrl = "";
  } catch {
    logoUrl = "";
  }
  return {
    displayName:
      typeof settings.displayName === "string"
        ? settings.displayName.trim().slice(0, 100)
        : "",
    greeting:
      typeof settings.greeting === "string" && settings.greeting.trim()
        ? settings.greeting.slice(0, 500)
        : DEFAULT_WIDGET_SETTINGS.greeting,
    primaryColor:
      typeof settings.primaryColor === "string" &&
      /^#[a-f0-9]{6}$/i.test(settings.primaryColor)
        ? settings.primaryColor
        : DEFAULT_WIDGET_SETTINGS.primaryColor,
    logoUrl,
    launcherPosition: settings.launcherPosition === "left" ? "left" : "right",
  };
}
export function widgetSettingsError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Widget settings are required.";
  const v = value as Record<string, unknown>;
  if (typeof v.displayName !== "string" || v.displayName.trim().length > 100)
    return "Display name must be 100 characters or fewer.";
  if (
    typeof v.greeting !== "string" ||
    !v.greeting.trim() ||
    v.greeting.length > 500
  )
    return "Greeting must contain 1–500 characters.";
  if (
    typeof v.primaryColor !== "string" ||
    !/^#[a-f0-9]{6}$/i.test(v.primaryColor)
  )
    return "Choose a six-digit hex color.";
  if (v.launcherPosition !== "left" && v.launcherPosition !== "right")
    return "Choose a left or right button position.";
  if (typeof v.logoUrl !== "string" || v.logoUrl.length > 2000)
    return "Logo URL must be 2,000 characters or fewer.";
  if (v.logoUrl) {
    try {
      const url = new URL(v.logoUrl);
      if (url.protocol !== "https:" || url.username || url.password)
        return "Use an HTTPS logo URL without credentials.";
    } catch {
      return "Use a valid HTTPS logo URL.";
    }
  }
  return null;
}
export function widgetColorForeground(hex: string): string {
  const channels = [1, 3, 5]
    .map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2] >
    0.179
    ? "#111827"
    : "#ffffff";
}
export function widgetRequestOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      url.origin === value &&
      !url.username &&
      !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
