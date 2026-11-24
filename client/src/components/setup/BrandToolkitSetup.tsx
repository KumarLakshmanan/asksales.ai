"use client";

import {
  BUSINESS_PROFILE_HEADER,
  openBusinessDashboard,
  selectedBusinessProfileId,
  selectBusinessProfile,
} from "@/lib/business-profile";
import {
  clearWorkspaceCreation,
  readWorkspaceCreation,
  readStringList,
  type BrandImageAsset,
  type SavedWorkspaceProfile,
} from "@/lib/workspace-profile";
import { EMPTY_GUIDANCE, readGuidance, readImages, readBrandData, type BrandData, type SavedBrandToolkit } from "./brandToolkitData";
import { BrandReview } from "./BrandReview";
import { BrandIdentityStep, BrandVoiceStep, BrandContentStep, BrandAudienceFields } from "./BrandToolkitSteps";
import { BrandVisualsStep } from "./BrandVisualsStep";
import { SetupDraftStatus } from "./SetupDraftStatus";
import { BrandImagesStep } from "@/components/setup/BrandImagesStep";

import React, { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useSetupComplete } from "@/hooks/useSetupComplete";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { useSetupDraft } from "@/components/setup/useSetupDraft";
import {
  isOptionalWebUrl,
} from "@/components/setup/SetupFields";
import { SetupShell, SetupReview } from "@/components/setup/SetupShell";
import { PageLoadingState } from "@/components/ui/page-state";
import { trackSetupEvent } from "@/lib/setup-analytics";
import api, { ApiError } from "@/lib/api";

const TOTAL_STEPS = 7;

