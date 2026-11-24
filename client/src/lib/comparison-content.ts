import type { ComparisonSlug } from "@/lib/comparisons";

export type Comparison = {
  slug: ComparisonSlug;
  name: string;
  shortFocus: string;
  headline: string;
  decision: string;
  summary: string;
  askSalesFit: string;
  competitorFit: string;
  pricingUrl: string;
  transitionFocus: string;
  differences: { title: string; description: string }[];
  rows: { capability: string; askSales: string; competitor: string }[];
  faqs: { question: string; answer: string }[];
  sources: { label: string; url: string }[];
};

export const comparisons: Comparison[] = [
  {
    slug: "manychat",
    name: "ManyChat",
    shortFocus: "Social and messaging automation",
    headline: "Go beyond the comment-to-DM flow.",
    decision: "Choose ManyChat for social conversation automation. Choose AskSales when the same campaign also needs prospect sourcing, creative production, paid ads and an approval trail.",
    summary:
      "ManyChat is built around automated conversations across Instagram, WhatsApp, Messenger and other channels. AskSales.AI connects prospect research, creative work, outreach and paid campaigns in one reviewable run.",
    askSalesFit:
      "Revenue teams that need to source prospects, prepare campaign assets and authorize provider actions together.",
    competitorFit:
      "Creators and businesses focused on DM triggers, conversation flows, broadcasts and a shared inbox.",
    pricingUrl: "https://manychat.com/pricing",
    transitionFocus: "Inventory your Instagram triggers, keyword flows, active contacts and inbox assignments before changing a live automation.",
    differences: [
      { title: "ManyChat leads on social triggers", description: "Its Instagram comment-to-DM, story and keyword automations are purpose-built for turning engagement into conversations." },
      { title: "AskSales begins with sourced leads", description: "Build a lead resource from an ideal customer profile, then carry it into creative, email, SMS and paid campaign preparation." },
      { title: "Approval spans the campaign", description: "Review recipients, copy, destinations and spend before supported outreach or ad actions run." },
    ],
    rows: [
      { capability: "Starting point", askSales: "A campaign brief with leads, assets and next actions", competitor: "Messaging triggers, flows and audience conversations" },
      { capability: "Lead work", askSales: "Discover and store prospects against an ideal customer profile", competitor: "Capture and qualify contacts through automated conversations" },
      { capability: "Creative work", askSales: "Prepare social, email, SMS and ad creative drafts", competitor: "Build automated messages, AI replies and broadcasts" },
      { capability: "Channels", askSales: "Outreach and supported paid campaign workflows", competitor: "Instagram, WhatsApp, Messenger, Telegram, email and SMS automations" },
      { capability: "Paid campaigns", askSales: "Plan, review and publish supported Meta and Google ads", competitor: "Connect social engagement and messaging journeys to lead capture" },
      { capability: "Approval and status", askSales: "Separate drafts, approvals, queued work and provider-confirmed results", competitor: "Configure and run channel automations with inbox and broadcast views" },
    ],
    faqs: [
      { question: "Does AskSales.AI replace ManyChat's Instagram DM flows?", answer: "They solve different starting problems. ManyChat provides dedicated social messaging automations. AskSales.AI is designed to coordinate the broader campaign, from lead research and creative preparation through reviewed outreach and paid media actions." },
      { question: "Can I use both products?", answer: "Yes. A team can keep its ManyChat conversations while using AskSales.AI to prepare leads, content and campaigns. Check the connected channel and data handoff you need before changing a live flow." },
      { question: "Where can I see AskSales.AI pricing?", answer: "The pricing page explains the credit model. The signed-in billing screen shows current operation costs and availability." },
    ],
    sources: [
      { label: "ManyChat Instagram automation", url: "https://manychat.com/blog/key-instagram-automation-features/" },
      { label: "ManyChat plans", url: "https://manychat.com/pricing" },
    ],
  },
  {
    slug: "wati",
    name: "Wati",
    shortFocus: "WhatsApp centered customer messaging",
    headline: "Connect the work around WhatsApp.",
    decision: "Wati is a strong home for WhatsApp campaigns and team conversations. AskSales is a broader workspace for finding leads, preparing content, coordinating outreach and reviewing ad execution.",
    summary:
      "Wati centers customer messaging, campaigns, chatbots and a team inbox around WhatsApp, with additional channel options. AskSales.AI starts with a campaign brief and carries the lead, creative, outreach and ad work through review and provider results.",
    askSalesFit:
      "Teams coordinating prospect discovery, content, outreach and advertising as one accountable campaign.",
    competitorFit:
      "Teams whose daily work centers on WhatsApp conversations, templates, campaigns and agent handoff.",
    pricingUrl: "https://www.wati.io/en/pricing/",
    transitionFocus: "Map your WhatsApp number, approved templates, contact attributes, chatbot flows and agent routing before a channel change.",
    differences: [
      { title: "Wati centers the WhatsApp team", description: "Its templates, shared inbox, chatbot flows and agent routing support teams that work primarily inside WhatsApp." },
      { title: "AskSales prepares the whole audience", description: "Research an ideal customer profile and keep the resulting leads beside email, SMS, social and ad assets." },
      { title: "Execution has a review point", description: "Check the action scope and see whether it is prepared, queued or confirmed by a provider." },
    ],
    rows: [
      { capability: "Starting point", askSales: "A coordinated sales and marketing request", competitor: "WhatsApp conversations and campaign operations" },
      { capability: "Lead work", askSales: "Discover, score and store prospects from multiple sources", competitor: "Capture and manage contacts from messages, ads and automations" },
      { capability: "Creative work", askSales: "Create social, email, SMS and ad drafts", competitor: "Create WhatsApp templates, chatbot flows and campaign messages" },
      { capability: "Channels", askSales: "Outreach plus supported Meta and Google ad workflows", competitor: "WhatsApp first, with Instagram and other channel features by plan" },
      { capability: "Paid campaigns", askSales: "Prepare and publish supported ad campaigns after review", competitor: "Run WhatsApp campaigns and Click-to-WhatsApp ad journeys" },
      { capability: "Approval and status", askSales: "Review scope before execution; reconcile provider results", competitor: "Operate campaigns and conversations from its team inbox" },
    ],
    faqs: [
      { question: "Is Wati limited to WhatsApp?", answer: "No. Wati's current documentation includes Instagram, Facebook Messenger and other channel features. WhatsApp remains central to its product and campaign workflows." },
      { question: "What changes if my team already uses Wati?", answer: "AskSales.AI adds a place to coordinate upstream lead research, creative production and paid campaign preparation. Review your existing Wati automations and channel setup before moving any live messaging process." },
      { question: "How should I evaluate a move from Wati?", answer: "List the templates, contacts, automations and connected numbers your team uses today. Then contact our team with the campaign workflow you want to run in AskSales.AI." },
    ],
    sources: [
      { label: "Wati product overview", url: "https://support.wati.io/en/articles/11375155-wati-overview-features-channels-and-integrations" },
      { label: "Wati plan and channel features", url: "https://support.wati.io/en/articles/12136628-understanding-difference-between-wati-s-pay-as-you-go-payg-and-growth-plans" },
      { label: "Wati pricing structure", url: "https://support.wati.io/en/articles/11462993-understanding-wati-s-pricing-structure" },
      { label: "Wati Instagram automation", url: "https://support.wati.io/en/articles/11463171-how-to-create-and-use-chatbots-for-instagram" },
    ],
  },
  {
    slug: "interakt",
    name: "Interakt",
    shortFocus: "WhatsApp and Instagram commerce",
    headline: "Take the campaign beyond chat commerce.",
    decision: "Interakt is built for WhatsApp and Instagram marketing, sales CRM and commerce. AskSales brings lead research, content creation, outreach and paid campaign work into one reviewed campaign run.",
    summary:
      "Interakt combines WhatsApp and Instagram marketing, a shared inbox, sales CRM and commerce tools. AskSales.AI is for teams that want research, creative, outreach and paid campaign execution coordinated from the first brief.",
    askSalesFit:
      "Teams running a wider sales and marketing process with lead sourcing, content and reviewed provider actions.",
    competitorFit:
      "Businesses prioritizing WhatsApp commerce, Instagram engagement, customer conversations and a messaging CRM.",
    pricingUrl: "https://www.interakt.shop/pricing-us/",
    transitionFocus: "Map your shared inbox, sales pipeline, templates, catalogs and payment journey before moving an active workflow.",
    differences: [
      { title: "Interakt handles chat commerce", description: "Its catalog, payment and WhatsApp-first sales CRM make sense when orders and conversations drive the journey." },
      { title: "AskSales produces campaign assets", description: "Research prospects, prepare copy and images, and plan outreach and paid media from the same brief." },
      { title: "Approvals cover more than messages", description: "Review audience, creative, destination and spend before a supported campaign action runs." },
    ],
    rows: [
      { capability: "Starting point", askSales: "Campaign brief and coordinated specialist work", competitor: "WhatsApp and Instagram marketing, sales and support" },
      { capability: "Lead work", askSales: "Source and store prospects from an ideal customer profile", competitor: "Capture and organize leads from chats, ads and CRM inputs" },
      { capability: "Creative work", askSales: "Draft social posts, messages, images and ad assets", competitor: "Build message templates, chatbot flows and promotions" },
      { capability: "Channels", askSales: "Outreach and supported paid campaign providers", competitor: "WhatsApp, Instagram and RCS messaging features" },
      { capability: "Paid campaigns", askSales: "Plan and publish supported Meta and Google campaigns", competitor: "Click-to-WhatsApp ads and campaign analytics" },
      { capability: "Approval and status", askSales: "Inspect the proposed action and its provider result", competitor: "Manage conversations and campaigns in a shared inbox" },
    ],
    faqs: [
      { question: "Does Interakt support Instagram as well as WhatsApp?", answer: "Yes. Interakt documents Instagram automation and a shared inbox spanning Instagram and WhatsApp." },
      { question: "Which product is better for WhatsApp commerce?", answer: "Interakt explicitly offers WhatsApp catalogs, payments and commerce journeys. AskSales.AI is aimed at coordinating lead research, creative, outreach and paid campaigns across a broader workflow." },
      { question: "Can AskSales.AI prepare ads?", answer: "Yes. Its performance marketing workflow prepares targeting, budgets and creative, with review before supported provider publication." },
    ],
    sources: [
      { label: "Interakt product overview", url: "https://www.interakt.shop/" },
      { label: "Interakt marketing automation", url: "https://www.interakt.shop/marketing-automation/" },
      { label: "Interakt plans", url: "https://www.interakt.shop/pricing-us/" },
    ],
  },
  {
    slug: "respond-io",
    name: "Respond.io",
    shortFocus: "Omnichannel conversation management",
    headline: "Start before the first conversation.",
    decision: "Respond.io excels at managing conversations, calls and AI agents across channels. AskSales covers the upstream prospect and creative work, plus reviewed paid campaign actions and provider results.",
    summary:
      "Respond.io unifies customer conversations, calls, AI agents and CRM context across channels. AskSales.AI puts prospect discovery, creative preparation, outreach and paid campaign actions in a single reviewable workflow.",
    askSalesFit:
      "Teams that need the work before and after a conversation connected to campaign approval and provider status.",
    competitorFit:
      "Customer facing teams that need a shared inbox, AI agents, routing and follow-up across many messaging channels.",
    pricingUrl: "https://respond.io/pricing",
    transitionFocus: "List your connected channels, routing rules, AI agents, CRM sync and conversation ownership before testing a new campaign path.",
    differences: [
      { title: "Respond.io runs the conversation floor", description: "Its shared inbox, AI agents, calls and routing serve teams handling customer messages across many channels." },
      { title: "AskSales works upstream", description: "Search for prospects, retain the lead resource and prepare campaign creative before the first conversation." },
      { title: "Paid actions stay reviewable", description: "Plan supported Meta and Google ads and distinguish a draft from a provider-confirmed result." },
    ],
    rows: [
      { capability: "Starting point", askSales: "A campaign request spanning research to execution", competitor: "A shared customer conversation workspace" },
      { capability: "Lead work", askSales: "Discover and store new prospects by ideal customer profile", competitor: "Capture, qualify and manage contacts from connected channels" },
      { capability: "Creative work", askSales: "Produce social, email, SMS and ad creative drafts", competitor: "Create AI replies, workflow messages and broadcasts" },
      { capability: "Channels", askSales: "Outreach plus supported paid media workflows", competitor: "Omnichannel inbox for messaging, email and calls" },
      { capability: "Paid campaigns", askSales: "Plan and publish supported Meta and Google ads", competitor: "Attribute and respond to leads from conversation entry points" },
      { capability: "Approval and status", askSales: "Explicit action review and provider receipt reconciliation", competitor: "Conversation routing, AI agent actions and lifecycle tracking" },
    ],
    faqs: [
      { question: "Does Respond.io have AI agents?", answer: "Yes. Respond.io documents AI agents that answer, route and perform conversation tasks. The main difference here is the wider campaign work AskSales.AI coordinates around lead research, creative and paid ads." },
      { question: "Should we use Respond.io for a large shared inbox?", answer: "Respond.io is built for that use case across many channels. Evaluate its supported channels and agent workflows if conversation operations are the primary requirement." },
      { question: "What does AskSales.AI show after an action runs?", answer: "The workspace separates a prepared resource, a reviewed action and the state returned by the selected provider. Queued work is not labeled sent or active." },
    ],
    sources: [
      { label: "Respond.io product overview", url: "https://respond.io/help/quick-start/what-is-respondio" },
      { label: "Respond.io AI agents", url: "https://respond.io/help/ai-agents" },
      { label: "Respond.io conversion events", url: "https://respond.io/help/workflows/step-send-conversions-api-event" },
      { label: "Respond.io plans", url: "https://respond.io/pricing" },
    ],
  },
  {
    slug: "aisensy",
    name: "AiSensy",
    shortFocus: "WhatsApp campaigns and customer engagement",
    headline: "Turn a broadcast into a full campaign.",
    decision: "AiSensy combines WhatsApp campaigns, AI agents, live chat and ad tools. AskSales adds prospect sourcing, a multi-format content studio, CRM work and explicit approval before consequential actions.",
    summary:
      "AiSensy brings WhatsApp broadcasts, chatbots, AI agents, live chat and ad tools together. AskSales.AI starts earlier with lead sourcing and connects creative, outreach and paid campaign work to approvals and provider results.",
    askSalesFit:
      "Teams that want a coordinated campaign across prospect research, content, outreach and advertising.",
    competitorFit:
      "Businesses centered on WhatsApp broadcasts, automated conversations, support and commerce engagement.",
    pricingUrl: "https://aisensy.com/pricing",
    transitionFocus: "Inventory broadcast segments, templates, chatbot flows, catalogs and agent handoffs before changing your WhatsApp setup.",
    differences: [
      { title: "AiSensy runs WhatsApp engagement", description: "Broadcasts, chatbot flows, live chat and its Ads Manager are geared to WhatsApp-led acquisition and service." },
      { title: "AskSales builds beyond a contact list", description: "Discover prospects against an ideal customer profile and prepare social, email, SMS and ad content together." },
      { title: "Campaign actions get a review", description: "Keep recipient scope, message copy, creative and budget visible before a supported action executes." },
    ],
    rows: [
      { capability: "Starting point", askSales: "A campaign brief with coordinated specialist work", competitor: "WhatsApp marketing and customer engagement" },
      { capability: "Lead work", askSales: "Discover, score and store prospects from external sources", competitor: "Segment, qualify and engage WhatsApp contacts" },
      { capability: "Creative work", askSales: "Prepare social, email, SMS, image and ad assets", competitor: "Create broadcast templates, chatbot flows and AI replies" },
      { capability: "Channels", askSales: "Outreach and supported Meta and Google ad workflows", competitor: "WhatsApp centered messaging, live chat and commerce" },
      { capability: "Paid campaigns", askSales: "Plan and publish supported paid campaigns after review", competitor: "Click-to-WhatsApp ads and AI Ads Manager" },
      { capability: "Approval and status", askSales: "Review action scope and reconcile provider-confirmed state", competitor: "Track broadcast and conversation results" },
    ],
    faqs: [
      { question: "Does AiSensy offer AI agents?", answer: "Yes. AiSensy currently lists AI WhatsApp agents alongside its chatbot builder and live chat tools." },
      { question: "Does AiSensy support advertising?", answer: "Yes. AiSensy lists Click-to-WhatsApp ads and an AI Ads Manager. AskSales.AI also coordinates prospect research, creative preparation and outreach in the same campaign run." },
      { question: "Can I compare current prices here?", answer: "This page does not quote a fixed competitor price. Review AiSensy's current plans and AskSales.AI's live billing catalog for the usage and channels your team needs." },
    ],
    sources: [
      { label: "AiSensy features", url: "https://aisensy.com/features" },
      { label: "AiSensy WhatsApp broadcasting", url: "https://aisensy.com/features/whatsapp-broadcasting" },
      { label: "AiSensy ad creative generator", url: "https://aisensy.com/features/ai-ad-creative-generator" },
      { label: "AiSensy plans", url: "https://aisensy.com/pricing" },
    ],
  },
];

export function getComparison(slug: string): Comparison | undefined {
  return comparisons.find((comparison) => comparison.slug === slug);
}
