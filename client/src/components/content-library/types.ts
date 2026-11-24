import { Mail, MessageSquare, Share2, Megaphone, Image, Video, LayoutGrid, FileText } from 'lucide-react';
import { createElement } from 'react';

export type ContentTabType = 'all' | 'image' | 'video' | 'email' | 'sms' | 'whatsapp' | 'social' | 'social_message' | 'ad_copy' | 'blog';

export interface BrandToolkit {
  id: number;
  name: string;
  brandName?: string;
  tagline?: string;
  missionStatement?: string;
  primaryColors?: string[];
  primaryBrandColor?: string;
  secondaryBrandColor?: string;
  isDefault: boolean;
}

export interface ContentAsset {
  id: number;
  type: string;
  title: string;
  content: string;
  channel: string;
  status: string;
  createdAt: string;
  threadId?: number;
  threadName?: string;
  imageUrl?: string;
  imageUrls?: string[];
  videoUrl?: string;
  videoUrls?: string[];
  publishedAt?: string;
  publishedPostId?: string;
  publishedUrl?: string;
  publishPlatform?: string;
  retryCount?: number;
  lastError?: string;
}

export interface TabConfigItem {
  id: ContentTabType;
  label: string;
  iconName: string;
  color: string;
  darkColor: string;
  bgColor: string;
  darkBgColor: string;
  textColor: string;
  darkTextColor: string;
}

export const tabConfig: TabConfigItem[] = [
  { id: 'all', label: 'All Content', iconName: 'LayoutGrid', color: 'text-gray-600', darkColor: 'dark:text-gray-400', bgColor: 'bg-gray-100', darkBgColor: 'dark:bg-gray-800', textColor: 'text-gray-800', darkTextColor: 'dark:text-gray-200' },
  { id: 'image', label: 'Images', iconName: 'Image', color: 'text-blue-600', darkColor: 'dark:text-blue-300', bgColor: 'bg-blue-100', darkBgColor: 'dark:bg-blue-950/60', textColor: 'text-blue-800', darkTextColor: 'dark:text-blue-300' },
  { id: 'video', label: 'Videos', iconName: 'Video', color: 'text-purple-600', darkColor: 'dark:text-purple-300', bgColor: 'bg-purple-100', darkBgColor: 'dark:bg-purple-950/60', textColor: 'text-purple-800', darkTextColor: 'dark:text-purple-300' },
  { id: 'email', label: 'Email Templates', iconName: 'Mail', color: 'text-green-600', darkColor: 'dark:text-emerald-300', bgColor: 'bg-green-100', darkBgColor: 'dark:bg-emerald-950/60', textColor: 'text-green-800', darkTextColor: 'dark:text-emerald-300' },
  { id: 'sms', label: 'SMS Templates', iconName: 'MessageSquare', color: 'text-yellow-600', darkColor: 'dark:text-amber-300', bgColor: 'bg-yellow-100', darkBgColor: 'dark:bg-amber-950/60', textColor: 'text-yellow-800', darkTextColor: 'dark:text-amber-300' },
  { id: 'whatsapp', label: 'WhatsApp Templates', iconName: 'MessageSquare', color: 'text-green-600', darkColor: 'dark:text-green-300', bgColor: 'bg-green-100', darkBgColor: 'dark:bg-green-950/60', textColor: 'text-green-800', darkTextColor: 'dark:text-green-300' },
  { id: 'social', label: 'Social Media Posts', iconName: 'Share2', color: 'text-violet-600', darkColor: 'dark:text-violet-300', bgColor: 'bg-violet-100', darkBgColor: 'dark:bg-violet-950/60', textColor: 'text-violet-800', darkTextColor: 'dark:text-violet-300' },
  { id: 'social_message', label: 'Social Messages', iconName: 'MessageSquare', color: 'text-cyan-600', darkColor: 'dark:text-cyan-300', bgColor: 'bg-cyan-100', darkBgColor: 'dark:bg-cyan-950/60', textColor: 'text-cyan-800', darkTextColor: 'dark:text-cyan-300' },
  { id: 'ad_copy', label: 'Ad Copy', iconName: 'Megaphone', color: 'text-orange-600', darkColor: 'dark:text-orange-300', bgColor: 'bg-orange-100', darkBgColor: 'dark:bg-orange-950/60', textColor: 'text-orange-800', darkTextColor: 'dark:text-orange-300' },
  { id: 'blog', label: 'Blog Posts', iconName: 'FileText', color: 'text-teal-600', darkColor: 'dark:text-teal-300', bgColor: 'bg-teal-100', darkBgColor: 'dark:bg-teal-950/60', textColor: 'text-teal-800', darkTextColor: 'dark:text-teal-300' },
];

// Map tab ids to API type values
export const tabToApiType: Record<string, string> = {
  'image': 'image',
  'video': 'video',
  'email': 'email_template',
  'sms': 'sms_template',
  'whatsapp': 'whatsapp_template',
  'social': 'social_post',
  'social_message': 'social_dm',
  'ad_copy': 'ad_copy',
  'blog': 'blog_post',
};

// Icon mapping - used by components to render icons
const iconMap: Record<string, React.FC<{ className?: string }>> = {
  LayoutGrid,
  Mail,
  MessageSquare,
  Share2,
  Megaphone,
  Image,
  Video,
  FileText,
};

export function getTabIcon(tab: TabConfigItem): React.ReactNode {
  const IconComponent = iconMap[tab.iconName];
  if (IconComponent) {
    return createElement(IconComponent, { className: 'w-4 h-4' });
  }
  return null;
}
