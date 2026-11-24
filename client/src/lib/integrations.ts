import { BarChart3, Facebook, FileText, Globe, Instagram, Mail, Megaphone, MessageCircle, MessageSquare, Phone, Send, Webhook, Workflow, Youtube, type LucideIcon } from "lucide-react";
import type { MSG91SettingsResponse } from "../../../shared/msg91";

export type IntegrationId = "instagram" | "whatsapp" | "facebook" | "email" | "meta" | "google-ads" | "msg91" | "youtube";
export type ConnectionState = "connected" | "disconnected" | "selection" | "action_required" | "reconnect" | "paused" | "unavailable";
export interface IntegrationFeature { name: string; description: string; icon: LucideIcon; href: string; scope?: string }
export interface IntegrationDefinition {
  id: IntegrationId; name: string; description: string; icon: LucideIcon; color: string; banner: string; connectLabel: string; prerequisite: string; features: IntegrationFeature[];
}

export const integrationDefinitions: IntegrationDefinition[] = [
  { id: "instagram", name: "Instagram", description: "Messages and content for your professional account.", icon: Instagram, color: "#db2777", banner: "bg-gradient-to-r from-orange-500 via-rose-600 to-fuchsia-700", connectLabel: "Continue with Instagram", prerequisite: "Sign in directly with your Instagram Business or Creator account. No Facebook Page is required. If you have a personal account, switch it to a professional account in Instagram first.", features: [
    { name: "Instagram messages", description: "Manage conversations with your Instagram audience.", icon: MessageCircle, href: "/dashboard/outreach/instagram", scope: "instagram_manage_messages" },
    { name: "Instagram automations", description: "Set up suggested questions, menus, and responses to comments.", icon: Workflow, href: "/dashboard/integrations/instagram/automations" },
    { name: "Content publishing", description: "Choose a saved social post to review and publish.", icon: Send, href: "/dashboard/saved-templates/social", scope: "instagram_content_publish" },
    { name: "Account analytics", description: "Review performance for your connected account.", icon: BarChart3, href: "/dashboard/marketing/analytics?tab=overview&platform=instagram", scope: "instagram_manage_insights" },
    { name: "Events and activity", description: "See messages and interactions received from Instagram.", icon: Webhook, href: "/dashboard/integrations/instagram/events" },
  ] },
  { id: "whatsapp", name: "WhatsApp", description: "Customer conversations with WhatsApp Business.", icon: Phone, color: "#16a34a", banner: "bg-gradient-to-r from-emerald-600 to-teal-700", connectLabel: "Connect WhatsApp Business", prerequisite: "Connect an eligible WhatsApp Business account and phone number through Meta. A personal WhatsApp account cannot connect directly to the Cloud API.", features: [
    { name: "WhatsApp messages", description: "Send messages and manage customer replies.", icon: MessageCircle, href: "/dashboard/outreach/whatsapp" },
    { name: "Message templates", description: "Create drafts and check template approval status.", icon: FileText, href: "/dashboard/integrations/whatsapp/templates" },
    { name: "Events and activity", description: "See customer messages and delivery updates.", icon: Webhook, href: "/dashboard/integrations/whatsapp/events" },
  ] },
  { id: "facebook", name: "Facebook", description: "Your Facebook Page and Messenger conversations.", icon: Facebook, color: "#1877f2", banner: "bg-gradient-to-r from-blue-600 to-indigo-700", connectLabel: "Continue with Facebook", prerequisite: "Sign in with your Facebook account, then choose a Page you can manage. AskSales connects the Page and Messenger; personal profile inboxes are not supported.", features: [
    { name: "Messenger", description: "Manage conversations sent to your Facebook Page.", icon: MessageCircle, href: "/dashboard/outreach/facebook", scope: "pages_messaging" },
    { name: "Page publishing", description: "Choose a saved social post to review and publish to your Page.", icon: Send, href: "/dashboard/saved-templates/social", scope: "pages_manage_posts" },
    { name: "Page analytics", description: "Review organic content performance.", icon: BarChart3, href: "/dashboard/marketing/analytics?tab=overview&platform=facebook", scope: "pages_read_engagement" },
    { name: "Events and activity", description: "See Messenger messages and Page interactions.", icon: Webhook, href: "/dashboard/integrations/facebook/events" },
  ] },
  { id: "email", name: "Email", description: "Gmail and verified sending domains in one place.", icon: Mail, color: "#7c3aed", banner: "bg-gradient-to-r from-violet-600 to-indigo-700", connectLabel: "Connect Gmail", prerequisite: "Connect your Gmail account with Google, or verify a sending domain and add a sender in this card.", features: [
    { name: "Email outreach", description: "Send messages using your connected sender.", icon: Mail, href: "/dashboard/outreach/inbox?channel=email" },
    { name: "Conversations", description: "Review replies from connected email accounts.", icon: MessageSquare, href: "/dashboard/outreach/inbox" },
    { name: "Sender settings", description: "Manage Gmail, domains, DNS and sender addresses.", icon: Send, href: "#connection-settings" },
  ] },
  { id: "meta", name: "Meta Ads", description: "Facebook and Instagram advertising accounts.", icon: Megaphone, color: "#2563eb", banner: "bg-gradient-to-r from-sky-600 to-blue-800", connectLabel: "Connect Meta Ads", prerequisite: "Sign in with Facebook and select an ad account and Page you have permission to use. Your Page messaging connections are managed separately.", features: [
    { name: "Paid campaigns", description: "Manage campaigns for your connected Meta ad accounts.", icon: Megaphone, href: "/dashboard/ads?tab=campaigns&platform=meta" },
    { name: "Ad performance", description: "Review campaign results and advertising spend.", icon: BarChart3, href: "/dashboard/ads?tab=overview&platform=meta" },
    { name: "Account and Page", description: "Choose which ad account and Page AskSales uses.", icon: Facebook, href: "#connection-settings" },
  ] },
  { id: "google-ads", name: "Google Ads", description: "Connect your Google Ads customer account.", icon: Globe, color: "#ca8a04", banner: "bg-gradient-to-r from-blue-600 to-cyan-600", connectLabel: "Connect with Google", prerequisite: "Sign in with a Google account that manages Google Ads, then choose an authorized customer account.", features: [
    { name: "Paid campaigns", description: "Manage campaigns for your connected Google Ads accounts.", icon: Megaphone, href: "/dashboard/ads?tab=campaigns&platform=google" },
    { name: "Ad performance", description: "Review results for your connected Google Ads accounts.", icon: BarChart3, href: "/dashboard/ads?tab=overview&platform=google" },
    { name: "Customer account", description: "Choose which authorized Google Ads account AskSales uses.", icon: Globe, href: "#connection-settings" },
  ] },
  { id: "msg91", name: "SMS", description: "Send SMS outreach through your MSG91 sender and approved template.", icon: MessageSquare, color: "#d97706", banner: "bg-amber-600", connectLabel: "Set up SMS", prerequisite: "Add your MSG91 Auth Key, approved Sender ID, and SMS Template ID to connect SMS outreach.", features: [
    { name: "SMS outreach", description: "Send and review customer SMS conversations.", icon: MessageSquare, href: "/dashboard/outreach/sms" },
    { name: "Sender and template", description: "Manage the sender and approved message template used for SMS.", icon: Phone, href: "#connection-settings" },
    { name: "Delivery and replies", description: "Set up MSG91 delivery reports and optional incoming SMS.", icon: Webhook, href: "#connection-settings" },
    { name: "Events and activity", description: "Review delivery updates, received messages, and callback errors.", icon: BarChart3, href: "/dashboard/integrations/msg91/events" },
  ] },
  { id: "youtube", name: "YouTube", description: "Publish approved videos to your connected channel.", icon: Youtube, color: "#dc2626", banner: "bg-red-600", connectLabel: "Continue with Google", prerequisite: "Sign in with a Google account that has a YouTube channel and approve channel access.", features: [
    { name: "Video publishing", description: "Choose a saved social post with a video to review and publish.", icon: Send, href: "/dashboard/saved-templates/social" },
    { name: "Channel tools", description: "Manage channel videos, playlists, captions, and comments.", icon: Youtube, href: "#connection-settings" },
  ] },
];