/** Dynamically load a Google Font by injecting a <link> element into <head> */
function loadGoogleFont(fontName: string) {
  if (!fontName || fontName.length < 2) return;
  const id = `gfont-${fontName.replace(/\s+/g, "-").toLowerCase()}`;
  if (document.getElementById(id)) return; // Already loaded
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;700&display=swap`;
  document.head.appendChild(link);
}

export function BrandToolkitSetup({ profileId }: { profileId?: number }) {
  const router = useRouter();
  const { toast } = useToast();
  const { user } = useAuth();
  const {
    hasBusinessProfile,
    isLoading: setupLoading,
    completeSetup,
    setHasBrandToolkit,
  } = useSetupComplete();

  const [workspaceType, setWorkspaceType] = useState("business");
  const [businessDna, setBusinessDna] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState(false);
  const [toolkitConflict, setToolkitConflict] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [step, setStep] = useState(1);
  const [returnToReview, setReturnToReview] = useState(false);
  const [toolkitVersion, setToolkitVersion] = useState<number | undefined>();
  const saveKeyRef = useRef<string | null>(null);
  const [existingLogoUrls, setExistingLogoUrls] = useState<string[]>([]);
  const [failedLogoUrl, setFailedLogoUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<number | null>(
    profileId || null,
  );
  const [availableImages, setAvailableImages] = useState<BrandImageAsset[]>([]);
  const [availableScreenshot, setAvailableScreenshot] = useState("");
  const [uploadingImages, setUploadingImages] = useState(false);
  const additionalWorkspace = user?.isSetupComplete === true;
  const requestOptions = {
    headers: { [BUSINESS_PROFILE_HEADER]: String(workspaceId) },
  };
  const [existingToolkitId, setExistingToolkitId] = useState<number | null>(
    null,
  );
  const hasPrefilledRef = useRef(false);
  const [data, setData] = useState<BrandData>({
    ...EMPTY_GUIDANCE,
    brandName: "",
    tagline: "",
    voiceTraits: [],
    brandValues: [],
    otherValue: "",
    primaryColor: "#6d28d9",
    secondaryColor: "",
    accentColor: "",
    colorPalette: [],
    fonts: { heading: "", body: "", accent: "" },
    fontFamilies: [],
    gradients: [],
    logoUrl: "",
    missionStatement: "",
    brandKeywords: "",
    voiceKeywords: [],
    contentPillars: [],
    contentFormats: [],
    defaultHashtags: [],
    defaultCtas: [],
    imageAssets: [],
    websiteScreenshotUrl: "",
  });

  useEffect(() => {
    if (!profileId && !setupLoading && !hasBusinessProfile) {
      router.replace("/setup/business-profile");
    }
  }, [profileId, setupLoading, hasBusinessProfile, router]);

  // Profile ID is pinned for every request; website analysis also survives a new browser session.
  useEffect(() => {
    if (setupLoading || (!profileId && !hasBusinessProfile)) return;
    if (hasPrefilledRef.current) return;
    hasPrefilledRef.current = true;
    const load = async () => {
      try {
        let profile: SavedWorkspaceProfile | undefined;
        if (profileId)
          profile = await api.get<SavedWorkspaceProfile>(
            "/api/settings/business-profiles/" + profileId,
          );
        else {
          const profiles = await api.get<SavedWorkspaceProfile[]>(
            "/api/settings/business-profiles",
          );
          const owned = profiles.filter(
            (item) => !item.role || item.role === "owner",
          );
          profile =
            owned.find((item) => item.id === selectedBusinessProfileId()) ||
            owned.find((item) => item.isDefault) ||
            owned[0];
        }
        if (!profile || (profile.role && profile.role !== "owner"))
          throw new Error("Only the workspace owner can finish its setup.");
        setWorkspaceType(String(profile.workspaceType || "business"));
        selectBusinessProfile(profile.id);
        setWorkspaceId(profile.id);
        const keys = [
          "description",
          "website",
          "industry",
          "email",
          "phone",
          "linkedinUrl",
          "twitterUrl",
          "facebookUrl",
          "instagramUrl",
          "youtubeUrl",
        ];
        setBusinessDna(
          Object.fromEntries(
            keys.map((key) => [key, String(profile![key] || "")]),
          ),
        );
        let crawl: Record<string, unknown> =
          profile.websiteAnalysis?.data || {};
        const analysisTime = profile.websiteAnalysis
          ? Date.parse(profile.websiteAnalysis.analyzedAt)
          : 0;
        try {
          const raw = sessionStorage.getItem(
            "_askSalesCrawlData:" + user?.id + ":" + profile.id,
          );
          const session = raw ? JSON.parse(raw) : null;
          if (
            session &&
            (!analysisTime || Number(session.freshAnalysis) >= analysisTime)
          ) {
            crawl = session;
          }
        } catch {
          /* Persistent analysis remains available. */
        }
        const toolkits = await api.get<SavedBrandToolkit[]>(
          "/api/content/brand-toolkits",
          { headers: { [BUSINESS_PROFILE_HEADER]: String(profile.id) } },
        );
        const toolkit = toolkits.find((item) => item.isDefault) || toolkits[0];
        setExistingToolkitId(toolkit?.id || null);
        setExistingLogoUrls(readStringList(toolkit?.logoUrls));
        setToolkitVersion(typeof toolkit?.version === "number" ? toolkit.version : undefined);
        const crawlSeed = {
          ...crawl,
          brandName: crawl.brandName || crawl.companyName,
          imageAssets: readImages(crawl.extractedImages),
          websiteScreenshotUrl: crawl.screenshotUrl,
        };
        const toolkitSeed = toolkit
          ? {
              ...toolkit,
              brandName: toolkit.brandName || toolkit.name,
              primaryColor:
                toolkit.primaryColors?.[0] || toolkit.primaryBrandColor,
              secondaryColor:
                toolkit.secondaryColors?.[0] || toolkit.secondaryBrandColor,
              colorPalette: toolkit.additionalColors || [],
            }
          : {};
        // Saved brand choices take precedence over later website analysis.
        const source = toolkit ? { ...crawlSeed, ...toolkitSeed } : { ...crawlSeed, brandName: profile.companyName || profile.name || crawlSeed.brandName };
        setData((previous) =>
          readBrandData(source, {
            ...previous,
            setupRequestKey: previous.setupRequestKey || crypto.randomUUID(),
            brandName: profile!.companyName || profile!.name || "",
          }),
        );
        const imagePool = [
          ...readImages(crawl.extractedImages),
          ...readImages(toolkit?.imageAssets),
        ];
        setAvailableImages([
          ...new Map(imagePool.map((asset) => [asset.url, asset])).values(),
        ]);
        setAvailableScreenshot(
          String(crawl.screenshotUrl || toolkit?.websiteScreenshotUrl || ""),
        );
      } catch (error) {
        setLoadError(true);
        toast({
          title: "Saved toolkit could not be loaded",
          description:
            error instanceof Error
              ? error.message
              : "Reload before saving to avoid duplicating a toolkit.",
          variant: "destructive",
        });
      } finally {
        setLoadingData(false);
      }
    };
    void load();
  }, [profileId, setupLoading, hasBusinessProfile, toast, user?.id]);

  useEffect(() => { if (!loadingData && !loadError) trackSetupEvent("setup_step_viewed", { step, phase: "brand_toolkit" }); }, [step, loadingData, loadError]);

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingLogo(true);
    const startedAt = Date.now();
    try {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error("Choose a PNG, JPG, or WebP logo up to 5 MB.");
      const formData = new FormData();
      formData.append("logo", file);
      // Attach the logo with the reviewed toolkit save so uploads cannot bypass its version check.
      const uploadPath = "/api/content/brand-toolkits/upload-logo";
      const result = await api.postForm<{
        success?: boolean;
        url?: string;
        originalName?: string;
        error?: string;
      }>(uploadPath, formData, requestOptions);
      if (result.success && result.url) {
        trackSetupEvent("asset_uploaded", { phase: "brand_logo", durationMs: Date.now() - startedAt });
        const logoUrl = result.url;
        setData((p) => ({ ...p, logoUrl }));
        toast({
          title: "Logo uploaded successfully!",
          description: result.originalName,
        });
      } else {
        throw new Error(result.error || "Upload failed");
      }
    } catch (err: unknown) {
      trackSetupEvent("asset_upload_failed", { phase: "brand_logo", durationMs: Date.now() - startedAt });
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setUploadingLogo(false);
      // Reset the input so the same file can be re-selected
      e.target.value = "";
    }
  };

  const canNext = (checkStep = step) => {
    if (checkStep === 1) return data.brandName.trim().length > 0;
    if (checkStep === 2)
      return (
        data.voiceTraits.length > 0 &&
        (!data.brandValues.includes("Other") || !!data.otherValue.trim())
      );
    if (checkStep === 3)
      return (
        [data.primaryColor, data.secondaryColor, data.accentColor].every(
          (c) => !c || /^#[0-9a-fA-F]{6}$/.test(c),
        ) &&
        !!data.primaryColor &&
        !uploadingLogo &&
        (data.logoUrl.startsWith("/uploads/") || isOptionalWebUrl(data.logoUrl))
      );
    if (checkStep === 4) return !uploadingImages;
    return true;
  };

  // Load Google Fonts for preview when font names change
  useEffect(() => {
    if (data.fonts.heading) loadGoogleFont(data.fonts.heading);
    if (data.fonts.body) loadGoogleFont(data.fonts.body);
    if (data.fonts.accent) loadGoogleFont(data.fonts.accent);
    for (const f of data.fontFamilies) loadGoogleFont(f);
  }, [
    data.fonts.heading,
    data.fonts.body,
    data.fonts.accent,
    data.fontFamilies,
  ]);

  const clearDraft = useSetupDraft<BrandData>({
    storageKey: `setup:brand-toolkit:${user?.id}:${workspaceId}`,
    maxStep: TOTAL_STEPS,
    remoteKey: workspaceId ? `brand:${workspaceId}` : undefined,
    sourceVersion: toolkitVersion,
    ready: !loadingData && !loadError && !setupLoading,
    data,
    step,
    restore: (draft, savedStep) => {
      setData((prev) => ({ ...prev, ...draft }));
      setStep(savedStep);
    },
  });

  const handleSave = async () => {
    if (
      saving ||
      !clearDraft.ready ||
      loadingData ||
      loadError ||
      !workspaceId ||
      uploadingLogo ||
      uploadingImages
    )
      return;
    const invalidStep = [1, 2, 3, 4, 5, 6].find((section) => !canNext(section));
    if (invalidStep) {
      setStep(invalidStep);
      return;
    }
    setSaving(true);
    try {
      await clearDraft.flush();
      const resolvedValues = data.brandValues
        .filter((v) => v !== "Other")
        .concat(
          data.brandValues.includes("Other") && data.otherValue.trim()
            ? [data.otherValue.trim()]
            : [],
        );

      const payload = {
        ...businessDna,
        ...readGuidance(data),
        additionalColors: data.colorPalette,
        imageAssets: data.imageAssets,
        websiteScreenshotUrl: data.websiteScreenshotUrl,
        fontFamilies: data.fontFamilies,
        gradients: data.gradients,
        name: data.brandName,
        brandName: data.brandName,
        tagline: data.tagline || "",
        voicePersonalityTraits: data.voiceTraits,
        brandValues: resolvedValues,
        primaryColors: [data.primaryColor],
        secondaryColors: data.secondaryColor ? [data.secondaryColor] : [],
        primaryBrandColor: data.primaryColor,
        secondaryBrandColor: data.secondaryColor || "",
        accentColor: data.accentColor || "",
        fonts:
          data.fonts.heading || data.fonts.body || data.fonts.accent
            ? data.fonts
            : { heading: "", body: "", accent: "" },
        fontFamily: data.fonts.body || data.fonts.heading || "",
        logoUrl: data.logoUrl || "",
        logoUrls: data.logoUrl ? [data.logoUrl, ...existingLogoUrls.filter((url) => url !== data.logoUrl).slice(0, 19)] : [],
        missionStatement: data.missionStatement || "",
        brandKeywords: data.brandKeywords
          ? data.brandKeywords
              .split(",")
              .map((k) => k.trim())
              .filter(Boolean)
          : [],
        voiceKeywords: data.voiceKeywords.length > 0 ? data.voiceKeywords : [],
        contentPillars:
          data.contentPillars.length > 0 ? data.contentPillars : [],
        contentFormats:
          data.contentFormats.length > 0 ? data.contentFormats : [],
        defaultHashtags:
          data.defaultHashtags.length > 0 ? data.defaultHashtags : [],
        defaultCtas: data.defaultCtas.length > 0 ? data.defaultCtas : [],
        isDefault: true,
        isActive: true,
      };

      let savedToolkitVersion = toolkitVersion;
      if (existingToolkitId) {
        const saved = await api.put<SavedBrandToolkit>(
          `/api/content/brand-toolkits/${existingToolkitId}`,
          { ...payload, ...(toolkitVersion !== undefined ? { expectedVersion: toolkitVersion } : {}) },
          requestOptions,
        );
        if (typeof saved?.version === "number") { savedToolkitVersion = saved.version; setToolkitVersion(saved.version); }
      } else {
        const keyStorage = `setup:brand-save:${user?.id}:${workspaceId}`;
        if (!saveKeyRef.current) {
          saveKeyRef.current = data.setupRequestKey || null;
          if (!saveKeyRef.current) try { saveKeyRef.current = sessionStorage.getItem(keyStorage); } catch { /* The in-memory key still protects retries. */ }
          if (!saveKeyRef.current) saveKeyRef.current = crypto.randomUUID();
          try { sessionStorage.setItem(keyStorage, saveKeyRef.current); } catch { /* Browser storage is optional. */ }
        }
        const saved = await api.post<SavedBrandToolkit>(
          "/api/content/brand-toolkits",
          { ...payload, idempotencyKey: saveKeyRef.current },
          requestOptions,
        );
        setExistingToolkitId(saved.id);
        if (typeof saved.version === "number") { savedToolkitVersion = saved.version; setToolkitVersion(saved.version); }
      }

      await clearDraft.flush({ data, step, sourceVersion: savedToolkitVersion });
      selectBusinessProfile(workspaceId);
      if (!additionalWorkspace)
        await api.post(
          "/api/auth/mark-setup-complete",
          undefined,
          requestOptions,
        );
      try { sessionStorage.removeItem(`_askSalesCrawlData:${user?.id}:${workspaceId}`); } catch { /* The saved toolkit is authoritative. */ }
      let cleanupFailed = false;
      try { if (workspaceId) await clearWorkspaceCreation(user?.id, workspaceId); } catch { cleanupFailed = true; }
      try { sessionStorage.removeItem(`setup:brand-save:${user?.id}:${workspaceId}`); } catch { /* Completion is already saved. */ }
      try { await clearDraft(); } catch { cleanupFailed = true; }
      if (cleanupFailed) toast({ title: "Toolkit saved", description: "An unfinished draft could not be cleared. It will be checked against your saved details when you return." });
      trackSetupEvent("setup_completed", { phase: "brand_toolkit" });
      setHasBrandToolkit(true);
      if (!additionalWorkspace) completeSetup();
      toast({
        title: additionalWorkspace ? "Workspace created" : "Setup complete!",
        description: additionalWorkspace
          ? "Your profile and brand toolkit are ready."
          : "Your account is under review.",
      });
      if (additionalWorkspace) openBusinessDashboard();
      else router.push("/setup/account-verification?justFinished=1");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setToolkitConflict(true);
      toast({
        title: "Unable to complete setup",
        description:
          error instanceof Error
            ? error.message
            : "Your toolkit was not marked complete. Check your connection and try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const update = <K extends keyof BrandData>(key: K, value: BrandData[K]) =>
    setData((previous) => ({ ...previous, [key]: value }));
  const creationIsAdditional =
    readWorkspaceCreation(user?.id, true)?.profileId === workspaceId;
  const profileBackPath = creationIsAdditional
    ? "/setup/business-profile/new"
    : "/setup/business-profile";
  const dnaLabels: Record<string, string> = {
    description: "Business description",
    website: "Website",
    industry: "Industry",
    email: "Business email",
    phone: "Business phone",
    linkedinUrl: "LinkedIn",
    twitterUrl: "X / Twitter",
    facebookUrl: "Facebook",
    instagramUrl: "Instagram",
    youtubeUrl: "YouTube",
  };
  const dnaReview = Object.fromEntries(
    Object.entries(businessDna).map(([key, value]) => [
      dnaLabels[key] || key,
      value,
    ]),
  );

  if (setupLoading || loadingData) {
    return (
      <PageLoadingState
        className="min-h-svh"
        label="Preparing your brand toolkit…"
      />
    );
  }

  if (loadError)
    return (
      <div className="p-10">
        <h1>We couldn’t load your saved details</h1>
        <p>
          Reload before continuing so an existing toolkit is not duplicated.
        </p>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </div>
    );

  const sectionTitles = [
    "Introduce your brand.",
    "Make every word sound like you.",
    "Give your brand a visual identity.",
    "Choose the images that tell your story.",
    "Set the direction for your content.",
    "Your business DNA, connected.",
    "Review your brand toolkit.",
  ];
  return (
    <SetupShell
      area="Brand toolkit"
      workspaceType={workspaceType}
      accountReview={!additionalWorkspace}
      title={sectionTitles[step - 1]}
      description={workspaceType === "creator" ? "Build a toolkit for your content and community. Start with the essentials; add detailed guidance later." : workspaceType === "individual" ? "Give your projects a consistent identity and voice. Start with the essentials; add details later." : workspaceType === "agency" ? "Keep this workspace’s agency or client brand consistent. Start with the essentials; refine the toolkit later." : "Bring your identity, voice, and business context together. Start with the essentials; add details later."}
      sections={[
        "Identity",
        "Voice",
        "Visuals",
        "Images",
        "Content",
        "Business DNA",
        "Review",
      ]}
      step={step}
      onStep={(nextStep) => { if (clearDraft.ready) setStep(nextStep); }}
    >
      <SetupDraftStatus draft={clearDraft} />
      {toolkitConflict && <Callout tone="danger" className="mb-5" actions={<Button size="sm" variant="outline" onClick={() => window.location.reload()}>Reload saved toolkit</Button>}>This toolkit changed in another tab or device. Your unfinished edits are kept. Reload to review the latest saved details before continuing.</Callout>}
      <fieldset disabled={!clearDraft.ready || saving || toolkitConflict} className="brand-draft-fields">
      <div className="setup-section-intro">
        <h2>
          {
            [
              "Brand identity",
              "Voice and personality",
              "Colors, type, and logo",
              "Brand images",
              "Content preferences",
              "Business DNA",
              "Review your toolkit",
            ][step - 1]
          }
        </h2>
        <p>
          {step === 7
            ? "Check the final toolkit before finishing setup. You can edit it later."
            : step > 3 ? "This section is optional. Keep existing details or add guidance now; you can update it later in your brand toolkit." : "Start with your name, voice, and primary color. Detailed guidance is optional and stays saved when you skip it."}
        </p>
      </div>
      {step === 1 && <BrandIdentityStep data={data} update={update} workspaceType={workspaceType} />}
      {step === 2 && <BrandVoiceStep data={data} update={update} workspaceType={workspaceType} />}
      {step === 3 && <BrandVisualsStep data={data} update={update} handleLogoUpload={handleLogoUpload} uploadingLogo={uploadingLogo} failedLogoUrl={failedLogoUrl} setFailedLogoUrl={setFailedLogoUrl} />}
      {step === 4 && workspaceId && (
        <BrandImagesStep
          profileId={workspaceId}
          available={[
            ...new Map(
              [...availableImages, ...data.imageAssets].map((asset) => [
                asset.url,
                asset,
              ]),
            ).values(),
          ]}
          selected={data.imageAssets}
          onChange={(images) => update("imageAssets", images)}
          onAdd={(images) => {
            setAvailableImages((previous) => [
              ...new Map(
                [...previous, ...images].map((asset) => [asset.url, asset]),
              ).values(),
            ]);
            setData((previous) => ({
              ...previous,
              imageAssets: [
                ...new Map(
                  [...previous.imageAssets, ...images].map((asset) => [
                    asset.url,
                    asset,
                  ]),
                ).values(),
              ],
            }));
          }}
          screenshot={availableScreenshot}
          keepScreenshot={!!data.websiteScreenshotUrl}
          onScreenshot={(keep) =>
            update("websiteScreenshotUrl", keep ? availableScreenshot : "")
          }
          onUploading={setUploadingImages}
        />
      )}
      {step === 5 && <BrandContentStep data={data} update={update} workspaceType={workspaceType} />}
      {step === 6 && (
        <div className="setup-fieldset">
          <div className="rounded-xl border bg-muted/30 p-5">
            <h2>Connected to your business profile</h2>
            <p className="my-3 text-sm leading-6 text-muted-foreground">
              These details are carried into your toolkit automatically. You
              only need to enter them once.
            </p>
            <SetupReview values={dnaReview} />
            <Button
              variant="outline"
              className="mt-5"
              onClick={() => router.push(profileBackPath)}
            >
              Edit business profile
            </Button>
          </div>
          <BrandAudienceFields data={data} update={update} />
        </div>
      )}
      {step === 7 && <BrandReview data={data} business={dnaReview} onEdit={(section) => { setReturnToReview(true); setStep(section); }} />}
      {!canNext() && (
        <p className="setup-validation" role="status">
          {step === 1
            ? "Add a brand name to continue."
            : step === 2
              ? "Choose at least one voice trait. Describe your brand value if you choose Other."
              : "Use six-digit hex colors, such as #514BBB. Wait for any upload to finish."}
        </p>
      )}
      <div className="setup-navigation">
        <Button
          variant="outline"
          disabled={saving}
          onClick={() => {
            if (step > 1) setStep(step - 1);
            else router.push(profileBackPath);
          }}
        >
          <ArrowLeft size={16} /> Back
        </Button>
        {(step >= 3 || returnToReview) && step < TOTAL_STEPS && <Button variant="outline" onClick={() => setStep(7)} disabled={[1, 2, 3, 4].some((section) => !canNext(section))}>{returnToReview ? "Back to review" : "Review essentials"}</Button>}
        {step < TOTAL_STEPS ? (
          <Button onClick={() => setStep(step + 1)} disabled={!canNext()}>
            Continue <ArrowRight size={16} />
          </Button>
        ) : (
          <Button
            onClick={handleSave}
            loading={saving}
            disabled={toolkitConflict || uploadingImages || uploadingLogo}
          >
            <Check size={16} /> Finish setup
          </Button>
        )}
      </div>
      </fieldset>
    </SetupShell>
  );
}
