"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import api from "@/lib/api";
import { normalizeUploadUrl } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageErrorState } from "@/components/ui/page-state";
import { LoadingState } from "@/components/ui/loading-state";
import {
  buildAutonomousCampaignPayload,
  campaignPublishState,
  CAMPAIGN_STATE_COPY,
  type CampaignPublishResponse,
  type CampaignPublishState,
  safeDashboardReturnPath,
} from "@/lib/adCampaignPublishing";
import {
  Megaphone,
  Send,
  ChevronLeft,
  Check,
  CheckCircle2,
  Globe,
  Image as ImageIcon,
  Sparkles,
  X,
  CircleDollarSign,
  Users,
  Target,
  Save,
  Info,
} from "lucide-react";

interface AdItem {
  id: string;
  title: string;
  content: string;
  body?: string;
  platform: string;
  imageUrl?: string;
  videoUrl?: string;
  keywords?: string[];
  businessProfileId?: number;
  brandToolkitId?: number;
  icpId?: number;
  threadId?: number;
  sourceType: "content_asset" | "content_template";
  sourceId: number;
  sourceVersion: number;
  sourceUpdatedAt?: string;
}

interface ContentAsset {
  id: number;
  type: string;
  title: string;
  content: string;
  channel?: string;
  imageUrl?: string;
  videoUrl?: string;
  imageUrls?: string[];
  videoUrls?: string[];
  createdAt: string;
  businessProfileId?: number;
  brandToolkitId?: number;
  icpId?: number;
  threadId?: number;
  metadata?: Record<string, unknown>;
  version?: number;
  updatedAt?: string;
}

interface ContentTemplate {
  id: number;
  name: string;
  type: string;
  content: string;
  category?: string;
  version: number;
  businessProfileId?: number;
  brandToolkitId?: number;
  updatedAt?: string;
}

interface PublishCampaignForm {
  selectedAds: string[];
  campaignName: string;
  publishPlatforms: ("meta" | "google")[];
  budgetType: "DAILY" | "LIFETIME";
  dailyBudget: string;
  lifetimeBudget: string;
  currency: "USD" | "EUR" | "GBP" | "INR" | "CAD" | "AUD" | "JPY" | "BRL" | "MXN" | "SGD" | "AED";
  bidStrategy: string;
  bidAmount: string;
  startDate: string;
  endDate: string;
  ageMin: number;
  ageMax: number;
  genders: string[];
  countries: string[];
  objective: string;
  optimizationGoal: string;
  billingEvent: string;
  callToAction: string;
  placements: string[];
  specialAdCategories: string[];
  metaPixelId: string;
  metaCustomConversionId: string;
  metaApplicationId: string;
  metaObjectStoreUrl: string;
  googleBudgetMode: "CAMPAIGN_TOTAL" | "AVERAGE_DAILY";
  googleBiddingStrategy: string;
  googleKeywordMatchType: "BROAD" | "PHRASE" | "EXACT";
  googleKeywords: string[];
  googleNegativeKeywords: string[];
  googleLanguageIds: string[];
  googleTrackingTemplate: string;
  googleFinalUrlSuffix: string;
  googlePath1: string;
  googlePath2: string;
  linkUrl: string;
  allowAiPause: boolean;
  activationConfirmed: boolean;
}

const CAMPAIGN_OBJECTIVES = [
  { value: "traffic", label: "Traffic (Link Clicks)" },
  { value: "sales", label: "Sales (Conversions)" },
  { value: "leads", label: "Leads (Lead Generation)" },
  { value: "engagement", label: "Engagement" },
  { value: "awareness", label: "Awareness (Reach & Brand Awareness)" },
  { value: "app_promotion", label: "App Promotion" },
];

const OPTIMIZATION_GOALS = [
  { value: "LINK_CLICKS", label: "Link Clicks" },
  { value: "LANDING_PAGE_VIEWS", label: "Landing Page Views" },
  { value: "IMPRESSIONS", label: "Impressions" },
  { value: "REACH", label: "Reach" },
  { value: "LEAD_GENERATION", label: "Lead Generation" },
  { value: "OFFSITE_CONVERSIONS", label: "Offsite Conversions" },
];

const BILLING_EVENTS = [
  { value: "IMPRESSIONS", label: "Impressions (CPM)" },
  { value: "LINK_CLICKS", label: "Link Clicks (CPC)" },
];

const BID_STRATEGIES = [
  { value: "LOWEST_COST_WITHOUT_CAP", label: "Lowest Cost (Automatic)" },
  { value: "COST_CAP", label: "Cost Cap" },
  { value: "BID_CAP", label: "Bid Cap" },
];

const CALL_TO_ACTIONS = [
  { value: "LEARN_MORE", label: "Learn More" },
  { value: "SHOP_NOW", label: "Shop Now" },
  { value: "SIGN_UP", label: "Sign Up" },
  { value: "DOWNLOAD", label: "Download" },
  { value: "CONTACT_US", label: "Contact Us" },
  { value: "GET_QUOTE", label: "Get Quote" },
  { value: "BOOK_TRAVEL", label: "Book Now" },
  { value: "SUBSCRIBE", label: "Subscribe" },
  { value: "GET_OFFER", label: "Get Offer" },
  { value: "APPLY_NOW", label: "Apply Now" },
  { value: "BUY_NOW", label: "Buy Now" },
  { value: "WATCH_MORE", label: "Watch More" },
];

const COUNTRIES = [
  { value: "US", label: "United States" },
  { value: "IN", label: "India" },
  { value: "GB", label: "United Kingdom" },
  { value: "CA", label: "Canada" },
  { value: "AU", label: "Australia" },
  { value: "DE", label: "Germany" },
  { value: "FR", label: "France" },
];

const GOOGLE_GEO_IDS: Record<string, string> = {
  US: "2840",
  IN: "2356",
  GB: "2826",
  CA: "2124",
  AU: "2036",
  DE: "2276",
  FR: "2250",
};

function AdPublishPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  const targetAssetId = parseInt(searchParams.get("assetId") || "0", 10);
  const targetTemplateId = parseInt(searchParams.get("templateId") || "0", 10);
  const fromPath = safeDashboardReturnPath(searchParams.get("from"), "/dashboard/saved-templates/ads");

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null);
  const [allAds, setAllAds] = useState<AdItem[]>([]);
  const [activeSettingsTab, setActiveSettingsTab] = useState("ads");
  const [activePreviewPlatform, setActivePreviewPlatform] = useState<"meta" | "google">("meta");
  const [currentPreviewIndex, setCurrentPreviewIndex] = useState(0);
  const [locationInput, setLocationInput] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [publishedResult, setPublishedResult] = useState<{
    campaignId?: string;
    state: CampaignPublishState;
    validationErrors?: string[];
  } | null>(null);
  const [objectiveRationale, setObjectiveRationale] = useState("");
  const [objectiveInferred, setObjectiveInferred] = useState(false);
  const [accountSnapshot, setAccountSnapshot] = useState<CampaignPublishResponse["accountSnapshot"]>();
  const [adSettingLocations, setAdSettingLocations] = useState<Array<{
    countryCode: string;
    region?: string;
    city?: string;
    googleGeoTargetId?: string;
    metaLocationKey?: string;
  }>>([]);
  const [requestKey, setRequestKey] = useState(() => `ad-library-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const [publishForm, setPublishForm] = useState<PublishCampaignForm>({
    selectedAds: [],
    campaignName: "My Ad Campaign",
    publishPlatforms: ["meta"],
    budgetType: "LIFETIME",
    dailyBudget: "1000",
    lifetimeBudget: "100",
    currency: "USD",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    bidAmount: "",
    startDate: new Date().toISOString().split("T")[0],
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
    ageMin: 18,
    ageMax: 65,
    genders: ["1", "2"],
    countries: ["US"],
    objective: "",
    optimizationGoal: "LINK_CLICKS",
    billingEvent: "IMPRESSIONS",
    callToAction: "LEARN_MORE",
    placements: [],
    specialAdCategories: [],
    metaPixelId: "",
    metaCustomConversionId: "",
    metaApplicationId: "",
    metaObjectStoreUrl: "",
    googleBudgetMode: "CAMPAIGN_TOTAL",
    googleBiddingStrategy: "MAXIMIZE_CONVERSIONS",
    googleKeywordMatchType: "BROAD",
    googleKeywords: [],
    googleNegativeKeywords: [],
    googleLanguageIds: ["languageConstants/1000"],
    googleTrackingTemplate: "",
    googleFinalUrlSuffix: "",
    googlePath1: "",
    googlePath2: "",
    linkUrl: "",
    allowAiPause: false,
    activationConfirmed: false,
  });

  const loadPageData = useCallback(async () => {
      setLoading(true);
      setLoadError(null);
      setProfileLoadError(null);
      try {
        const [profileResult, toolkitResult, assetsResult, templateResult] = await Promise.allSettled([
          api.get<Array<{ id: number; website?: string }>>("/api/settings/business-profiles"),
          api.get<{ id: number }>("/api/content/brand-toolkits/default"),
          api.get<ContentAsset[]>("/api/content/assets?type=ad_copy"),
          targetTemplateId > 0
            ? api.get<ContentTemplate>(`/api/content/templates/${targetTemplateId}`)
            : Promise.resolve(null),
        ]);
        let defaultLinkUrl = "";
        let defaultBusinessProfileId: number | undefined;
        if (profileResult.status === "fulfilled") {
          const profileResponse = profileResult.value;
          defaultBusinessProfileId = profileResponse[0]?.id;
          if (Array.isArray(profileResponse) && profileResponse.length > 0 && profileResponse[0].website) {
          const ws = profileResponse[0].website;
          defaultLinkUrl = ws.startsWith("http") ? ws : `https://${ws}`;
          }
        } else {
          setProfileLoadError(profileResult.reason instanceof Error ? profileResult.reason.message : "The default website could not be loaded.");
        }
        const defaultBrandToolkitId = toolkitResult.status === "fulfilled"
          ? toolkitResult.value.id
          : undefined;

        if (assetsResult.status === "rejected") throw assetsResult.reason;
        const assets = assetsResult.value;
        const mappedAds: AdItem[] = assets.map((a) => {
          let headline = a.title;
          let body = a.content;
          let imageUrl = a.imageUrl || a.imageUrls?.[0];
          let videoUrl = a.videoUrl || a.videoUrls?.[0];
          let keywords: string[] = [];

          try {
            const parsed = JSON.parse(a.content);
            headline = parsed.headline || a.title;
            body = parsed.body || parsed.primaryText || a.content;
            if (parsed.imageUrl) imageUrl = parsed.imageUrl;
            if (parsed.videoUrl) videoUrl = parsed.videoUrl;
            if (Array.isArray(parsed.keywords)) keywords = parsed.keywords;
          } catch {
            // Keep default values
          }

          return {
            id: a.id.toString(),
            title: headline,
            content: body,
            body: body,
            platform: a.channel || "meta",
            imageUrl,
            videoUrl,
            keywords,
            businessProfileId: a.businessProfileId || defaultBusinessProfileId,
            brandToolkitId: a.brandToolkitId || defaultBrandToolkitId,
            icpId: a.icpId || (typeof a.metadata?.icpId === "number" ? a.metadata.icpId : undefined),
            threadId: a.threadId,
            sourceType: "content_asset" as const,
            sourceId: a.id,
            sourceVersion: a.version || 1,
            sourceUpdatedAt: a.updatedAt,
          };
        });

        if (targetTemplateId > 0) {
          if (templateResult.status === "rejected") throw templateResult.reason;
          const template = templateResult.value;
          if (!template || template.type !== "ad_copy") {
            throw new Error("The selected Saved Template is missing or is not an ad template.");
          }
          let headline = template.name;
          let body = template.content;
          let keywords: string[] = [];
          try {
            const parsed = JSON.parse(template.content) as Record<string, unknown>;
            headline = String(parsed.headline || parsed.title || template.name);
            body = String(parsed.body || parsed.primaryText || parsed.description || template.content);
            keywords = Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [];
          } catch {
            // Plain-text templates remain valid creative snapshots.
          }
          mappedAds.unshift({
            id: `template-${template.id}`,
            title: headline,
            content: body,
            body,
            platform: template.category || "google",
            keywords,
            businessProfileId: template.businessProfileId || defaultBusinessProfileId,
            brandToolkitId: template.brandToolkitId || defaultBrandToolkitId,
            sourceType: "content_template",
            sourceId: template.id,
            sourceVersion: template.version || 1,
            sourceUpdatedAt: template.updatedAt,
          });
        }

        // Pre-select target asset and set initial campaign name
        const selectedIdStr = targetTemplateId > 0 ? `template-${targetTemplateId}` : targetAssetId.toString();
        // Publishing is irreversible once queued, so never pre-select every creative. Only a targeted ad is pre-selected;
        // otherwise the owner chooses which creatives to publish.
        const selectedAds = mappedAds.some((ad) => ad.id === selectedIdStr)
          ? [selectedIdStr]
          : [];

        const targetAd = mappedAds.find((ad) => ad.id === selectedIdStr);
        let campaignName = "My Ad Campaign";
        if (targetAd) {
          campaignName = `${targetAd.title} Campaign`;
        }

        setPublishForm((prev) => ({
          ...prev,
          selectedAds,
          campaignName,
          linkUrl: defaultLinkUrl,
        }));
        const selectedForInference = mappedAds.filter((ad) => selectedAds.includes(ad.id));
        const [settingsResponse, inferenceResponse, icpResponse] = await Promise.all([
          api.get<{
            settings: {
              defaultLifetimeBudget: number;
              currency: PublishCampaignForm["currency"];
              locations: Array<{
                countryCode: string;
                region?: string;
                city?: string;
                googleGeoTargetId?: string;
                metaLocationKey?: string;
              }>;
            };
            readiness?: { accounts?: CampaignPublishResponse["accountSnapshot"] };
          }>("/api/settings/ads"),
          api.post<{ inference: { objective: string; rationale: string } | null }>(
            "/api/campaigns/autonomous/infer-objective",
            { contentStudioContext: selectedForInference.map((ad) => `${ad.title}\n${ad.content}`).join("\n\n").slice(0, 100_000) || "No objective signals available." },
          ),
          selectedForInference[0]?.threadId
            ? api.get<{
              id?: number | null;
              approved?: boolean;
              campaignObjective?: string | null;
              targetAudience?: {
                ageRange?: { min?: number; max?: number };
                gender?: string[];
                countries?: string[];
                locations?: string[];
              } | null;
            }>(`/api/icp/thread/${selectedForInference[0].threadId}`).catch(() => null)
            : Promise.resolve(null),
        ]);
        const inferredKeywords = Array.from(new Set(selectedForInference.flatMap((ad) => ad.keywords || [])));
        const contextualAds = mappedAds.map((ad) => ({
          ...ad,
          icpId: ad.icpId || (
            icpResponse?.approved && ad.threadId === selectedForInference[0]?.threadId && icpResponse.id
              ? icpResponse.id
              : undefined
          ),
        }));
        setAllAds(contextualAds);
        const icpCountries = icpResponse?.approved
          ? (icpResponse.targetAudience?.countries || icpResponse.targetAudience?.locations || [])
            .map((country) => country.trim().toUpperCase())
            .filter((country) => /^[A-Z]{2}$/.test(country))
          : [];
        const icpGenders = icpResponse?.approved
          ? (icpResponse.targetAudience?.gender || [])
            .map((gender) => gender.toLowerCase() === "male" ? "1" : gender.toLowerCase() === "female" ? "2" : "")
            .filter(Boolean)
          : [];
        const approvedIcpObjective = icpResponse?.approved
          && CAMPAIGN_OBJECTIVES.some((objective) => objective.value === icpResponse.campaignObjective)
          ? icpResponse.campaignObjective || ""
          : "";
        setPublishForm((prev) => ({
          ...prev,
          lifetimeBudget: String(settingsResponse.settings.defaultLifetimeBudget),
          currency: settingsResponse.settings.currency,
          countries: icpCountries.length
            ? icpCountries
            : settingsResponse.settings.locations.length
              ? settingsResponse.settings.locations.map((location) => location.countryCode)
              : prev.countries,
          ageMin: icpResponse?.approved ? icpResponse.targetAudience?.ageRange?.min || prev.ageMin : prev.ageMin,
          ageMax: icpResponse?.approved ? icpResponse.targetAudience?.ageRange?.max || prev.ageMax : prev.ageMax,
          genders: icpGenders.length ? icpGenders : prev.genders,
          objective: approvedIcpObjective || inferenceResponse.inference?.objective || prev.objective,
          googleKeywords: inferredKeywords,
        }));
        setAccountSnapshot(settingsResponse.readiness?.accounts);
        setAdSettingLocations(settingsResponse.settings.locations);
        setObjectiveRationale(approvedIcpObjective
          ? "Prefilled from the approved ICP linked to this conversation."
          : inferenceResponse.inference?.rationale || "Objective could not be inferred. Select one before publishing.");
        setObjectiveInferred(Boolean(approvedIcpObjective || inferenceResponse.inference));
      } catch (err) {
        console.error("Failed to load page details", err);
        setLoadError(err instanceof Error ? err.message : "Ad creatives could not be loaded.");
      } finally {
        setLoading(false);
      }
  }, [targetAssetId, targetTemplateId]);

  useEffect(() => { void loadPageData(); }, [loadPageData]);

  const displayHost = (value: string) => {
    if (!value) return "YOURSITE.COM";
    try { return new URL(value).hostname; } catch { return value; }
  };

  // Adjust preview platform based on form platform selection
  useEffect(() => {
    if (publishForm.publishPlatforms.length > 0 && !publishForm.publishPlatforms.includes(activePreviewPlatform)) {
      setActivePreviewPlatform(publishForm.publishPlatforms[0]);
    }
  }, [publishForm.publishPlatforms, activePreviewPlatform]);

  const toggleAdSelection = (adId: string) => {
    setPublishForm((prev) => ({
      ...prev,
      selectedAds: prev.selectedAds.includes(adId)
        ? prev.selectedAds.filter((id) => id !== adId)
        : [...prev.selectedAds, adId],
    }));
  };

  const selectAllAds = () => {
    setPublishForm((prev) => ({
      ...prev,
      selectedAds: prev.selectedAds.length === allAds.length ? [] : allAds.map((a) => a.id),
    }));
  };

  const toggleGender = (gender: string) => {
    setPublishForm((prev) => ({
      ...prev,
      genders: prev.genders.includes(gender)
        ? prev.genders.filter((g) => g !== gender)
        : [...prev.genders, gender],
    }));
  };

  const toggleCountry = (country: string) => {
    setPublishForm((prev) => ({
      ...prev,
      countries: prev.countries.includes(country)
        ? prev.countries.filter((c) => c !== country)
        : [...prev.countries, country],
    }));
  };

  // Validations
  function validateForm(): boolean {
    if (publishForm.selectedAds.length === 0) {
      toast({ title: "Validation Error", description: "Please select at least one ad creative", variant: "destructive" });
      setActiveSettingsTab("ads");
      return false;
    }
    if (!publishForm.campaignName.trim()) {
      toast({ title: "Validation Error", description: "Campaign Name is required", variant: "destructive" });
      setActiveSettingsTab("ads");
      return false;
    }
    if (publishForm.campaignName.trim().length < 3) {
      toast({ title: "Validation Error", description: "Campaign Name must be at least 3 characters", variant: "destructive" });
      setActiveSettingsTab("ads");
      return false;
    }

    const lifetimeBudget = Number(publishForm.lifetimeBudget);
    if (!Number.isFinite(lifetimeBudget) || lifetimeBudget <= 0) {
      toast({ title: "Validation Error", description: "Total lifetime budget must be greater than zero.", variant: "destructive" });
      setActiveSettingsTab("budget");
      return false;
    }

    const start = new Date(publishForm.startDate);
    const end = new Date(publishForm.endDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (start < today) {
      toast({ title: "Validation Error", description: "Start date cannot be in the past", variant: "destructive" });
      setActiveSettingsTab("budget");
      return false;
    }
    if (end <= start) {
      toast({ title: "Validation Error", description: "End date must be after start date", variant: "destructive" });
      setActiveSettingsTab("budget");
      return false;
    }
    if ((end.getTime() - start.getTime()) / (1000 * 60 * 60) < 24) {
      toast({ title: "Validation Error", description: "Campaign must run for at least 24 hours", variant: "destructive" });
      setActiveSettingsTab("budget");
      return false;
    }

    if (publishForm.countries.length === 0) {
      toast({ title: "Validation Error", description: "Please select at least one country", variant: "destructive" });
      setActiveSettingsTab("targeting");
      return false;
    }
    if (publishForm.publishPlatforms.includes("meta") && publishForm.genders.length === 0) {
      toast({ title: "Validation Error", description: "Please select at least one gender", variant: "destructive" });
      setActiveSettingsTab("targeting");
      return false;
    }
    if (publishForm.publishPlatforms.includes("meta") && publishForm.ageMin >= publishForm.ageMax) {
      toast({ title: "Validation Error", description: "Minimum age must be less than maximum age", variant: "destructive" });
      setActiveSettingsTab("targeting");
      return false;
    }
    if (publishForm.publishPlatforms.includes("google")) {
      const missingGeoTargets = publishForm.countries.filter((countryCode) => !/^geoTargetConstants\/\d+$/.test(
        adSettingLocations.find((location) => location.countryCode === countryCode)?.googleGeoTargetId
        || (GOOGLE_GEO_IDS[countryCode] ? `geoTargetConstants/${GOOGLE_GEO_IDS[countryCode]}` : ""),
      ));
      if (missingGeoTargets.length) {
        toast({
          title: "Google location mapping required",
          description: `Add a geoTargetConstants ID for: ${missingGeoTargets.join(", ")}.`,
          variant: "destructive",
        });
        setActiveSettingsTab("targeting");
        return false;
      }
    }

    if (!publishForm.objective) {
      toast({ title: "Validation Error", description: "Review and select the campaign objective before publishing.", variant: "destructive" });
      setActiveSettingsTab("settings");
      return false;
    }

    if (!publishForm.linkUrl.trim()) {
      toast({ title: "Validation Error", description: "A landing page URL is required before activation.", variant: "destructive" });
      setActiveSettingsTab("settings");
      return false;
    }

    if (publishForm.linkUrl.trim()) {
      try {
        new URL(publishForm.linkUrl);
      } catch {
        toast({ title: "Validation Error", description: "Please enter a valid landing page URL (e.g. https://example.com)", variant: "destructive" });
        setActiveSettingsTab("settings");
        return false;
      }
    }

    if (!publishForm.activationConfirmed) {
      toast({ title: "Live activation confirmation required", description: "Confirm the selected accounts, lifetime budget, and live activation scope before publishing.", variant: "destructive" });
      setActiveSettingsTab("settings");
      return false;
    }

    return true;
  }

  async function handlePublish() {
    if (!validateForm()) return;

    setIsPublishing(true);
    try {
      const selectedAdObjects = allAds.filter((ad) => publishForm.selectedAds.includes(ad.id));
      const inferredGoogleKeywords = Array.from(
        new Set(selectedAdObjects.flatMap((ad) => ad.keywords || []))
      );
      const googleKeywords = publishForm.googleKeywords.length
        ? publishForm.googleKeywords
        : inferredGoogleKeywords;
      const creatives = selectedAdObjects.map((ad) => ({
        id: ad.id,
        headline: ad.title,
        primaryText: ad.content,
        description: ad.body || ad.content,
        imageUrl: ad.imageUrl,
        videoUrl: ad.videoUrl,
        keywords: ad.keywords,
        callToAction: publishForm.callToAction,
        ageMin: publishForm.ageMin,
        ageMax: publishForm.ageMax,
        genders: publishForm.genders.map(Number),
      }));
      const response = await api.post<{
        success: boolean;
        campaign: CampaignPublishResponse;
      }>("/api/campaigns/autonomous", buildAutonomousCampaignPayload({
        form: {
          ...publishForm,
          objectiveRationale: objectiveRationale || "Objective reviewed in the ad publishing surface.",
        },
        contentStudioContext: selectedAdObjects.map((ad) => `${ad.title}\n${ad.content}`).join("\n\n"),
        context: {
          businessProfileId: selectedAdObjects[0]?.businessProfileId,
          brandToolkitId: selectedAdObjects[0]?.brandToolkitId,
          icpId: selectedAdObjects[0]?.icpId,
          threadId: selectedAdObjects[0]?.threadId,
          creativeSources: selectedAdObjects.map((ad) => ({
            sourceType: ad.sourceType,
            sourceId: ad.sourceId,
            sourceVersion: ad.sourceVersion,
            updatedAt: ad.sourceUpdatedAt,
          })),
          scheduleDates: { startDate: publishForm.startDate, endDate: publishForm.endDate },
        },
        locations: publishForm.countries.map((countryCode) => ({
          ...adSettingLocations.find((location) => location.countryCode === countryCode),
          countryCode,
          googleGeoTargetId: adSettingLocations.find((location) => location.countryCode === countryCode)?.googleGeoTargetId
            || (GOOGLE_GEO_IDS[countryCode] ? `geoTargetConstants/${GOOGLE_GEO_IDS[countryCode]}` : undefined),
        })),
        creatives: {
          meta: publishForm.publishPlatforms.includes("meta") ? creatives : undefined,
          google: publishForm.publishPlatforms.includes("google")
            ? creatives.map((creative) => ({
                ...creative,
                keywords: googleKeywords.length ? googleKeywords : creative.keywords,
              }))
            : undefined,
        },
        idempotencyKey: requestKey,
        publish: true,
      }));

      if (response.success) {
        const state = campaignPublishState(response.campaign);
        const copy = CAMPAIGN_STATE_COPY[state];
        setPublishedResult({
          campaignId: String(response.campaign.id),
          state,
          validationErrors: response.campaign.validationErrors,
        });
        if (state === "validation_failed") {
          setRequestKey(`ad-library-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        }
        toast({
          title: copy.title,
          description: response.campaign.validationErrors?.length
            ? response.campaign.validationErrors.join(" ")
            : copy.description,
          variant: ["validation_failed", "provider_failed"].includes(state) ? "destructive" : "default",
        });
      }
    } catch (error) {
      console.error(error);
      toast({
        title: "Publishing Failed",
        description: error instanceof Error ? error.message : "Something went wrong. Verify your Ads connection in Settings.",
        variant: "destructive",
      });
    } finally {
      setIsPublishing(false);
    }
  }

  async function handleSaveAsDraft() {
    if (!publishForm.campaignName.trim() || publishForm.selectedAds.length === 0) {
      toast({ title: "Draft needs a name and creative", description: "Select at least one ad and enter a campaign name.", variant: "destructive" });
      return;
    }

    setIsSavingDraft(true);
    try {
      const selectedAdObjects = allAds.filter((ad) => publishForm.selectedAds.includes(ad.id));
      const creatives = selectedAdObjects.map((ad) => ({
        id: ad.id,
        headline: ad.title,
        primaryText: ad.content,
        description: ad.body || ad.content,
        imageUrl: ad.imageUrl,
        videoUrl: ad.videoUrl,
        keywords: ad.keywords,
        callToAction: publishForm.callToAction,
      }));
      const googleKeywords = publishForm.googleKeywords.length
        ? publishForm.googleKeywords
        : Array.from(new Set(selectedAdObjects.flatMap((ad) => ad.keywords || [])));
      const response = await api.post<{
        success: boolean;
        campaign: CampaignPublishResponse;
      }>("/api/campaigns/autonomous", buildAutonomousCampaignPayload({
        form: {
          ...publishForm,
          objectiveRationale: objectiveRationale || "Objective has not yet been reviewed.",
        },
        contentStudioContext: selectedAdObjects.map((ad) => `${ad.title}\n${ad.content}`).join("\n\n"),
        context: {
          businessProfileId: selectedAdObjects[0]?.businessProfileId,
          brandToolkitId: selectedAdObjects[0]?.brandToolkitId,
          icpId: selectedAdObjects[0]?.icpId,
          threadId: selectedAdObjects[0]?.threadId,
          creativeSources: selectedAdObjects.map((ad) => ({
            sourceType: ad.sourceType,
            sourceId: ad.sourceId,
            sourceVersion: ad.sourceVersion,
            updatedAt: ad.sourceUpdatedAt,
          })),
          scheduleDates: { startDate: publishForm.startDate, endDate: publishForm.endDate },
        },
        locations: publishForm.countries.map((countryCode) => ({
          ...adSettingLocations.find((location) => location.countryCode === countryCode),
          countryCode,
          googleGeoTargetId: adSettingLocations.find((location) => location.countryCode === countryCode)?.googleGeoTargetId
            || (GOOGLE_GEO_IDS[countryCode] ? `geoTargetConstants/${GOOGLE_GEO_IDS[countryCode]}` : undefined),
        })),
        creatives: {
          meta: publishForm.publishPlatforms.includes("meta") ? creatives : undefined,
          google: publishForm.publishPlatforms.includes("google")
            ? creatives.map((creative) => ({ ...creative, keywords: googleKeywords }))
            : undefined,
        },
        idempotencyKey: `${requestKey}-draft`,
        publish: false,
      }));

      if (response.success) {
        const state = campaignPublishState(response.campaign);
        toast({
          title: CAMPAIGN_STATE_COPY[state].title,
          description: CAMPAIGN_STATE_COPY[state].description,
        });
        router.push(fromPath);
      }
    } catch (error) {
      console.error(error);
      toast({
        title: "Draft Saving Failed",
        description: error instanceof Error ? error.message : "Something went wrong.",
        variant: "destructive",
      });
    } finally {
      setIsSavingDraft(false);
    }
  }

  // Pre-calculate selected ad copy details for live preview
  const validPreviewIndex = Math.min(currentPreviewIndex, Math.max(0, publishForm.selectedAds.length - 1));
  const currentSelectedId = publishForm.selectedAds[validPreviewIndex];
  const previewCreative = allAds.find((ad) => ad.id === currentSelectedId) || allAds[0] || null;

  // Previews
  function MetaPreview() {
    if (!previewCreative) return <div className="text-center py-12 text-muted-foreground text-xs">Select an ad creative to view preview</div>;

    const displayCaption = previewCreative.content || "Your ad copy body text will appear here...";
    const headline = previewCreative.title || "Your ad headline";
    const imageUrl = previewCreative.imageUrl ? normalizeUploadUrl(previewCreative.imageUrl) : null;
    const ctaLabel = CALL_TO_ACTIONS.find((c) => c.value === publishForm.callToAction)?.label || "Learn More";

    return (
      <div className="mx-auto w-[290px] rounded-xl overflow-hidden bg-white dark:bg-zinc-900 shadow-xl border border-border">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/50 bg-white dark:bg-zinc-900">
          <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold">
            YB
          </div>
          <div className="flex-1">
            <p className="text-xs font-semibold leading-none text-foreground">Your Brand Page</p>
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-xs text-muted-foreground">Sponsored ·</span>
              <Globe className="w-2.5 h-2.5 text-muted-foreground" />
            </div>
          </div>
        </div>

        {/* Caption */}
        <div className="px-3 py-2">
          <p className="text-xs leading-relaxed text-foreground line-clamp-4 whitespace-pre-wrap">{displayCaption}</p>
        </div>

        {/* Media Block */}
        <div className="aspect-video bg-muted flex items-center justify-center relative overflow-hidden">
          {imageUrl ? (
            <img src={imageUrl} alt="Ad creative" className="w-full h-full object-cover" />
          ) : (
            <div className="text-center text-muted-foreground">
              <ImageIcon className="w-8 h-8 mx-auto mb-1 opacity-40" />
              <span className="text-xs">No image asset yet</span>
            </div>
          )}
        </div>

        {/* CTA Bar */}
        <div className="px-3 py-2.5 bg-muted/30 border-t flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wider truncate">
              {displayHost(publishForm.linkUrl)}
            </p>
            <p className="text-xs font-semibold text-foreground truncate mt-0.5">{headline}</p>
          </div>
          <span className="bg-background dark:bg-zinc-800 text-foreground border border-border px-3 py-1.5 rounded text-xs font-bold shrink-0 shadow-sm">
            {ctaLabel}
          </span>
        </div>

        {/* Interaction bar */}
        <div className="px-3 py-1.5 flex items-center justify-between border-t border-border bg-card">
          <div className="flex items-center gap-1">
            <span className="text-xs">👍 ❤️</span>
            <span className="text-xs text-muted-foreground ml-1">1.2K</span>
          </div>
          <span className="text-xs text-muted-foreground">42 comments</span>
        </div>
      </div>
    );
  }

  function GooglePreview() {
    if (!previewCreative) return <div className="text-center py-12 text-muted-foreground text-xs">Select an ad creative to view preview</div>;

    const headline = previewCreative.title || "Your Google Ad Headline";
    const description = previewCreative.content.slice(0, 150) || "Your Google Ad description text goes here...";
    const displayUrl = publishForm.linkUrl || "https://www.yourbrand.com";

    return (
      <div className="mx-auto w-[300px] rounded-lg border border-border/80 bg-white dark:bg-zinc-900 p-4 shadow-xl">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-bold bg-muted-foreground/10 text-muted-foreground px-1.5 py-0.5 rounded uppercase tracking-wide">
            Sponsored
          </span>
          <span className="text-xs text-muted-foreground truncate">{displayUrl}</span>
        </div>
        <a href="#" className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline line-clamp-2 block leading-snug">
          {headline}
        </a>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed line-clamp-3">
          {description}
        </p>
      </div>
    );
  }

  // Success UI Screen
  if (publishedResult) {
    const stateCopy = CAMPAIGN_STATE_COPY[publishedResult.state];
    const isFailure = ["validation_failed", "provider_failed"].includes(publishedResult.state);
    return (
      <div className="h-full flex flex-col bg-background">
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-md w-full">
            <div className={`mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-md border ${
              isFailure ? "border-destructive/30 bg-destructive/10" : "border-border bg-muted/40"
            }`}>
              <CheckCircle2 className={`h-8 w-8 ${isFailure ? "text-destructive" : "text-primary"}`} />
            </div>
            <h2 className="text-2xl font-bold mb-2">{stateCopy.title}</h2>
            <p className="text-muted-foreground mb-6">
              {publishedResult.validationErrors?.length
                ? publishedResult.validationErrors.join(" ")
                : stateCopy.description}
            </p>
            {publishedResult.campaignId && (
              <div className="bg-muted/40 border border-border p-3 rounded-lg text-xs font-mono text-muted-foreground break-all mb-6">
                Campaign ID: {publishedResult.campaignId}
              </div>
            )}
            <div className="flex gap-3 justify-center">
              <Button variant="outline" onClick={() => router.push(fromPath)}>
                Back to library
              </Button>
              <Button variant="outline" onClick={() => router.push("/dashboard/ads?tab=campaigns")}>
                View status
              </Button>
              <Button onClick={() => {
                setPublishedResult(null);
                setRequestKey(`ad-library-${Date.now()}-${Math.random().toString(36).slice(2)}`);
                setPublishForm((previous) => ({ ...previous, activationConfirmed: false }));
              }}>
                <Sparkles className="w-4 h-4 mr-2" />
                Publish another
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!loading && loadError) {
    return <PageErrorState title="Ad creatives could not be loaded" description={loadError} reset={() => void loadPageData()} />;
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header Bar */}
      <div className="flex items-center gap-3 px-5 py-3.5 border-b bg-card">
        <Button variant="ghost" size="sm" onClick={() => router.push(fromPath)} className="gap-1.5 -ml-1">
          <ChevronLeft className="w-4 h-4" />
          Back
        </Button>
        <div className="h-4 w-px bg-border" />
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold">Publish ad campaign</h1>
        </div>
      </div>

      {profileLoadError && <Alert variant="destructive" className="m-4"><AlertTitle>Default website could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{profileLoadError} You can still enter the destination URL manually.</span><Button variant="outline" size="sm" onClick={() => void loadPageData()}>Try again</Button></AlertDescription></Alert>}

      {loading ? (
        <LoadingState size="section" label="Loading ad campaign settings…" className="flex-1" />
      ) : (
        <div className="flex-1 overflow-auto">
          <div className="max-w-6xl mx-auto px-5 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* Left Column: Form Settings (Tabs Style) */}
            <div className="lg:col-span-7 space-y-6">
              <div className="flex items-center justify-between border-b pb-4">
                <div>
                  <h2 className="text-lg font-semibold">Campaign settings</h2>
                  <p className="text-xs text-muted-foreground">Configure budget, targeting, and deployment settings</p>
                </div>
              </div>

              <Tabs value={activeSettingsTab} onValueChange={setActiveSettingsTab} className="w-full">
                <TabsList className="grid grid-cols-4 w-full bg-muted/50 p-1 rounded-xl">
                  <TabsTrigger value="ads" className="text-xs font-semibold rounded-lg">
                    <Megaphone className="w-3.5 h-3.5 mr-1.5" />
                    Creatives
                  </TabsTrigger>
                  <TabsTrigger value="budget" className="text-xs font-semibold rounded-lg">
                    <CircleDollarSign className="w-3.5 h-3.5 mr-1.5" />
                    Budget
                  </TabsTrigger>
                  <TabsTrigger value="targeting" className="text-xs font-semibold rounded-lg">
                    <Users className="w-3.5 h-3.5 mr-1.5" />
                    Targeting
                  </TabsTrigger>
                  <TabsTrigger value="settings" className="text-xs font-semibold rounded-lg">
                    <Target className="w-3.5 h-3.5 mr-1.5" />
                    Settings
                  </TabsTrigger>
                </TabsList>

                {/* Tab content 1: Creatives & Platforms */}
                <TabsContent value="ads" className="space-y-5 pt-4">
                  <div className="space-y-2">
                    <Label htmlFor="campaign-name" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      Campaign Name *
                    </Label>
                    <Input
                      id="campaign-name"
                      value={publishForm.campaignName}
                      onChange={(e) => setPublishForm((prev) => ({ ...prev, campaignName: e.target.value }))}
                      placeholder="E.g., Winter Clearance Campaign"
                    />
                  </div>

                  {/* Platforms selection */}
                  <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Publish Platforms *</Label>
                    <div className="grid grid-cols-2 gap-4">
                      {(["meta", "google"] as const).map((p) => {
                        const isSelected = publishForm.publishPlatforms.includes(p);
                        return (
                          <div
                            key={p}
                            role="checkbox"
                            aria-checked={isSelected}
                            tabIndex={0}
                            onClick={() => {
                              setPublishForm((prev) => {
                                const exists = prev.publishPlatforms.includes(p);
                                const updated = exists
                                  ? prev.publishPlatforms.filter((plat) => plat !== p)
                                  : [...prev.publishPlatforms, p];
                                return {
                                  ...prev,
                                  publishPlatforms: updated.length > 0 ? updated : prev.publishPlatforms,
                                };
                              });
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" && event.key !== " ") return;
                              event.preventDefault();
                              event.currentTarget.click();
                            }}
                            className={`flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all ${
                              isSelected
                                ? p === "meta"
                                  ? "border-blue-500 bg-blue-50/40 dark:bg-blue-950/20"
                                  : "border-green-600 bg-green-50/40 dark:bg-green-950/20"
                                : "border-border hover:border-muted-foreground/30 bg-card"
                            }`}
                          >
                            <span
                              aria-hidden="true"
                              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${isSelected ? "border-primary bg-primary text-primary-foreground" : "border-primary"}`}
                            >
                              {isSelected && <Check className="h-3 w-3" />}
                            </span>
                            <div>
                              <p className="text-sm font-bold capitalize">{p === "meta" ? "Meta Ads" : "Google Ads"}</p>
                              <p className="text-xs text-muted-foreground">
                                {p === "meta" ? "Facebook & Instagram" : "Search Network"}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <Alert>
                    <Info className="h-4 w-4" />
                    <AlertTitle>Provider identity snapshot</AlertTitle>
                    <AlertDescription className="space-y-1 text-xs">
                      {publishForm.publishPlatforms.includes("meta") && (
                        <p>
                          Meta: {accountSnapshot?.meta
                            ? `${accountSnapshot.meta.adAccountName || accountSnapshot.meta.adAccountId} · ${accountSnapshot.meta.pageName || accountSnapshot.meta.pageId}${accountSnapshot.meta.instagramUsername ? ` · @${accountSnapshot.meta.instagramUsername}` : ""}`
                            : "No ready ad account/Page identity."}
                        </p>
                      )}
                      {publishForm.publishPlatforms.includes("google") && (
                        <p>
                          Google: {accountSnapshot?.google
                            ? `${accountSnapshot.google.accountName || "Customer"} · ${accountSnapshot.google.customerId}`
                            : "No ready customer account."}
                        </p>
                      )}
                      <p>The configured identity is rechecked before queueing and provider execution.</p>
                    </AlertDescription>
                  </Alert>

                  {/* Select creatives */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                        Ad Creatives ({publishForm.selectedAds.length} selected) *
                      </Label>
                      <Button variant="ghost" size="sm" type="button" onClick={selectAllAds} className="text-xs h-6 px-2">
                        {publishForm.selectedAds.length === allAds.length ? "Deselect All" : "Select All"}
                      </Button>
                    </div>

                    <div className="border rounded-xl max-h-56 overflow-y-auto divide-y bg-card">
                      {allAds.map((ad) => {
                        const isChecked = publishForm.selectedAds.includes(ad.id);
                        return (
                          <div
                            key={ad.id}
                            className="flex items-center gap-3 p-3 hover:bg-muted/30 cursor-pointer transition-colors"
                            onClick={() => toggleAdSelection(ad.id)}
                          >
                            <Checkbox checked={isChecked} aria-readonly="true" className="pointer-events-none" />
                            <div className="flex-1 min-w-0 space-y-2" onClick={(event) => event.stopPropagation()}>
                              <Input
                                value={ad.title}
                                onChange={(event) => setAllAds((previous) => previous.map((item) => (
                                  item.id === ad.id ? { ...item, title: event.target.value } : item
                                )))}
                                aria-label={`Headline for ${ad.id}`}
                                className="h-8 text-xs font-semibold"
                              />
                              <Textarea
                                value={ad.content}
                                onChange={(event) => setAllAds((previous) => previous.map((item) => (
                                  item.id === ad.id ? { ...item, content: event.target.value, body: event.target.value } : item
                                )))}
                                aria-label={`Primary text for ${ad.id}`}
                                className="min-h-16 text-xs"
                              />
                            </div>
                            {ad.imageUrl && (
                              <img src={normalizeUploadUrl(ad.imageUrl)} alt="" className="w-8 h-8 rounded object-cover border" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </TabsContent>

                {/* Tab content 2: Budget & Schedule */}
                <TabsContent value="budget" className="space-y-4 pt-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Budget Type</Label>
                      <Select value="LIFETIME" disabled>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="LIFETIME">Total Lifetime Budget</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {publishForm.publishPlatforms.includes("meta") && <div className="space-y-2">
                      <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Meta Bid Strategy</Label>
                      <Select
                        value={publishForm.bidStrategy}
                        onValueChange={(val) => setPublishForm((prev) => ({ ...prev, bidStrategy: val }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {BID_STRATEGIES.map((s) => (
                            <SelectItem key={s.value} value={s.value}>
                              {s.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {publishForm.bidStrategy !== "LOWEST_COST_WITHOUT_CAP" && (
                        <Input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={publishForm.bidAmount}
                          onChange={(event) => setPublishForm((previous) => ({ ...previous, bidAmount: event.target.value }))}
                          placeholder={`Bid/cost cap (${publishForm.currency})`}
                        />
                      )}
                    </div>}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="budget-amount" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      Lifetime Budget Amount ({publishForm.currency})
                    </Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-bold">{publishForm.currency}</span>
                      <Input
                        id="budget-amount"
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={publishForm.lifetimeBudget}
                        onChange={(e) => setPublishForm((prev) => ({ ...prev, lifetimeBudget: e.target.value }))}
                        className="pl-14"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Info className="w-3 h-3 text-primary shrink-0" />
                      The aggregate allocation and spend across Meta ad sets and Google ad groups cannot exceed this stored cap.
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4 pt-2">
                    <div className="space-y-2">
                      <Label htmlFor="start-date" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                        Start Date
                      </Label>
                      <Input
                        id="start-date"
                        type="date"
                        value={publishForm.startDate}
                        onChange={(e) => setPublishForm((prev) => ({ ...prev, startDate: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="end-date" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                        End Date
                      </Label>
                      <Input
                        id="end-date"
                        type="date"
                        value={publishForm.endDate}
                        onChange={(e) => setPublishForm((prev) => ({ ...prev, endDate: e.target.value }))}
                      />
                    </div>
                  </div>
                </TabsContent>

                {/* Tab content 3: Targeting */}
                <TabsContent value="targeting" className="space-y-5 pt-4">
                  {publishForm.publishPlatforms.includes("meta") ? <>
                  <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      Age Range: {publishForm.ageMin} - {publishForm.ageMax === 65 ? "65+" : publishForm.ageMax}
                    </Label>
                    <div className="px-1 py-4">
                      <Slider
                        value={[publishForm.ageMin, publishForm.ageMax]}
                        onValueChange={([min, max]) => setPublishForm((prev) => ({ ...prev, ageMin: min, ageMax: max }))}
                        min={18}
                        max={65}
                        step={1}
                        className="w-full animate-none"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Gender Targeting</Label>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant={publishForm.genders.includes("1") ? "default" : "outline"}
                        onClick={() => toggleGender("1")}
                        className="rounded-full px-5 py-1.5 h-8 text-xs font-semibold"
                      >
                        Male
                      </Button>
                      <Button
                        type="button"
                        variant={publishForm.genders.includes("2") ? "default" : "outline"}
                        onClick={() => toggleGender("2")}
                        className="rounded-full px-5 py-1.5 h-8 text-xs font-semibold"
                      >
                        Female
                      </Button>
                    </div>
                  </div>
                  </> : (
                    <Alert>
                      <Info className="h-4 w-4" />
                      <AlertTitle>Google Search targeting</AlertTitle>
                      <AlertDescription>Google-only campaigns use the reviewed keywords, locations, languages, and network settings below. Age and gender controls apply only to Meta campaigns.</AlertDescription>
                    </Alert>
                  )}

                  <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Target Countries</Label>

                    {/* Chips */}
                    {publishForm.countries.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {publishForm.countries.map((cCode) => {
                          const name = COUNTRIES.find((c) => c.value === cCode)?.label || cCode;
                          return (
                            <Badge
                              key={cCode}
                              variant="secondary"
                              className="text-xs gap-1 cursor-pointer hover:bg-destructive hover:text-white transition-colors"
                              onClick={() => toggleCountry(cCode)}
                            >
                              {name}
                              <X className="w-3 h-3" />
                            </Badge>
                          );
                        })}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Input
                        value={locationInput}
                        onChange={(e) => setLocationInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && locationInput.trim()) {
                            e.preventDefault();
                            const val = locationInput.trim().toUpperCase();
                            if (!publishForm.countries.includes(val)) {
                              setPublishForm((prev) => ({ ...prev, countries: [...prev.countries, val] }));
                            }
                            setLocationInput("");
                          }
                        }}
                        placeholder="Type country code (e.g. IN, US) and press enter"
                      />
                    </div>

                    <div className="flex flex-wrap gap-1.5 mt-2">
                      <span className="text-xs text-muted-foreground self-center">Quick add:</span>
                      {COUNTRIES.filter((c) => !publishForm.countries.includes(c.value)).map((country) => (
                        <Badge
                          key={country.value}
                          variant="outline"
                          className="text-xs cursor-pointer hover:bg-primary hover:text-white transition-colors"
                          onClick={() => setPublishForm((prev) => ({ ...prev, countries: [...prev.countries, country.value] }))}
                        >
                          + {country.label}
                        </Badge>
                      ))}
                    </div>
                    {publishForm.publishPlatforms.includes("google") && (
                      <div className="space-y-2 rounded-xl border p-3">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                          Google Location Resource IDs
                        </Label>
                        {publishForm.countries.map((countryCode) => (
                          <div key={countryCode} className="grid grid-cols-[3rem_1fr] items-center gap-2">
                            <span className="text-xs font-medium">{countryCode}</span>
                            <Input
                              value={adSettingLocations.find((location) => location.countryCode === countryCode)?.googleGeoTargetId
                                || (GOOGLE_GEO_IDS[countryCode] ? `geoTargetConstants/${GOOGLE_GEO_IDS[countryCode]}` : "")
                              }
                              onChange={(event) => setAdSettingLocations((previous) => {
                                const existing = previous.find((location) => location.countryCode === countryCode);
                                const next = {
                                  ...(existing || { countryCode }),
                                  googleGeoTargetId: event.target.value.trim() || undefined,
                                };
                                return existing
                                  ? previous.map((location) => location.countryCode === countryCode ? next : location)
                                  : [...previous, next];
                              })}
                              placeholder="geoTargetConstants/…"
                            />
                          </div>
                        ))}
                        <p className="text-xs text-muted-foreground">
                          Required for every Google country and persisted in the approved location snapshot.
                        </p>
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* Tab content 4: Campaign Settings */}
                <TabsContent value="settings" className="space-y-4 pt-4">
                  <div className="rounded-xl border border-primary/20 bg-primary/[0.03] p-4">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        id="campaign-ai-pause-consent"
                        checked={publishForm.allowAiPause}
                        onCheckedChange={(checked) => setPublishForm((prev) => ({ ...prev, allowAiPause: checked === true }))}
                      />
                      <div className="space-y-1">
                        <Label htmlFor="campaign-ai-pause-consent">Allow AI to pause underperforming ads</Label>
                        <p className="text-xs text-muted-foreground">Optional and off by default. Policy ads-pause-v1 permits pause only after fresh data, learning, evidence, and hierarchy checks. It never resumes, changes budget, edits targeting, or publishes replacements. Revoke anytime in Ad Performance.</p>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Campaign Objective</Label>
                      <Select
                        value={publishForm.objective}
                        onValueChange={(val) => {
                          setPublishForm((prev) => ({ ...prev, objective: val }));
                          setObjectiveInferred(false);
                          setObjectiveRationale("Objective selected by the client in the publishing surface.");
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Review inferred objective" />
                        </SelectTrigger>
                        <SelectContent>
                          {CAMPAIGN_OBJECTIVES.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {objectiveInferred ? "AI inferred: " : "Review required: "}
                        {objectiveRationale || "No objective signal was strong enough to choose safely."}
                      </p>
                    </div>

                    {publishForm.publishPlatforms.includes("meta") && <div className="space-y-2">
                      <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Optimization Goal</Label>
                      <Select
                        value={publishForm.optimizationGoal}
                        onValueChange={(val) => setPublishForm((prev) => ({ ...prev, optimizationGoal: val }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {OPTIMIZATION_GOALS.map((g) => (
                            <SelectItem key={g.value} value={g.value}>
                              {g.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {publishForm.publishPlatforms.includes("meta") && <div className="space-y-2">
                      <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Billing Event</Label>
                      <Select
                        value={publishForm.billingEvent}
                        onValueChange={(val) => setPublishForm((prev) => ({ ...prev, billingEvent: val }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {BILLING_EVENTS.map((e) => (
                            <SelectItem key={e.value} value={e.value}>
                              {e.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>}

                    <div className="space-y-2">
                      <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Call To Action</Label>
                      <Select
                        value={publishForm.callToAction}
                        onValueChange={(val) => setPublishForm((prev) => ({ ...prev, callToAction: val }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CALL_TO_ACTIONS.map((c) => (
                            <SelectItem key={c.value} value={c.value}>
                              {c.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {publishForm.publishPlatforms.includes("meta") && (
                    <div className="space-y-3 rounded-xl border p-3">
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Meta Special Ad Category</Label>
                        <Select
                          value={publishForm.specialAdCategories[0] || "NONE"}
                          onValueChange={(value) => setPublishForm((previous) => ({
                            ...previous,
                            specialAdCategories: value === "NONE" ? [] : [value],
                          }))}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="NONE">None</SelectItem>
                            <SelectItem value="HOUSING">Housing</SelectItem>
                            <SelectItem value="EMPLOYMENT">Employment</SelectItem>
                            <SelectItem value="CREDIT">Credit</SelectItem>
                            <SelectItem value="ISSUES_ELECTIONS_POLITICS">Issues, elections or politics</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Meta Placements</Label>
                        <div className="flex flex-wrap gap-2">
                          {[
                            ["facebook_feed", "Facebook Feed"],
                            ["instagram_stream", "Instagram Feed"],
                            ["instagram_story", "Instagram Stories"],
                            ["instagram_reels", "Instagram Reels"],
                          ].map(([value, label]) => (
                            <Badge
                              key={value}
                              variant={publishForm.placements.includes(value) ? "default" : "outline"}
                              className="cursor-pointer"
                              onClick={() => setPublishForm((previous) => ({
                                ...previous,
                                placements: previous.placements.includes(value)
                                  ? previous.placements.filter((placement) => placement !== value)
                                  : [...previous.placements, value],
                              }))}
                            >
                              {label}
                            </Badge>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground">Leave unselected for automatic placements.</p>
                      </div>
                      {["sales", "app_promotion"].includes(publishForm.objective) && (
                        <div className="space-y-2 border-t pt-3">
                          <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Conversion Destination</Label>
                          {publishForm.objective === "sales" ? (
                            <>
                              <Input
                                value={publishForm.metaPixelId}
                                onChange={(event) => setPublishForm((previous) => ({ ...previous, metaPixelId: event.target.value }))}
                                placeholder="Meta Pixel ID"
                              />
                              <Input
                                value={publishForm.metaCustomConversionId}
                                onChange={(event) => setPublishForm((previous) => ({ ...previous, metaCustomConversionId: event.target.value }))}
                                placeholder="Custom conversion ID (optional)"
                              />
                            </>
                          ) : (
                            <>
                              <Input
                                value={publishForm.metaApplicationId}
                                onChange={(event) => setPublishForm((previous) => ({ ...previous, metaApplicationId: event.target.value }))}
                                placeholder="Meta application ID"
                              />
                              <Input
                                type="url"
                                value={publishForm.metaObjectStoreUrl}
                                onChange={(event) => setPublishForm((previous) => ({ ...previous, metaObjectStoreUrl: event.target.value }))}
                                placeholder="App Store or Play Store URL"
                              />
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {publishForm.publishPlatforms.includes("google") && (
                    <div className="space-y-3 rounded-xl border p-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Google Budget</Label>
                          <Select
                            value={publishForm.googleBudgetMode}
                            onValueChange={(value: "CAMPAIGN_TOTAL" | "AVERAGE_DAILY") => setPublishForm((previous) => ({ ...previous, googleBudgetMode: value }))}
                          >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="CAMPAIGN_TOTAL">Dated campaign total</SelectItem>
                              <SelectItem value="AVERAGE_DAILY">Average daily derived from total</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Keyword Match</Label>
                          <Select
                            value={publishForm.googleKeywordMatchType}
                            onValueChange={(value: "BROAD" | "PHRASE" | "EXACT") => setPublishForm((previous) => ({ ...previous, googleKeywordMatchType: value }))}
                          >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="BROAD">Broad</SelectItem>
                              <SelectItem value="PHRASE">Phrase</SelectItem>
                              <SelectItem value="EXACT">Exact</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Google Bidding</Label>
                        <Select
                          value={publishForm.googleBiddingStrategy}
                          onValueChange={(value) => setPublishForm((previous) => ({ ...previous, googleBiddingStrategy: value }))}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="MAXIMIZE_CONVERSIONS">Maximize conversions</SelectItem>
                            <SelectItem value="MAXIMIZE_CONVERSION_VALUE">Maximize conversion value</SelectItem>
                            <SelectItem value="MAXIMIZE_CLICKS">Maximize clicks</SelectItem>
                            <SelectItem value="MANUAL_CPC">Manual CPC</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <Input
                        value={publishForm.googleKeywords.join(", ")}
                        onChange={(event) => setPublishForm((previous) => ({
                          ...previous,
                          googleKeywords: event.target.value.split(",").map((keyword) => keyword.trim()).filter(Boolean),
                        }))}
                        placeholder="Reviewed keywords, comma separated"
                      />
                      <Input
                        value={publishForm.googleNegativeKeywords.join(", ")}
                        onChange={(event) => setPublishForm((previous) => ({
                          ...previous,
                          googleNegativeKeywords: event.target.value.split(",").map((keyword) => keyword.trim()).filter(Boolean),
                        }))}
                        placeholder="Negative keywords, comma separated"
                      />
                      <div className="grid grid-cols-2 gap-3">
                        <Input
                          value={publishForm.googlePath1}
                          maxLength={15}
                          onChange={(event) => setPublishForm((previous) => ({ ...previous, googlePath1: event.target.value }))}
                          placeholder="Display path 1"
                        />
                        <Input
                          value={publishForm.googlePath2}
                          maxLength={15}
                          onChange={(event) => setPublishForm((previous) => ({ ...previous, googlePath2: event.target.value }))}
                          placeholder="Display path 2"
                        />
                      </div>
                      <Input
                        value={publishForm.googleTrackingTemplate}
                        onChange={(event) => setPublishForm((previous) => ({ ...previous, googleTrackingTemplate: event.target.value }))}
                        placeholder="Tracking template (optional)"
                      />
                      <Input
                        value={publishForm.googleFinalUrlSuffix}
                        onChange={(event) => setPublishForm((previous) => ({ ...previous, googleFinalUrlSuffix: event.target.value }))}
                        placeholder="Final URL suffix (optional)"
                      />
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="landing-url" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      Landing Page URL
                    </Label>
                    <Input
                      id="landing-url"
                      value={publishForm.linkUrl}
                      onChange={(e) => setPublishForm((prev) => ({ ...prev, linkUrl: e.target.value }))}
                      placeholder="https://yoursite.com/campaign-landing"
                    />
                  </div>
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        id="library-live-activation-confirmation"
                        checked={publishForm.activationConfirmed}
                        onCheckedChange={(checked) => setPublishForm((previous) => ({ ...previous, activationConfirmed: checked === true }))}
                      />
                      <div className="space-y-1">
                        <Label htmlFor="library-live-activation-confirmation">Confirm live activation and spend</Label>
                        <p className="text-xs text-muted-foreground">
                          I reviewed {publishForm.publishPlatforms.map((platform) => platform === "google" ? "Google Ads" : "Meta Ads").join(" + ")}, the selected provider account{publishForm.publishPlatforms.length > 1 ? "s" : ""}, and the {publishForm.currency} {publishForm.lifetimeBudget || "0"} lifetime cap. Publishing may activate provider resources and begin spend.
                        </p>
                      </div>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>

              {/* Action buttons */}
              <div className="flex gap-3 pt-6 border-t">
                {activeSettingsTab !== "settings" ? (
                  <Button
                    type="button"
                    onClick={() => {
                      const tabs = ["ads", "budget", "targeting", "settings"];
                      const idx = tabs.indexOf(activeSettingsTab);
                      if (idx < tabs.length - 1) setActiveSettingsTab(tabs[idx + 1]);
                    }}
                    className="flex-1 font-bold h-11 text-xs uppercase"
                  >
                    Next Step
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      type="button"
                      onClick={handleSaveAsDraft}
                      loading={isSavingDraft}
                      loadingText="Saving…"
                      disabled={isPublishing}
                      className="flex-1 font-bold h-11 text-xs uppercase"
                    >
                      <Save className="w-4 h-4 mr-2" />
                      Save as Draft
                    </Button>
                    <Button
                      type="button"
                      onClick={handlePublish}
                      loading={isPublishing}
                      loadingText="Publishing…"
                      disabled={isSavingDraft || !publishForm.activationConfirmed}
                      className="flex-1 font-bold h-11 text-xs uppercase bg-green-600 hover:bg-green-700 text-white"
                    >
                      <Send className="w-4 h-4 mr-2" />
                      Publish Campaign
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/* Right Column: Live Previews */}
            <div className="lg:col-span-5 space-y-4">
              <div>
                <h2 className="text-lg font-bold">Live Preview</h2>
                <p className="text-xs text-muted-foreground">See how your campaign creatives will appear to users</p>
              </div>

              {publishForm.publishPlatforms.length > 1 && (
                <div className="flex gap-1 bg-muted/60 p-1 rounded-xl">
                  {publishForm.publishPlatforms.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setActivePreviewPlatform(p)}
                      className={`flex-1 py-2 px-3 rounded-lg text-xs font-bold capitalize transition-all ${
                        activePreviewPlatform === p
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {p === "meta" ? "Meta Feed Post" : "Google Search Ad"}
                    </button>
                  ))}
                </div>
              )}

              <div className="bg-muted/30 border border-dashed border-border rounded-2xl p-6 min-h-[400px] flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 relative group">
                {publishForm.selectedAds.length > 1 && (
                  <Button
                    variant="secondary"
                    size="icon"
                    className="absolute left-2 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => setCurrentPreviewIndex(prev => Math.max(0, prev - 1))}
                    disabled={validPreviewIndex === 0}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                )}
                
                {activePreviewPlatform === "meta" ? <MetaPreview /> : <GooglePreview />}
                
                {publishForm.selectedAds.length > 1 && (
                  <Button
                    variant="secondary"
                    size="icon"
                    className="absolute right-2 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => setCurrentPreviewIndex(prev => Math.min(publishForm.selectedAds.length - 1, prev + 1))}
                    disabled={validPreviewIndex === publishForm.selectedAds.length - 1}
                  >
                    <ChevronLeft className="w-4 h-4 rotate-180" />
                  </Button>
                )}
              </div>
              
              {publishForm.selectedAds.length > 1 && (
                <div className="flex items-center justify-center gap-1.5 mt-2">
                  {publishForm.selectedAds.map((_, i) => (
                    <div 
                      key={i} 
                      className={`h-1.5 rounded-full transition-all ${i === validPreviewIndex ? "w-4 bg-primary" : "w-1.5 bg-muted-foreground/30"}`} 
                    />
                  ))}
                </div>
              )}

              {/* Tips cards */}
              <div className="bg-card border rounded-2xl p-4 space-y-2">
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  {activePreviewPlatform === "meta" ? "Meta Campaign Advice" : "Google Campaign Advice"}
                </p>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  {activePreviewPlatform === "meta" ? (
                    <>
                      <li className="flex items-start gap-2">
                        <span className="text-blue-500 font-bold">•</span>
                        <span>Ensure your Facebook page is fully connected under Settings before executing.</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="text-blue-500 font-bold">•</span>
                        <span>Meta creatives perform 80% better when paired with dynamic product page links.</span>
                      </li>
                    </>
                  ) : (
                    <>
                      <li className="flex items-start gap-2">
                        <span className="text-green-500 font-bold">•</span>
                        <span>Google Search Ads perform best when keywords are closely aligned to search intent.</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="text-green-500 font-bold">•</span>
                        <span>Keep descriptions under 90 characters for optimal display across desktop and mobile SERPs.</span>
                      </li>
                    </>
                  )}
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdPublishPage() {
  return (
    <Suspense fallback={<LoadingState size="section" label="Loading ad campaign…" className="h-full" />}>
      <AdPublishPageInner />
    </Suspense>
  );
}