export const integrationPath = (id: IntegrationId) => `/dashboard/integrations/${id}`;
export const integrationDefinition = (id: IntegrationId) => integrationDefinitions.find(item => item.id === id)!;
export const connectionLabels: Record<ConnectionState, string> = { connected: "Connected", disconnected: "Not connected", selection: "Choose account", action_required: "Action required", reconnect: "Reconnect required", paused: "Paused", unavailable: "Status unavailable" };

export interface MetaCapability { scope: string; status: "available" | "limited" | "blocked"; tokenGranted: boolean; appReviewStatus: string; reason?: string | null }
export interface MetaMessagingAccount {
  connected: boolean; authorized?: boolean; selectionRequired?: boolean; requiresReconnect?: boolean;
  loginConfigured?: boolean;
  username: string | null; pageId?: string | null; instagramAccountId?: string | null;
  tokenExpired: boolean; expiresAt: string | null; connectionMethod?: "oauth" | "manual" | null; loginMethod?: "instagram" | "facebook";
  credentialId?: number | null; profilePicture?: string | null; pagePictureUrl?: string | null;
  followersCount?: number | null; pageName?: string | null; instagramUsername?: string | null;
  webhookSubscribed?: boolean; grantedScopes?: string[]; declinedScopes?: string[];
  capabilities?: MetaCapability[]; readinessErrorCode?: string | null; lastVerifiedAt?: string | null;
  missingScopes?: string[];
}
export interface MetaMessagingStatus { officialApi: MetaMessagingAccount }

