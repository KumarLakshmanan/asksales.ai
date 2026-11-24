"use client";

import React, { useState, useRef, useEffect, useCallback, useImperativeHandle, useId, forwardRef } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Upload,
  X,
  Plus,
  Image as ImageIcon,
  Palette,
  Globe,
  Sparkles,
  Building2,
  Rocket,
  Linkedin,
  Twitter,
  Instagram,
  Facebook,
  Youtube,
  BadgeCheck,
  ChevronRight,
} from "lucide-react";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import { cn, normalizeUploadUrl } from "@/lib/utils";

// =============================================================
// BRAND TOOLKIT DATA
// =============================================================
export interface BrandToolkitFormData {
  id?: number;
  version?: number;
  brandName: string;
  tagline: string;
  missionStatement: string;
  brandValues: string[];
  brandKeywords: string[];
  primaryColors: string[];
  secondaryColors: string[];
  accentColor: string;
  fonts: { heading: string; body: string; accent: string };
  logoUrls: string[];
  logoVisibility: boolean;
  imageStyleReference: string;
  visualInstructions: string;
  logoUsageGuidelines: string;
  voiceType: string;
  customToneGuidelines: string;
  voicePersonalityTraits: string[];
  voiceDos: string[];
  voiceDonts: string[];
  voiceKeywords: string[];
  contentPillars: string[];
  contentFormats: string[];
  defaultHashtags: string[];
  defaultCtas: string[];
  contentInstructions: string;
  sampleContent: string;
  audiencePainPoints: string[];
  audienceGoals: string[];
  audienceLanguageStyle: string[];
  audienceTriggers: string[];
  // Business DNA fields
  website: string;
  industry: string;
  description: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  twitterUrl: string;
  facebookUrl: string;
  instagramUrl: string;
  youtubeUrl: string;
}

const emptyBrandToolkit: BrandToolkitFormData = {
  brandName: "",
  tagline: "",
  missionStatement: "",
  brandValues: [],
  brandKeywords: [],
  primaryColors: ["#7C3AED"],
  secondaryColors: ["#EC4899"],
  accentColor: "#3B82F6",
  fonts: { heading: "Outfit", body: "Inter", accent: "Inter" },
  logoUrls: [],
  logoVisibility: true,
  imageStyleReference: "",
  visualInstructions: "",
  logoUsageGuidelines: "",
  voiceType: "",
  customToneGuidelines: "",
  voicePersonalityTraits: [],
  voiceDos: [],
  voiceDonts: [],
  voiceKeywords: [],
  contentPillars: [],
  contentFormats: [],
  defaultHashtags: [],
  defaultCtas: [],
  contentInstructions: "",
  sampleContent: "",
  audiencePainPoints: [],
  audienceGoals: [],
  audienceLanguageStyle: [],
  audienceTriggers: [],
  // Business DNA fields
  website: "",
  industry: "",
  description: "",
  email: "",
  phone: "",
  linkedinUrl: "",
  twitterUrl: "",
  facebookUrl: "",
  instagramUrl: "",
  youtubeUrl: "",
};


// =============================================================
// PROPS
// =============================================================
interface BrandToolkitFormProps {
  /** Called after successful save */
  onSaveSuccess?: (data: BrandToolkitFormData) => void;
  /** Custom save button label */
  saveButtonLabel?: string;
  /** Whether to show save button (default true) */
  showSave?: boolean;
  /** Whether the form is in saving state (controlled externally) */
  isSavingExternal?: boolean;
  /** Custom save handler - overrides default save behavior */
  onSave?: (data: BrandToolkitFormData) => Promise<void>;
  /** Load a specific toolkit by ID (for edit mode) */
  toolkitId?: number;
  /** Start with empty form and always create new (for create mode) */
  isCreateMode?: boolean;
}

/** Imperative handle exposed via ref */
export interface BrandToolkitFormHandle {
  triggerSave: () => Promise<void>;
}

// =============================================================
// ANIMATION VARIANTS
// =============================================================
const sectionVariants: Variants = {
  hidden: { opacity: 0, x: 20 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.4, ease: "easeOut" } },
  exit: { opacity: 0, x: -20, transition: { duration: 0.3 } }
};

