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
import { useDmOutreach } from "@/components/content-studio/useDmOutreach";
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
import { useContentBrandContext } from "@/hooks/use-content-brand-context";
import {
  MessageCircle,
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
  Send,
} from "lucide-react";
import { ContentFullscreenModal } from "@/components/modals";
import { SocialMessageCard } from "@/components/content-cards";
import { ContentCreatorBody, ContentCreatorComposer, ContentCreatorHeader, ContentCreatorShell, ContentCreatorStage, CreatorResultsPane } from "@/components/content-studio/ContentCreatorShell";
import { CreatorPreview, manualDraftPreview, type CreatorPreviewModel } from "@/components/content-studio/CreatorPreview";
import { MasonryGrid } from "@/components/ui/masonry-grid";

interface GeneratedDm {
  id: string;
  title: string;
  message: string;
  platform: string;
  createdAt: number;
  category?: string;
  tone?: string;
}

const DM_TYPES = [
  { value: "cold-outreach", label: "Cold Outreach" },
  { value: "follow-up", label: "Follow-up" },
  { value: "engagement", label: "Engagement" },
  { value: "collaboration", label: "Collaboration" },
  { value: "thank-you", label: "Thank You" },
  { value: "re-engagement", label: "Re-engagement" },
];

const TONES = [
  { value: "professional", label: "Professional" },
  { value: "casual", label: "Casual" },
  { value: "friendly", label: "Friendly" },
  { value: "formal", label: "Formal" },
  { value: "playful", label: "Playful" },
];

