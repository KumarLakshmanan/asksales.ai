"use client";

import { useContentLibraryRefresh } from "@/hooks/useContentLibraryRefresh";

import { useRefreshContentLibrary } from "@/hooks/use-content-counts";
import { useCreatorScope, creatorAssetUrl, creatorGenerationContext } from "../CreatorScope";

import { useState, useEffect } from "react";
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
import { useContentBrandContext } from "@/hooks/use-content-brand-context";
import {
  MessageSquare,
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
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import MediaManager from "@/components/MediaManager";
import { SmsCard } from "@/components/content-cards";
import { MasonryGrid } from "@/components/ui/masonry-grid";
import { ContentCreatorBody, ContentCreatorComposer, ContentCreatorHeader, ContentCreatorShell, ContentCreatorStage, CreatorResultsPane } from "@/components/content-studio/ContentCreatorShell";
import { CreatorPreview, manualDraftPreview, type CreatorPreviewModel } from "@/components/content-studio/CreatorPreview";
import { contentAssetSmsMessage } from "@/lib/contentAssetMapping";
import { calculateSmsMetrics } from "@/lib/smsMetrics";
import { SmsSendingEstimate } from "@/components/content-studio/SmsSendingEstimate";

interface GeneratedSms {
  id: string;
  title: string;
  message: string;
  createdAt: number;
  category?: string;
  tone?: string;
  segmentCount?: number;
  maxCharacters?: number;
  imageUrls?: string[];
  videoUrls?: string[];
}

const SMS_TYPES = [
  { value: "promotional", label: "Promotional" },
  { value: "transactional", label: "Transactional" },
  { value: "follow-up", label: "Follow-up" },
  { value: "reminder", label: "Reminder" },
  { value: "appointment", label: "Appointment" },
  { value: "confirmation", label: "Confirmation" },
  { value: "thank-you", label: "Thank You" },
];

const TONES = [
  { value: "professional", label: "Professional" },
  { value: "casual", label: "Casual" },
  { value: "friendly", label: "Friendly" },
  { value: "urgent", label: "Urgent" },
  { value: "formal", label: "Formal" },
];

const calculateSegments = (text: string): number => {
  return calculateSmsMetrics(text).segments;
};

export default function SmsCreator() {
  const scope = useCreatorScope();
  useContentLibraryRefresh(scope.refreshKey ?? 0, () => { void loadMessages(); });
  const refreshContent = useRefreshContentLibrary();
  const generationContext = creatorGenerationContext(scope);
  const router = useRouter();
  const { toast } = useToast();
  const { brandToolkitId, businessProfileId, missingMessage } = useContentBrandContext();
  const { subscribe } = useWebSocket();

  // Generation settings
  const { prompt, setPrompt, proposeEnhancement, enhancementReview } = useCreatorPrompt("sms");
  const [smsType, setSmsType] = useState("promotional");
  const [tone, setTone] = useState("professional");
  const [includeOptOut, setIncludeOptOut] = useState(true);
  const [includeHashtags, setIncludeHashtags] = useState(false);
  const [includeEmojis, setIncludeEmojis] = useState(false);
  const [maxLength, setMaxLength] = useState("160");

  // UI state
  const [isGenerating, setIsGenerating] = useState(false);
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const [generationError, setGenerationError] = useState<string | undefined>();
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [messages, setMessages] = useState<GeneratedSms[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [showSettings, setShowSettings] = useState(false);
  const [generationMode, setGenerationMode] = useState<GeneratorMode>("ai");
  const [manualDraft, setManualDraft] = useState<ManualDraft>({ title: "", subject: "", description: "", content: "" });
  const [previewMessage, setPreviewMessage] = useState<GeneratedSms | null>(null);
  const [currentMessage, setCurrentMessage] = useState<GeneratedSms | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    loadMessages();
  }, []);

  useEffect(() => {
    const unsub = subscribe('content_asset_updated', (data) => {
      if (data.type === 'sms_template') {
        loadMessages();
      }
    });
    return unsub;
  }, [subscribe]);

  const loadMessages = async () => {
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
      }>>(creatorAssetUrl("sms_template", scope));

      if (Array.isArray(response)) {
        const mapped: GeneratedSms[] = response
          .filter((a) => a.type === "sms_template")
          .map((asset) => {
            const perf = asset.performance || {};
            const message = contentAssetSmsMessage(asset.content);
            return {
              id: `db-${asset.id}`,
              title: asset.title,
              message,
              createdAt: new Date(asset.createdAt).getTime(),
              category: (perf.category as string) || undefined,
              tone: (perf.tone as string) || undefined,
              segmentCount: calculateSegments(message),
              maxCharacters: Number(perf.maxCharacters) || 160,
              imageUrls: asset.imageUrls || [],
              videoUrls: asset.videoUrls || [],
            };
          });
        setMessages(mapped);
        setCurrentMessage(current => current ? mapped.find(item => item.id === current.id) || current : null);
        setPreviewMessage(current => current ? mapped.find(item => item.id === current.id) || current : null);
      }
    } catch (error) {
      setLoadError(true);
      console.error("Error loading SMS templates:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!brandToolkitId || !businessProfileId) {
      toast({ title: "Brand context required", description: missingMessage || "Complete your business profile and Brand Toolkit.", variant: "destructive" });
      return;
    }
    if (!prompt.trim()) {
      toast({ title: "Error", description: "Please enter a prompt", variant: "destructive" });
      return;
    }

    setSubmittedPrompt(prompt.trim());
    setGenerationError(undefined);
    setIsGenerating(true);
    try {
      // Generate exactly the prompt the user reviewed. Enhancement is an explicit action.
      const enhancedPrompt = prompt;

      const fullPrompt = `${enhancedPrompt}\n\nSMS type: ${smsType}\nTone: ${tone}\nMax length: ${maxLength} characters${includeOptOut ? "\nInclude opt-out message (Reply STOP to unsubscribe)" : ""}${includeHashtags ? "\nInclude relevant hashtags" : ""}${includeEmojis ? "\nInclude emojis" : ""}`;

      const response = await api.post<{
        success: boolean;
        message?: string;
        content?: string;
        assetId?: number;
        error?: string;
      }>("/api/content/studio/sms", {
        prompt: fullPrompt,
        ...generationContext,
        brandToolkitId,
        businessProfileId,
        maxCharacters: Number(maxLength),
        includeOptOut,
      });

      if (response.success) {
        if (!Number.isSafeInteger(response.assetId) || Number(response.assetId) <= 0) {
          throw new Error("Generation returned without a confirmed saved draft. Check the library before generating again.");
        }
        const message = response.message || response.content || "";
        const newMessage: GeneratedSms = {
          id: response.assetId ? `db-${response.assetId}` : `gen-${Date.now()}`,
          title: `Generated SMS`,
          message,
          createdAt: Date.now(),
          category: smsType,
          tone,
          segmentCount: calculateSegments(message),
          maxCharacters: Number(maxLength),
        };
        refreshContent();
        setMessages((prev) => [newMessage, ...prev]);
        setCurrentMessage(newMessage);
        toast({ title: "Success", description: "SMS template generated successfully" });
      } else {
        setGenerationError(response.error || "Generation failed. Try again.");
        toast({
          title: "Generation Failed",
          description: response.error || "Failed to generate SMS",
          variant: "destructive",
        });
      }
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Generation failed. Try again.");
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to generate SMS",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
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
        contentType: "sms",
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
    setMessages((prev) => prev.filter((m) => m.id !== id));
    setCurrentMessage(previous => previous?.id === id ? null : previous);
    setPreviewMessage(previous => previous?.id === id ? null : previous);
    toast({ title: "Deleted", description: "SMS template removed" });
  };

  const handleCopyMessage = async (message: GeneratedSms) => {
    try {
      await copyText(message.message);
      setCopiedId(message.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast({ title: "Could not copy", description: "Clipboard access was denied. Select and copy the text manually.", variant: "destructive" });
    }
  };

  const handleDownload = (message: GeneratedSms) => {
    const blob = new Blob([message.message], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sms-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const filteredMessages = messages.filter((message) => {
    const query = searchQuery.toLowerCase();
    return (
      message.message.toLowerCase().includes(query) ||
      (message.category && message.category.toLowerCase().includes(query)) ||
      (message.tone && message.tone.toLowerCase().includes(query))
    );
  });

  const activeMessage = currentMessage;
  const smsPreview: CreatorPreviewModel = {
    format: "sms",
    status: isGenerating ? "generating" : generationError ? "failed" : activeMessage ? "ready" : "empty",
    submittedPrompt,
    error: generationError,
    title: activeMessage?.title,
    message: activeMessage?.message || "",
    maxCharacters: activeMessage?.maxCharacters,
  };

  return (
    <ContentCreatorShell>
      {/* Header */}
      <ContentCreatorHeader>
        <div className="mb-3">
          <button onClick={() => router.push("/dashboard/saved-templates/sms")} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-3.5 w-3.5 rotate-180" /> SMS templates
          </button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:items-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background">
              <MessageSquare className="h-5 w-5 text-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">SMS generation</h1>
              <p className="text-sm text-muted-foreground">Create concise SMS templates with AI</p>
            </div>
          </div>
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <SearchInput
              size="sm"
              aria-label="Search SMS"
              placeholder="Search SMS..."
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
            <Button variant="outline" size="sm" onClick={loadMessages} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 mr-1.5 ${isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </ContentCreatorHeader>

      {/* Main Content - Split Panel */}
      <ContentCreatorBody recentCount={filteredMessages.length}>
        {/* Left Panel - Generation Controls */}
        <ContentCreatorComposer>
          <div className="flex-1 space-y-5 p-4 sm:p-5">
            <GeneratorModeSwitch mode={generationMode} onChange={setGenerationMode} manualLabel="Write an SMS" />
              <ManualContentComposer
                active={generationMode === "manual"}
                onDraftChange={setManualDraft}
                assetType="sms_template"
                channel="sms"
                returnHref="/dashboard/saved-templates/sms"
                contentLabel="SMS message"
                contentPlaceholder="Write the message, call to action, and opt-out language…"
                uploadLabel="MMS image"
                accept="image/*"
                onCreated={() => void loadMessages()}
              />
            {generationMode === "ai" && (
            <div className="contents">
            {/* Prompt */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="sms-prompt" className="text-sm font-medium">SMS Prompt</Label>
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
                    id="sms-prompt"
                placeholder="Enter a prompt for the SMS you want to create. E.g., Write a promotional SMS for a flash sale with 50% off..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                className="resize-none text-sm"
              />
            </div>
            {enhancementReview}

            {/* SMS Type */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">SMS Type</Label>
              <Select value={smsType} onValueChange={setSmsType}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SMS_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Maximum draft length</legend>
              <div className="grid grid-cols-2 gap-2">
                {["160", "320"].map(length => <Button key={length} type="button" variant={maxLength === length ? "default" : "outline"} aria-pressed={maxLength === length} onClick={() => setMaxLength(length)}>{length} characters</Button>)}
              </div>
              <p className="text-xs text-muted-foreground">Character length is not the number of billable segments. Unicode, symbols and personalized links can increase segments; 320 GSM-7 characters use 3 segments.</p>
              <SmsSendingEstimate />
            </fieldset>

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

                {/* Include Opt-out */}
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="includeOptOut"
                    checked={includeOptOut}
                    onCheckedChange={(checked) => setIncludeOptOut(checked === true)}
                  />
                  <Label htmlFor="includeOptOut" className="text-xs font-medium cursor-pointer">
                    Include Opt-out (Reply STOP)
                  </Label>
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
              Generate SMS
            </Button>
            </div>
            )}
          </div>
        </ContentCreatorComposer>

        {/* Right Panel - Gallery */}
        <ContentCreatorStage preview={<CreatorPreview model={generationMode === "manual" ? manualDraftPreview("sms", manualDraft) : smsPreview} />} recentCount={filteredMessages.length} searchQuery={searchQuery}>
          <CreatorResultsPane>
          {loadError && <Callout tone="danger" className="mb-4" actions={<Button variant="outline" size="sm" onClick={loadMessages}>Retry loading SMS templates</Button>}>SMS templates could not be loaded.</Callout>}
          {isLoading ? (
            <div className="grid grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-32 rounded-xl bg-muted animate-pulse" />
              ))}
            </div>
          ) : loadError ? null : filteredMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="p-6 rounded-2xl bg-muted/50 mb-4">
                <MessageSquare className="w-12 h-12 text-muted-foreground/50" />
              </div>
              <h3 className="text-lg font-medium mb-1">No SMS templates yet</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Enter a prompt and click Generate to create your first AI SMS template
              </p>
            </div>
          ) : viewMode === "grid" ? (
            <MasonryGrid columns={2}>
              {filteredMessages.map((message) => (
                <SmsCard
                  onHireAgent={scope.onHireAgent}
                  maxCharacters={message.maxCharacters}
                  key={message.id}
                  id={message.id.startsWith("db-") ? parseInt(message.id.replace("db-", ""), 10) : undefined}
                  title={message.title || `SMS - ${new Date(message.createdAt).toLocaleDateString()}`}
                  content={message.message}
                  createdAt={message.createdAt}
                  onDelete={() => handleDelete(message.id)}
                />
              ))}
            </MasonryGrid>
          ) : (
            <div className="space-y-2">
              {filteredMessages.map((message) => (
                <Card
                  key={message.id}
                  className="group hover:shadow-md transition-all cursor-pointer"
                  onClick={() => setPreviewMessage(message)}
                >
                  <CardContent className="p-3 flex items-start gap-4">
                    <div className="p-2 bg-green-100 dark:bg-green-900/30 rounded-lg flex-shrink-0">
                      <MessageSquare className="w-5 h-5 text-green-600 dark:text-green-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm line-clamp-2">{message.message}</p>
                      <div className="flex items-center gap-2 mt-1">
                        {message.category && <Badge variant="outline" className="text-xs py-0">{message.category}</Badge>}
                        {message.tone && <Badge variant="outline" className="text-xs py-0">{message.tone}</Badge>}
                        <Badge variant="outline" className="text-xs py-0">{message.segmentCount} seg</Badge>
                        <span className="text-xs text-muted-foreground">{new Date(message.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Copy text" onClick={(e) => { e.stopPropagation(); handleCopyMessage(message); }}>
                        {copiedId === message.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Download draft" onClick={(e) => { e.stopPropagation(); handleDownload(message); }}>
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                      <DeleteDraftAction onDelete={() => handleDelete(message.id)} />
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
      <Dialog open={!!previewMessage} onOpenChange={() => setPreviewMessage(null)}>
        <DialogContent className="max-w-lg p-0 overflow-hidden">
          <DialogTitle className="sr-only">SMS preview</DialogTitle>
          <DialogDescription className="sr-only">Review saved content before using it.</DialogDescription>
          {previewMessage && (
            <div className="flex flex-col">
              <div className="bg-card border-b px-6 py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {previewMessage.category && <Badge variant="outline">{previewMessage.category}</Badge>}
                    {previewMessage.tone && <Badge variant="outline">{previewMessage.tone}</Badge>}
                    <Badge variant="outline">{previewMessage.segmentCount} segment{previewMessage.segmentCount !== 1 ? "s" : ""}</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => handleCopyMessage(previewMessage)}>
                      {copiedId === previewMessage.id ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                      Copy
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleDownload(previewMessage)}>
                      <Download className="h-4 w-4 mr-1" />
                      Download
                    </Button>
                  </div>
                </div>
              </div>
              <div className="p-6 bg-background">
                {/* Phone Mockup */}
                <div className="mx-auto max-w-[280px]">
                  <div className="bg-black rounded-[2.5rem] p-2 shadow-xl">
                    <div className="overflow-hidden rounded-[2rem] bg-white text-gray-900">
                      {/* Status Bar */}
                      <div className="bg-gray-100 px-4 py-2 flex items-center justify-between text-xs text-gray-600">
                        <span>9:41</span>
                        <div className="flex items-center gap-1">
                          <span>●●●●</span>
                          <span>WiFi</span>
                          <span>100%</span>
                        </div>
                      </div>
                      {/* Messages Header */}
                      <div className="bg-gray-50 px-4 py-2 border-b">
                        <p className="text-xs font-semibold text-center">Messages</p>
                      </div>
                      {/* Message Bubble */}
                      <div className="p-4 min-h-[200px]">
                        <div className="bg-green-500 text-white rounded-2xl rounded-tr-sm px-4 py-3 max-w-[85%]">
                          <p className="text-sm whitespace-pre-wrap">{previewMessage.message}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Media Manager */}
                {previewMessage.id.startsWith("db-") && (
                  <div className="mt-4 pt-4 border-t">
                    <MediaManager
                      threadId={scope.threadId}
                      images={previewMessage.imageUrls || []}
                      videos={previewMessage.videoUrls || []}
                      assetId={previewMessage.id}
                      onMediaChange={(imageUrls, videoUrls) => {
                        const update = (item: GeneratedSms) => item.id === previewMessage.id ? { ...item, imageUrls, videoUrls } : item;
                        setMessages(items => items.map(update));
                        setPreviewMessage(item => item ? update(item) : item);
                        setCurrentMessage(item => item ? update(item) : item);
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
