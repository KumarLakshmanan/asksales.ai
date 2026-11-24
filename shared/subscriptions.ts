/** Seed values only. Checkout and presentation read the published database catalog. */
export const SUBSCRIPTION_CATALOG_VERSION = 2;
export const LIMIT_DEFINITIONS = [
  { key: 'businessProfiles', label: 'Business profiles / workspaces' },
  { key: 'workspaces', label: 'Business workspaces (same as profiles)' },
  { key: 'contacts', label: 'Saved CRM contacts' },
  { key: 'storageBytes', label: 'File storage' },
  { key: 'channelAccounts', label: 'Connected channel accounts' },
  { key: 'aiAssistants', label: 'Active AI assistants' },
  { key: 'members', label: 'Staff members, including owner' },
  { key: 'supportAgents', label: 'Support-agent seats' },
  { key: 'supportTeams', label: 'Support teams / inboxes' },
  { key: 'automations', label: 'Active automation rules' },
  { key: 'knowledgeSources', label: 'Knowledge sources' },
] as const;
export type LimitKey = typeof LIMIT_DEFINITIONS[number]['key'];
export type PlanLimits = Record<LimitKey, number | null>;
export type PlanSlug = string;
export type BillingTerm = 'monthly' | 'yearly';
export type SubscriptionPlan = {
  version: number; slug: string; name: string; description: string;
  monthlyRupees: number; yearlyRupees: number; monthlyCredits: number;
  limits: PlanLimits; sortOrder: number; featured: boolean;
  finderMinScore: number; finderMaxScore: number | null;
};
export type SubscriptionCatalog = { version: number; currency: 'INR'; taxInclusive: true; plans: SubscriptionPlan[] };
export type OrganizationEntitlements = {
  limits: PlanLimits; usage: Record<LimitKey, number>; enforced: boolean;
  catalogVersion: number | null; planSlug: string | null;
};
export type BillingOrganization = {
  id: number; name: string; role: 'owner' | 'billing_admin' | 'member'; canManageBilling: boolean;
};
export const UNLIMITED_LIMITS: PlanLimits = Object.fromEntries(LIMIT_DEFINITIONS.map(({key}) => [key, null])) as PlanLimits;
const seedLimits = (profile: number, contacts: number, gb: number, channels: number, members: number, agents: number, teams: number, automations: number, knowledge: number): PlanLimits => ({
  businessProfiles: profile, workspaces: profile, contacts, storageBytes: gb * 1_000_000_000,
  channelAccounts: channels, aiAssistants: profile, members, supportAgents: agents,
  supportTeams: teams, automations, knowledgeSources: knowledge,
});
export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {version:2,slug:'starter',name:'Starter',description:'One business. A focused start for your team.',monthlyRupees:500,yearlyRupees:4800,monthlyCredits:5000,limits:seedLimits(1,5000,2,3,2,2,1,5,20),sortOrder:0,featured:false,finderMinScore:0,finderMaxScore:6},
  {version:2,slug:'growth',name:'Growth',description:'Room for growing businesses and a busy pipeline.',monthlyRupees:1500,yearlyRupees:14400,monthlyCredits:15000,limits:seedLimits(5,30000,10,10,5,10,5,25,100),sortOrder:1,featured:true,finderMinScore:7,finderMaxScore:10},
  {version:2,slug:'scale',name:'Scale',description:'Shared capacity for a larger portfolio of businesses.',monthlyRupees:5000,yearlyRupees:48000,monthlyCredits:50000,limits:seedLimits(20,100000,50,30,20,25,15,100,500),sortOrder:2,featured:false,finderMinScore:11,finderMaxScore:null},
];
export const formatRupees = (value: number) => `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
export const formatCredits = (value: number) => value.toLocaleString('en-IN');
export const formatLimit = (key: LimitKey, value: number | null) => value === null ? 'Unlimited'
  : key === 'storageBytes' ? `${(value / 1_000_000_000).toLocaleString('en-IN', {maximumFractionDigits: 2})} GB` : formatCredits(value);
/** Legacy catalog storage is inherited from the account, never unlimited by omission. */
export const formatPlanLimit = (plan: SubscriptionPlan, key: LimitKey) =>
  plan.version < 2 && key === 'storageBytes' && plan.limits.storageBytes == null
    ? 'Legacy account allowance' : formatLimit(key, plan.limits[key]);
export const planAmountPaise = (plan: SubscriptionPlan, term: BillingTerm) =>
  Math.round((term === 'yearly' ? plan.yearlyRupees : plan.monthlyRupees) * 100);

export const FINDER_QUESTIONS = [
  { id: 'customer', title: 'Who are you?', hint: 'Choose the closest fit for this account.', selection: 'single', options: [
    { label: 'Solo founder', score: 0 }, { label: 'Creator / influencer', score: 0 },
    { label: 'Small team (2–5)', score: 1 }, { label: 'Growing brand', score: 2 },
    { label: 'Scale-up / enterprise', score: 3 }, { label: 'Agency', score: 2 },
  ] },
  { id: 'workflow', title: 'What will you focus on?', hint: 'Choose the work you want to do. Every plan includes these tools.', selection: 'multiple', options: [
    { label: 'Finding and managing leads', score: 0 }, { label: 'Outreach and follow-ups', score: 1 },
    { label: 'Content and creative work', score: 1 }, { label: 'Performance marketing', score: 1 },
  ] },
  { id: 'leads', title: 'How many leads each month?', hint: 'Think about the leads you expect to discover or enrich.', selection: 'single', options: [
    { label: 'Up to 100', score: 0 }, { label: '101–500', score: 1 },
    { label: '501–2,000', score: 2 }, { label: '2,001–10,000', score: 3 },
    { label: 'More than 10,000', score: 4 },
  ] },
  { id: 'outreach', title: 'How much outreach each month?', hint: 'Count individual messages across your channels.', selection: 'single', options: [
    { label: 'Up to 100 messages', score: 0 }, { label: '101–500 messages', score: 1 },
    { label: '501–2,000 messages', score: 2 }, { label: '2,001–10,000 messages', score: 3 },
    { label: 'More than 10,000 messages', score: 4 },
  ] },
  { id: 'creation', title: 'How often will you create content or ads?', hint: 'Include copy, images, video and campaign preparation.', selection: 'single', options: [
    { label: 'Occasionally or not yet', score: 0 }, { label: 'A few times a week', score: 1 },
    { label: 'Every day', score: 2 }, { label: 'Several times a day', score: 3 },
  ] },
] as const;

export function planForScore(score: number, plans: SubscriptionPlan[] = SUBSCRIPTION_PLANS): SubscriptionPlan {
  if (!Number.isFinite(score) || score < 0) throw new Error('Invalid guidance score');
  const plan = plans.find(plan => score >= plan.finderMinScore && (plan.finderMaxScore === null || score <= plan.finderMaxScore));
  if (!plan) throw new Error('No published recommendation is available for these answers');
  return plan;
}

export type FinderAnswers = number[][];

export function recommendPlan(answers: FinderAnswers, plans: SubscriptionPlan[] = SUBSCRIPTION_PLANS) {
  if (answers.length !== FINDER_QUESTIONS.length) throw new Error('Answer all five questions');
  const choices = FINDER_QUESTIONS.map((question, index) => {
    const selected = [...new Set(answers[index])].sort((a, b) => a - b);
    if (!selected.length || (question.selection === 'single' && selected.length !== 1)) {
      throw new Error(question.selection === 'multiple' ? 'Choose at least one answer' : 'Choose one answer per question');
    }
    const options = selected.map(optionIndex => {
      if (!Number.isInteger(optionIndex) || !question.options[optionIndex]) throw new Error('Invalid finder answer');
      return question.options[optionIndex];
    });
    // Multiple workflows retain the original mixed-workflow weight, without counting overlapping work twice.
    const score = question.id === 'workflow' && options.length > 1 ? 2 : Math.max(...options.map(option => option.score));
    return { question: question.title, label: options.map(option => option.label).join(', '), score };
  });
  const score = choices.reduce((total, choice) => total + choice.score, 0);
  return { plan: planForScore(score, plans), score, choices };
}

/** Always calculate from the original anniversary, avoiding Jan 31 → Feb 28 → Mar 28 drift. */
export function addCalendarMonths(anchor: Date, months: number): Date {
  const result = new Date(anchor);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result;
}

export function creditDepositDates(start: Date, end: Date, term: BillingTerm): Date[] {
  return Array.from({ length: term === 'yearly' ? 12 : 1 }, (_, index) => addCalendarMonths(start, index))
    .filter(date => date < end);
}

export type SubscriptionAccess = {
  allowed: boolean;
  reason: 'rollout_pending' | 'paid' | 'admin_grant' | 'existing_user_grace' | 'payment_grace' | 'subscription_required' | 'approval_required';
  accessUntil: string | null;
  canTopUp: boolean;
};

export function calculateSubscriptionAccess(input: {
  enforced: boolean; launchedAt: Date | null; userCreatedAt: Date;
  paidFrom?: Date | null; paidThrough?: Date | null; failedRenewal?: boolean; cancelled?: boolean;
}, now = new Date()): SubscriptionAccess {
  const paid = !!input.paidFrom && input.paidFrom <= now && !!input.paidThrough && input.paidThrough > now;
  if (paid) return { allowed: true, reason: 'paid', accessUntil: input.paidThrough!.toISOString(), canTopUp: true };
  if (!input.enforced) return { allowed: true, reason: 'rollout_pending', accessUntil: null, canTopUp: false };
  const existingUntil = input.launchedAt && input.userCreatedAt < input.launchedAt
    ? new Date(input.launchedAt.getTime() + 30 * 86400000) : null;
  if (existingUntil && existingUntil > now) return { allowed: true, reason: 'existing_user_grace', accessUntil: existingUntil.toISOString(), canTopUp: false };
  const recoveryUntil = input.failedRenewal && !input.cancelled && input.paidThrough
    ? new Date(input.paidThrough.getTime() + 7 * 86400000) : null;
  if (recoveryUntil && recoveryUntil > now) return { allowed: true, reason: 'payment_grace', accessUntil: recoveryUntil.toISOString(), canTopUp: false };
  return { allowed: false, reason: 'subscription_required', accessUntil: null, canTopUp: false };
}

export type SubscriptionSummary = {
  id: string; version: number; name: string; plan: PlanSlug; term: BillingTerm; status: string; mode: 'test' | 'live';
  paidThrough: string | null; cancelAtPeriodEnd: boolean; paymentMethod: string | null;
  source?: 'razorpay' | 'admin';
};
export type SubscriptionState = {
  organization: BillingOrganization; entitlements: OrganizationEntitlements;
  access: SubscriptionAccess; approved: boolean; checkoutAvailable: boolean; mode: 'test' | 'live' | null;
  subscription: SubscriptionSummary | null; pendingChange: SubscriptionSummary | null;
  nextDepositAt: string | null;
  charges: { id: string; amountPaise: number; term: BillingTerm; plan: PlanSlug; paidAt: string; periodStart: string; periodEnd: string; invoiceUrl: string | null; taxPaise: number | null; refundAmountPaise?: number; refundObservedAt?: string | null }[];
};
export type SubscriptionCheckout = { subscriptionId: string; keyId: string; mode: 'test' | 'live'; startsAt: string | null; replacement: boolean };
