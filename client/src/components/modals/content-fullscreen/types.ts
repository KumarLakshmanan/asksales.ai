import React from "react";

// Content types
export type ContentType = "image" | "video" | "email" | "sms" | "social_message" | "social_post" | "ad_copy";

// Common parsed content interface
export interface ParsedContent {
  body?: string;
  message?: string;
  content?: string;
  subject?: string;
  greeting?: string;
  closing?: string;
  signature?: string;
  cta?: string;
  headline?: string;
  description?: string;
  primaryText?: string;
  callToAction?: string;
  displayUrl?: string;
  caption?: string;
  hashtags?: string[];
  recipientName?: string;
  platform?: string;
  imageUrl?: string;
  videoUrl?: string;
  imageUrls?: string[];
  videoUrls?: string[];
  imagePrompts?: string[];
  videoPrompts?: string[];
  characterCount?: number;
}

// Media item for carousel
export interface MediaItem {
  type: "image" | "video" | "image_placeholder" | "video_placeholder";
  url?: string;
  prompt?: string;
}

// Common props for content renderers
export interface ContentRendererProps {
  parsedContent: ParsedContent;
  content: string;
  title: string;
  platform?: string;
  channel?: string;
}

// Full modal props
export interface ContentFullscreenModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contentType: ContentType;
  title: string;
  content: string;
  status?: string;
  channel?: string;
  platform?: string;
  createdAt?: string | number;
  imageUrl?: string;
  videoUrl?: string;
  imageUrls?: string[];
  videoUrls?: string[];
  prompt?: string;
  imagePrompt?: string;
  videoPrompt?: string;
  customActions?: React.ReactNode;
}
