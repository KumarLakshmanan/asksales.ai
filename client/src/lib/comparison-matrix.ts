import type { ComparisonSlug } from "@/lib/comparisons";

export type FeatureRow = {
  label: string;
  askSales: string;
  competitor: Record<ComparisonSlug, string | null>;
};

export type FeatureGroup = {
  id: string;
  title: string;
  description: string;
  rows: FeatureRow[];
};

// Null means the linked vendor sources did not establish a directly comparable
// workflow. It must never be rendered as a claim that the vendor lacks it.
export const featureGroups: FeatureGroup[] = [
  {
    id: "find",
    title: "Find and qualify",
    description: "How a campaign gets a usable audience before the first send.",
    rows: [
      {
        label: "Prospect discovery",
        askSales: "ICP-led lead research across configured sources, with a stored lead resource for the campaign.",
        competitor: {
          manychat: "Captures contacts from social and messaging interactions.",
          wati: "Captures contacts from WhatsApp, ads and conversation flows.",
          interakt: "Captures leads from WhatsApp, Instagram, ads and commerce journeys.",
          "respond-io": "Captures contacts from connected conversation channels and ads.",
          aisensy: "Grows and segments opted-in WhatsApp audiences.",
        },
      },
      {
        label: "Enrichment and deduplication",
        askSales: "Enriches lead profiles and deduplicates records before outreach preparation.",
        competitor: {
          manychat: null,
          wati: "Contact attributes and management are documented; external enrichment is not established in the reviewed sources.",
          interakt: "Sales CRM organizes captured leads; external prospect enrichment is not established in the reviewed sources.",
          "respond-io": "Contact profiles can sync with connected CRMs; external prospect enrichment is not established in the reviewed sources.",
          aisensy: "Audience segmentation is documented; external prospect enrichment is not established in the reviewed sources.",
        },
      },
      {
        label: "CRM and pipeline",
        askSales: "Contacts, pipeline stages, reminders, alerts and automations live in the workspace.",
        competitor: {
          manychat: "Contacts, tags and inbox organization support conversation-led follow-up.",
          wati: "Contacts, attributes and team assignment support messaging operations.",
          interakt: "WhatsApp-first Sales CRM with owners and deal statuses.",
          "respond-io": "Contact lifecycle tracking and CRM integrations keep conversations in context.",
          aisensy: "Contact segmentation and live-chat handoff support WhatsApp sales and support.",
        },
      },
      {
        label: "AI qualification",
        askSales: "Specialist agents prepare lead, content, outreach and ad work from the campaign brief.",
        competitor: {
          manychat: "AI replies and automation flows can qualify leads in conversations.",
          wati: "AI agents and chatbots can qualify inbound WhatsApp leads.",
          interakt: "AI agents and no-code chatbots answer queries and qualify leads.",
          "respond-io": "AI agents qualify, route and act on customer conversations.",
          aisensy: "AI WhatsApp agents and chatbot flows qualify leads in chat.",
        },
      },
    ],
  },
  {
    id: "create",
    title: "Create and publish",
    description: "The content and creative work that surrounds the conversation.",
    rows: [
      {
        label: "Brand toolkit",
        askSales: "A workspace brand toolkit guides tone, colors and reusable creative context.",
        competitor: {
          manychat: "ManyChat AI can learn a business's tone for automated replies.",
          wati: null,
          interakt: null,
          "respond-io": "AI agents use instructions and knowledge sources for response context.",
          aisensy: "Its ad creative generator can use uploaded logos and product images; a workspace-wide brand toolkit is not established in the reviewed sources.",
        },
      },
      {
        label: "Multi-format copy",
        askSales: "Drafts social posts, email, SMS, DMs and ad copy from campaign context.",
        competitor: {
          manychat: "Creates conversation flows, AI replies and broadcasts for connected channels.",
          wati: "Creates WhatsApp templates, chatbot flows and campaign messages.",
          interakt: "Creates WhatsApp and Instagram messages, chatbot flows and promotions.",
          "respond-io": "Creates AI replies, workflow messages and broadcasts.",
          aisensy: "Creates WhatsApp broadcasts, chatbot flows and AI replies.",
        },
      },
      {
        label: "Image and video creation",
        askSales: "Content Studio offers AI image and video draft generation for campaign assets.",
        competitor: { manychat: null, wati: null, interakt: null, "respond-io": null, aisensy: "Generates AI image ads from prompts and brand assets. A video generator is listed as coming soon." },
      },
      {
        label: "Social publishing and calendar",
        askSales: "Approved social assets can move into connected publishing and calendar workflows.",
        competitor: {
          manychat: "Automates replies to posts, Reels, comments and story interactions.",
          wati: null,
          interakt: "Automates Instagram comments, mentions and DMs.",
          "respond-io": "Manages conversations that originate from social channels.",
          aisensy: null,
        },
      },
    ],
  },
  {
    id: "engage",
    title: "Reach and respond",
    description: "Which channels are used and what teams can do with replies.",
    rows: [
      {
        label: "WhatsApp",
        askSales: "Connects a WhatsApp Business account for messages, templates and outreach workflows.",
        competitor: {
          manychat: "WhatsApp automation and broadcasts are available on eligible plans.",
          wati: "Core platform for WhatsApp campaigns, chatbots and team messaging.",
          interakt: "Core platform for WhatsApp marketing, commerce and support.",
          "respond-io": "WhatsApp messaging and calls are part of its shared conversation workspace.",
          aisensy: "Core platform for WhatsApp broadcasts, agents, chatbots and live chat.",
        },
      },
      {
        label: "Instagram and Messenger",
        askSales: "Connected Instagram messages and Facebook Page Messenger sit alongside social publishing.",
        competitor: {
          manychat: "Instagram and Messenger automation are core channels, including comment-to-DM triggers.",
          wati: "Instagram and Messenger features appear in current product documentation; plan access varies.",
          interakt: "Instagram DMs, comments and story interactions connect to its shared inbox.",
          "respond-io": "Instagram and Facebook Messenger sit in the omnichannel inbox.",
          aisensy: null,
        },
      },
      {
        label: "Email and SMS outreach",
        askSales: "Connected email senders and SMS configuration support outreach and follow-up sequences.",
        competitor: {
          manychat: "Email and SMS are available as automation channels on eligible plans.",
          wati: "The reviewed sources center on WhatsApp, with RCS and other messaging options.",
          interakt: "The reviewed sources center on WhatsApp, Instagram and RCS messaging.",
          "respond-io": "Email is among its connected conversation channels.",
          aisensy: "The reviewed feature set centers on WhatsApp messaging.",
        },
      },
      {
        label: "Inbox and follow-ups",
        askSales: "A shared outreach inbox, channel activity and follow-up workspace keep replies attached to work.",
        competitor: {
          manychat: "Shared inbox, assignments and reminders vary by plan.",
          wati: "Team inbox, assignment, automations and campaign follow-up.",
          interakt: "Shared WhatsApp and Instagram inbox with sales follow-up tools.",
          "respond-io": "Shared inbox, AI routing, lifecycle and follow-up workflows are core features.",
          aisensy: "Multi-agent live chat, bot handoff and audience retargeting.",
        },
      },
    ],
  },
  {
    id: "measure",
    title: "Launch and measure",
    description: "Paid media, reporting and discovery beyond messaging analytics.",
    rows: [
      {
        label: "Meta ad campaigns",
        askSales: "Plans and publishes supported Meta campaigns after account, creative and spend review.",
        competitor: {
          manychat: "Connects social engagement and ads to automated conversations and CAPI tracking.",
          wati: "Supports Click-to-WhatsApp ad journeys and campaign reporting.",
          interakt: "Runs Click-to-WhatsApp ad journeys and measures conversation outcomes.",
          "respond-io": "Captures and routes leads from ads; conversion events are available in workflows.",
          aisensy: "Ads Manager supports Click-to-WhatsApp, lead-form and other Meta campaigns, with AI image ad creatives.",
        },
      },
      {
        label: "Google Ads management",
        askSales: "Connects a Google Ads account for supported campaign creation and performance review.",
        competitor: { manychat: null, wati: "Google Ads to WhatsApp lead flows are documented; direct campaign management is not established.", interakt: null, "respond-io": null, aisensy: null },
      },
      {
        label: "Campaign analytics",
        askSales: "Combines campaign views with channel and paid-media performance, using provider results where available.",
        competitor: {
          manychat: "Automation, audience and broadcast performance are available in the platform.",
          wati: "Campaign and inbox analytics are documented.",
          interakt: "Campaign, click and team analytics are documented.",
          "respond-io": "Channel, agent, ad and lifecycle analytics are part of the product.",
          aisensy: "Broadcast delivery, click and audience analytics are documented.",
        },
      },
      {
        label: "AI Visibility",
        askSales: "Dedicated SEO, GEO, competitor and AI-answer visibility workspaces.",
        competitor: { manychat: null, wati: null, interakt: null, "respond-io": null, aisensy: null },
      },
    ],
  },
  {
    id: "govern",
    title: "Review and close",
    description: "How work is authorized, proved and handed to the next team.",
    rows: [
      {
        label: "Pre-action approval",
        askSales: "Recipients, copy, destinations, schedule and spend are visible before consequential provider actions.",
        competitor: {
          manychat: "Teams configure and publish messaging automations; a comparable cross-workflow review gate is not documented in the reviewed sources.",
          wati: "Teams configure campaigns and automations; a comparable cross-workflow review gate is not documented in the reviewed sources.",
          interakt: "Teams configure campaigns and flows; a comparable cross-workflow review gate is not documented in the reviewed sources.",
          "respond-io": "Teams configure AI agents and workflows; a comparable cross-workflow review gate is not documented in the reviewed sources.",
          aisensy: "Teams configure broadcasts and agents; a comparable cross-workflow review gate is not documented in the reviewed sources.",
        },
      },
      {
        label: "Provider-confirmed status",
        askSales: "Separates prepared, queued, sent, published and active states using durable records and provider receipts.",
        competitor: {
          manychat: "Inbox and broadcast views report channel activity; status semantics differ by channel.",
          wati: "Campaign and inbox views report messaging activity and delivery.",
          interakt: "Campaign analytics and inbox views report message outcomes.",
          "respond-io": "Conversation, workflow and broadcast analytics report channel outcomes.",
          aisensy: "Broadcast and live-chat analytics report messaging outcomes.",
        },
      },
      {
        label: "Support operations",
        askSales: "Support tickets, team queues and Support AI sit beside sales work.",
        competitor: {
          manychat: "Inbox seats and AI replies help handle customer conversations.",
          wati: "Team inbox, chatbots and AI support agents handle customer queries.",
          interakt: "Shared support inbox and chatbot handoff handle customer queries.",
          "respond-io": "Omnichannel inbox, AI agents and routing support service teams.",
          aisensy: "Multi-agent live chat, chatbot handoff and AI agents handle support.",
        },
      },
      {
        label: "Proposals and catalog",
        askSales: "Products and services, proposal templates, drafts and analytics have dedicated workspace areas.",
        competitor: {
          manychat: null,
          wati: "WhatsApp product catalog is documented; a proposal editor is not established in the reviewed sources.",
          interakt: "WhatsApp catalog and payments are documented; a proposal editor is not established in the reviewed sources.",
          "respond-io": null,
          aisensy: "WhatsApp commerce features are documented; a proposal editor is not established in the reviewed sources.",
        },
      },
      {
        label: "Pricing model",
        askSales: "A per-account subscription deposits monthly credits; operations use credits and ad spend is billed by the connected provider.",
        competitor: {
          manychat: "Plan tiers include monthly active-contact allowances, with additional active contacts billed separately.",
          wati: "Plan subscription, messaging charges and optional add-ons make up the total.",
          interakt: "Plan subscription and WhatsApp message charges vary with plan, region and use.",
          "respond-io": "Plans scale by monthly active contacts; AI credits and connected channel charges also matter.",
          aisensy: "Plan subscription and WhatsApp message charges depend on usage and selected features.",
        },
      },
    ],
  },
];
