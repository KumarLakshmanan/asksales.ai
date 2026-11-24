import {
  UserSearch,
  Palette,
  Send,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

export interface AgentData {
  slug: string;
  name: string;
  role: string;
  icon: LucideIcon;
  color: string;
  borderColor: string;
  bgGradient: string;
  avatar: string;
  description: string;
  longDescription: string;
  features: string[];
  capabilities: string[];
  chatKey: string;
}

export const agentsData: AgentData[] = [
  {
    slug: "lead-generation",
    name: "Marcus Johnson",
    role: "Lead Generation Specialist",
    icon: UserSearch,
    color: "bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400",
    borderColor: "border-violet-200 dark:border-violet-800",
    bgGradient: "from-violet-600 to-violet-800",
    avatar: "/agent-avatars/leadagent.png",
    description:
      "B2B & B2C lead discovery specialist across LinkedIn, Google Maps, JustDial, and more. Generates platform-specific search parameters from your ICP.",
    longDescription:
      "Marcus is your dedicated lead generation powerhouse. He scours multiple platforms — LinkedIn, Google Maps, JustDial, Apollo, and more — to find high-quality prospects that match your Ideal Customer Profile. With advanced filtering, deduplication, and scoring, Marcus ensures every lead that enters your pipeline is worth pursuing.",
    features: [
      "Multi-platform lead scraping",
      "ICP-based targeting",
      "Automated search parameters",
      "Lead scoring & dedup",
    ],
    capabilities: [
      "Scrape leads from LinkedIn, Google Maps, JustDial, Apollo, and custom sources",
      "Automatically generate search parameters from your ICP definition",
      "Score and rank leads based on fit and engagement metrics",
      "Deduplicate across sources to avoid redundant outreach",
      "Enrich lead profiles with company data, social links, and contact info",
      "Export leads in structured formats for outreach campaigns",
    ],
    chatKey: "leads",
  },
  {
    slug: "content-studio",
    name: "Alex Chen",
    role: "Content Studio Director",
    icon: Palette,
    color: "bg-pink-100 dark:bg-pink-900/30 text-pink-600 dark:text-pink-400",
    borderColor: "border-pink-200 dark:border-pink-800",
    bgGradient: "from-pink-600 to-pink-800",
    avatar: "/agent-avatars/content-studio.png",
    description:
      "Creative content strategist who crafts social posts, email templates, SMS campaigns, ad creatives, and AI-generated images & videos.",
    longDescription:
      "Alex is your creative AI partner. From social media captions to full email campaigns, SMS follow-ups, ad copy, and even AI-generated images and videos — Alex handles it all. Powered by your brand toolkit, every piece of content stays on-brand and conversion-focused.",
    features: [
      "Social media content",
      "Email & SMS templates",
      "AI image & video generation",
      "Ad copy & creatives",
    ],
    capabilities: [
      "Generate social media posts optimized for each platform",
      "Create email templates with personalization tokens",
      "Write SMS campaigns with character-count awareness",
      "Design ad copy for Meta, Google, and LinkedIn campaigns",
      "Generate AI images using DALL-E and Stable Diffusion",
      "Create AI video content for social and ads",
      "Apply your brand voice, colors, and style guidelines automatically",
    ],
    chatKey: "content",
  },
  {
    slug: "outreach",
    name: "Emily Rodriguez",
    role: "Outreach Coordinator",
    icon: Send,
    color: "bg-cyan-100 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-400",
    borderColor: "border-cyan-200 dark:border-cyan-800",
    bgGradient: "from-cyan-600 to-cyan-800",
    avatar: "/agent-avatars/outreach.png",
    description:
      "Outreach specialist focused on building authentic connections through automated email workflows, SMS campaigns, and multi-channel follow-ups.",
    longDescription:
      "Emily orchestrates your entire outreach operation. She builds automated email workflows, SMS drip campaigns, and multi-channel follow-up strategies that feel human. With smart throttling, compliance checks, and optimal send-time analysis, Emily maximizes deliverability and response rates.",
    features: [
      "Email follow-ups",
      "SMS campaigns",
      "Follow-up automation",
      "Spam compliance",
    ],
    capabilities: [
      "Build multi-step email workflows with smart timing",
      "Create SMS drip campaigns with opt-out handling",
      "Manage multi-channel outreach (email + SMS + Instagram DM)",
      "Personalize messages using lead data and AI variables",
      "Smart throttling to protect sender reputation",
      "Analyze response sentiment and auto-categorize replies",
      "Generate follow-up messages based on engagement metrics",
    ],
    chatKey: "outreach",
  },
  {
    slug: "performance-marketing",
    name: "Sarah Martinez",
    role: "Performance Marketing Manager",
    icon: TrendingUp,
    color: "bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400",
    borderColor: "border-orange-200 dark:border-orange-800",
    bgGradient: "from-orange-600 to-orange-800",
    avatar: "/agent-avatars/performance.png",
    description:
      "Data-savvy performance marketing expert who plans and runs ad campaigns on Meta, Google, and LinkedIn with smart budget allocation.",
    longDescription:
      "Sarah is your performance marketing strategist. She plans, creates, and optimizes ad campaigns across Meta, Google, and LinkedIn. From audience targeting to budget allocation and A/B testing, Sarah ensures every rupee of your ad spend delivers maximum ROI.",
    features: [
      "Meta & Google ads",
      "Budget optimization",
      "A/B testing strategies",
      "Campaign publishing",
    ],
    capabilities: [
      "Plan full ad campaigns with targeting, budgets, and creative",
      "Create and publish campaigns on Meta Ads and Google Ads",
      "Optimize budget allocation across channels and ad sets",
      "Design A/B testing strategies for copy, creative, and audiences",
      "Monitor campaign performance and suggest optimizations",
      "Generate performance reports with ROI attribution",
    ],
    chatKey: "performance",
  }
];

export function getAgentBySlug(slug: string): AgentData | undefined {
  return agentsData.find((a) => a.slug === slug);
}
