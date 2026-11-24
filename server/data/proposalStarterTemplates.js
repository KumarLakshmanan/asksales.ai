// Commercial terms and prices are intentionally left for the seller to approve.
const specs = [
  [
    "Digital Marketing",
    "Campaign strategy, channels, creative deliverables, measurement and reporting",
    "Audience and objectives|Channel strategy|Campaign deliverables|Measurement and reporting",
  ],
  [
    "Website Development",
    "Discovery, design, implementation, testing and website launch",
    "Discovery and requirements|Design and accessibility|Development scope|Testing and launch",
  ],
  [
    "SaaS Implementation",
    "Configuration, integrations, migration and adoption of a software platform",
    "Success criteria|Configuration and integrations|Data migration|Training and adoption",
  ],
  [
    "Consulting",
    "Advisory engagement with defined outcomes and deliverables",
    "Current situation|Engagement approach|Deliverables|Governance and success measures",
  ],
  [
    "SEO Services",
    "Technical SEO, content planning and organic search measurement",
    "Baseline audit|Technical improvements|Content roadmap|Reporting and measurement",
  ],
  [
    "Social Media Management",
    "Content calendars, publishing, community management and reporting",
    "Audience and brand voice|Content calendar|Publishing and community scope|Performance reporting",
  ],
  [
    "Brand Identity",
    "Brand discovery, visual identity and delivery of brand guidelines",
    "Brand discovery|Identity concepts|Design deliverables|Brand guidelines and handover",
  ],
  [
    "Customer Support",
    "Support operations with agreed channels, coverage and escalation",
    "Support channels and coverage|Service targets|Escalation and ownership|Quality assurance and reporting",
  ],
  [
    "Sales Outreach",
    "Prospecting, qualification and outreach campaign delivery",
    "Ideal customer profile|Prospecting and qualification|Outreach sequence|Handoff and reporting",
  ],
  [
    "Maintenance and Retainer",
    "Recurring maintenance, service allocation and review cadence",
    "Included services|Service allocation and exclusions|Request and escalation process|Monthly review and renewal",
  ],
];
export const proposalStarterTemplates = specs.map(
  ([name, description, headings], index) => ({
    key: `starter-${index + 1}`,
    name,
    category: [
      "Marketing",
      "Web and software",
      "Web and software",
      "Consulting",
      "Marketing",
      "Marketing",
      "Branding",
      "Customer operations",
      "Sales",
      "Retainers",
    ][index],
    description,
    templateContent: {
      sections: [
        {
          title: "Executive summary",
          kind: "cover",
          body: "",
          instruction: `Prepare a ${name.toLowerCase()} proposal for {{client_name}} from {{company_name}}. State confirmed objectives and flag missing inputs for review.`,
        },
        ...headings.split("|").map((title) => ({
          title,
          kind: "content",
          body: "",
          instruction: `Describe ${title.toLowerCase()} using verified customer requirements. Specify deliverables, responsibilities, dependencies, exclusions and acceptance criteria. Leave unconfirmed commitments marked for review.`,
        })),
        {
          title: "Timeline and investment",
          kind: "content",
          body: "",
          instruction:
            "Set out milestones, customer dependencies and approved pricing. Do not invent prices or dates. Use the separately approved pricing table.",
        },
        {
          title: "Commercial terms",
          kind: "terms",
          body: "",
          instruction:
            "Confirm payment schedule, change requests, exclusions, validity and cancellation terms with the seller before sending.",
        },
        {
          title: "Next steps",
          kind: "closing",
          body: "Review the scope and commercial terms, resolve open questions and accept the proposal to begin onboarding.",
        },
      ],
      placeholders: ["client_name", "company_name"],
      warnings: [],
      requiredFields: ["client_name", "company_name"],
    },
  }),
);