const DM_PLATFORMS = [
  { value: "all", label: "All social platforms" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook Messenger" },
  { value: "twitter", label: "Twitter/X" },
  { value: "whatsapp", label: "WhatsApp" },
];

export default function DmCreator() {
  const scope = useCreatorScope();
  useContentLibraryRefresh(scope.refreshKey ?? 0, () => { void loadMessages(); });
  const refreshContent = useRefreshContentLibrary();
  const generationContext = creatorGenerationContext(scope);
  const router = useRouter();
  const { openOutreach, destinationDialog } = useDmOutreach();
  const { toast } = useToast();
  const { brandToolkitId, businessProfileId, missingMessage } = useContentBrandContext();
  const { subscribe } = useWebSocket();

  // Generation settings
  const { prompt, setPrompt, proposeEnhancement, enhancementReview } = useCreatorPrompt("dm");
  const [platform, setPlatform] = useState("all");
  const [dmType, setDmType] = useState("cold-outreach");
  const [tone, setTone] = useState("professional");
  const [recipientName, setRecipientName] = useState("");
  const [recipientContext, setRecipientContext] = useState("");
  const [includeHashtags, setIncludeHashtags] = useState(false);
  const [includeEmojis, setIncludeEmojis] = useState(false);

  // UI state
  const [isGenerating, setIsGenerating] = useState(false);
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const [generationError, setGenerationError] = useState<string | undefined>();
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [messages, setMessages] = useState<GeneratedDm[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [showSettings, setShowSettings] = useState(false);
  const [generationMode, setGenerationMode] = useState<GeneratorMode>("ai");
  const [manualDraft, setManualDraft] = useState<ManualDraft>({ title: "", subject: "", description: "", content: "" });
  const [previewMessage, setPreviewMessage] = useState<GeneratedDm | null>(null);
  const [currentMessage, setCurrentMessage] = useState<GeneratedDm | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");


  useEffect(() => {
    loadMessages();
  }, []);

  useEffect(() => {
    const unsub = subscribe('content_asset_updated', (data) => {
      if (data.type === 'social_dm') {
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
      }>>(creatorAssetUrl("social_dm", scope));

      if (Array.isArray(response)) {
        const mapped: GeneratedDm[] = response
          .filter((a) => a.type === "social_dm")
          .map((asset) => {
            const perf = asset.performance || {};
            let parsedContent: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(asset.content);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                parsedContent = parsed as Record<string, unknown>;
              }
            } catch {
              // Plain-text DMs remain supported.
            }
            return {
              id: `db-${asset.id}`,
              title: asset.title,
              message: String(parsedContent.message || parsedContent.content || parsedContent.body || asset.content),
              platform: String(parsedContent.platform || perf.platform || "unknown"),
              createdAt: new Date(asset.createdAt).getTime(),
              category: (perf.category as string) || undefined,
              tone: (perf.tone as string) || undefined,
            };
          });
        setMessages(mapped);
        setCurrentMessage(current => current ? mapped.find(item => item.id === current.id) || current : null);
        setPreviewMessage(current => current ? mapped.find(item => item.id === current.id) || current : null);
      }
    } catch (error) {
      setLoadError(true);
      console.error("Error loading DM templates:", error);
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

      let fullPrompt = `${enhancedPrompt}\n\nDM type: ${dmType}\nTone: ${tone}`;
      if (recipientName) fullPrompt += `\nRecipient name: ${recipientName}`;
      if (recipientContext) fullPrompt += `\nContext about recipient: ${recipientContext}`;
      if (includeHashtags) fullPrompt += "\nInclude relevant hashtags";
      if (includeEmojis) fullPrompt += "\nInclude emojis";

      const response = await api.post<{
        success: boolean;
        message?: string;
        content?: string;
        assetId?: number;
        error?: string;
      }>("/api/content/studio/social-message", {
        prompt: fullPrompt,
        platform,
        ...generationContext,
        brandToolkitId,
        businessProfileId,
      });

      if (response.success) {
        if (!Number.isSafeInteger(response.assetId) || Number(response.assetId) <= 0) {
          throw new Error("Generation returned without a confirmed saved draft. Check the library before generating again.");
        }
        const newMessage: GeneratedDm = {
          id: response.assetId ? `db-${response.assetId}` : `gen-${Date.now()}`,
          title: "Generated DM",
          message: response.message || response.content || "",
          platform,
          createdAt: Date.now(),
          category: dmType,
          tone,
        };
        setCurrentMessage(newMessage);
        refreshContent();
        setMessages(previous => [newMessage, ...previous.filter(message => message.id !== newMessage.id)]);
        toast({ title: "Success", description: "DM template generated successfully" });
      } else {
        setGenerationError(response.error || "Generation failed. Try again.");
        toast({
          title: "Generation Failed",
          description: response.error || "Failed to generate DM",
          variant: "destructive",
        });
      }
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Generation failed. Try again.");
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to generate DM",
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
        contentType: "social_dm",
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
    toast({ title: "Deleted", description: "DM template removed" });
  };

  const handleCopyMessage = async (message: GeneratedDm) => {
    try {
      await copyText(message.message);
      setCopiedId(message.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast({ title: "Could not copy", description: "Clipboard access was denied. Select and copy the text manually.", variant: "destructive" });
    }
  };

  const handleDownload = (message: GeneratedDm) => {
    const blob = new Blob([message.message], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dm-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const getPlatformIcon = (platform: string) => {
    switch (platform) {
      default: return <MessageCircle className="w-4 h-4" />;
    }
  };

  const getPlatformColor = (_platform: string) => {
    return "bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400";
  };

  const getPlatformLabel = (platform: string) => {
    if (!platform || platform === "all" || platform === "unknown" || platform === "multi-platform") {
      return "All Platforms";
    }
    const labels: Record<string, string> = {
      facebook: "Facebook",
      instagram: "Instagram",
      linkedin: "LinkedIn",
      twitter: "Twitter/X",
    };
    return labels[platform] || platform.charAt(0).toUpperCase() + platform.slice(1);
  };

  const filteredMessages = messages.filter((message) => {
    const query = searchQuery.toLowerCase();
    return (
      message.message.toLowerCase().includes(query) ||
      (message.category && message.category.toLowerCase().includes(query)) ||
      (message.tone && message.tone.toLowerCase().includes(query)) ||
      message.platform.toLowerCase().includes(query)
    );
  });

  const activeMessage = currentMessage;
  const dmPreview: CreatorPreviewModel = {
    format: "dm",
    status: isGenerating ? "generating" : generationError ? "failed" : activeMessage ? "ready" : "empty",
    submittedPrompt,
    error: generationError,
    title: activeMessage?.title,
    message: activeMessage?.message || "",
    platform: activeMessage?.platform,
  };

  return (
    <ContentCreatorShell>
      {/* Header */}
      <ContentCreatorHeader>
        <div className="mb-3">
          <button onClick={() => router.push("/dashboard/saved-templates/dm")} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-3.5 w-3.5 rotate-180" /> Social DM templates
          </button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:items-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background">
              <MessageCircle className="h-5 w-5 text-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">DM generation</h1>
              <p className="text-sm text-muted-foreground">Create personalized DM templates with AI</p>
            </div>
          </div>
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <SearchInput
              size="sm"
              aria-label="Search DMs"
              placeholder="Search DMs..."
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
            <GeneratorModeSwitch mode={generationMode} onChange={setGenerationMode} manualLabel="Write a DM" />
            <div className="space-y-2">
              <Label className="text-xs font-medium">Messaging platform</Label>
              <Select value={platform} onValueChange={setPlatform}>
                <SelectTrigger className="h-9" aria-label="Messaging platform"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DM_PLATFORMS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
              <ManualContentComposer
                active={generationMode === "manual"}
                onDraftChange={setManualDraft}
                assetType="social_dm"
                channel={platform}
                returnHref="/dashboard/saved-templates/dm"
                contentLabel="Direct message"
                contentPlaceholder="Write the greeting, message, and next step…"
                uploadLabel="Image or video attachment"
                onCreated={() => void loadMessages()}
                buildStoredContent={({ title, description, content }) => ({
                  title,
                  subject: title,
                  message: content,
                  description,
                  platform,
                  origin: "manual",
                })}
              />
            {generationMode === "ai" && (
            <div className="contents">
            {/* Prompt */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="dm-prompt" className="text-sm font-medium">DM Prompt</Label>
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
                    id="dm-prompt"
                placeholder="Enter a prompt for the DM you want to create. E.g., Write a cold outreach DM to a prospect who posted about a product launch..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                className="resize-none text-sm"
              />
            </div>
            {enhancementReview}



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
                {/* DM Type */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">DM Type</Label>
                  <Select value={dmType} onValueChange={setDmType}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DM_TYPES.map((type) => (
                        <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

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

                {/* Recipient Name */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Recipient Name (optional)</Label>
                  <Input
                    placeholder="e.g., John"
                    value={recipientName}
                    onChange={(e) => setRecipientName(e.target.value)}
                    className="text-sm"
                  />
                </div>

                {/* Recipient Context */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">About the Recipient (optional)</Label>
                  <Textarea
                    placeholder="e.g., Marketing manager at a SaaS company, posted about their product launch..."
                    value={recipientContext}
                    onChange={(e) => setRecipientContext(e.target.value)}
                    rows={2}
                    className="resize-none text-sm"
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
              Generate DM
            </Button>
            </div>
            )}
          </div>
        </ContentCreatorComposer>

        {/* Right Panel - Gallery */}
        <ContentCreatorStage preview={<CreatorPreview model={generationMode === "manual" ? manualDraftPreview("dm", manualDraft, platform) : dmPreview} />} recentCount={filteredMessages.length} searchQuery={searchQuery}>
          <CreatorResultsPane>
          {loadError && <Callout tone="danger" className="mb-4" actions={<Button variant="outline" size="sm" onClick={loadMessages}>Retry loading direct messages</Button>}>Direct messages could not be loaded.</Callout>}
          {isLoading ? (
            <div className="grid grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-40 rounded-xl bg-muted animate-pulse" />
              ))}
            </div>
          ) : loadError ? null : filteredMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="p-6 rounded-2xl bg-muted/50 mb-4">
                <MessageCircle className="w-12 h-12 text-muted-foreground/50" />
              </div>
              <h3 className="text-lg font-medium mb-1">No DMs yet</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Enter a prompt and click Generate to create your first AI DM template
              </p>
            </div>
          ) : viewMode === "grid" ? (
            <MasonryGrid columns={2}>
              {filteredMessages.map((message) => (
                <SocialMessageCard
                  onHireAgent={scope.onHireAgent}
                  key={message.id}
                  id={message.id.startsWith("db-") ? parseInt(message.id.replace("db-", ""), 10) : undefined}
                  title={message.title || "Generated direct message"}
                  content={message.message}
                  platform={message.platform}
                  createdAt={new Date(message.createdAt).toISOString()}
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
                    <div className={`p-2 rounded-lg flex-shrink-0 ${getPlatformColor(message.platform)}`}>
                      {getPlatformIcon(message.platform)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm line-clamp-2">{message.message}</p>
                      <div className="flex items-center gap-2 mt-1">
                        {message.category && <Badge variant="outline" className="text-xs py-0">{message.category}</Badge>}
                        {message.tone && <Badge variant="outline" className="text-xs py-0">{message.tone}</Badge>}
                        <span className="text-xs text-muted-foreground">{getPlatformLabel(message.platform)}</span>
                        <span className="text-xs text-muted-foreground">{new Date(message.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-primary" onClick={(e) => {
                        e.stopPropagation();
                        openOutreach(message.message, message.platform);
                      }} title="Use in outreach" aria-label="Use in outreach">
                        <Send className="h-3.5 w-3.5" />
                      </Button>
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
      <ContentFullscreenModal
        open={!!previewMessage}
        onOpenChange={(open) => { if (!open) setPreviewMessage(null); }}
        contentType="social_message"
        title={previewMessage?.title || "DM Template"}
        content={previewMessage ? JSON.stringify({
          message: previewMessage.message,
        }) : ""}
        platform={previewMessage?.platform || "all"}
        createdAt={previewMessage?.createdAt}
        customActions={previewMessage ? (
          <>
            <Button variant="outline" size="sm" onClick={() => handleDownload(previewMessage)}>
              <Download className="h-4 w-4 mr-1" />
              Download
            </Button>
            <Button size="sm" onClick={() => {
              openOutreach(previewMessage.message, previewMessage.platform);
              setPreviewMessage(null);
            }}>
              <Send className="h-4 w-4 mr-1" />
              Use in outreach
            </Button>
          </>
        ) : null}
      />

      {destinationDialog}
    </ContentCreatorShell>
  );
}
