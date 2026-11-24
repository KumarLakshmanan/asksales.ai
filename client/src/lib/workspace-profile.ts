import api from "@/lib/api";
import { WORKSPACE_TYPES } from "../../../shared/workspaceOnboarding";
import { isEmailAddress } from "../../../shared/emailAddress";
import { deviceTimeZone } from "../../../shared/timeZones";
export { WORKSPACE_TYPES, APPLICATION_USES, CHANNELS, TEAM_SIZES, FOCUS_AREAS } from "../../../shared/workspaceOnboarding";

export interface BrandImageAsset {
  url: string;
  originalUrl?: string;
  thumbnailUrl?: string;
  alt?: string;
  width?: number;
  height?: number;
  source?: "website" | "upload";
  originalName?: string;
  sizeBytes?: number;
}
export interface WorkspaceWebsiteAnalysis {
  url: string;
  analyzedAt: string;
  data: Record<string, unknown>;
  kbEntryId: number | null;
  summary: { pages: number; knowledgeSaved: boolean; warnings: string[] };
}
export interface SavedWorkspaceProfile extends Record<string, unknown> {
  id: number;
  name?: string;
  companyName?: string;
  isDefault?: boolean;
  role?: string;
  websiteAnalysis?: WorkspaceWebsiteAnalysis | null;
}
export interface WorkspaceProfileData {
  workspaceType: string;
  name: string;
  country: string;
  timezone: string;
  companySize: string;
  description: string;
  industry: string;
  website: string;
  customerType: string;
  targetRegions: string[];
  email: string;
  phone: string;
  applicationUses: string[];
  setupGoal: string;
  currentTools: string;
  preferredChannels: string[];
}

export function readStringList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    try {
      return readStringList(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}
export function emptyWorkspaceProfile(): WorkspaceProfileData {
  return {
    workspaceType: "",
    name: "",
    country: "",
    timezone: deviceTimeZone("UTC"),
    companySize: "",
    description: "",
    industry: "",
    website: "",
    customerType: "",
    targetRegions: [],
    email: "",
    phone: "",
    applicationUses: [],
    setupGoal: "",
    currentTools: "",
    preferredChannels: [],
  };
}
const stringValue = (value: unknown) =>
  typeof value === "string" ? value : "";
export function workspaceProfileData(
  profile: Record<string, unknown>,
): WorkspaceProfileData {
  const defaults = emptyWorkspaceProfile();
  const legacyType = stringValue(profile.profileType).toLowerCase();
  return {
    ...defaults,
    ...Object.fromEntries(
      Object.keys(defaults)
        .filter(
          (key) => !Array.isArray(defaults[key as keyof WorkspaceProfileData]),
        )
        .map((key) => [
          key,
          stringValue(profile[key]) ||
            defaults[key as keyof WorkspaceProfileData],
        ]),
    ),
    workspaceType:
      stringValue(profile.workspaceType) ||
      {
        individual: "individual",
        creator: "creator",
        agency: "agency",
        organization: "business",
        b2b: "business",
        b2c: "business",
        both: "business",
      }[legacyType] ||
      "",
    name:
      stringValue(profile.companyName) ||
      stringValue(profile.businessName) ||
      stringValue(profile.name),
    applicationUses: readStringList(profile.applicationUses),
    targetRegions: readStringList(profile.targetRegions),
    preferredChannels: readStringList(profile.preferredChannels),
  };
}

export function applyWebsiteToProfile(
  current: WorkspaceProfileData,
  analysis: WorkspaceWebsiteAnalysis,
): WorkspaceProfileData {
  const extracted = workspaceProfileData(analysis.data);
  const fields = [
    "name",
    "description",
    "industry",
    "country",
    "website",
    "customerType",
    "email",
    "phone",
    "companySize",
  ] as const;
  const result = { ...current };
  for (const key of fields) if (extracted[key]) result[key] = extracted[key];
  if (extracted.targetRegions.length)
    result.targetRegions = extracted.targetRegions;
  if (extracted.preferredChannels.length)
    result.preferredChannels = extracted.preferredChannels;
  result.website = stringValue(analysis.data.website) || analysis.url;
  return result;
}

/** Only represented fields are written: advanced legacy profile details stay intact. */
export function workspaceProfilePayload(data: WorkspaceProfileData) {
  return {
    name: data.name.trim(),
    companyName: data.name.trim(),
    ...(data.workspaceType ? { workspaceType: data.workspaceType } : {}),
    country: data.country,
    timezone: data.timezone || null,
    companySize: data.companySize,
    description: data.description.trim(),
    industry: data.industry.trim(),
    website: data.website.trim(),
    customerType: data.customerType.trim(),
    targetRegions: [
      ...new Set(
        data.targetRegions.map((value) => value.trim()).filter(Boolean),
      ),
    ],
    email: data.email.trim(),
    phone: data.phone.trim(),
    applicationUses: data.applicationUses,
    setupGoal: data.setupGoal.trim(),
    currentTools: data.currentTools.trim(),
    preferredChannels: data.preferredChannels,
  };
}

export function profileStepError(
  data: WorkspaceProfileData,
  step: number,
  creating = true,
): string | null {
  if (step === 1) {
    if (
      creating &&
      !WORKSPACE_TYPES.some((type) => type.value === data.workspaceType)
    )
      return "Choose who this workspace is for.";
    if (!data.name.trim()) return "Add a workspace name.";
    if (data.name.length > 255)
      return "Keep the workspace name within 255 characters.";
    if (data.timezone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: data.timezone });
      } catch {
        return "Choose a valid time zone.";
      }
    }
  }
  if (step === 2) {
    if (creating && !data.description.trim())
      return "Add a short description of your work.";
    if (data.website) {
      try {
        const url = new URL(data.website);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          return "Use a full http:// or https:// website URL.";
      } catch {
        return "Use a full http:// or https:// website URL.";
      }
    }
    if (data.email && !isEmailAddress(data.email))
      return "Check the contact email address.";
  }
  if (step === 3 && creating && !data.applicationUses.length)
    return "Choose at least one way you plan to use AskSales.";
  return null;
}

