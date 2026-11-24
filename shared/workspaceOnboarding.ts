/** Shared onboarding choices and limits consumed by client and server. */
export const WORKSPACE_TYPES = [
  {
    value: "individual",
    label: "Individual",
    description: "Personal projects or freelance work",
  },
  {
    value: "creator",
    label: "Creator",
    description: "Content, community, or a personal brand",
  },
  {
    value: "business",
    label: "Business / Organization",
    description: "A company, brand, or organization",
  },
  {
    value: "agency",
    label: "Agency",
    description: "Your agency or a client workspace",
  },
] as const;

export const APPLICATION_USES = [
  {
    value: "customer_support",
    label: "Customer support",
    description: "Reply to customers and resolve queries",
  },
  {
    value: "sales_leads",
    label: "Sales & leads",
    description: "Find prospects and follow up",
  },
  {
    value: "content_social",
    label: "Content & social media",
    description: "Create and publish content",
  },
  {
    value: "marketing_campaigns",
    label: "Marketing campaigns",
    description: "Run email and outreach campaigns",
  },
  {
    value: "advertising",
    label: "Advertising",
    description: "Manage ads and track results",
  },
  {
    value: "personal_productivity",
    label: "Personal productivity",
    description: "Research, plan, and organize work",
  },
] as const;

export const CHANNELS = [
  "Email",
  "WhatsApp",
  "Instagram",
  "Facebook / Messenger",
  "YouTube",
  "Website chat",
  "Google Ads",
  "Meta Ads",
];
export const TEAM_SIZES = [
  { value: "1", label: "Just me" },
  { value: "2-10", label: "2–10" },
  { value: "11-50", label: "11–50" },
  { value: "51+", label: "51+" },
];
export const FOCUS_AREAS = [
  "Design & creative",
  "Technology",
  "Education",
  "Entertainment",
  "Finance",
  "Healthcare",
  "E-commerce",
  "Retail",
  "Marketing",
  "Consulting",
  "Nonprofit",
  "Other",
];


export const WORKSPACE_TYPE_VALUES = ["individual", "creator", "business", "agency"] as const;
export const APPLICATION_USE_VALUES = ["customer_support", "sales_leads", "content_social", "marketing_campaigns", "advertising", "personal_productivity"] as const;
export const BRAND_IMAGE_LIMITS = { count: 100, uploadBytes: 5 * 1024 * 1024, alt: 1000, originalName: 255, dimension: 100000, storedBytes: 100000000 } as const;
