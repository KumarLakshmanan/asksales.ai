import type { OutreachChannel } from "./types";

export interface ChannelCapabilities {
  label: string;
  placeholder: string;
  characterLimit?: number;
  supportsSubject: boolean;
  supportsAttachments: boolean;
  supportsTemplates: boolean;
  sendHint: string;
}

export const channelCapabilities: Record<OutreachChannel, ChannelCapabilities> = {
  email: { label: "Email", placeholder: "Write an email…", supportsSubject: true, supportsAttachments: true, supportsTemplates: true, sendHint: "Ctrl/⌘ + Enter to send" },
  instagram: { label: "Instagram", placeholder: "Write an Instagram message…", characterLimit: 1000, supportsSubject: false, supportsAttachments: true, supportsTemplates: true, sendHint: "Ctrl/⌘ + Enter to send" },
  sms: { label: "SMS", placeholder: "Write an SMS…", supportsSubject: false, supportsAttachments: false, supportsTemplates: true, sendHint: "SMS segment estimate" },
  whatsapp: { label: "WhatsApp", placeholder: "Write a WhatsApp message…", characterLimit: 4096, supportsSubject: false, supportsAttachments: true, supportsTemplates: true, sendHint: "Ctrl/⌘ + Enter to send" },
  facebook: { label: "Facebook", placeholder: "Write a Messenger reply…", characterLimit: 2000, supportsSubject: false, supportsAttachments: true, supportsTemplates: true, sendHint: "Ctrl/⌘ + Enter to send" },
  twitter: { label: "X", placeholder: "Write a direct message…", characterLimit: 10000, supportsSubject: false, supportsAttachments: true, supportsTemplates: true, sendHint: "Ctrl/⌘ + Enter to send" },
  linkedin: { label: "LinkedIn", placeholder: "Write a LinkedIn message…", characterLimit: 1900, supportsSubject: false, supportsAttachments: true, supportsTemplates: true, sendHint: "Ctrl/⌘ + Enter to send" },
};

export function getChannelCapabilities(channel: OutreachChannel) {
  return channelCapabilities[channel];
}
