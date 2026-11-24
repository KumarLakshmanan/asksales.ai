export const comparisonLinks = [
  { slug: "manychat", name: "ManyChat" },
  { slug: "wati", name: "Wati" },
  { slug: "interakt", name: "Interakt" },
  { slug: "respond-io", name: "Respond.io" },
  { slug: "aisensy", name: "AiSensy" },
] as const;

export type ComparisonSlug = (typeof comparisonLinks)[number]["slug"];
