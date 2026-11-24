'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/loading-state';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import api from '@/lib/api';
import { useOrganicPublishingAccounts } from '@/hooks/useOrganicPublishingAccounts';
import { extractVariables, findUnresolvedTemplateTokens } from '@/utils/templateVariables';
import { SocialPublisher } from '@/components/social-publishing/SocialPublisher';
import { renderApprovedTemplate } from '@/lib/reusableTemplates';
import { scheduledLocalValue } from '@/lib/socialPublishing';
import { DEFAULT_BUSINESS_TIMEZONE } from '@/lib/timezoneDefaults';
import {
  Instagram,
  Facebook,
  Youtube,
  Loader2,
  ImagePlus,
  VideoIcon,
  Wand2,
  FileText,
  Sparkles,
  X,
  Clock,
  Send,
} from 'lucide-react';
import { formatLocalDate as formatDate } from '@/lib/display-format';

// ─── Types ──────────────────────────────────────────────────────────────────────

type Platform = 'instagram' | 'facebook' | 'youtube';
type PostType = 'feed' | 'reel' | 'carousel' | 'video' | 'short' | 'text';

interface CreatePostModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPostCreated: () => void;
  selectedDate?: Date;
}

interface ContentTemplate {
  id: number;
  name: string;
  type: string;
  content: string;
  subject?: string | null;
  category?: string;
  usageCount: number;
  isApproved?: boolean;
  isPredefined?: boolean;
}

interface GenerateSocialResponse {
  success: boolean;
  caption?: string;
  hashtags?: string[];
  error?: string;
}