export function messagingState(account: MetaMessagingAccount | undefined, error?: string | null): ConnectionState {
  if (error) return "unavailable";
  if (account?.requiresReconnect || account?.tokenExpired) return "reconnect";
  if (account?.selectionRequired) return "selection";
  if (!account?.connected) return account?.authorized ? "action_required" : "disconnected";
  return "connected";
}

export function messagingNextStep(account: MetaMessagingAccount | undefined, platform: "instagram" | "facebook"): string | undefined {
  if (account?.readinessErrorCode === "REQUIRED_SCOPES") return "Some required account permissions were not granted. Reconnect and allow the required account and messaging permissions.";
  if (account?.requiresReconnect || account?.tokenExpired) return `Your authorization has expired or was revoked. Reconnect with ${platform === "instagram" ? "Instagram" : "Facebook"} to restore access.`;
  if (account?.selectionRequired) return platform === "instagram" ? "Choose the Instagram account you want AskSales to use." : "Choose the Facebook Page you want AskSales to use for Messenger.";
  if (!account?.authorized || account.connected) return undefined;
  const required = platform === "instagram" ? account.loginMethod === "instagram" ? "instagram_business_manage_messages" : "instagram_manage_messages" : "pages_messaging";
  if (!account.grantedScopes?.includes(required)) return "Messaging permission was not granted. Reconnect and allow access to messages for the selected account.";
  if (account.missingScopes?.length) return "Some required account permissions were not granted. Reconnect and allow the required account and messaging permissions.";
  if (!account.webhookSubscribed) return "Incoming message setup is incomplete. Reconnect to retry, or contact support if the issue continues.";
  return "This account needs attention. Check the connection options in this card or contact support.";
}

export function metaAdsState(account?: { isActive: boolean; selectionRequired?: boolean; expiresAt?: string | null; adAccountId?: string | null; pageId?: string | null; capabilities?: MetaCapability[] } | null): ConnectionState {
  if (account?.expiresAt && new Date(account.expiresAt).getTime() <= Date.now()) return "reconnect";
  if (!account?.isActive) return "disconnected";
  if (account.selectionRequired || !account.adAccountId || !account.pageId) return "selection";
  return account.capabilities?.some(capability => ["ads_read", "ads_management"].includes(capability.scope) && !capability.tokenGranted) ? "action_required" : "connected";
}

export function googleAdsState(config?: { ready?: boolean; hasRefreshToken?: boolean; refreshToken?: string } | null): ConnectionState {
  return config?.ready ? "connected" : config?.hasRefreshToken || config?.refreshToken ? "action_required" : "disconnected";
}

export function whatsappState(status: { configured: boolean; enabled?: boolean; config?: { connectionStatus?: string; tokenStatus?: string } | null }): ConnectionState {
  if (!status.configured) return "disconnected";
  if (status.config?.connectionStatus === "reauth_required" || ["expired", "invalid"].includes(status.config?.tokenStatus || "")) return "reconnect";
  if (!["ready", "limited"].includes(status.config?.connectionStatus || "")) return "action_required";
  return status.enabled === false ? "paused" : "connected";
}

export function msg91State(status?: MSG91SettingsResponse | null, error?: string | null): ConnectionState {
  if (error || status?.success === false) return "unavailable";
  if (status?.settings?.connectionStatus === "reauth_required") return "reconnect";
  if (status?.connected === true && status.settings?.connectionStatus === "ready") return "connected";
  return status?.settings ? "action_required" : "disconnected";
}
