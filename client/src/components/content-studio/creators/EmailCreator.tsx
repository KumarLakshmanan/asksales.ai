"use client";

import { useContentLibraryRefresh } from "@/hooks/useContentLibraryRefresh";

import { useRefreshContentLibrary } from "@/hooks/use-content-counts";
import { useCreatorScope, creatorAssetUrl, creatorGenerationContext } from "../CreatorScope";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Callout } from "@/components/ui/callout";
import { copyText } from "@/components/ui/copy-button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useCreatorPrompt } from "@/hooks/use-creator-prompt";
import { GenerationEstimate } from '@/components/content-studio/GenerationEstimate';
import { DeleteDraftAction } from "@/components/content-studio/DeleteDraftAction";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { GeneratorModeSwitch, ManualContentComposer, type GeneratorMode, type ManualDraft } from "@/components/content-studio/GeneratorMode";
import { useWebSocket } from "@/contexts/WebSocketContext";
import api from "@/lib/api";
import { ApiError } from "@/lib/api-client";
import { creatorSessionScope } from "@/lib/creator-session";
import { EMAIL_GENERATION_WAIT_MS, EMAIL_SAVE_UNCONFIRMED, EMAIL_WAIT_CANCELLED, EMAIL_WAIT_TIMED_OUT, EmailGenerationRecoveryError, emailGenerationErrorMessage } from "@/lib/emailGenerationRecovery";
import {
  Mail,
  Sparkles,
  Wand2,
  Download,
  Copy,
  Check,
  RefreshCw,
  Settings2,
  Grid3X3,
  List,
  ChevronDown,
  ChevronRight,
  FileText,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import MediaManager from "@/components/MediaManager";
import { EmailCard } from "@/components/content-cards";
import { MasonryGrid } from "@/components/ui/masonry-grid";
import { readEmailDraft } from "@/lib/emailTemplateSections";
import { sanitizeEmailPreviewHtml } from "@/lib/contentTemplateRendering";
import { useContentBrandContext } from "@/hooks/use-content-brand-context";
import { ContentCreatorBody, ContentCreatorComposer, ContentCreatorHeader, ContentCreatorShell, ContentCreatorStage, CreatorResultsPane } from "@/components/content-studio/ContentCreatorShell";
import { CreatorPreview, manualDraftPreview, type CreatorPreviewModel } from "@/components/content-studio/CreatorPreview";

interface GeneratedEmail {
  id: string;
  title: string;
  subject: string;
  preheader?: string;
  body: string;
  html?: string;
  createdAt: number;
  category?: string;
  tone?: string;
  imageUrls?: string[];
  videoUrls?: string[];
}

interface EmailGenerationAttempt {
  controller: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
}

const EMAIL_TYPES = [
  { value: "cold-outreach", label: "Cold Outreach" },
  { value: "follow-up", label: "Follow-up" },
  { value: "newsletter", label: "Newsletter" },
  { value: "promotion", label: "Promotional" },
  { value: "welcome", label: "Welcome" },
  { value: "re-engagement", label: "Re-engagement" },
  { value: "transactional", label: "Transactional" },
  { value: "thank-you", label: "Thank You" },
];

const TONES = [
  { value: "professional", label: "Professional" },
  { value: "casual", label: "Casual" },
  { value: "friendly", label: "Friendly" },
  { value: "urgent", label: "Urgent" },
  { value: "formal", label: "Formal" },
  { value: "playful", label: "Playful" },
  { value: "authoritative", label: "Authoritative" },
];

export default function EmailCreator() {
  const scope = useCreatorScope();
  const refreshContent = useRefreshContentLibrary();
  const generationContext = creatorGenerationContext(scope);
  const router = useRouter();
  const { toast } = useToast();
  const { brandToolkitId, businessProfileId, missingMessage } = useContentBrandContext();
  const { subscribe } = useWebSocket();

  // Generation settings
  const { prompt, setPrompt, proposeEnhancement, enhancementReview } = useCreatorPrompt("email");
  const [emailType, setEmailType] = useState("cold-outreach");
  const [tone, setTone] = useState("professional");
  const [targetAudience, setTargetAudience] = useState("");
  const [ctaText, setCtaText] = useState("");
  const [includeHashtags, setIncludeHashtags] = useState(false);
  const [includeEmojis, setIncludeEmojis] = useState(false);
  // UI state
  const [isGenerating, setIsGenerating] = useState(false);
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const [generationError, setGenerationError] = useState<string | undefined>();
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [emails, setEmails] = useState<GeneratedEmail[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [showSettings, setShowSettings] = useState(false);
  const [generationMode, setGenerationMode] = useState<GeneratorMode>("ai");
  const [manualDraft, setManualDraft] = useState<ManualDraft>({ title: "", subject: "", description: "", content: "" });
  const [previewEmail, setPreviewEmail] = useState<GeneratedEmail | null>(null);
  const [currentEmail, setCurrentEmail] = useState<GeneratedEmail | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [newlyCreatedEmailId, setNewlyCreatedEmailId] = useState<string | null>(null);
  const requestScope = `${creatorSessionScope()}:${scope.threadId ?? 'library'}:${scope.icpId ?? ''}:${businessProfileId ?? ''}:${brandToolkitId ?? ''}`;
  const requestScopeRef = useRef(requestScope);
  const generationRef = useRef<EmailGenerationAttempt | null>(null);
  const libraryRequestRef = useRef<AbortController | null>(null);

  const stopWaiting = useCallback((notice?: string) => {
    const attempt = generationRef.current;
    generationRef.current = null;
    if (attempt) {
      clearTimeout(attempt.timeout);
      attempt.controller.abort();
    }
    setIsGenerating(false);
    if (notice) setGenerationError(notice);
  }, []);

  useEffect(() => {
    requestScopeRef.current = requestScope;
    setIsGenerating(false);
    setGenerationError(undefined);
    setCurrentEmail(null);
    setPreviewEmail(null);
    setEmails([]);
    return () => {
      const attempt = generationRef.current;
      generationRef.current = null;
      if (attempt) {
        clearTimeout(attempt.timeout);
        attempt.controller.abort();
      }
      libraryRequestRef.current?.abort();
    };
  }, [requestScope]);

  const loadEmails = useCallback(async () => {
    libraryRequestRef.current?.abort();
    const controller = new AbortController();
    libraryRequestRef.current = controller;
    const session = creatorSessionScope();
    const isCurrent = () => libraryRequestRef.current === controller && !controller.signal.aborted && requestScopeRef.current === requestScope && creatorSessionScope() === session;
    setIsLoading(true);
    setLoadError(false);
    try {
      const response = await api.get<Array<{
        id: number;
        type: string;
        title: string;
        content: string;
        createdAt: string;
        performance?: Record<string, unknown>;
        imageUrls?: string[];
        videoUrls?: string[];
      }>>(creatorAssetUrl("email_template", { threadId: scope.threadId }), { signal: controller.signal });
      if (!isCurrent()) return;

      if (Array.isArray(response)) {
        const mapped: GeneratedEmail[] = response
          .filter((a) => a.type === "email_template")
          .map((asset) => {
            const { subject, preheader, body, html } = readEmailDraft(asset.content);

            const perf = asset.performance || {};
            return {
              id: `db-${asset.id}`,
              title: asset.title,
              subject,
              preheader,
              body,
              html,
              createdAt: new Date(asset.createdAt).getTime(),
              category: (perf.category as string) || undefined,
              tone: (perf.tone as string) || undefined,
              imageUrls: asset.imageUrls || [],
              videoUrls: asset.videoUrls || [],
            };
          });
        setEmails(mapped);
        setCurrentEmail(current => current ? mapped.find(item => item.id === current.id) || current : null);
        setPreviewEmail(current => current ? mapped.find(item => item.id === current.id) || current : null);
      }
    } catch (error) {
      if (!isCurrent()) return;
      setLoadError(true);
      console.error("Error loading emails:", error);
    } finally {
      if (isCurrent()) setIsLoading(false);
    }
  }, [scope.threadId, requestScope]);

  useContentLibraryRefresh(scope.refreshKey ?? 0, () => { void loadEmails(); });

  useEffect(() => {
    loadEmails();
  }, [loadEmails]);

  useEffect(() => {
    const unsub = subscribe('content_asset_updated', (data) => {
      if (data.type === 'email_template') {
        loadEmails();
      }
    });
    return unsub;
  }, [subscribe, loadEmails]);

  const handleGenerate = async () => {
    // The ref closes the same-render duplicate-click window before React disables the button.
    if (generationRef.current || isEnhancing) return;
    if (!brandToolkitId || !businessProfileId) {
      toast({ title: "Brand context required", description: missingMessage || "Complete your business profile and Brand Toolkit.", variant: "destructive" });
      return;
    }
    if (!prompt.trim()) {
      toast({ title: "Error", description: "Please enter a prompt", variant: "destructive" });
      return;
    }

    const attempt: EmailGenerationAttempt = { controller: new AbortController() };
    generationRef.current = attempt;
    const session = creatorSessionScope();
    const isCurrent = () => generationRef.current === attempt && !attempt.controller.signal.aborted && requestScopeRef.current === requestScope && creatorSessionScope() === session;
    attempt.timeout = setTimeout(() => {
      if (isCurrent()) stopWaiting(EMAIL_WAIT_TIMED_OUT);
    }, EMAIL_GENERATION_WAIT_MS);
    setSubmittedPrompt(prompt.trim());
    setGenerationError(undefined);
    setIsGenerating(true);
    try {
      // Generate exactly the prompt the user reviewed. Enhancement is an explicit action.
      const enhancedPrompt = prompt;

      const fullPrompt = `${enhancedPrompt}\n\nEmail type: ${emailType}\nTone: ${tone}${targetAudience ? `\nTarget audience: ${targetAudience}` : ""}${ctaText ? `\nCTA: ${ctaText}` : ""}${includeHashtags ? "\nInclude relevant hashtags" : ""}${includeEmojis ? "\nInclude emojis" : ""}`;

      const response = await api.post<{
        success: boolean;
        subject?: string;
        body?: string;
        html?: string;
        content?: string;
        assetId?: number;
        persisted?: boolean;
        error?: string;
      }>("/api/content/studio/email", {
        prompt: fullPrompt,
        tone,
        ...generationContext,
        brandToolkitId,
        businessProfileId,
        ...(ctaText.trim() ? { cta: ctaText.trim() } : {}),
      }, { signal: attempt.controller.signal });
      if (!isCurrent()) return;

      if (response.success) {
        if (response.persisted === false || !Number.isSafeInteger(response.assetId) || Number(response.assetId) <= 0) {
          throw new EmailGenerationRecoveryError(EMAIL_SAVE_UNCONFIRMED);
        }
        const email = readEmailDraft(response.content || response);
        if (!email.subject.trim() || !email.body.trim()) {
          throw new EmailGenerationRecoveryError('The AI provider returned an invalid email. Check email templates before generating again.');
        }
        const newEmail: GeneratedEmail = {
          id: response.assetId ? `db-${response.assetId}` : `gen-${Date.now()}`,
          title: email.subject || `Generated Email`,
          subject: email.subject,
          preheader: email.preheader,
          body: email.body,
          html: email.html,
          createdAt: Date.now(),
          category: emailType,
          tone,
        };
        refreshContent();
        setEmails((prev) => [newEmail, ...prev]);
        setCurrentEmail(newEmail);
        setNewlyCreatedEmailId(newEmail.id);
        toast({ title: "Template created", description: "Your new email template is highlighted at the top." });
      } else {
        throw new ApiError('Email generation failed', 502, response);
      }
    } catch (error) {
      if (!isCurrent()) return;
      const description = emailGenerationErrorMessage(error);
      setGenerationError(description);
      toast({
        title: "Error",
        description,
        variant: "destructive",
      });
    } finally {
      clearTimeout(attempt.timeout);
      if (isCurrent()) {
        generationRef.current = null;
        setIsGenerating(false);
      }
    }
  };

  const handleEnhancePrompt = async () => {
    if (!prompt.trim() || isEnhancing || isGenerating) return;
    setIsEnhancing(true);
    try {
      const response = await api.post<{
        success: boolean;
        enhancedPrompt: string;
      }>("/api/content/studio/magic-prompt", {
        currentPrompt: prompt,
        contentType: "email",
        ...generationContext,
        brandToolkitId,
        businessProfileId,
      });
      if (response.success && response.enhancedPrompt) {
        proposeEnhancement(response.enhancedPrompt);
        toast({ title: "Enhancement ready", description: "Compare the suggestion and apply it when ready." });
      }
    } catch {
      toast({ title: "Error", description: "Failed to enhance prompt", variant: "destructive" });
    } finally {
      setIsEnhancing(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (id.startsWith("db-")) {
      const dbId = parseInt(id.replace("db-", ""), 10);
      if (!isNaN(dbId)) {
        try {
          await api.delete(`/api/content/assets/${dbId}`);
        } catch {
          toast({ title: "Error", description: "Failed to delete", variant: "destructive" });
          return;
        }
      }
    }
    refreshContent();
    setEmails((prev) => prev.filter((e) => e.id !== id));
    setCurrentEmail(previous => previous?.id === id ? null : previous);
    setPreviewEmail(previous => previous?.id === id ? null : previous);
    toast({ title: "Deleted", description: "Email template removed" });
  };

  const handleCopySubject = async (email: GeneratedEmail) => {
    try {
      await copyText(email.subject);
      setCopiedId(email.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast({ title: "Could not copy", description: "Clipboard access was denied. Select and copy the text manually.", variant: "destructive" });
    }
  };

  const handleCopyBody = async (email: GeneratedEmail) => {
    try {
      await copyText(email.body);
      setCopiedId(email.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast({ title: "Could not copy", description: "Clipboard access was denied. Select and copy the text manually.", variant: "destructive" });
    }
  };

  const handleDownload = (email: GeneratedEmail) => {
    const content = `Subject: ${email.subject}\n\n${email.body}`;
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `email-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const truncateText = (text: string, maxLength: number) => {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + "...";
  };

  const filteredEmails = emails.filter((email) => {
    const query = searchQuery.toLowerCase();
    return (
      email.title.toLowerCase().includes(query) ||
      JSON.stringify(email).toLowerCase().includes(query) ||
      (email.category && email.category.toLowerCase().includes(query)) ||
      (email.tone && email.tone.toLowerCase().includes(query))
    );
  });

  const activeEmail = currentEmail;
  const emailPreview: CreatorPreviewModel = {
    format: "email",
    // A failed retry keeps the previous email on screen; the error is shown alongside it.
    status: isGenerating ? "generating" : activeEmail ? "ready" : generationError ? "failed" : "empty",
    submittedPrompt,
    error: generationError,
    title: activeEmail?.title,
    subject: activeEmail?.subject,
    preheader: activeEmail?.preheader,
    body: activeEmail?.body || "",
    html: activeEmail?.html,
  };

  return (
    <ContentCreatorShell>
      {/* Header */}
      <ContentCreatorHeader>
        <div className="mb-3">
          <button onClick={() => { stopWaiting(); router.push("/dashboard/saved-templates/email"); }} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-3.5 w-3.5 rotate-180" /> Email templates
          </button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:items-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background">
              <Mail className="h-5 w-5 text-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">Email generation</h1>
              <p className="text-sm text-muted-foreground">Create professional email templates with AI</p>
            </div>
          </div>
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <SearchInput
              size="sm"
              aria-label="Search emails"
              placeholder="Search emails..."
              value={searchQuery}
              onValueChange={setSearchQuery}
              wrapperClassName="flex-1 sm:w-[200px] sm:flex-none"
            />
            <div className="inline-flex items-center rounded-lg border border-border bg-background p-1">
              <button
                aria-label="Grid view"
                aria-pressed={viewMode === "grid"}
                onClick={() => setViewMode("grid")}
                className={`p-1.5 rounded-md transition-colors ${viewMode === "grid" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              >
                <Grid3X3 className="h-4 w-4" />
              </button>
              <button
                aria-label="List view"
                aria-pressed={viewMode === "list"}
                onClick={() => setViewMode("list")}
                className={`p-1.5 rounded-md transition-colors ${viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
            <Button variant="outline" size="sm" onClick={loadEmails} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 mr-1.5 ${isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </ContentCreatorHeader>

      {/* Main Content - Split Panel */}
      <ContentCreatorBody recentCount={filteredEmails.length}>
        {/* Left Panel - Generation Controls */}
        <ContentCreatorComposer>
          <div className="flex-1 space-y-5 p-4 sm:p-5">
            <GeneratorModeSwitch mode={generationMode} onChange={setGenerationMode} manualLabel="Write an email" />
              <ManualContentComposer
                active={generationMode === "manual"}
                onDraftChange={setManualDraft}
                assetType="email_template"
                channel="email"
                returnHref="/dashboard/saved-templates/email"
                contentLabel="Email body"
                contentPlaceholder="Write the greeting, message, and call to action…"
                uploadLabel="Email image"
                accept="image/*"
                onCreated={() => void loadEmails()}
              />
            {generationMode === "ai" && (
            <div className="contents">
            {/* Prompt */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="email-prompt" className="text-sm font-medium">Email Prompt</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleEnhancePrompt}
                  loading={isEnhancing}
                  loadingText="Enhancing…"
                  disabled={isGenerating || !prompt.trim()}
                  className="h-7 text-xs text-primary hover:bg-primary/8 hover:text-primary"
                >
                  <Wand2 className="w-3.5 h-3.5 mr-1" /> Enhance
                </Button>
              </div>
              <Textarea
                    id="email-prompt"
                placeholder="Enter a prompt for the email you want to create. E.g., Write a cold outreach email for a SaaS product targeting marketing managers..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={5}
                className="resize-none text-sm"
              />
            </div>
            {enhancementReview}

            {/* Email Type */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Email Type</Label>
              <Select value={emailType} onValueChange={setEmailType}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMAIL_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Settings Toggle */}
            <button
              aria-expanded={showSettings}
                onClick={() => setShowSettings(!showSettings)}
              className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors w-full"
            >
              <Settings2 className="w-4 h-4" />
              Additional Settings
              <ChevronDown className={`w-4 h-4 ml-auto transition-transform ${showSettings ? "rotate-180" : ""}`} />
            </button>

            {showSettings && (
              <div className="space-y-4 bg-muted/30 rounded-lg p-4">
                {/* Tone */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Tone</Label>
                  <Select value={tone} onValueChange={setTone}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TONES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Target Audience */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Target Audience (optional)</Label>
                  <Input
                    placeholder="E.g., Marketing managers at SaaS companies"
                    value={targetAudience}
                    onChange={(e) => setTargetAudience(e.target.value)}
                    className="text-sm"
                  />
                </div>

                {/* CTA Text */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Call-to-Action Text (optional)</Label>
                  <Input
                    placeholder="E.g., Schedule a demo, Start free trial"
                    value={ctaText}
                    onChange={(e) => setCtaText(e.target.value)}
                    className="text-sm"
                  />
                </div>

                {/* Include Hashtags */}
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="includeHashtags"
                    checked={includeHashtags}
                    onCheckedChange={(checked) => setIncludeHashtags(checked === true)}
                  />
                  <Label htmlFor="includeHashtags" className="text-xs font-medium cursor-pointer">
                    Include Hashtags
                  </Label>
                </div>

                {/* Include Emojis */}
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="includeEmojis"
                    checked={includeEmojis}
                    onCheckedChange={(checked) => setIncludeEmojis(checked === true)}
                  />
                  <Label htmlFor="includeEmojis" className="text-xs font-medium cursor-pointer">
                    Include Emojis
                  </Label>
                </div>
              </div>
            )}

            {/* Generate Button */}
            <GenerationEstimate />
            <Button
              data-creator-action
              onClick={handleGenerate}
              loading={isGenerating}
              loadingText="Generating..."
              disabled={isEnhancing || !prompt.trim()}
              className="h-11 w-full"
              size="lg"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Generate Email
            </Button>
            {isGenerating && <Button type="button" variant="outline" onClick={() => stopWaiting(EMAIL_WAIT_CANCELLED)} className="w-full">Stop waiting</Button>}
            </div>
            )}
          </div>
        </ContentCreatorComposer>

        {/* Right Panel - Gallery */}
        <ContentCreatorStage preview={<CreatorPreview model={generationMode === "manual" ? manualDraftPreview("email", manualDraft) : emailPreview} />} recentCount={filteredEmails.length} searchQuery={searchQuery}>
          <CreatorResultsPane>
          {loadError && <Callout tone="danger" className="mb-4" actions={<Button variant="outline" size="sm" onClick={loadEmails}>Retry loading emails</Button>}>Email templates could not be loaded.</Callout>}
          {isLoading ? (
            <div className="grid grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-48 rounded-xl bg-muted animate-pulse" />
              ))}
            </div>
          ) : loadError ? null : filteredEmails.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="p-6 rounded-2xl bg-muted/50 mb-4">
                <Mail className="w-12 h-12 text-muted-foreground/50" />
              </div>
              <h3 className="text-lg font-medium mb-1">No emails yet</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Enter a prompt and click Generate to create your first AI email template
              </p>
            </div>
          ) : viewMode === "grid" ? (
            <MasonryGrid columns={2}>
              {filteredEmails.map((email) => (
                <EmailCard
                  onHireAgent={scope.onHireAgent}
                  key={email.id}
                  id={email.id.startsWith("db-") ? parseInt(email.id.replace("db-", ""), 10) : undefined}
                  title={email.title || "Untitled Email"}
                  subject={email.subject}
                  content={email.body}
                  htmlContent={email.html}
                  createdAt={email.createdAt}
                  isNew={email.id === newlyCreatedEmailId}
                  onDelete={() => handleDelete(email.id)}
                  onEdit={() => setPreviewEmail(email)}
                />
              ))}
            </MasonryGrid>
          ) : (
            <div className="space-y-2">
              {filteredEmails.map((email) => (
                <Card
                  key={email.id}
                  className={`group hover:shadow-md transition-all cursor-pointer ${email.id === newlyCreatedEmailId ? "ring-2 ring-emerald-400/70" : ""}`}
                  onClick={() => setPreviewEmail(email)}
                >
                  <CardContent className="p-3 flex items-start gap-4">
                    <div className="p-2 bg-orange-100 dark:bg-orange-900/30 rounded-lg flex-shrink-0">
                      <Mail className="w-5 h-5 text-orange-600 dark:text-orange-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{email.subject || "No Subject"}</p>
                        {email.id === newlyCreatedEmailId && <Badge className="bg-emerald-600 text-white text-[10px] py-0">New</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{truncateText(email.body, 100)}</p>
                      <div className="flex items-center gap-2 mt-1">
                        {email.category && <Badge variant="outline" className="text-xs py-0">{email.category}</Badge>}
                        {email.tone && <Badge variant="outline" className="text-xs py-0">{email.tone}</Badge>}
                        <span className="text-xs text-muted-foreground">{new Date(email.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Copy subject" onClick={(e) => { e.stopPropagation(); handleCopySubject(email); }}>
                        {copiedId === email.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Download draft" onClick={(e) => { e.stopPropagation(); handleDownload(email); }}>
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                      <DeleteDraftAction onDelete={() => handleDelete(email.id)} />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}


          </CreatorResultsPane>
        </ContentCreatorStage>
      </ContentCreatorBody>

      {/* Full-screen Preview Dialog */}
      <Dialog open={!!previewEmail} onOpenChange={() => setPreviewEmail(null)}>
        <DialogContent className="max-w-3xl p-0 overflow-hidden">
          <DialogTitle className="sr-only">Email preview</DialogTitle>
          <DialogDescription className="sr-only">Review saved content before using it.</DialogDescription>
          {previewEmail && (
            <div className="flex flex-col">
              <div className="bg-card border-b px-6 py-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold">{previewEmail.subject || "No Subject"}</h3>
                    <div className="flex items-center gap-2 mt-1">
                      {previewEmail.category && <Badge variant="outline">{previewEmail.category}</Badge>}
                      {previewEmail.tone && <Badge variant="outline">{previewEmail.tone}</Badge>}
                      <span className="text-xs text-muted-foreground">{new Date(previewEmail.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => handleCopySubject(previewEmail)}>
                      {copiedId === previewEmail.id ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                      Copy Subject
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleCopyBody(previewEmail)}>
                      <FileText className="h-4 w-4 mr-1" />
                      Copy Body
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleDownload(previewEmail)}>
                      <Download className="h-4 w-4 mr-1" />
                      Download
                    </Button>
                  </div>
                </div>
              </div>
              <div className="p-6 bg-background max-h-[60vh] overflow-y-auto">
                {previewEmail.html ? (
                  <div
                    className="prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: sanitizeEmailPreviewHtml(previewEmail.html) }}
                  />
                ) : (
                  <div className="whitespace-pre-wrap text-sm">{previewEmail.body}</div>
                )}

                {/* Media Manager */}
                {previewEmail.id.startsWith("db-") && (
                  <div className="mt-4 pt-4 border-t">
                    <MediaManager
                      threadId={scope.threadId}
                      images={previewEmail.imageUrls || []}
                      videos={previewEmail.videoUrls || []}
                      assetId={previewEmail.id}
                      onMediaChange={(imageUrls, videoUrls) => {
                        const update = (item: GeneratedEmail) => item.id === previewEmail.id ? { ...item, imageUrls, videoUrls } : item;
                        setEmails(items => items.map(update));
                        setPreviewEmail(item => item ? update(item) : item);
                        setCurrentEmail(item => item ? update(item) : item);
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </ContentCreatorShell>
  );
}