interface UploadResponse {
  success: boolean;
  url?: string;
  error?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const platformConfig: Record<Platform, { label: string; icon: React.ReactNode; color: string }> = {
  instagram: {
    label: 'Instagram',
    icon: <Instagram className="w-4 h-4" />,
    color: 'bg-gradient-to-r from-purple-500 via-pink-500 to-orange-400 text-white',
  },
  facebook: {
    label: 'Facebook',
    icon: <Facebook className="w-4 h-4" />,
    color: 'bg-blue-600 text-white hover:bg-blue-700',
  },
  youtube: {
    label: 'YouTube',
    icon: <Youtube className="w-4 h-4" />,
    color: 'bg-red-600 text-white hover:bg-red-700',
  },
};

const defaultForm = {
    platforms: ['instagram'] as Platform[],
    postType: 'feed' as PostType,
    title: '',
    caption: '',
    tags: [] as string[],
    imageUrl: '',
    imageUrls: [] as string[],
    videoUrl: '',
    aiPrompt: '',
    templateId: undefined as number | undefined,
    templateVersion: undefined as number | undefined,
    templateIsPredefined: false,
    templateBrandContext: undefined as Record<string, unknown> | undefined,
    publishNow: true,
    scheduledDate: '',
    scheduledTime: '12:00',
    privacyStatus: 'private' as 'public' | 'private' | 'unlisted',
    madeForKids: undefined as boolean | undefined,
    containsSyntheticMedia: undefined as boolean | undefined,
    credentialIds: {} as Partial<Record<Platform, number>>,
    timezone: DEFAULT_BUSINESS_TIMEZONE,
    _pendingImageFiles: [] as File[],
    _pendingVideoFile: null as File | null,
  };

// ─── Component ──────────────────────────────────────────────────────────────────

export default function CreatePostModal({
  open,
  onOpenChange,
  onPostCreated,
  selectedDate,
}: CreatePostModalProps) {
  const { toast } = useToast();
  const [form, setForm] = useState(defaultForm);
  const [reviewAssetId, setReviewAssetId] = useState<number | null>(null);
  const [urlMediaType, setUrlMediaType] = useState<'image' | 'video'>('image');
  const [mediaUrlInput, setMediaUrlInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const savedDraftRef = useRef<{ id: number; fingerprint: string } | null>(null);
  const uploadedFilesRef = useRef(new Map<File, string>());
  const [savedDraftId, setSavedDraftId] = useState<number | null>(null);
  const [creationUncertain, setCreationUncertain] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const previouslyOpen = useRef(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [templates, setTemplates] = useState<ContentTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [pendingTemplate, setPendingTemplate] = useState<ContentTemplate | null>(null);
  const [templateVariables, setTemplateVariables] = useState<Record<string, string>>({});
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  const templateBusy = useRef(false);
  const modalOpen = useRef(open);
  const templateGeneration = useRef(0);
  modalOpen.current = open;
  const [tagInput, setTagInput] = useState('');
  const publishingAccounts = useOrganicPublishingAccounts();
  const connectedPublishingAccounts = publishingAccounts.accounts;
  const preferredAccountForPlatform = publishingAccounts.preferredForPlatform;
  const connectedPlatforms = publishingAccounts.connectedPlatforms;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const updateForm = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const getInitialForm = useCallback(() => {
    return {
      ...defaultForm,
      platforms: ['instagram'] as Platform[],
      tags: [] as string[],
      publishNow: !selectedDate,
      scheduledDate: selectedDate ? formatDate(selectedDate) : '',
      _pendingImageFiles: [] as File[],
      _pendingVideoFile: null,
    };
  }, [selectedDate]);

  useEffect(() => {
    if (previouslyOpen.current === open) return;
    previouslyOpen.current = open;
    templateGeneration.current += 1;
    if (open) {
      savedDraftRef.current = null;
      uploadedFilesRef.current.clear();
      setSavedDraftId(null);
      setReviewAssetId(null);
      setMediaUrlInput('');
      setCreationUncertain(false);
      setPublishError(null);
      setForm((current) => {
        current.imageUrls.filter((url) => url.startsWith('blob:')).forEach(URL.revokeObjectURL);
        if (current.imageUrl.startsWith('blob:')) URL.revokeObjectURL(current.imageUrl);
        if (current.videoUrl.startsWith('blob:')) URL.revokeObjectURL(current.videoUrl);
        return getInitialForm();
      });
      setTagInput('');
      setPendingTemplate(null);
      setTemplateVariables({});
      setTemplatesError(null);
    }
  }, [open, getInitialForm]);

  useEffect(() => {
    setForm((current) => {
      const credentialIds = { ...current.credentialIds };
      let changed = false;
      for (const platform of ['instagram', 'facebook', 'youtube'] as const) {
        const preferred = preferredAccountForPlatform(platform);
        if (!credentialIds[platform] && preferred) {
          credentialIds[platform] = preferred.credentialId;
          changed = true;
        }
      }
      return changed ? { ...current, credentialIds } : current;
    });
  }, [connectedPublishingAccounts, preferredAccountForPlatform]);

  useEffect(() => {
    if (!open || publishingAccounts.loading) return;
    setForm((current) => {
      const visible = current.platforms.filter((platform) => connectedPlatforms.includes(platform));
      if (visible.length) return visible.length === current.platforms.length ? current : { ...current, platforms: visible };
      return connectedPlatforms[0] ? { ...current, platforms: [connectedPlatforms[0]] } : current.platforms.length ? { ...current, platforms: [] } : current;
    });
  }, [connectedPlatforms, open, publishingAccounts.loading]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.get<{ timezone?: string; preferences?: { timezone?: string } }>('/api/settings/preferences').then(preferences => {
      if (!cancelled) setForm(current => ({ ...current, timezone: preferences.timezone || preferences.preferences?.timezone || DEFAULT_BUSINESS_TIMEZONE }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  // ─── Template Loading ─────────────────────────────────────────────────────

  const loadTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    setTemplatesError(null);
    try {
      const data = await api.get<ContentTemplate[] | { templates?: ContentTemplate[] }>('/api/content/templates?type=social');
      setTemplates(Array.isArray(data) ? data : data.templates ?? []);
    } catch (error) {
      setTemplatesError(error instanceof Error ? error.message : 'Templates could not be loaded. Try again.');
    } finally {
      setLoadingTemplates(false);
    }
  }, []);

  const applyReusableTemplate = async (template: ContentTemplate, variables: Record<string, string>) => {
    if (templateBusy.current) return;
    templateBusy.current = true;
    setApplyingTemplate(true);
    const generation = templateGeneration.current;
    try {
      const rendered = await renderApprovedTemplate(template.id, variables);
      if (!modalOpen.current || generation !== templateGeneration.current) return;
      setForm((current) => ({
        ...current,
        templateId: rendered.templateId,
        templateVersion: rendered.templateVersion,
        templateIsPredefined: Boolean(template.isPredefined),
        templateBrandContext: rendered.brandContext,
        caption: rendered.content,
        ...(current.platforms.includes('youtube') && rendered.subject ? { title: rendered.subject } : {}),
      }));
      setPendingTemplate(null);
      setTemplateVariables({});
      toast({ title: 'Template applied', description: `Using template: ${template.name} (version ${rendered.templateVersion})` });
    } catch (error) {
      if (modalOpen.current && generation === templateGeneration.current) toast({
        title: 'Template could not be used',
        description: error instanceof Error ? error.message : 'Review and approve the template first.',
        variant: 'destructive',
      });
    } finally {
      templateBusy.current = false;
      setApplyingTemplate(false);
    }
  };

  const handleTemplateSelect = async (template: ContentTemplate) => {
    if (templateBusy.current) return;
    if (!template.isApproved) {
      toast({
        title: 'Template approval required',
        description: 'Approve this template before using it in a published post.',
        variant: 'destructive',
      });
      return;
    }
    const variables = extractVariables([template.subject, template.content].filter(Boolean).join('\n'));
    if (variables.length > 0) {
      setPendingTemplate(template);
      setTemplateVariables(Object.fromEntries(variables.map((variable) => [variable, ''])));
      return;
    }
    await applyReusableTemplate(template, {});
  };

  // ─── AI Generation ────────────────────────────────────────────────────────

  const templateGenerationContext = () => {
    if (form.templateIsPredefined) return {};
    const provenance = form.templateBrandContext?.provenance as {
      businessProfile?: { id?: number }; brandToolkit?: { id?: number };
    } | undefined;
    return {
      businessProfileId: provenance?.businessProfile?.id,
      brandToolkitId: provenance?.brandToolkit?.id,
    };
  };

  const handleGenerateContent = async () => {
    if (!form.aiPrompt.trim()) {
      toast({ title: 'Error', description: 'Please enter a prompt', variant: 'destructive' });
      return;
    }
    setIsGenerating(true);
    try {
      const data = await api.post('/api/content/studio/social', {
        prompt: form.aiPrompt,
        platform: form.platforms[0],
        postType: form.postType,
        persist: false,
        ...templateGenerationContext(),
      }) as GenerateSocialResponse;

      if (data.success && data.caption?.trim()) {
        updateForm('caption', data.caption);
        if (data.hashtags?.length) updateForm('tags', data.hashtags.map((t) => t.replace('#', '')));
        toast({ title: 'Content generated', description: 'AI content has been generated successfully' });
      } else {
        toast({ title: 'Generation failed', description: data.error || 'Failed to generate content', variant: 'destructive' });
      }
    } catch (_error) {
      toast({ title: 'Error', description: 'Failed to generate content', variant: 'destructive' });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleEnhancePrompt = async () => {
    if (!form.aiPrompt.trim()) return;
    setIsEnhancing(true);
    try {
      const data = await api.post('/api/content/studio/enhance-prompt', {
        prompt: form.aiPrompt,
        platform: form.platforms[0],
        ...templateGenerationContext(),
      }) as { success: boolean; enhancedPrompt?: string; error?: string };
      if (data.success && data.enhancedPrompt) {
        updateForm('aiPrompt', data.enhancedPrompt);
        toast({ title: 'Prompt enhanced', description: 'Your prompt has been improved' });
      } else {
        toast({ title: 'Prompt could not be enhanced', description: data.error || 'The generator returned no enhanced prompt. Please try again.', variant: 'destructive' });
      }
    } catch (error) {
      toast({ title: 'Prompt could not be enhanced', description: error instanceof Error ? error.message : 'Please try again.', variant: 'destructive' });
    } finally {
      setIsEnhancing(false);
    }
  };

  // ─── File Upload ──────────────────────────────────────────────────────────

  const handleFileUpload = (files: File[], type: 'image' | 'video') => {
    if (files.length === 0) return;
    setIsUploading(true);
    try {
      if (type === 'image') {
        const seenFiles = new Set<string>();
        const selectedFiles = files.filter((file) => {
          const identity = `${file.name}:${file.size}:${file.lastModified}`;
          if (seenFiles.has(identity)) return false;
          seenFiles.add(identity);
          return true;
        }).slice(0, form.videoUrl ? 9 : 10);
        const previewUrls = selectedFiles.map((file) => URL.createObjectURL(file));
        setForm((current) => ({
          ...current,
          ...(selectedFiles.length > 1 && current.platforms.length === 1 && current.platforms[0] === 'instagram'
            ? { postType: 'carousel' as PostType }
            : {}),
          imageUrl: previewUrls[0],
          imageUrls: previewUrls,
          _pendingImageFiles: selectedFiles,
        }));
      } else {
        if (form.imageUrls.length >= 10) throw new Error('A carousel supports at most ten images and videos. Remove an image before adding a video.');
        const previewUrl = URL.createObjectURL(files[0]);
        setForm((current) => ({
          ...current,
          videoUrl: previewUrl,
          _pendingVideoFile: files[0],
        }));
      }
      toast({
        title: files.length > 1 ? `${Math.min(files.length, 10)} files selected` : 'File selected',
        description: `${type}${files.length > 1 ? 's' : ''} will be uploaded when the post is created`,
      });
    } catch (_error) {
      toast({ title: 'Error', description: 'Failed to select file', variant: 'destructive' });
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, type: 'image' | 'video') => {
    handleFileUpload(Array.from(e.target.files || []), type);
    e.target.value = '';
  };

  // ─── Tags ─────────────────────────────────────────────────────────────────

  const handleAddTag = () => {
    const tag = tagInput.trim().replace('#', '');
    if (tag && !form.tags.includes(tag)) {
      updateForm('tags', [...form.tags, tag]);
    }
    setTagInput('');
  };

  const handleRemoveTag = (tag: string) => {
    updateForm('tags', form.tags.filter((t) => t !== tag));
  };

  // ─── Submit ───────────────────────────────────────────────────────────────

  const validate = (): string | null => {
    if (applyingTemplate) return 'Wait for template validation to finish';
    if (pendingTemplate) return 'Apply or cancel the pending template before creating the post';
    if (!form.platforms.length) return 'Select at least one connected publishing account';
    if (findUnresolvedTemplateTokens(form.caption, form.title).length) return 'Resolve every template variable before reviewing the post';
    if (!form.caption.trim() && !form.imageUrl && !form.videoUrl && !form._pendingImageFiles.length && !form._pendingVideoFile) return 'Add a caption or media before continuing';
    return null;
  };

  const handleSubmit = async () => {
    if (submittingRef.current || creationUncertain) return;
    const error = validate();
    if (error) {
      toast({ title: 'Validation error', description: error, variant: 'destructive' });
      return;
    }
    submittingRef.current = true;
    setIsSubmitting(true);
    setPublishError(null);
    try {
      {
        let publishImageUrls = form._pendingImageFiles.length
          ? form._pendingImageFiles.map((file) => uploadedFilesRef.current.get(file)).filter((url): url is string => Boolean(url))
          : form.imageUrls.filter((url) => !url.startsWith('blob:'));
        if (!publishImageUrls.length && form.imageUrl && !form.imageUrl.startsWith('blob:')) publishImageUrls = [form.imageUrl];
        let publishVideoUrl = form._pendingVideoFile
          ? uploadedFilesRef.current.get(form._pendingVideoFile) || ''
          : form.videoUrl.startsWith('blob:') ? '' : form.videoUrl;
        const assetPayload: Record<string, unknown> = {
          type: 'social_post',
          title: form.title || 'Social post',
          content: form.tags.length ? JSON.stringify({ caption: form.caption, hashtags: form.tags }) : form.caption,
          channel: 'social',
          publishPlatform: form.platforms[0],
          status: 'ready',
          imageUrl: publishImageUrls[0] || null,
          imageUrls: publishImageUrls,
          videoUrl: publishVideoUrl || null,
          metadata: {
            postType: form.postType, tags: form.tags,
            privacyStatus: form.privacyStatus, platforms: form.platforms,
            youtubeOptions: form.platforms.includes('youtube') ? { madeForKids: form.madeForKids, containsSyntheticMedia: form.containsSyntheticMedia } : undefined,
          },
        };
        if (form.templateId && form.templateVersion) {
          assetPayload.sourceTemplateId = form.templateId;
          assetPayload.sourceTemplateVersion = form.templateVersion;
          const provenance = form.templateBrandContext?.provenance as {
            businessProfile?: { id?: number }; brandToolkit?: { id?: number };
          } | undefined;
          if (!form.templateIsPredefined && provenance?.businessProfile?.id) assetPayload.businessProfileId = provenance.businessProfile.id;
          if (!form.templateIsPredefined && provenance?.brandToolkit?.id) assetPayload.brandToolkitId = provenance.brandToolkit.id;
        }

        const fingerprint = JSON.stringify(assetPayload);
        let draft = savedDraftRef.current;
        if (!draft) {
          try {
            const asset = await api.post<{ id: number }>('/api/content/assets', assetPayload);
            if (!Number.isSafeInteger(asset?.id) || asset.id <= 0) throw new Error('The draft save did not return a valid receipt.');
            draft = { id: asset.id, fingerprint };
            savedDraftRef.current = draft;
            setSavedDraftId(asset.id);
          } catch (error) {
            const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
            if (!status || status >= 500) {
              setCreationUncertain(true);
              throw new Error('The draft save could not be confirmed. Check Content Library before creating another post to avoid a duplicate.');
            }
            throw error;
          }
        } else if (draft.fingerprint !== fingerprint) {
          const updated = await api.put<{ id: number }>('/api/content/assets/' + draft.id, assetPayload);
          if (updated?.id !== draft.id) throw new Error('The draft update could not be confirmed. Keep this form open and retry.');
          draft.fingerprint = fingerprint;
        }

        // Successful uploads are retained even if a later file fails.
        if (form._pendingImageFiles.length || form._pendingVideoFile) {
          const uploads = [...form._pendingImageFiles.map((file) => ({ file, mediaType: 'image' as const })), ...(form._pendingVideoFile ? [{ file: form._pendingVideoFile, mediaType: 'video' as const }] : [])];
          const uploadedImageUrls: string[] = [];
          for (const { file, mediaType } of uploads) {
            let url = uploadedFilesRef.current.get(file);
            if (!url) {
              const data = new FormData();
              data.append('file', file);
              data.append('assetId', String(draft.id));
              data.append('mediaType', mediaType);
              try {
                const uploaded = await api.upload<UploadResponse>('/api/content/assets/upload', data);
                if (!uploaded.success || !uploaded.url) throw new Error(uploaded.error || 'Media upload failed');
                url = uploaded.url;
                uploadedFilesRef.current.set(file, url);
              } catch {
                throw new Error('The post was saved as a draft, but its media could not be uploaded. Please retry the upload.');
              }
            }
            if (mediaType === 'image') uploadedImageUrls.push(url);
            else publishVideoUrl = url;
          }
          if (uploadedImageUrls.length) publishImageUrls = uploadedImageUrls;
          setForm((current) => {
            current.imageUrls.filter((url) => url.startsWith('blob:')).forEach(URL.revokeObjectURL);
            if (current.videoUrl.startsWith('blob:')) URL.revokeObjectURL(current.videoUrl);
            return { ...current, imageUrl: publishImageUrls[0] || '', imageUrls: publishImageUrls, videoUrl: publishVideoUrl, _pendingImageFiles: [], _pendingVideoFile: null };
          });
        }
        draft.fingerprint = JSON.stringify({ ...assetPayload, imageUrl: publishImageUrls[0] || null, imageUrls: publishImageUrls, videoUrl: publishVideoUrl || null });

        // Final destinations, account, per-network formats and schedule are reviewed
        // in the same publisher used by Content Library.
        setReviewAssetId(draft.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The request could not be completed. Keep this form open and retry.';
      setPublishError(message);
      toast({ title: savedDraftRef.current ? 'Draft saved; action needs attention' : 'Post creation failed', description: message, variant: 'destructive' });
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  if (reviewAssetId) return <SocialPublisher assetId={reviewAssetId} open={open} initialPlatforms={form.platforms} initialScheduledDate={!form.publishNow && form.scheduledDate ? `${form.scheduledDate}T${form.scheduledTime}` : undefined} onOpenChange={next => { if (!next) { setReviewAssetId(null); onOpenChange(false); } }} onPublished={() => onPostCreated()} />;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submittingRef.current) onOpenChange(next); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="w-5 h-5" />
            Create Post
          </DialogTitle>
          <DialogDescription>Create your content, then review each destination and preview before publishing.</DialogDescription>
        </DialogHeader>

        {publishError && <div role="alert" className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><p>{publishError}</p>{savedDraftId && <p>Draft #{savedDraftId} is saved. Retry this request without creating another post.</p>}<Link href="/dashboard/saved-templates/social" className="underline">Open Content Library</Link></div>}
        <fieldset disabled={isSubmitting || creationUncertain} className="space-y-6 min-w-0">
          {/* Platform Selection - Multi-select */}
          <div className="space-y-2">
            <Label>Platforms (select multiple for cross-posting)</Label>
            <div className="flex gap-2">
              {(Object.keys(platformConfig) as Platform[]).filter((candidate) => connectedPlatforms.includes(candidate)).map((p) => {
                const isSelected = form.platforms.includes(p);
                return (
                  <Button
                    key={p}
                    variant={isSelected ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      const newPlatforms = isSelected
                        ? form.platforms.filter(pl => pl !== p)
                        : [...form.platforms, p];
                      if (newPlatforms.length > 0) {
                        updateForm('platforms', newPlatforms);
                      }
                    }}
                    className={isSelected ? platformConfig[p].color : ''}
                  >
                    {platformConfig[p].icon}
                    <span className="ml-1">{platformConfig[p].label}</span>
                    {isSelected && <span className="ml-1">✓</span>}
                  </Button>
                );
              })}
            </div>
            {!publishingAccounts.loading && connectedPlatforms.length === 0 && (
              <div className="rounded-xl border border-dashed p-4 text-center">
                <p className="text-sm font-medium">Connect a publishing account first</p>
                <Button asChild size="sm" className="mt-3"><Link href="/dashboard/integrations">Connect social accounts</Link></Button>
              </div>
            )}
            {form.platforms.length > 1 && (
              <p className="text-xs text-muted-foreground">
                Cross-posting to {form.platforms.length} platforms
              </p>
            )}
          </div>

          <p className="text-xs text-muted-foreground">You’ll review connected accounts, captions and formats for each destination in the next step.</p>
          {/* Title (for YouTube) */}
          {form.platforms.includes('youtube') && (
            <div className="space-y-2">
              <Label>Title *</Label>
              <Input
                value={form.title}
                onChange={(e) => updateForm('title', e.target.value)}
                placeholder="Video title"
                maxLength={100}
              />
            </div>
          )}

          {/* Content Tabs */}
          <Tabs defaultValue="manual" onValueChange={(v) => {
            if (v === 'template') loadTemplates();
          }}>
            <TabsList>
              <TabsTrigger value="manual" className="flex items-center gap-1">
                <FileText className="w-3 h-3" />
                Manual
              </TabsTrigger>
              <TabsTrigger value="template" className="flex items-center gap-1">
                <Sparkles className="w-3 h-3" />
                Templates
              </TabsTrigger>
              <TabsTrigger value="ai" className="flex items-center gap-1">
                <Wand2 className="w-3 h-3" />
                AI Generate
              </TabsTrigger>
            </TabsList>

            {/* Manual Content Tab */}
            <TabsContent value="manual" className="space-y-4">
              <div className="space-y-2">
                <Label>{form.platforms.includes('youtube') ? 'Description' : 'Caption'} *</Label>
                <Textarea
                  value={form.caption}
                  onChange={(e) => updateForm('caption', e.target.value)}
                  placeholder={form.platforms.includes('youtube') ? 'Write your video description...' : 'Write your caption...'}
                  rows={6}
                />
              </div>
            </TabsContent>

            {/* Template Tab */}
            <TabsContent value="template" className="space-y-4">
              {loadingTemplates ? (
                <LoadingState className="py-8" label="Loading templates…" />
              ) : templatesError ? (
                <div role="alert" className="space-y-2 text-sm">
                  <p>{templatesError}</p>
                  <Button variant="outline" onClick={() => void loadTemplates()}>Retry templates</Button>
                </div>
              ) : templates.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No templates found. Create templates in Content Studio first.
                </div>
              ) : (
                <div className="grid gap-2 max-h-48 overflow-y-auto">
                  {templates.map((template) => (
                    <button
                      type="button"
                      disabled={applyingTemplate}
                      key={template.id}
                      className={`p-3 border rounded-lg text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${
                        !template.isApproved ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                      } ${
                        form.templateId === template.id
                          ? 'border-primary bg-primary/5'
                          : 'hover:bg-muted'
                      }`}
                      onClick={() => handleTemplateSelect(template)}
                    >
                      <div className="font-medium text-sm">{template.name}</div>
                      {!template.isApproved && <Badge variant="outline" className="ml-2 text-xs">Approval required</Badge>}
                      <div className="text-xs text-muted-foreground line-clamp-2 mt-1">
                        {template.content}
                      </div>
                      {template.category && (
                        <Badge variant="secondary" className="mt-1 text-xs">
                          {template.category}
                        </Badge>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {pendingTemplate && (
                <div className="space-y-3 rounded-md border p-3">
                  <p className="text-sm font-medium">Fill variables for {pendingTemplate.name}</p>
                  {Object.entries(templateVariables).map(([variable, value], index) => (
                    <div key={variable} className="space-y-1">
                      <Label htmlFor={`post-template-variable-${index}`}>{variable}</Label>
                      <Input id={`post-template-variable-${index}`} value={value} onChange={(event) => setTemplateVariables((current) => ({ ...current, [variable]: event.target.value }))} />
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <Button onClick={() => void applyReusableTemplate(pendingTemplate, templateVariables)} loading={applyingTemplate}>
                      Apply template
                    </Button>
                    <Button variant="outline" onClick={() => setPendingTemplate(null)} disabled={applyingTemplate}>Cancel</Button>
                  </div>
                </div>
              )}
              {applyingTemplate && <p role="status" className="text-sm text-muted-foreground">Verifying template…</p>}
              {form.templateId && (
                <div className="space-y-2">
                  <Label htmlFor="selected-template-caption">Selected Template Caption · Version {form.templateVersion}</Label>
                  <Textarea
                    id="selected-template-caption"
                    value={form.caption}
                    onChange={(e) => updateForm('caption', e.target.value)}
                    rows={6}
                  />
                </div>
              )}
            </TabsContent>

            {/* AI Generate Tab */}
            <TabsContent value="ai" className="space-y-4">
              <div className="space-y-2">
                <Label>Generation Prompt</Label>
                <Textarea
                  value={form.aiPrompt}
                  onChange={(e) => updateForm('aiPrompt', e.target.value)}
                  placeholder="Describe what you want to generate..."
                  rows={3}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleEnhancePrompt}
                  loading={isEnhancing}
                  disabled={!form.aiPrompt.trim()}
                >
                  <Sparkles className="w-3 h-3 mr-1" />
                  Enhance Prompt
                </Button>
                <Button
                  size="sm"
                  onClick={handleGenerateContent}
                  loading={isGenerating}
                  disabled={!form.aiPrompt.trim()}
                >
                  <Wand2 className="w-3 h-3 mr-1" />
                  Generate Content
                </Button>
              </div>
              {form.caption && (
                <div className="space-y-2">
                  <Label>Generated Caption</Label>
                  <Textarea
                    value={form.caption}
                    onChange={(e) => updateForm('caption', e.target.value)}
                    rows={6}
                  />
                </div>
              )}
            </TabsContent>
          </Tabs>

          {/* Tags */}
          <div className="space-y-2">
            <Label>Tags / Hashtags</Label>
            <div className="flex gap-2">
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder="Add tag..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddTag();
                  }
                }}
              />
              <Button variant="outline" size="sm" onClick={handleAddTag}>
                Add
              </Button>
            </div>
            {form.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {form.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="flex items-center gap-1">
                    #{tag}
                    <X className="w-3 h-3 cursor-pointer" onClick={() => handleRemoveTag(tag)} />
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Media Section */}
          <div className="space-y-3">
            <Label>Media</Label>
            <div className="border rounded-lg p-4 space-y-4">
              {/* Current Media Preview */}
              {(form.imageUrl || form.videoUrl) && (
                <div className="relative inline-block">
                  {form.imageUrl ? (
                    <div className="flex max-w-lg flex-wrap gap-2">
                      {(form.imageUrls.length > 0 ? form.imageUrls : [form.imageUrl]).map((imageUrl, index) => (
                        <img
                          key={imageUrl}
                          src={imageUrl}
                          alt={`Preview ${index + 1}`}
                          className="w-32 h-32 object-cover rounded-lg border"
                        />
                      ))}
                    </div>
                  ) : null}
                  {form.videoUrl ? (
                    <video
                      src={form.videoUrl}
                      className="w-32 h-32 object-cover rounded-lg border"
                      muted
                    />
                  ) : null}
                  <Button
                    variant="destructive"
                    size="icon"
                    className="absolute -top-2 -right-2 w-6 h-6"
                    onClick={() => {
                      if (form.videoUrl.startsWith('blob:')) URL.revokeObjectURL(form.videoUrl);
                      updateForm('imageUrl', '');
                      form.imageUrls.filter((url) => url.startsWith('blob:')).forEach(URL.revokeObjectURL);
                      updateForm('imageUrls', []);
                      updateForm('videoUrl', '');
                      updateForm('_pendingImageFiles', []);
                      updateForm('_pendingVideoFile', null);
                    }}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                  {form._pendingImageFiles.length > 0 || form._pendingVideoFile ? (
                    <Badge className="absolute bottom-1 left-1 text-xs" variant="secondary">
                      Pending upload
                    </Badge>
                  ) : null}
                </div>
              )}

              {/* Media Actions */}
              {(
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Button
                    variant="outline"
                    className="h-20 flex flex-col gap-1"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                  >
                    {isUploading ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <ImagePlus className="w-5 h-5" />
                    )}
                    <span className="text-xs">{form.imageUrl ? "Replace images" : "Upload images"}</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-20 flex flex-col gap-1"
                    onClick={() => videoInputRef.current?.click()}
                    disabled={isUploading}
                  >
                    {isUploading ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <VideoIcon className="w-5 h-5" />
                    )}
                    <span className="text-xs">{form.videoUrl ? "Replace video" : "Upload video"}</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-20 flex flex-col gap-1"
                    asChild
                  >
                    <Link href="/dashboard/saved-templates/image/generate" target="_blank" rel="noopener noreferrer">
                      <Wand2 className="w-5 h-5" />
                      <span className="text-xs">AI Image Studio ↗</span>
                    </Link>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-20 flex flex-col gap-1"
                    asChild
                  >
                    <Link href="/dashboard/saved-templates/video/generate" target="_blank" rel="noopener noreferrer">
                      <VideoIcon className="w-5 h-5" />
                      <span className="text-xs">AI Video Studio ↗</span>
                    </Link>
                  </Button>
                </div>
              )}

              {/* URL Input */}
              {!form.imageUrl && !form.videoUrl && (
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Or paste media URL</Label>
                  <div className="flex gap-2">
                    <Select value={urlMediaType} onValueChange={value => setUrlMediaType(value as 'image' | 'video')}><SelectTrigger aria-label="Media URL type" className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="image">Image</SelectItem><SelectItem value="video">Video</SelectItem></SelectContent></Select>
                    <Input aria-label="Media URL" value={mediaUrlInput} onChange={event => setMediaUrlInput(event.target.value)} placeholder="https://…" />
                    <Button type="button" variant="outline" onClick={() => { const url = mediaUrlInput.trim(); if (!url.startsWith('https://') && !url.startsWith('http://')) { toast({ title: 'Enter a valid public media URL', variant: 'destructive' }); return; } setForm(current => ({ ...current, imageUrl: urlMediaType === 'image' ? url : '', imageUrls: urlMediaType === 'image' ? [url] : [], videoUrl: urlMediaType === 'video' ? url : '' })); }}>Add media</Button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Scheduling */}
          <div className="space-y-3">
            <Label>Schedule</Label>
            <div className="flex gap-4">
              <Button
                variant={form.publishNow ? 'default' : 'outline'}
                size="sm"
                onClick={() => updateForm('publishNow', true)}
              >
                <Send className="w-3 h-3 mr-1" />
                Publish Now
              </Button>
              <Button
                variant={!form.publishNow ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  updateForm('publishNow', false);
                  if (!form.scheduledDate) {
                    updateForm('scheduledDate', formatDate(selectedDate || new Date()));
                  }
                }}
              >
                <Clock className="w-3 h-3 mr-1" />
                Schedule
              </Button>
            </div>

            {!form.publishNow && (
              <div className="flex flex-wrap gap-2">
                <Input
                  type="date"
                  value={form.scheduledDate}
                  onChange={(e) => updateForm('scheduledDate', e.target.value)}
                  className="w-40"
                  min={scheduledLocalValue(new Date().toISOString(), form.timezone).slice(0, 10)}
                  aria-label="Scheduled publish date"
                />
                <Input
                  type="time"
                  value={form.scheduledTime}
                  onChange={(e) => updateForm('scheduledTime', e.target.value)}
                  className="w-32"
                  aria-label="Scheduled publish time"
                />
                <p className="self-center text-xs text-muted-foreground">Account timezone: {form.timezone}</p>
              </div>
            )}
          </div>
        </fieldset>

        {/* Hidden file inputs */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => handleFileChange(e, 'image')}
        />
        <input
          ref={videoInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => handleFileChange(e, 'video')}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={isSubmitting} disabled={applyingTemplate || creationUncertain}>
            <Send className="w-4 h-4 mr-1" />
            {savedDraftId ? 'Continue to review saved draft' : 'Continue to publishing review'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
