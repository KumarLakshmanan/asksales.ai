import api from "@/lib/api";
import { msg91State } from "@/lib/integrations";
import type { MSG91SettingsResponse } from "../../../shared/msg91";

export type OutreachIntegration =
  | "email"
  | "instagram"
  | "facebook"
  | "twitter"
  | "linkedin"
  | "whatsapp"
  | "sms";

interface OAuthStatus {
  officialApi?: { connected?: boolean };
}

/**
 * Returns whether an integration can execute outreach, not merely whether a
 * configuration record exists. Social channels require an official API connection.
 */
export async function getOutreachIntegrationStatus(platform: OutreachIntegration): Promise<boolean> {
  switch (platform) {
    case "email": {
      const result = await api.get<{ connected?: boolean; resend?: { configured?: boolean } }>("/api/email/status");
      return Boolean(result.connected || result.resend?.configured);
    }
    case "instagram":
    case "facebook":
    case "twitter":
    case "linkedin": {
      const oauth = await api.get<OAuthStatus>(`/api/${platform}/oauth/status`);
      return Boolean(oauth.officialApi?.connected);
    }
    case "whatsapp": {
      const result = await api.get<{ connected?: boolean; configured?: boolean }>("/api/integrations/whatsapp/status");
      return Boolean(result.connected || result.configured);
    }
    case "sms": {
      const result = await api.get<MSG91SettingsResponse>("/api/msg91-settings");
      return msg91State(result) === "connected";
    }
  }
}
