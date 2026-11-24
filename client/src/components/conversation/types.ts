import type { ReactNode } from "react";

export type ConversationSurface = "campaign" | "support" | "outreach";

export type ConversationActivityStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "gated"
  | "awaiting_approval";

export interface ConversationSource {
  id?: string | number;
  title: string;
  excerpt?: string;
  similarity?: number;
  type?: string;
  filename?: string;
  href?: string;
}
export interface ConversationActivityStep {
  id: string;
  label: string;
  detail?: string;
  status: ConversationActivityStatus;
  durationMs?: number;
  icon?: ReactNode;
  children?: ReactNode;
}

export interface ConversationAttachmentView {
  id: string | number;
  name: string;
  href?: string;
  mimeType?: string;
  size?: number;
  status?: "ready" | "uploading" | "failed" | "blocked";
  detail?: string;
}

export interface ComposerAction {
  id: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}