// =============================================================
// MAIN COMPONENT
// =============================================================
export const BrandToolkitForm = forwardRef<BrandToolkitFormHandle, BrandToolkitFormProps>(function BrandToolkitForm({
  onSaveSuccess,
  saveButtonLabel = "Save Changes",
  showSave = true,
  isSavingExternal,
  onSave,
  toolkitId,
  isCreateMode,
}, ref) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const brandNameRef = useRef<HTMLInputElement>(null);
  const loadSequence = useRef(0);
  const creationRequestKey = useRef<string | null>(null);
  const formId = useId();
  const fieldId = (field: string) => `${formId}-${field}`;
  const [hasBrandNameError, setHasBrandNameError] = useState(false);
  
  const [activeSection, setActiveSection] = useState<"identity" | "visuals" | "voice" | "content" | "presence">("identity");
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const [isLoading, setIsLoading] = useState(!isCreateMode);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState<string | null>(null);
  const [brandToolkit, setBrandToolkit] = useState<BrandToolkitFormData>(emptyBrandToolkit);
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(emptyBrandToolkit));
  const [tagDrafts, setTagDrafts] = useState<Partial<Record<keyof BrandToolkitFormData, string>>>({});
  const [analyzeUrl, setAnalyzeUrl] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const saving = (isSavingExternal ?? isSaving) || isUploadingLogo;
  const { clearGuard } = useUnsavedChanges(saving || isAnalyzing || Object.values(tagDrafts).some(value => Boolean(value)) || (!isLoading && JSON.stringify(brandToolkit) !== savedSnapshot));
  const brandNameError = hasBrandNameError && !brandToolkit.brandName.trim();

  const attachBrandName = useCallback((input: HTMLInputElement | null) => {
    brandNameRef.current = input;
    if (brandNameError) input?.focus();
  }, [brandNameError]);

  useImperativeHandle(ref, () => ({
    triggerSave: handleSaveBrand,
  }));

  useEffect(() => {
    setBrandToolkit(emptyBrandToolkit);
    setSavedSnapshot(JSON.stringify(emptyBrandToolkit));
    setTagDrafts({});
    setLoadError(null);
    setSaveConflict(null);
    setIsSaving(false);
    setIsUploadingLogo(false);
    setIsAnalyzing(false);
    setAnalyzeUrl("");
    creationRequestKey.current = null;
    if (isCreateMode) setIsLoading(false);
    else void loadExistingBrand();
    return () => { loadSequence.current += 1; };
  }, [toolkitId, isCreateMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const mapBrandToFormData = (b: Record<string, unknown>): BrandToolkitFormData => ({
    id: b.id as number,
    version: b.version as number | undefined,
    brandName: (b.brandName as string) || (b.name as string) || "",
    tagline: (b.tagline as string) || "",
    missionStatement: (b.missionStatement as string) || "",
    brandValues: (b.brandValues as string[]) || [],
    brandKeywords: (b.brandKeywords as string[]) || [],
    primaryColors: (b.primaryColors as string[]) || ["#7C3AED"],
    secondaryColors: (b.secondaryColors as string[]) || ["#EC4899"],
    accentColor: (b.accentColor as string) || "#3B82F6",
    fonts: (b.fonts as { heading: string; body: string; accent: string }) || { heading: "Outfit", body: "Inter", accent: "Inter" },
    logoUrls: b.logoUrl
      ? [
          b.logoUrl as string,
          ...((b.logoUrls as string[]) || []).filter((url) => url !== b.logoUrl),
        ]
      : (b.logoUrls as string[]) || [],
    logoVisibility: b.logoVisibility !== false,
    imageStyleReference: (b.imageStyleReference as string) || "",
    visualInstructions: (b.visualInstructions as string) || "",
    logoUsageGuidelines: (b.logoUsageGuidelines as string) || "",
    voiceType: (b.voiceType as string) || "",
    customToneGuidelines: (b.customToneGuidelines as string) || "",
    voicePersonalityTraits: (b.voicePersonalityTraits as string[]) || [],
    voiceDos: (b.voiceDos as string[]) || [],
    voiceDonts: (b.voiceDonts as string[]) || [],
    voiceKeywords: (b.voiceKeywords as string[]) || [],
    contentPillars: (b.contentPillars as string[]) || [],
    contentFormats: (b.contentFormats as string[]) || [],
    defaultHashtags: (b.defaultHashtags as string[]) || [],
    defaultCtas: (b.defaultCtas as string[]) || [],
    contentInstructions: (b.contentInstructions as string) || "",
    sampleContent: typeof b.sampleContent === "string" ? b.sampleContent : b.sampleContent ? JSON.stringify(b.sampleContent, null, 2) : "",
    audiencePainPoints: (b.audiencePainPoints as string[]) || [],
    audienceGoals: (b.audienceGoals as string[]) || [],
    audienceLanguageStyle: (b.audienceLanguageStyle as string[]) || [],
    audienceTriggers: (b.audienceTriggers as string[]) || [],
    // Business DNA fields
    website: (b.website as string) || "",
    industry: (b.industry as string) || "",
    description: (b.description as string) || "",
    email: (b.email as string) || "",
    phone: (b.phone as string) || "",
    linkedinUrl: (b.linkedinUrl as string) || "",
    twitterUrl: (b.twitterUrl as string) || "",
    facebookUrl: (b.facebookUrl as string) || "",
    instagramUrl: (b.instagramUrl as string) || "",
    youtubeUrl: (b.youtubeUrl as string) || "",
  });

  const loadExistingBrand = async () => {
    const sequence = ++loadSequence.current;
    try {
      setIsLoading(true);
      setLoadError(null);
      if (toolkitId) {
        const b = await api.get<Record<string, unknown>>(`/api/content/brand-toolkits/${toolkitId}`);
        if (sequence !== loadSequence.current) return;
        if (b) {
          const mapped = mapBrandToFormData(b);
          setBrandToolkit(mapped);
          setTagDrafts({});
          setSavedSnapshot(JSON.stringify(mapped));
          setSaveConflict(null);
        }
        return;
      }
      const brands = await api.get<Array<Record<string, unknown>>>("/api/content/brand-toolkits");
      if (sequence !== loadSequence.current) return;
      if (Array.isArray(brands) && brands.length > 0) {
        const mapped = mapBrandToFormData(brands[0]);
        setBrandToolkit(mapped);
        setTagDrafts({});
        setSavedSnapshot(JSON.stringify(mapped));
        setSaveConflict(null);
      }
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      const message = error instanceof Error ? error.message : "Unable to load the brand toolkit";
      setLoadError(message);
      toast({ title: "Brand toolkit unavailable", description: message, variant: "destructive" });
    } finally {
      if (sequence === loadSequence.current) setIsLoading(false);
    }
  };

  const handleBTChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setBrandToolkit((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleBTSelectChange = (field: string, value: string) => {
    setBrandToolkit((prev) => ({ ...prev, [field]: value }));
  };

  const addToArray = (field: keyof BrandToolkitFormData, value: string) => {
    if (!value.trim()) return;
    setBrandToolkit((prev) => ({
      ...prev,
      [field]: [...((prev[field] as string[]) || []), value.trim()],
    }));
  };

  const removeFromArray = (field: keyof BrandToolkitFormData, index: number) => {
    setBrandToolkit((prev) => ({
      ...prev,
      [field]: ((prev[field] as string[]) || []).filter((_, i) => i !== index),
    }));
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (saving || saveConflict || isLoading || loadError) return;
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "Error", description: "Logo must be less than 5MB", variant: "destructive" });
      return;
    }
    const sequence = loadSequence.current;
    setIsUploadingLogo(true);
    try {
      const formData = new FormData();
      formData.append("logo", file);
      if (brandToolkit.version !== undefined) formData.append("expectedVersion", String(brandToolkit.version));
      const uploadPath = brandToolkit.id
        ? `/api/content/brand-toolkits/${brandToolkit.id}/logo`
        : "/api/content/brand-toolkits/upload-logo";
      const data = await api.postForm<{ url: string; toolkit?: { version: number } }>(uploadPath, formData);
      if (sequence !== loadSequence.current) return;
      setBrandToolkit((prev) => ({
        ...prev,
        version: data.toolkit?.version ?? prev.version,
        logoUrls: [data.url, ...(prev.logoUrls || []).filter((url) => url !== data.url)],
      }));
      if (brandToolkit.id && data.toolkit) setSavedSnapshot(snapshot => {
        const saved = JSON.parse(snapshot) as BrandToolkitFormData;
        return JSON.stringify({ ...saved, version: data.toolkit!.version, logoUrls: [data.url, ...saved.logoUrls.filter(url => url !== data.url)] });
      });
      toast({ title: "Logo Uploaded", description: "Logo uploaded successfully" });
    } catch (err: unknown) {
      if (sequence !== loadSequence.current) return;
      const message = (err as Error)?.message || "Failed to upload logo";
      if ((err as { status?: number })?.status === 409) setSaveConflict(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      if (sequence === loadSequence.current) setIsUploadingLogo(false);
      e.target.value = "";
    }
  };

  const addColor = (field: "primaryColors" | "secondaryColors") => {
    const colors = brandToolkit[field] || [];
    setBrandToolkit((prev) => ({ ...prev, [field]: [...colors, "#000000"] }));
  };

  const updateColor = (field: "primaryColors" | "secondaryColors", index: number, value: string) => {
    const colors = [...(brandToolkit[field] || [])];
    colors[index] = value;
    setBrandToolkit((prev) => ({ ...prev, [field]: colors }));
  };

  const removeColor = (field: "primaryColors" | "secondaryColors", index: number) => {
    const colors = (brandToolkit[field] || []).filter((_, i) => i !== index);
    setBrandToolkit((prev) => ({ ...prev, [field]: colors }));
  };

  const handleAnalyzeWebsite = async () => {
    const sequence = loadSequence.current;
    let normalizedUrl = analyzeUrl.trim();
    if (!normalizedUrl) return;
    if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
      normalizedUrl = "https://" + normalizedUrl;
    }
    setIsAnalyzing(true);
    try {
      const res = await api.post<{ success?: boolean; data?: Record<string, unknown>; kbEntryId?: number }>(
        "/api/setup/analyze-website",
        { url: normalizedUrl }
      );
      if (sequence !== loadSequence.current) return;
      if (res?.data) {
        const r = res.data;
        const palette = (r.colorPalette as string[]) || [];
        setBrandToolkit((prev) => ({
          ...prev,
          brandName: (r.companyName as string) || (r.brandName as string) || prev.brandName,
          tagline: (r.tagline as string) || prev.tagline,
          missionStatement: (r.missionStatement as string) || prev.missionStatement,
          brandValues: Array.isArray(r.brandValues) && r.brandValues.length > 0 ? r.brandValues : prev.brandValues,
          primaryColors: r.primaryColor ? [r.primaryColor as string, ...palette.slice(0, 2)] : palette.length ? palette.slice(0, 3) : prev.primaryColors,
          secondaryColors: r.secondaryColor ? [r.secondaryColor as string, ...palette.slice(3, 5)] : palette.length > 3 ? palette.slice(3, 6) : prev.secondaryColors,
          accentColor: (r.accentColor as string) || palette[0] || prev.accentColor,
          fonts: {
            heading: (r.fonts as { heading?: string })?.heading || prev.fonts.heading,
            body: (r.fonts as { body?: string })?.body || prev.fonts.body,
            accent: (r.fonts as { accent?: string })?.accent || prev.fonts.accent,
          },
          logoUrls: r.logoUrl ? [r.logoUrl as string] : prev.logoUrls,
          voicePersonalityTraits: Array.isArray(r.voicePersonalityTraits) && r.voicePersonalityTraits.length > 0 ? r.voicePersonalityTraits : prev.voicePersonalityTraits,
          voiceKeywords: Array.isArray(r.voiceKeywords) && r.voiceKeywords.length > 0 ? r.voiceKeywords : prev.voiceKeywords,
          contentPillars: Array.isArray(r.contentPillars) && r.contentPillars.length > 0 ? r.contentPillars : prev.contentPillars,
          contentFormats: Array.isArray(r.contentFormats) && r.contentFormats.length > 0 ? r.contentFormats : prev.contentFormats,
          defaultHashtags: Array.isArray(r.defaultHashtags) && r.defaultHashtags.length > 0 ? r.defaultHashtags : prev.defaultHashtags,
          defaultCtas: Array.isArray(r.defaultCtas) && r.defaultCtas.length > 0 ? r.defaultCtas : prev.defaultCtas,
          website: normalizedUrl || prev.website,
          industry: (r.industry as string) || prev.industry,
          description: (r.description as string) || prev.description,
          email: (r.email as string) || prev.email,
          phone: (r.phone as string) || prev.phone,
          linkedinUrl: (r.linkedinUrl as string) || prev.linkedinUrl,
          twitterUrl: (r.twitterUrl as string) || prev.twitterUrl,
          facebookUrl: (r.facebookUrl as string) || prev.facebookUrl,
          instagramUrl: (r.instagramUrl as string) || prev.instagramUrl,
          youtubeUrl: (r.youtubeUrl as string) || prev.youtubeUrl,
        }));
        toast({ title: "Brand toolkit auto-filled from your website" });
      } else {
        toast({ title: "No data returned", description: "Please fill in details manually.", variant: "destructive" });
      }
    } catch (err: unknown) {
      if (sequence !== loadSequence.current) return;
      toast({
        title: "Couldn't analyze website",
        description: err instanceof Error ? err.message : "Please try again or fill in details manually.",
        variant: "destructive",
      });
    } finally {
      if (sequence === loadSequence.current) setIsAnalyzing(false);
    }
  };

  const handleSaveBrand = async () => {
    if (saveConflict || isLoading || loadError || saving) return;
    const sequence = loadSequence.current;
    const pendingTag = (Object.keys(tagDrafts) as Array<keyof BrandToolkitFormData>).find(field => tagDrafts[field]?.trim());
    if (pendingTag) {
      const voiceFields = ['brandValues', 'brandKeywords', 'voicePersonalityTraits', 'voiceKeywords', 'voiceDos', 'voiceDonts'];
      setActiveSection(voiceFields.includes(pendingTag) ? 'voice' : 'content');
      toast({ title: "Finish adding tags", description: "Use the add button or Enter to add your tag text, or clear it before saving.", variant: "destructive" });
      return;
    }
    if (!brandToolkit.brandName.trim()) {
      setHasBrandNameError(true);
      setActiveSection("identity");
      toast({ title: "Required", description: "Please enter a brand name", variant: "destructive" });
      brandNameRef.current?.focus();
      return;
    }

    if (onSave) {
      await onSave(brandToolkit);
      return;
    }

    setIsSaving(true);
    try {
      const createsToolkit = !brandToolkit.id || isCreateMode;
      if (createsToolkit) creationRequestKey.current ??= crypto.randomUUID();
      const payload = {
        ...(createsToolkit ? { idempotencyKey: creationRequestKey.current } : {}),
        ...(brandToolkit.id && !isCreateMode ? { expectedVersion: brandToolkit.version } : {}),
        name: brandToolkit.brandName,
        brandName: brandToolkit.brandName,
        tagline: brandToolkit.tagline,
        missionStatement: brandToolkit.missionStatement,
        brandValues: brandToolkit.brandValues,
        brandKeywords: brandToolkit.brandKeywords,
        primaryColors: brandToolkit.primaryColors,
        secondaryColors: brandToolkit.secondaryColors,
        accentColor: brandToolkit.accentColor,
        primaryBrandColor: brandToolkit.primaryColors?.[0],
        secondaryBrandColor: brandToolkit.secondaryColors?.[0],
        fonts: brandToolkit.fonts,
        fontFamily: brandToolkit.fonts?.body,
        logoUrl: brandToolkit.logoUrls?.[0] || "",
        logoUrls: brandToolkit.logoUrls,
        logoVisibility: brandToolkit.logoVisibility,
        imageStyleReference: brandToolkit.imageStyleReference,
        visualInstructions: brandToolkit.visualInstructions,
        logoUsageGuidelines: brandToolkit.logoUsageGuidelines,
        voiceType: brandToolkit.voiceType,
        customToneGuidelines: brandToolkit.customToneGuidelines,
        voicePersonalityTraits: brandToolkit.voicePersonalityTraits,
        voiceDos: brandToolkit.voiceDos,
        voiceDonts: brandToolkit.voiceDonts,
        voiceKeywords: brandToolkit.voiceKeywords,
        contentPillars: brandToolkit.contentPillars,
        contentFormats: brandToolkit.contentFormats,
        defaultHashtags: brandToolkit.defaultHashtags,
        defaultCtas: brandToolkit.defaultCtas,
        contentInstructions: brandToolkit.contentInstructions,
        sampleContent: brandToolkit.sampleContent,
        audiencePainPoints: brandToolkit.audiencePainPoints,
        audienceGoals: brandToolkit.audienceGoals,
        audienceLanguageStyle: brandToolkit.audienceLanguageStyle,
        audienceTriggers: brandToolkit.audienceTriggers,
        // Business DNA fields
        website: brandToolkit.website,
        industry: brandToolkit.industry,
        description: brandToolkit.description,
        email: brandToolkit.email,
        phone: brandToolkit.phone,
        linkedinUrl: brandToolkit.linkedinUrl,
        twitterUrl: brandToolkit.twitterUrl,
        facebookUrl: brandToolkit.facebookUrl,
        instagramUrl: brandToolkit.instagramUrl,
        youtubeUrl: brandToolkit.youtubeUrl,
        isActive: true,
      };

      let savedData = brandToolkit;
      if (brandToolkit.id && !isCreateMode) {
        const updated = await api.put<Record<string, unknown>>(`/api/content/brand-toolkits/${brandToolkit.id}`, payload);
        if (sequence !== loadSequence.current) return;
        savedData = mapBrandToFormData(updated);
        setBrandToolkit(savedData);
        toast({ title: "Success", description: "Brand toolkit updated successfully" });
      } else {
        const created = await api.post<Record<string, unknown>>("/api/content/brand-toolkits", payload);
        if (sequence !== loadSequence.current) return;
        if (created && created.id) {
          savedData = { ...brandToolkit, id: created.id as number, version: created.version as number | undefined };
          setBrandToolkit(savedData);
        }
        toast({ title: "Success", description: "Brand toolkit saved successfully" });
      }
      queryClient.invalidateQueries({ queryKey: ["brand-toolkits"] });
      setSavedSnapshot(JSON.stringify(savedData));
      clearGuard();
      onSaveSuccess?.(savedData);
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      const message = error instanceof Error ? error.message : "Failed to save brand toolkit";
      if ((error as { status?: number })?.status === 409) setSaveConflict(message);
      toast({ title: "Unable to save brand toolkit", description: message, variant: "destructive" });
    } finally {
      if (sequence === loadSequence.current) setIsSaving(false);
    }
  };

  const tagInputProps = { idPrefix: formId, brandToolkit, addToArray, removeFromArray, drafts: tagDrafts, setDraft: (field: keyof BrandToolkitFormData, value: string) => setTagDrafts(previous => ({ ...previous, [field]: value })) };

  if (isLoading) {
    return (
      <LoadingState className="min-h-[600px]" label="Loading brand toolkit…" />
    );
  }

  if (loadError) {
    return (
      <div className="flex min-h-[360px] flex-col items-center justify-center rounded-xl border border-border bg-card p-6 text-center">
        <h3 className="text-lg font-semibold text-foreground">Unable to load this brand toolkit</h3>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">{loadError}</p>
        <Button className="mt-5" variant="outline" onClick={() => { void loadExistingBrand(); }}>
          Try again
        </Button>
      </div>
    );
  }

  const conflictNotice = saveConflict ? (
    <div role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-card p-4 text-sm">
      <p>{saveConflict}</p>
      {isCreateMode || !brandToolkit.id ? (
        <>
          <p className="mt-1 text-muted-foreground">Your draft is still shown. Review your saved toolkits before starting another creation.</p>
          <Button asChild className="mt-3" variant="outline"><Link href="/dashboard/brand-toolkit">Review saved toolkits</Link></Button>
        </>
      ) : (
        <>
          <p className="mt-1 text-muted-foreground">Your unsaved edits are still shown. Copy any changes you want to keep before reloading the saved toolkit.</p>
          <Button className="mt-3" variant="outline" onClick={() => { void loadExistingBrand(); }}>Reload saved toolkit</Button>
        </>
      )}
    </div>
  ) : null;

  const sections = [
    { id: "identity", label: "Brand Details", icon: Building2, color: "text-blue-500", bg: "bg-blue-500/10" },
    { id: "visuals", label: "Visual Identity", icon: Palette, color: "text-primary", bg: "bg-primary/10" },
    { id: "voice", label: "Voice & Values", icon: Sparkles, color: "text-indigo-500", bg: "bg-indigo-500/10" },
    { id: "content", label: "Content Settings", icon: Rocket, color: "text-emerald-500", bg: "bg-emerald-500/10" },
    { id: "presence", label: "Social Media", icon: Globe, color: "text-pink-500", bg: "bg-pink-500/10" },
  ] as const;

  return (
    <div className="flex flex-col lg:flex-row h-full min-h-[600px] bg-card/10 backdrop-blur-xl border border-border/60 rounded-xl overflow-hidden shadow-2xl">
      {/* Hidden file input */}
      <input
        id={fieldId("logo")}
        aria-label="Brand Logo"
        aria-describedby={activeSection === "visuals" ? fieldId("logo-description") : undefined}
        type="file"
        disabled={saving || Boolean(saveConflict)}
        ref={fileInputRef}
        onChange={handleLogoUpload}
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
      />

      {/* Sidebar Navigation */}
      <aside className="flex w-full flex-col gap-4 border-b border-border bg-muted/20 p-4 lg:w-[280px] lg:gap-8 lg:border-b-0 lg:border-r lg:p-5">
        <div className="hidden space-y-4 lg:block">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-white shadow-lg">
              <Palette className="w-4 h-4" />
            </div>
            <p className="text-xl font-semibold tracking-tight text-foreground">Brand</p>
          </div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Toolkit</p>
        </div>

        <nav className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => setActiveSection(section.id)}
              className={cn(
                "group relative flex shrink-0 items-center gap-3 overflow-hidden rounded-xl px-3 py-2.5 text-left transition-all duration-300 lg:px-4 lg:py-3.5",
                activeSection === section.id
                  ? "bg-background shadow-lg scale-[1.02] active:scale-100"
                  : "hover:bg-muted/70"
              )}
            >
              {activeSection === section.id && (
                <motion.div
                  layoutId="active-nav-indicator"
                  className="absolute left-0 w-1 h-full bg-primary rounded-r-full"
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                />
              )}
              <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center transition-colors", section.id === activeSection ? section.bg : "bg-muted/40")}>
                <section.icon className={cn("w-4 h-4", activeSection === section.id ? section.color : "text-muted-foreground")} />
              </div>
              <span className={cn("text-sm font-medium tracking-tight", activeSection === section.id ? "text-foreground" : "text-muted-foreground")}>
                {section.label}
              </span>
            </button>
          ))}
        </nav>

        <div className="mt-auto hidden space-y-2 rounded-xl border border-primary/20 bg-primary/5 p-4 lg:block">
          <div className="flex items-center gap-2">
            <BadgeCheck className="w-3.5 h-3.5 text-primary" />
            <span className="text-sm font-medium text-primary font-bold">Verified Setup</span>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed font-medium">Your brand toolkit data ensures your visual assets and voice keywords are applied consistently.</p>
        </div>
      </aside>

      {/* Content Area */}
      <section aria-label="Brand toolkit settings" className="relative min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-4 pb-24 sm:p-6 sm:pb-24 md:p-8 lg:p-10 lg:pb-24">
        {conflictNotice}
        <AnimatePresence mode="wait">
          {activeSection === "identity" && (
            <motion.div key="identity" variants={sectionVariants} initial="hidden" animate="visible" exit="exit" className="space-y-8">
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold tracking-tighter text-foreground">Brand Details</h2>
                <p className="text-muted-foreground text-sm">Define your brand&apos;s core identity, mission, and basic details.</p>
              </div>

              {/* Auto-fill from Website */}
              <div className="space-y-3 rounded-xl border border-dashed border-primary/40 bg-primary/5 p-4">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                    <Globe className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <Label htmlFor={fieldId("analyzeUrl")} className="text-xs font-bold text-foreground">Auto-fill from Website</Label>
                    <p id={fieldId("analyzeUrl-description")} className="text-sm text-muted-foreground">Enter your URL to automatically extract brand details</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Input
                    id={fieldId("analyzeUrl")}
                    aria-describedby={fieldId("analyzeUrl-description")}
                    value={analyzeUrl}
                    onChange={(e) => setAnalyzeUrl(e.target.value)}
                    placeholder="https://yourcompany.com"
                    className="h-10 px-4 rounded-lg bg-muted/20 border border-input focus:ring-2 focus:ring-primary/20 font-bold flex-1 text-xs text-foreground"
                    onKeyDown={(e) => { if (e.key === "Enter" && analyzeUrl.trim()) handleAnalyzeWebsite(); }}
                  />
                  <Button
                    variant="outline"
                    onClick={handleAnalyzeWebsite}
                    loading={isAnalyzing}
                    loadingText="Analyzing..."
                    disabled={!analyzeUrl.trim()}
                    className="h-10 px-4 rounded-lg gap-2 shrink-0 text-sm font-medium uppercase tracking-widest border-border"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Analyze
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label htmlFor={fieldId("brandName")} className="text-sm font-medium text-muted-foreground ml-1">Brand Name <span aria-hidden="true">*</span></Label>
                  <Input
                    id={fieldId("brandName")}
                    ref={attachBrandName}
                    required
                    aria-invalid={brandNameError || undefined}
                    aria-describedby={brandNameError ? fieldId("brandName-error") : undefined}
                    name="brandName"
                    value={brandToolkit.brandName}
                    onChange={handleBTChange}
                    placeholder="e.g. Acme Corp"
                    className="h-11 px-4 rounded-lg bg-muted/20 border border-input focus:ring-2 focus:ring-primary/20 text-sm font-medium text-foreground"
                  />
                  {brandNameError && (
                    <p id={fieldId("brandName-error")} role="alert" className="ml-1 text-sm text-destructive">Please enter a brand name</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor={fieldId("tagline")} className="text-sm font-medium text-muted-foreground ml-1">Tagline</Label>
                  <Input
                    id={fieldId("tagline")}
                    name="tagline"
                    value={brandToolkit.tagline}
                    onChange={handleBTChange}
                    placeholder="e.g. The future of SaaS"
                    className="h-11 px-4 rounded-lg bg-muted/20 border border-input focus:ring-2 focus:ring-primary/20 text-sm font-medium text-foreground"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor={fieldId("website")} className="text-sm font-medium text-muted-foreground ml-1">Website</Label>
                  <Input
                    id={fieldId("website")}
                    name="website"
                    value={brandToolkit.website}
                    onChange={handleBTChange}
                    placeholder="https://acme.com"
                    className="h-11 px-4 rounded-lg bg-muted/20 border border-input focus:ring-2 focus:ring-primary/20 text-sm font-medium text-foreground"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor={fieldId("industry")} className="text-sm font-medium text-muted-foreground ml-1">Industry</Label>
                  <Input
                    id={fieldId("industry")}
                    name="industry"
                    value={brandToolkit.industry}
                    onChange={handleBTChange}
                    placeholder="e.g. Technology"
                    className="h-11 px-4 rounded-lg bg-muted/20 border border-input focus:ring-2 focus:ring-primary/20 text-sm font-medium text-foreground"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor={fieldId("email")} className="text-sm font-medium text-muted-foreground ml-1">Contact Email</Label>
                  <Input
                    id={fieldId("email")}
                    name="email"
                    type="email"
                    value={brandToolkit.email}
                    onChange={handleBTChange}
                    placeholder="contact@acme.com"
                    className="h-11 px-4 rounded-lg bg-muted/20 border border-input focus:ring-2 focus:ring-primary/20 text-sm font-medium text-foreground"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor={fieldId("phone")} className="text-sm font-medium text-muted-foreground ml-1">Phone Number</Label>
                  <Input
                    id={fieldId("phone")}
                    name="phone"
                    value={brandToolkit.phone}
                    onChange={handleBTChange}
                    placeholder="+1 (555) 123-4567"
                    className="h-11 px-4 rounded-lg bg-muted/20 border border-input focus:ring-2 focus:ring-primary/20 text-sm font-medium text-foreground"
                  />
                </div>

                <div className="space-y-2 col-span-full">
                  <Label htmlFor={fieldId("missionStatement")} className="text-sm font-medium text-muted-foreground ml-1">Mission Statement</Label>
                  <Textarea
                    id={fieldId("missionStatement")}
                    name="missionStatement"
                    value={brandToolkit.missionStatement}
                    onChange={handleBTChange}
                    placeholder="Describe your brand's mission..."
                    className="min-h-16 px-4 py-3 rounded-lg bg-muted/20 border border-input focus:ring-2 focus:ring-primary/20 text-sm font-medium text-foreground"
                  />
                </div>

                <div className="space-y-2 col-span-full">
                  <Label htmlFor={fieldId("description")} className="text-sm font-medium text-muted-foreground ml-1">Business Description</Label>
                  <Textarea
                    id={fieldId("description")}
                    name="description"
                    value={brandToolkit.description}
                    onChange={handleBTChange}
                    placeholder="Brief overview of your business..."
                    className="min-h-20 px-4 py-3 rounded-lg bg-muted/20 border border-input focus:ring-2 focus:ring-primary/20 text-sm font-medium text-foreground"
                  />
                </div>
              </div>
            </motion.div>
          )}

          {activeSection === "visuals" && (
            <motion.div key="visuals" variants={sectionVariants} initial="hidden" animate="visible" exit="exit" className="space-y-8">
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold tracking-tighter text-foreground">Visual Identity</h2>
                <p className="text-muted-foreground text-sm">Manage your brand&apos;s logo assets, color palette, and default fonts.</p>
              </div>

              {/* Logo Upload */}
              <div className="space-y-4">
                <div className="space-y-1">
                  <Label htmlFor={fieldId("logo")} className="text-sm font-medium text-muted-foreground ml-1">Brand Logo</Label>
                  <p id={fieldId("logo-description")} className="text-sm text-muted-foreground ml-1 font-medium">Primary logo representing your brand (max 5MB).</p>
                </div>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
                  <button
                    type="button"
                    aria-label="Upload brand logo"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={saving || Boolean(saveConflict)}
                    className={cn(
                      "w-24 h-24 rounded-xl border border-dashed flex flex-col items-center justify-center cursor-pointer transition-all shrink-0",
                      brandToolkit.logoUrls.length > 0
                        ? "border-primary/50 bg-white shadow-sm"
                        : "border-border/40 hover:border-primary/40 bg-muted/20"
                    )}
                  >
                    {brandToolkit.logoUrls.length > 0 ? (
                      <img src={normalizeUploadUrl(brandToolkit.logoUrls[0])} alt="Logo" className="w-full h-full object-contain rounded-lg p-2" />
                    ) : (
                      <>
                        <ImageIcon className="w-6 h-6 text-muted-foreground mb-1" />
                        <span className="text-xs font-bold text-muted-foreground">Upload</span>
                      </>
                    )}
                  </button>
                  <div className="flex-1 space-y-2.5">
                    {brandToolkit.logoUrls.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {brandToolkit.logoUrls.map((url, i) => (
                          <Badge key={i} variant="secondary" className="px-2.5 py-1 rounded-lg text-sm font-medium bg-background border border-border/60">
                            Logo {i + 1}
                            <button
                              type="button"
                              aria-label={`Remove logo ${i + 1}`}
                              onClick={() => setBrandToolkit((prev) => ({ ...prev, logoUrls: prev.logoUrls.filter((_, idx) => idx !== i) }))}
                              className="ml-1.5 text-muted-foreground hover:text-destructive transition-colors"
                            >
                              <X aria-hidden="true" className="w-3 h-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={saving || Boolean(saveConflict)}
                      className="h-9 px-4 rounded-lg text-sm font-medium gap-2 border-border text-foreground"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      Choose File
                    </Button>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-6 border-t border-border/60 pt-6 lg:grid-cols-2">
                <div className="space-y-3 lg:col-span-2">
                  <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/20 p-4">
                    <Checkbox
                      id={fieldId("logoVisibility")}
                      aria-describedby={fieldId("logoVisibility-description")}
                      checked={brandToolkit.logoVisibility}
                      onCheckedChange={(checked) => setBrandToolkit((prev) => ({ ...prev, logoVisibility: checked === true }))}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={fieldId("logoVisibility")} className="cursor-pointer text-sm font-semibold text-foreground">Use the approved logo in generated visuals</Label>
                      <p id={fieldId("logoVisibility-description")} className="text-sm leading-relaxed text-muted-foreground">The approved logo will be sent to the image or video model as a visual reference and used with the rules below.</p>
                    </div>
                  </div>
                </div>
                <div className="space-y-2 lg:col-span-2">
                  <Label htmlFor={fieldId("logoUsageGuidelines")} className="ml-1 text-sm font-medium text-muted-foreground">Logo Usage Guidelines</Label>
                  <Textarea
                    id={fieldId("logoUsageGuidelines")}
                    name="logoUsageGuidelines"
                    value={brandToolkit.logoUsageGuidelines}
                    onChange={handleBTChange}
                    placeholder="Placement, clear space, contrast, and changes that are not allowed..."
                    className="min-h-24 resize-y rounded-lg border border-input bg-muted/20 px-4 py-3 text-sm text-foreground"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={fieldId("imageStyleReference")} className="ml-1 text-sm font-medium text-muted-foreground">Image Style Reference</Label>
                  <Input
                    id={fieldId("imageStyleReference")}
                    name="imageStyleReference"
                    value={brandToolkit.imageStyleReference}
                    onChange={handleBTChange}
                    placeholder="e.g. Premium enterprise technology"
                    className="h-11 rounded-lg border border-input bg-muted/20 px-4 text-sm text-foreground"
                  />
                </div>
                <div className="space-y-2 lg:col-span-2">
                  <Label htmlFor={fieldId("visualInstructions")} className="ml-1 text-sm font-medium text-muted-foreground">Image & Video Instructions</Label>
                  <Textarea
                    id={fieldId("visualInstructions")}
                    aria-describedby={fieldId("visualInstructions-description")}
                    name="visualInstructions"
                    value={brandToolkit.visualInstructions}
                    onChange={handleBTChange}
                    placeholder="Composition, lighting, subjects, backgrounds, text treatment, and visual restrictions..."
                    className="min-h-28 resize-y rounded-lg border border-input bg-muted/20 px-4 py-3 text-sm text-foreground"
                  />
                  <p id={fieldId("visualInstructions-description")} className="ml-1 text-sm leading-relaxed text-muted-foreground">These rules are added to direct and background image/video generations.</p>
                </div>
              </div>

              {/* Color Palette */}
              <div className="space-y-6 pt-6 border-t border-border/60">
                <div className="space-y-1">
                  <h3 className="text-xs font-bold text-foreground">Color Palette</h3>
                  <p className="text-sm text-muted-foreground">Select colors representing your brand assets.</p>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* Primary Colors */}
                  <div className="space-y-3">
                    <Label id={fieldId("primaryColors-label")} htmlFor={fieldId("primaryColors-0-hex")} className="text-sm font-medium text-muted-foreground ml-1">Primary Colors</Label>
                    <div className="space-y-2">
                      {(brandToolkit.primaryColors || []).map((color, i) => (
                        <div key={i} className="flex items-center gap-2 group">
                          <span id={fieldId(`primaryColors-${i}-picker-label`)} className="sr-only">{i + 1} color picker</span>
                          <span id={fieldId(`primaryColors-${i}-hex-label`)} className="sr-only">{i + 1} hex value</span>
                          <input
                            id={fieldId(`primaryColors-${i}-picker`)}
                            aria-labelledby={`${fieldId("primaryColors-label")} ${fieldId(`primaryColors-${i}-picker-label`)}`}
                            type="color"
                            value={color}
                            onChange={(e) => updateColor("primaryColors", i, e.target.value)}
                            className="w-10 h-10 rounded-lg border-0 cursor-pointer overflow-hidden bg-transparent"
                          />
                          <Input
                            id={fieldId(`primaryColors-${i}-hex`)}
                            aria-labelledby={`${fieldId("primaryColors-label")} ${fieldId(`primaryColors-${i}-hex-label`)}`}
                            value={color}
                            onChange={(e) => updateColor("primaryColors", i, e.target.value)}
                            className="h-10 px-3 rounded-lg bg-muted/20 border border-input text-sm font-medium uppercase flex-1 focus:ring-2 focus:ring-primary/20 text-foreground"
                          />
                          {(brandToolkit.primaryColors || []).length > 1 && (
                            <button
                              type="button"
                              aria-label={`Remove primary color ${i + 1}`}
                              onClick={() => removeColor("primaryColors", i)}
                              className="text-muted-foreground hover:text-red-500 transition-colors p-1"
                            >
                              <X aria-hidden="true" className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label="Add Color to primary palette"
                      onClick={() => addColor("primaryColors")}
                      className="h-8 text-xs font-bold tracking-tight text-primary hover:text-primary hover:bg-primary/5 rounded-lg px-2"
                    >
                      <Plus aria-hidden="true" className="w-3.5 h-3.5 mr-1" /> Add Color
                    </Button>
                  </div>

                  {/* Secondary Colors */}
                  <div className="space-y-3">
                    <Label id={fieldId("secondaryColors-label")} htmlFor={fieldId("secondaryColors-0-hex")} className="text-sm font-medium text-muted-foreground ml-1">Secondary Colors</Label>
                    <div className="space-y-2">
                      {(brandToolkit.secondaryColors || []).map((color, i) => (
                        <div key={i} className="flex items-center gap-2 group">
                          <span id={fieldId(`secondaryColors-${i}-picker-label`)} className="sr-only">{i + 1} color picker</span>
                          <span id={fieldId(`secondaryColors-${i}-hex-label`)} className="sr-only">{i + 1} hex value</span>
                          <input
                            id={fieldId(`secondaryColors-${i}-picker`)}
                            aria-labelledby={`${fieldId("secondaryColors-label")} ${fieldId(`secondaryColors-${i}-picker-label`)}`}
                            type="color"
                            value={color}
                            onChange={(e) => updateColor("secondaryColors", i, e.target.value)}
                            className="w-10 h-10 rounded-lg border-0 cursor-pointer overflow-hidden bg-transparent"
                          />
                          <Input
                            id={fieldId(`secondaryColors-${i}-hex`)}
                            aria-labelledby={`${fieldId("secondaryColors-label")} ${fieldId(`secondaryColors-${i}-hex-label`)}`}
                            value={color}
                            onChange={(e) => updateColor("secondaryColors", i, e.target.value)}
                            className="h-10 px-3 rounded-lg bg-muted/20 border border-input text-sm font-medium uppercase flex-1 focus:ring-2 focus:ring-primary/20 text-foreground"
                          />
                          {(brandToolkit.secondaryColors || []).length > 1 && (
                            <button
                              type="button"
                              aria-label={`Remove secondary color ${i + 1}`}
                              onClick={() => removeColor("secondaryColors", i)}
                              className="text-muted-foreground hover:text-red-500 transition-colors p-1"
                            >
                              <X aria-hidden="true" className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label="Add Color to secondary palette"
                      onClick={() => addColor("secondaryColors")}
                      className="h-8 text-xs font-bold tracking-tight text-primary hover:text-primary hover:bg-primary/5 rounded-lg px-2"
                    >
                      <Plus aria-hidden="true" className="w-3.5 h-3.5 mr-1" /> Add Color
                    </Button>
                  </div>

                  {/* Accent Color */}
                  <div className="space-y-3">
                    <Label id={fieldId("accentColor-label")} htmlFor={fieldId("accentColor-hex")} className="text-sm font-medium text-muted-foreground ml-1">Accent Color</Label>
                    <div className="flex items-center gap-2">
                      <span id={fieldId("accentColor-picker-label")} className="sr-only">color picker</span>
                      <span id={fieldId("accentColor-hex-label")} className="sr-only">hex value</span>
                      <input
                        id={fieldId("accentColor-picker")}
                        aria-labelledby={`${fieldId("accentColor-label")} ${fieldId("accentColor-picker-label")}`}
                        type="color"
                        value={brandToolkit.accentColor}
                        onChange={(e) => handleBTSelectChange("accentColor", e.target.value)}
                        className="w-10 h-10 rounded-lg border-0 cursor-pointer overflow-hidden bg-transparent"
                      />
                      <Input
                        id={fieldId("accentColor-hex")}
                        aria-labelledby={`${fieldId("accentColor-label")} ${fieldId("accentColor-hex-label")}`}
                        value={brandToolkit.accentColor}
                        onChange={(e) => handleBTSelectChange("accentColor", e.target.value)}
                        className="h-10 px-3 rounded-lg bg-muted/20 border border-input text-sm font-medium uppercase flex-1 focus:ring-2 focus:ring-primary/20 text-foreground"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Typography */}
              <div className="space-y-6 pt-6 border-t border-border/60">
                <div className="space-y-1">
                  <h3 className="text-xs font-bold text-foreground">Typography Fonts</h3>
                  <p className="text-sm text-muted-foreground">Select fonts representing your brand voice.</p>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="space-y-2">
                    <Label htmlFor={fieldId("fonts-heading")} className="text-sm font-medium text-muted-foreground ml-1">Heading Font</Label>
                    <Input
                      id={fieldId("fonts-heading")}
                      value={brandToolkit.fonts.heading}
                      onChange={(e) => setBrandToolkit((prev) => ({ ...prev, fonts: { ...prev.fonts, heading: e.target.value } }))}
                      placeholder="e.g. Outfit"
                      className="h-11 px-4 rounded-lg bg-muted/20 border border-input focus:ring-2 focus:ring-primary/20 text-sm font-medium text-foreground"
                    />
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor={fieldId("fonts-body")} className="text-sm font-medium text-muted-foreground ml-1">Body Font</Label>
                    <Input
                      id={fieldId("fonts-body")}
                      value={brandToolkit.fonts.body}
                      onChange={(e) => setBrandToolkit((prev) => ({ ...prev, fonts: { ...prev.fonts, body: e.target.value } }))}
                      placeholder="e.g. Inter"
                      className="h-11 px-4 rounded-lg bg-muted/20 border border-input focus:ring-2 focus:ring-primary/20 text-sm font-medium text-foreground"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor={fieldId("fonts-accent")} className="text-sm font-medium text-muted-foreground ml-1">Accent Font</Label>
                    <Input
                      id={fieldId("fonts-accent")}
                      value={brandToolkit.fonts.accent}
                      onChange={(e) => setBrandToolkit((prev) => ({ ...prev, fonts: { ...prev.fonts, accent: e.target.value } }))}
                      placeholder="e.g. Playfair Display"
                      className="h-11 px-4 rounded-lg bg-muted/20 border border-input focus:ring-2 focus:ring-primary/20 text-sm font-medium text-foreground"
                    />
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeSection === "voice" && (
            <motion.div key="voice" variants={sectionVariants} initial="hidden" animate="visible" exit="exit" className="space-y-8">
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold tracking-tighter text-foreground">Voice & Values</h2>
                <p className="text-muted-foreground text-sm">Specify brand values, personality traits, and keywords.</p>
              </div>

              <div className="space-y-6">
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={fieldId("voiceType")} className="ml-1 text-sm font-medium text-muted-foreground">Voice Type</Label>
                    <Input
                      id={fieldId("voiceType")}
                      name="voiceType"
                      value={brandToolkit.voiceType}
                      onChange={handleBTChange}
                      placeholder="e.g. Authoritative and practical"
                      className="h-11 rounded-lg border border-input bg-muted/20 px-4 text-sm text-foreground"
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor={fieldId("customToneGuidelines")} className="ml-1 text-sm font-medium text-muted-foreground">Custom Tone Guidelines</Label>
                    <Textarea
                      id={fieldId("customToneGuidelines")}
                      name="customToneGuidelines"
                      value={brandToolkit.customToneGuidelines}
                      onChange={handleBTChange}
                      placeholder="Explain how the brand should sound across channels..."
                      className="min-h-24 resize-y rounded-lg border border-input bg-muted/20 px-4 py-3 text-sm text-foreground"
                    />
                  </div>
                </div>
                <TagInput
                  {...tagInputProps}
                  label="Brand Values"
                  field="brandValues"
                  placeholder="e.g. Innovation, Trust, Transparency"
                  description="Core principles guiding your business decisions."
                />
                <TagInput
                  {...tagInputProps}
                  label="Brand Keywords"
                  field="brandKeywords"
                  placeholder="e.g. AI agents, Autonomous workforce"
                  description="Approved concepts and phrases that define the brand."
                />
                <TagInput
                  {...tagInputProps}
                  label="Personality Traits"
                  field="voicePersonalityTraits"
                  placeholder="e.g. Confident, Friendly, Technical"
                  description="Describe how your brand sounds and communicates."
                />
                <TagInput
                  {...tagInputProps}
                  label="Voice Keywords"
                  field="voiceKeywords"
                  placeholder="e.g. Empower, Simplify, Accelerate"
                  description="Keywords that should appear frequently in your content."
                />
                <TagInput
                  {...tagInputProps}
                  label="Voice Do's"
                  field="voiceDos"
                  placeholder="e.g. Lead with measurable business outcomes"
                  description="Writing practices every generated asset should follow."
                />
                <TagInput
                  {...tagInputProps}
                  label="Voice Don'ts"
                  field="voiceDonts"
                  placeholder="e.g. Do not invent customer results"
                  description="Mandatory restrictions for all generated content."
                />
              </div>
            </motion.div>
          )}

          {activeSection === "content" && (
            <motion.div key="content" variants={sectionVariants} initial="hidden" animate="visible" exit="exit" className="space-y-8">
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold tracking-tighter text-foreground">Content Settings</h2>
                <p className="text-muted-foreground text-sm">Configure content pillars, formats, default hashtags, and calls-to-action.</p>
              </div>

              <div className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor={fieldId("contentInstructions")} className="ml-1 text-sm font-medium text-muted-foreground">Global Generation Instructions</Label>
                  <Textarea
                    id={fieldId("contentInstructions")}
                    aria-describedby={fieldId("contentInstructions-description")}
                    name="contentInstructions"
                    value={brandToolkit.contentInstructions}
                    onChange={handleBTChange}
                    placeholder="Audience, approved claims, naming, links, CTAs, compliance rules, and other mandatory directions..."
                    className="min-h-32 resize-y rounded-lg border border-input bg-muted/20 px-4 py-3 text-sm text-foreground"
                  />
                  <p id={fieldId("contentInstructions-description")} className="ml-1 text-sm leading-relaxed text-muted-foreground">Applied to every email, SMS, social post, DM, ad, blog, image, and video prompt.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={fieldId("sampleContent")} className="ml-1 text-sm font-medium text-muted-foreground">Approved Sample Content</Label>
                  <Textarea
                    id={fieldId("sampleContent")}
                    name="sampleContent"
                    value={brandToolkit.sampleContent}
                    onChange={handleBTChange}
                    placeholder="Paste a short example that demonstrates the preferred style..."
                    className="min-h-24 resize-y rounded-lg border border-input bg-muted/20 px-4 py-3 text-sm text-foreground"
                  />
                </div>
                <TagInput
                  {...tagInputProps}
                  label="Content Pillars"
                  field="contentPillars"
                  placeholder="e.g. Thought Leadership, Product Updates, Case Studies"
                  description="Primary themes around which your content is built."
                />
                <TagInput
                  {...tagInputProps}
                  label="Content Formats"
                  field="contentFormats"
                  placeholder="e.g. Blog posts, Video Reels, LinkedIn articles"
                  description="Formats that perform best for your target audience."
                />
                <TagInput
                  {...tagInputProps}
                  label="Default Hashtags"
                  field="defaultHashtags"
                  placeholder="e.g. #automation, #marketing"
                  description="Hashtags that should be included on social posts."
                />
                <TagInput
                  {...tagInputProps}
                  label="Default CTAs"
                  field="defaultCtas"
                  placeholder="e.g. Sign up today, Start free trial"
                  description="Primary calls-to-action to use across your content."
                />
                <div className="border-t border-border/60 pt-6">
                  <h3 className="text-sm font-semibold text-foreground">Audience Guidance</h3>
                  <p className="mt-1 text-sm text-muted-foreground">Give every format the same audience needs, language, and decision triggers.</p>
                </div>
                <TagInput
                  {...tagInputProps}
                  label="Audience Pain Points"
                  field="audiencePainPoints"
                  placeholder="e.g. AI initiatives stuck in pilot"
                />
                <TagInput
                  {...tagInputProps}
                  label="Audience Goals"
                  field="audienceGoals"
                  placeholder="e.g. Deploy production AI quickly"
                />
                <TagInput
                  {...tagInputProps}
                  label="Audience Language Style"
                  field="audienceLanguageStyle"
                  placeholder="e.g. Executive, concise, technically credible"
                />
                <TagInput
                  {...tagInputProps}
                  label="Audience Triggers"
                  field="audienceTriggers"
                  placeholder="e.g. Faster deployment, measurable outcomes"
                />
              </div>
            </motion.div>
          )}

          {activeSection === "presence" && (
            <motion.div key="presence" variants={sectionVariants} initial="hidden" animate="visible" exit="exit" className="space-y-8">
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold tracking-tighter text-foreground">Social Media</h2>
                <p className="text-muted-foreground text-sm">Add links to your official social profiles.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <SocialInput
                  id={fieldId("linkedinUrl")}
                  platform="linkedin"
                  label="LinkedIn Page"
                  icon={Linkedin}
                  color="text-blue-600"
                  value={brandToolkit.linkedinUrl}
                  onChange={(v) => handleBTSelectChange("linkedinUrl", v)}
                />
                <SocialInput
                  id={fieldId("twitterUrl")}
                  platform="twitter"
                  label="Twitter / X"
                  icon={Twitter}
                  color="text-zinc-950 dark:text-white"
                  value={brandToolkit.twitterUrl}
                  onChange={(v) => handleBTSelectChange("twitterUrl", v)}
                />
                <SocialInput
                  id={fieldId("instagramUrl")}
                  platform="instagram"
                  label="Instagram Profile"
                  icon={Instagram}
                  color="text-rose-500"
                  value={brandToolkit.instagramUrl}
                  onChange={(v) => handleBTSelectChange("instagramUrl", v)}
                />
                <SocialInput
                  id={fieldId("facebookUrl")}
                  platform="facebook"
                  label="Facebook Page"
                  icon={Facebook}
                  color="text-blue-500"
                  value={brandToolkit.facebookUrl}
                  onChange={(v) => handleBTSelectChange("facebookUrl", v)}
                />
                <div className="col-span-full">
                  <SocialInput
                    id={fieldId("youtubeUrl")}
                    platform="youtube"
                    label="YouTube Channel"
                    icon={Youtube}
                    color="text-red-500"
                    value={brandToolkit.youtubeUrl}
                    onChange={(v) => handleBTSelectChange("youtubeUrl", v)}
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {showSave && (
          <div className="sticky bottom-3 z-20 ml-auto mt-8 flex w-fit max-w-full items-center gap-2 rounded-xl border border-border bg-background/95 p-2 shadow-lg backdrop-blur-md sm:bottom-4 sm:gap-3">
            <Button
              variant="ghost"
              type="button"
              className="h-11 rounded-lg px-4 text-sm font-medium text-muted-foreground hover:text-foreground sm:px-6"
              onClick={() => {
                const idx = sections.findIndex((s) => s.id === activeSection);
                if (idx > 0) setActiveSection(sections[idx - 1].id);
              }}
              disabled={activeSection === "identity"}
            >
              Back
            </Button>
            <Button
              type="button"
              className="h-11 gap-2 rounded-lg px-5 text-sm font-semibold shadow-md transition-all active:scale-95 sm:px-8"
              loading={saving}
              loadingText={activeSection === "presence" ? (saveButtonLabel || "Save Toolkit") : "Continue"}
              disabled={Boolean(saveConflict)}
              onClick={async () => {
                const idx = sections.findIndex((s) => s.id === activeSection);
                if (idx < sections.length - 1) {
                  setActiveSection(sections[idx + 1].id);
                } else {
                  await handleSaveBrand();
                }
              }}
            >
              {activeSection === "presence" ? (saveButtonLabel || "Save Toolkit") : "Continue"}
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        )}
      </section>
    </div>
  );
});

BrandToolkitForm.displayName = "BrandToolkitForm";

// =============================================================
// SUB-COMPONENTS
// =============================================================
function TagInput({
  idPrefix,
  drafts,
  setDraft,
  brandToolkit,
  addToArray,
  removeFromArray,
  label,
  field,
  placeholder,
  description,
}: {
  idPrefix: string;
  drafts: Partial<Record<keyof BrandToolkitFormData, string>>;
  setDraft: (field: keyof BrandToolkitFormData, value: string) => void;
  brandToolkit: BrandToolkitFormData;
  addToArray: (field: keyof BrandToolkitFormData, value: string) => void;
  removeFromArray: (field: keyof BrandToolkitFormData, index: number) => void;
  label: string;
  field: keyof BrandToolkitFormData;
  placeholder: string;
  description?: string;
}) {
  const input = drafts[field] || "";
  const setInput = (value: string) => setDraft(field, value);
  const inputId = `${idPrefix}-${field}`;
  const descriptionId = `${inputId}-description`;
  const values = (brandToolkit[field] as string[]) || [];

  const handleAdd = () => {
    if (input.trim()) {
      addToArray(field, input);
      setInput("");
    }
  };

  return (
    <div className="space-y-2.5">
      <div>
        <Label htmlFor={inputId} className="text-sm font-medium text-muted-foreground ml-1">{label}</Label>
        {description && <p id={descriptionId} className="text-sm text-muted-foreground mt-0.5 ml-1 leading-normal">{description}</p>}
      </div>
      <div className="flex gap-2">
        <Input
          id={inputId}
          aria-describedby={description ? descriptionId : undefined}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
          className="h-11 px-4 rounded-lg bg-muted/20 border border-input focus:ring-2 focus:ring-primary/20 text-sm font-medium flex-1 text-foreground"
        />
        <Button
          type="button"
          aria-label={`Add ${label}`}
          onClick={handleAdd}
          variant="outline"
          className="h-11 px-4 rounded-lg shrink-0 border-border"
        >
          <Plus aria-hidden="true" className="w-4 h-4 text-primary" />
        </Button>
      </div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {values.map((v, i) => (
            <Badge key={i} variant="secondary" className="px-2.5 py-1 rounded-lg text-sm font-medium bg-background border border-border/60 flex items-center gap-1 shadow-sm transition-all hover:border-primary/20">
              {v}
              <button
                type="button"
                aria-label={`Remove ${v} from ${label}`}
                onClick={() => removeFromArray(field, i)}
                className="text-muted-foreground hover:text-red-500 transition-colors"
              >
                <X aria-hidden="true" className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function SocialInput({
  id,
  platform,
  label,
  icon: Icon,
  color,
  value,
  onChange,
}: {
  id: string;
  platform: string;
  label: string;
  icon: React.ElementType;
  color: string;
  value?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2 group">
      <div className="flex items-center justify-between px-1">
        <Label htmlFor={id} className="text-sm font-medium text-muted-foreground">{label}</Label>
        <Icon aria-hidden="true" className={cn("w-3.5 h-3.5 opacity-20 group-hover:opacity-100 transition-all", color)} />
      </div>
      <div className="relative">
        <Input
          id={id}
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`https://${platform}.com/${platform === "linkedin" ? "company/" : ""}`}
          className="h-11 px-4 rounded-lg bg-muted/20 border border-input focus:ring-2 focus:ring-primary/20 font-bold transition-all shadow-sm text-xs text-foreground"
        />
        {value && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <BadgeCheck className="w-4 h-4 text-emerald-500 animate-in zoom-in-50 duration-300" />
          </div>
        )}
      </div>
    </div>
  );
}