export function suggestedChannels(uses: string[]): string[] {
  const channels = new Set<string>();
  for (const use of uses) {
    for (const channel of {
      customer_support: ["Email", "WhatsApp", "Website chat"],
      sales_leads: ["Email", "WhatsApp"],
      content_social: ["Instagram", "Facebook / Messenger", "YouTube"],
      marketing_campaigns: ["Email", "WhatsApp"],
      advertising: ["Google Ads", "Meta Ads"],
      personal_productivity: ["Email"],
    }[use] || [])
      channels.add(channel);
  }
  return [...channels];
}

export const workspaceCreationKey = (
  userId: number | undefined,
  adding: boolean,
) => `setup:workspace-creation:${userId}:${adding ? "additional" : "initial"}`;
export interface WorkspaceCreationDraft {
  requestKey?: string;
  profileId: number | null;
  phase: "website" | "profile";
  data: WorkspaceProfileData;
  step: number;
  analysis?: WorkspaceWebsiteAnalysis | null;
  updatedAt: number;
}
export function readWorkspaceCreation(
  userId: number | undefined,
  adding: boolean,
): WorkspaceCreationDraft | null {
  try {
    const stored = JSON.parse(
      sessionStorage.getItem(workspaceCreationKey(userId, adding)) || "null",
    );
    const draft = stored?.version === 2 ? { ...stored.data, updatedAt: stored.updatedAt } : stored;
    return draft &&
      draft.updatedAt > Date.now() - 24 * 60 * 60 * 1000 &&
      draft.data &&
      ["website", "profile"].includes(draft.phase)
      ? draft
      : null;
  } catch {
    return null;
  }
}
export async function clearWorkspaceCreation(
  userId: number | undefined,
  profileId: number,
) {
  for (const adding of [false, true]) {
    const remoteKey = adding ? "workspace:new" : "workspace:first";
    const endpoint = `/api/setup/drafts/${encodeURIComponent(remoteKey)}`;
    const response = await api.get<{ draft: { data: WorkspaceCreationDraft; revision: number } | null }>(endpoint);
    if (response?.draft?.data?.profileId === profileId) {
      await api.delete(endpoint, { body: JSON.stringify({ expectedRevision: response.draft.revision }), headers: { "Content-Type": "application/json" } });
    }
    if (readWorkspaceCreation(userId, adding)?.profileId === profileId)
      sessionStorage.removeItem(workspaceCreationKey(userId, adding));
  }
}

/** Country names from ISO codes, with existing custom values retained by the form. */
export function countryNames(): string[] {
  const codes =
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW";
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  return codes
    .split(" ")
    .map((code) => names.of(code) || code)
    .sort();
}
