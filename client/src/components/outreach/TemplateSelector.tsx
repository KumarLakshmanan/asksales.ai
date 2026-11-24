import type { TemplateRenderContext } from '../../../../shared/templateRenderContext';
import { selectedBusinessProfileId } from '@/lib/business-profile';

/**
 * TemplateSelector - Modal component for selecting message templates
 * Supports optional stepper flow with variable prefill from lead/business data
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { Callout } from "@/components/ui/callout";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  FileText,
  Mail,
  MessageSquare,
  Instagram,
  Clock,
  ArrowLeft,
  Variable,
  CheckCircle,
  Heart,
  Send,
  Bookmark,
  Repeat2,
  ThumbsUp,
} from "lucide-react";
import api from "@/lib/api";
import { extractVariables, ALL_VARIABLES, replaceTemplateVariableValues } from "@/utils/templateVariables";
import { usePreferences } from "@/contexts/PreferencesContext";
import { renderApprovedTemplate } from "@/lib/reusableTemplates";
import { readLibraryDraft } from "@/lib/libraryDraft";
import { loadReusableTemplates } from "@/lib/contentTemplateLibrary";

interface ContentTemplate {
  id: number;
  name: string;
  type: string;
  subject?: string;
  content: string;
  htmlContent?: string | null;
  sourceTemplateId?: number;
  sourceTemplateVersion?: number;
  templateRenderContext?: TemplateRenderContext;
  brandContext?: Record<string, unknown>;
  category?: string;
  tags?: string[];
  usageCount: number;
  isApproved?: boolean;
  lastUsedAt?: string;
  source?: 'template' | 'asset' | 'predefined'; // Track source for proper handling
}

interface ContentAsset {
  id: number;
  type: string;
  title: string;
  content: string;
  channel: string;
  status: string;
  createdAt: string;
}

interface TemplateSelectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: "email" | "sms" | "instagram" | "social" | "facebook" | "twitter" | "linkedin" | "whatsapp";
  onSelect: (template: ContentTemplate) => void;
  /** When provided, enables Step 2: variable prefill from lead + business data */
  leadId?: number;
  /** Restrict choices to sources the consuming workflow can resolve at send time. */
  selectableSources?: readonly NonNullable<ContentTemplate['source']>[];
  /** Keep recipient variables unresolved until the scheduler sends each message. */
  selectionMode?: 'message' | 'follow-up';
}

// Variable value entry for the prefill step
interface VariableEntry {
  originalValue?: string;
  variable: string; // e.g. "{{first_name}}"
  label: string;
  value: string;
}

export function TemplateSelector({
  open,
  onOpenChange,
  channel,
  onSelect,
  leadId,
  selectableSources,
  selectionMode = 'message',
}: TemplateSelectorProps) {
  const { preferences, formatDate } = usePreferences();
  const [templates, setTemplates] = useState<ContentTemplate[]>([]);
  const [_predefinedTemplates, setPredefinedTemplates] = useState<ContentTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Stepper state
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedTemplate, setSelectedTemplate] = useState<ContentTemplate | null>(null);
  const [variableEntries, setVariableEntries] = useState<VariableEntry[]>([]);
  const [loadingVariableData, setLoadingVariableData] = useState(false);
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const selectionBusy = useRef(false);
  const selectorOpen = useRef(open);
  const selectionGeneration = useRef(0);
  const loadGeneration = useRef(0);
  selectorOpen.current = open;
  const isSocialChannel = ["instagram", "facebook", "twitter", "linkedin", "social"].includes(channel);

  // Reset stepper when dialog closes
  useEffect(() => {
    selectionGeneration.current += 1;
      setStep(1);
      setSelectedTemplate(null);
      setVariableEntries([]);
      setSearchQuery("");
      setSelectionError(null);
  }, [open, channel, leadId, selectionMode]);

  // Build prefilled variable values from lead + business data
  const buildVariableEntries = useCallback(async (template: ContentTemplate) => {
    const variables = extractVariables(template.content);
    // Also extract from subject if email
    if (template.subject) {
      const subjectVars = extractVariables(template.subject);
      for (const v of subjectVars) {
        if (!variables.includes(v)) variables.push(v);
      }
    }
    for (const variable of extractVariables(template.htmlContent || "")) {
      if (!variables.includes(variable)) variables.push(variable);
    }

    if (variables.length === 0) return [];

    // Fetch lead data + business profile in parallel
    setLoadingVariableData(true);
    try {
      const promises: Promise<Record<string, string>>[] = [];

      // Fetch lead data if leadId provided
      if (leadId) {
        promises.push(
          api.get<Record<string, unknown>>(`/api/leads/${leadId}`).then((leadResponse) => {
            const lead = (leadResponse.data as Record<string, unknown> | undefined) || leadResponse;
            const data: Record<string, string> = {};
            const name = (lead.fullName as string) || (lead.full_name as string) || (lead.name as string) || "";
            const parts = name.split(" ");
            data["{{first_name}}"] = (lead.firstName as string) || (lead.first_name as string) || parts[0] || "";
            data["{{last_name}}"] = (lead.lastName as string) || (lead.last_name as string) || parts.slice(1).join(" ") || "";
            data["{{full_name}}"] = name;
            data["{{email}}"] = (lead.email as string) || "";
            data["{{phone}}"] = (lead.phone as string) || "";
            data["{{company_name}}"] = (lead.company as string) || (lead.companyName as string) || (lead.company_name as string) || "";
            data["{{company_industry}}"] = (lead.industry as string) || "";
            data["{{company_size}}"] = (lead.companySize as string) || (lead.company_size as string) || "";
            data["{{company_website}}"] = (lead.website as string) || (lead.companyWebsite as string) || (lead.company_website as string) || "";
            data["{{company_location}}"] = (lead.location as string) || "";
            data["{{job_title}}"] = (lead.jobTitle as string) || (lead.job_title as string) || (lead.title as string) || (lead.role as string) || "";
            data["{{department}}"] = (lead.department as string) || "";
            return data;
          }).catch(() => ({} as Record<string, string>))
        );
      } else {
        promises.push(Promise.resolve({} as Record<string, string>));
      }

      // Fetch business profile / brand toolkit
      promises.push(
        api.get<Record<string, unknown>[]>("/api/settings/business-profiles").then((profiles) => {
          const profile = profiles.find((candidate) => candidate.id === selectedBusinessProfileId()) || {};
          const data: Record<string, string> = {};
          data["{{your_company_name}}"] = (profile.companyName as string) || (profile.name as string) || "";
          data["{{your_industry}}"] = (profile.industry as string) || "";
          data["{{value_proposition}}"] = (profile.valueProposition as string) || (profile.description as string) || "";
          data["{{your_website}}"] = (profile.website as string) || "";
          return data;
        }).catch(() => ({} as Record<string, string>))
      );

      const [leadData, businessData] = await Promise.all(promises);
      const allData = { ...leadData, ...businessData };

      // Add dynamic variables
      const now = new Date();
      allData["{{current_date}}"] = formatDate(now);
      allData["{{current_year}}"] = new Intl.DateTimeFormat(preferences.locale, {
        timeZone: preferences.timezone,
        year: "numeric",
      }).format(now);
      allData["{{current_month}}"] = new Intl.DateTimeFormat(preferences.locale, {
        timeZone: preferences.timezone,
        month: "long",
      }).format(now);

      // Build entries for each variable found
      const entries: VariableEntry[] = variables.map((v) => {
        const meta = ALL_VARIABLES.find((av) => av.variable === v);
        return {
          variable: v,
          label: meta?.name || v.replace(/\{\{|\}\}/g, "").replace(/_/g, " "),
          value: allData[v] || "",
          originalValue: allData[v] || "",
        };
      });

      return entries;
    } finally {
      setLoadingVariableData(false);
    }
  }, [formatDate, leadId, preferences.locale, preferences.timezone]);

  // Map channel to template type
  const getTemplateType = () => {
    switch (channel) {
      case "email":
        return "email";
      case "sms":
        return "sms";
      case "whatsapp":
        return "whatsapp";
      case "instagram":
      case "facebook":
      case "twitter":
      case "linkedin":
        return "social_message";
      case "social":
        return "social";
      default:
        return "email";
    }
  };

  // Map channel to content asset type
  const getAssetType = () => {
    switch (channel) {
      case "email":
        return "email_template";
      case "sms":
        return "sms_template";
      case "whatsapp":
        return "whatsapp_template";
      case "instagram":
      case "facebook":
      case "twitter":
      case "linkedin":
        return "social_dm";
      case "social":
        return "social_post";
      default:
        return "email_template";
    }
  };

  const loadTemplates = async () => {
    const request = ++loadGeneration.current;
    try {
      setLoading(true);
      setLoadError(null);
      const type = getTemplateType();
      const assetType = getAssetType();
      const allowedSources = selectableSources ? new Set(selectableSources) : null;
      const includeUserTemplates = !allowedSources || allowedSources.has('template');
      const includePredefined = !allowedSources || allowedSources.has('predefined');
      const includeAssets = !allowedSources || allowedSources.has('asset');

      const [templatesResult, predefinedResult, assetsResult] = await Promise.allSettled([
        includeUserTemplates ? loadReusableTemplates<ContentTemplate>(type) : Promise.resolve([]),
        includePredefined ? api.get<ContentTemplate[]>(`/api/content/templates/predefined?type=${type}`) : Promise.resolve([]),
        includeAssets ? api.get<ContentAsset[]>(`/api/content/assets?type=${assetType}`) : Promise.resolve([]),
      ]);
      if (request !== loadGeneration.current) return;

      const templatesRes = templatesResult.status === 'fulfilled' ? templatesResult.value : null;
      const predefinedRes = predefinedResult.status === 'fulfilled' ? predefinedResult.value : null;
      const assetsRes = assetsResult.status === 'fulfilled' ? assetsResult.value : null;
      const unavailable = [templatesResult, predefinedResult, assetsResult].filter((result) => result.status === 'rejected').length;
      if (unavailable) setLoadError(unavailable === 3 ? 'Templates could not be loaded. Try again.' : 'Some templates could not be loaded. Retry to see the complete library.');

      // Convert content assets to template format
      const contentAssets: ContentTemplate[] = (Array.isArray(assetsRes) ? assetsRes : []).map((asset: ContentAsset) => ({
        id: asset.id,
        name: asset.title || 'Untitled Template',
        type: type,
        subject: channel === 'email' ? extractSubject(asset.content) : undefined,
        // For social channels, preserve raw JSON so parsePostContent can extract hashtags
        content: isSocialChannel ? asset.content : extractContent(asset.content),
        htmlContent: channel === 'email' ? readLibraryDraft(asset.content).html || null : null,
        category: asset.channel,
        tags: [],
        usageCount: 0,
        lastUsedAt: asset.createdAt,
        source: 'asset' as const,
      }));
      
      // User's own templates — API may return array or {templates: [...]}
      const rawTemplates = templatesRes
        ? (Array.isArray(templatesRes) ? templatesRes : (templatesRes as { templates?: ContentTemplate[] }).templates || [])
        : [];
      const userTemplates = rawTemplates.map((t: ContentTemplate) => ({ ...t, source: 'template' as const }));
      
      // Predefined templates from admin
      const adminTemplates: ContentTemplate[] = (Array.isArray(predefinedRes) ? predefinedRes : []).map(t => ({ 
        ...t, 
        source: 'predefined' as const 
      }));
      
      // Combine all templates into a single list
      const combinedTemplates = [
        ...userTemplates,
        ...contentAssets,
        ...adminTemplates,
      ];
      
      setTemplates(combinedTemplates);
      setPredefinedTemplates([]);

    } catch {
      if (request === loadGeneration.current) setLoadError('Templates could not be loaded. Try again.');
    } finally {
      if (request === loadGeneration.current) setLoading(false);
    }
  };

  // Helper to extract subject from JSON content
  const extractSubject = (content: string): string | undefined => {
    try {
      const parsed = JSON.parse(content);
      return parsed.subject || parsed.emailSubject;
    } catch {
      return undefined;
    }
  };

  // Helper to extract body content from JSON or return as-is
  const extractContent = (content: string): string => {
    const draft = readLibraryDraft(content);
    if (draft.body) return draft.body;
    try {
      const parsed = JSON.parse(content);
      return parsed.body || parsed.emailBody || parsed.message || parsed.caption || parsed.content || content;
    } catch {
      return content;
    }
  };

  useEffect(() => {
    if (open) {
      setTemplates([]);
      loadTemplates();
    }
    return () => { loadGeneration.current++; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, channel, selectableSources?.join(',')]);

  const filteredTemplates = templates.filter(
    (t) =>
      !searchQuery ||
      t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.subject?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.category?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getChannelIcon = () => {
    switch (channel) {
      case "email":
        return <Mail className="w-4 h-4" />;
      case "sms":
        return <MessageSquare className="w-4 h-4" />;
      case "whatsapp":
        return <MessageSquare className="w-4 h-4" />;
      case "instagram":
      case "social":
      case "facebook":
      case "twitter":
      case "linkedin":
        return <Instagram className="w-4 h-4" />;
      default:
        return <FileText className="w-4 h-4" />;
    }
  };

  const getChannelLabel = () => {
    switch (channel) {
      case "email":
        return "Email Templates";
      case "sms":
        return "SMS Templates";
      case "whatsapp":
        return "WhatsApp Templates";
      case "instagram":
        return "Instagram Templates";
      case "facebook":
        return "Facebook Templates";
      case "twitter":
        return "Twitter Templates";
      case "linkedin":
        return "LinkedIn Templates";
      case "social":
        return "Social Media Templates";
      default:
        return "Templates";
    }
  };

  const applyTemplate = async (template: ContentTemplate, values: Record<string, string>, edited = false) => {
    const generation = selectionGeneration.current;
    if (template.source === 'template' || template.source === 'predefined') {
      const rendered = await renderApprovedTemplate(template.id, values, !edited && leadId ? { leadId, channel } : undefined);
      if (!selectorOpen.current || generation !== selectionGeneration.current) return;
      onSelect({
        ...template,
        content: rendered.content,
        subject: rendered.subject ?? undefined,
        htmlContent: rendered.htmlContent,
        ...(edited ? { sourceTemplateId: undefined, sourceTemplateVersion: undefined, templateRenderContext: undefined } : { sourceTemplateId: rendered.templateId, sourceTemplateVersion: rendered.templateVersion, templateRenderContext: rendered.templateRenderContext }),
        brandContext: rendered.brandContext,
      });
    } else {
      onSelect({
        ...template,
        content: replaceTemplateVariableValues(template.content, values),
        htmlContent: template.htmlContent ? replaceTemplateVariableValues(template.htmlContent, values, { escapeHtml: true }) : null,
        subject: template.subject ? replaceTemplateVariableValues(template.subject, values) : undefined,
      });
    }
    onOpenChange(false);
  };

  const handleSelect = async (template: ContentTemplate) => {
    if (selectionBusy.current) return;
    selectionBusy.current = true;
    setApplyingTemplate(true);
    setSelectionError(null);
    const generation = selectionGeneration.current;
    try {
      if (selectionMode === 'follow-up') {
        if (template.source === 'template' && template.isApproved === false) {
          throw new Error('Review and approve this template in the template library before using it.');
        }
        // Generated drafts and predefined examples need a durable, user-owned
        // template ID; asset IDs are from a different table and cannot be scheduled.
        const reusable = template.source === 'template' ? template : await api.post<ContentTemplate>('/api/content/templates', {
          name: template.name, type: getTemplateType(), content: extractContent(template.content),
          subject: template.subject || null, htmlContent: template.htmlContent || null,
          category: 'follow_up', tags: ['follow-up', channel],
        });
        if (!Number.isSafeInteger(reusable?.id) || reusable.id <= 0 || typeof reusable.content !== 'string') {
          throw new Error('This template could not be saved. Please try again.');
        }
        if (!selectorOpen.current || generation !== selectionGeneration.current) return;
        onSelect({ ...reusable, source: 'template' });
        onOpenChange(false);
        return;
      }
      const candidate = template.source === 'asset' ? { ...template, content: extractContent(template.content) } : template;
      const hasVars = [candidate.content, candidate.subject, candidate.htmlContent].some((part) => extractVariables(part || '').length > 0);
      if (hasVars) {
        setSelectedTemplate(candidate);
        setStep(2);
        const entries = await buildVariableEntries(candidate);
        if (selectorOpen.current && generation === selectionGeneration.current) setVariableEntries(entries);
      } else {
        await applyTemplate(candidate, {});
      }
    } catch (error) {
      if (selectorOpen.current && generation === selectionGeneration.current) setSelectionError(error instanceof Error ? error.message : 'This template could not be verified. Review its approval and try again.');
    } finally {
      selectionBusy.current = false;
      setApplyingTemplate(false);
    }
  };

  const handleApplyTemplate = async () => {
    if (!selectedTemplate || selectionBusy.current) return;
    selectionBusy.current = true;
    setApplyingTemplate(true);
    setSelectionError(null);
    const generation = selectionGeneration.current;
    try {
      await applyTemplate(selectedTemplate, Object.fromEntries(variableEntries.map((entry) => [entry.variable, entry.value])), variableEntries.some(entry => entry.value !== entry.originalValue));
    } catch (error) {
      if (selectorOpen.current && generation === selectionGeneration.current) setSelectionError(error instanceof Error ? error.message : 'Resolve the template variables and try again.');
    } finally {
      selectionBusy.current = false;
      setApplyingTemplate(false);
    }
  };

  const handleVariableChange = (index: number, value: string) => {
    setVariableEntries((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], value };
      return updated;
    });
  };

  // Parse hashtags and content from JSON or plain text
  const parsePostContent = (content: string) => {
    try {
      const parsed = JSON.parse(content);
      return {
        text: parsed.content || parsed.caption || parsed.body || content,
        hashtags: (parsed.hashtags || []) as string[],
      };
    } catch {
      return { text: content, hashtags: [] as string[] };
    }
  };

  // Get platform-specific engagement bar
  const renderEngagementBar = (ch: string) => {
    switch (ch) {
      case "instagram":
        return (
          <div className="flex items-center justify-between px-3 py-2 border-t text-muted-foreground">
            <div className="flex items-center gap-3">
              <Heart className="w-4 h-4" />
              <MessageSquare className="w-4 h-4" />
              <Send className="w-4 h-4" />
            </div>
            <Bookmark className="w-4 h-4" />
          </div>
        );
      case "twitter":
        return (
          <div className="flex items-center justify-between px-3 py-2 border-t text-muted-foreground text-xs">
            <div className="flex items-center gap-1"><MessageSquare className="w-3.5 h-3.5" /><span>24</span></div>
            <div className="flex items-center gap-1"><Repeat2 className="w-3.5 h-3.5" /><span>128</span></div>
            <div className="flex items-center gap-1"><Heart className="w-3.5 h-3.5" /><span>1.2K</span></div>
            <Bookmark className="w-3.5 h-3.5" />
          </div>
        );
      case "linkedin":
        return (
          <div className="flex items-center justify-between px-3 py-2 border-t text-muted-foreground text-xs">
            <div className="flex items-center gap-1"><ThumbsUp className="w-3.5 h-3.5" /><span>Like</span></div>
            <div className="flex items-center gap-1"><MessageSquare className="w-3.5 h-3.5" /><span>Comment</span></div>
            <div className="flex items-center gap-1"><Repeat2 className="w-3.5 h-3.5" /><span>Repost</span></div>
            <div className="flex items-center gap-1"><Send className="w-3.5 h-3.5" /><span>Send</span></div>
          </div>
        );
      case "facebook":
        return (
          <div className="flex items-center justify-between px-3 py-2 border-t text-muted-foreground text-xs">
            <div className="flex items-center gap-1"><ThumbsUp className="w-3.5 h-3.5" /><span>Like</span></div>
            <div className="flex items-center gap-1"><MessageSquare className="w-3.5 h-3.5" /><span>Comment</span></div>
            <div className="flex items-center gap-1"><Send className="w-3.5 h-3.5" /><span>Share</span></div>
          </div>
        );
      case "social":
        return (
          <div className="flex items-center justify-between px-3 py-2 border-t text-muted-foreground">
            <div className="flex items-center gap-3">
              <Heart className="w-4 h-4" />
              <MessageSquare className="w-4 h-4" />
              <Send className="w-4 h-4" />
            </div>
            <Bookmark className="w-4 h-4" />
          </div>
        );
      default:
        return null;
    }
  };

  const renderTemplateCard = (template: ContentTemplate) => {
    // Social post card design for AI-generated assets on social channels
    if (isSocialChannel && template.source === 'asset') {
      const { text, hashtags } = parsePostContent(template.content);
      return (
        <button
          key={`${template.source}-${template.id}`}
          onClick={() => handleSelect(template)}
          className="w-full text-left rounded-lg border hover:border-primary hover:shadow-md transition-all overflow-hidden bg-white dark:bg-slate-950"
        >
          {/* Post header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-500 to-pink-500 flex items-center justify-center">
              <span className="text-white text-[10px] font-bold">AI</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold truncate">{template.name}</p>
            </div>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 capitalize">
              {channel === "social" ? "all" : channel}
            </Badge>
          </div>
          {/* Post content */}
          <div className="px-3 py-2.5">
            <p className="text-sm line-clamp-4 whitespace-pre-line">{text}</p>
            {hashtags.length > 0 && (
              <p className="text-xs text-primary mt-1.5">
                {hashtags.slice(0, 5).map((h) => `#${h.replace(/^#+/, "")}`).join(" ")}
                {hashtags.length > 5 && ` +${hashtags.length - 5}`}
              </p>
            )}
          </div>
          {/* Platform-specific engagement bar */}
          {renderEngagementBar(channel)}
        </button>
      );
    }

    // DM-style card for social channel non-asset templates (My Templates / Predefined)
    if (isSocialChannel) {
      return (
        <button
          key={`${template.source}-${template.id}`}
          onClick={() => handleSelect(template)}
          className="w-full text-left rounded-lg border hover:border-primary hover:shadow-md transition-all overflow-hidden bg-white dark:bg-slate-950"
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-sky-500 to-cyan-500 flex items-center justify-center">
              <MessageSquare className="w-3.5 h-3.5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold truncate">{template.name}</p>
            </div>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 capitalize">
              DM
            </Badge>
          </div>
          <div className="px-3 py-2.5">
            <div className="bg-muted/50 rounded-xl rounded-tl-sm px-3 py-2">
              <p className="text-sm line-clamp-3 whitespace-pre-line">{template.content}</p>
            </div>
          </div>
          {template.tags && template.tags.length > 0 && (
            <div className="flex items-center gap-1.5 px-3 pb-2">
              {template.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>
              ))}
            </div>
          )}
        </button>
      );
    }

    // Default card design (email, sms)
    return (
      <button
        key={`${template.source}-${template.id}`}
        onClick={() => handleSelect(template)}
        className="w-full text-left p-4 rounded-lg border hover:border-primary hover:bg-primary/5 transition-all"
      >
        <div className="flex items-start justify-between mb-2">
          <h4 className="font-medium text-sm">{template.name}</h4>
        </div>
        
        {template.subject && (
          <p className="text-xs text-muted-foreground mb-2">
            Subject: {template.subject}
          </p>
        )}
        
        <p className="text-sm text-foreground/60 line-clamp-3">
          {template.content}
        </p>
        
        <div className="flex items-center gap-2 mt-3">
          {template.category && (
            <Badge variant="outline" className="text-xs">
              {template.category}
            </Badge>
          )}
          {template.tags?.slice(0, 2).map((tag) => (
            <Badge key={tag} variant="outline" className="text-xs">
              {tag}
            </Badge>
          ))}
          {template.lastUsedAt && (
            <span className="text-xs text-muted-foreground/60 flex items-center gap-1 ml-auto">
              <Clock className="w-3 h-3" />
              Last used
            </span>
          )}
        </div>
      </button>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        {selectionError && <Callout tone="danger" size="sm">{selectionError}</Callout>}
        {applyingTemplate && !loadingVariableData && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner size="sm" label={null} /> Verifying template…</p>}
        {/* Step indicator when leadId is provided */}
        {(leadId || step === 2) && (
          <div className="flex items-center gap-2 mb-2">
            <div className={`flex items-center gap-1.5 text-xs font-medium ${step === 1 ? "text-primary" : "text-muted-foreground"}`}>
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${step === 1 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                {step > 1 ? <CheckCircle className="w-3.5 h-3.5" /> : "1"}
              </div>
              Select Template
            </div>
            <div className="h-px w-8 bg-border" />
            <div className={`flex items-center gap-1.5 text-xs font-medium ${step === 2 ? "text-primary" : "text-muted-foreground"}`}>
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${step === 2 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                2
              </div>
              Fill Variables
            </div>
          </div>
        )}

        {/* ─── Step 1: Template Selection ─────────────────────── */}
        {step === 1 && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {getChannelIcon()}
                {getChannelLabel()}
              </DialogTitle>
              <DialogDescription>
                {selectionMode === 'follow-up'
                  ? 'Choose reusable wording. Customer variables are filled at send time. Selecting a generated draft or predefined example saves a reusable copy in your library.'
                  : <>Select a template to use as your message.{leadId ? " Variables will be prefilled from lead data." : " You can fill in any template variables before applying it."}</>}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {loadError && <div role="alert" className="space-y-2 text-sm"><p>{loadError}</p><Button variant="outline" size="sm" onClick={() => void loadTemplates()} disabled={loading}>Retry templates</Button></div>}
              <SearchInput
                aria-label="Search templates"
                placeholder="Search templates..."
                value={searchQuery}
                onValueChange={setSearchQuery}
              />

              <div className="mt-4">
                <ScrollArea className="h-[400px]">
                  {loading ? (
                    <LoadingState className="py-8" label="Loading templates…" />
                  ) : filteredTemplates.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <FileText className="w-12 h-12 mx-auto mb-3 text-muted-foreground/40" />
                      <p className="font-medium">No templates found</p>
                      <p className="text-sm mt-1">
                        {searchQuery
                          ? "Try a different search term"
                          : "Create a template in the Templates section"}
                      </p>
                    </div>
                  ) : (
                    <div className="grid gap-3">
                      {filteredTemplates.map(renderTemplateCard)}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </div>
          </>
        )}

        {/* ─── Step 2: Variable Prefill ──────────────────────── */}
        {step === 2 && selectedTemplate && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Variable className="w-5 h-5" />
                Fill Template Variables
              </DialogTitle>
              <DialogDescription>
                Review and fill the values for &ldquo;{selectedTemplate.name}&rdquo;. Reusable templates must pass approval and variable checks before they can be applied.
              </DialogDescription>
            </DialogHeader>

            {loadingVariableData ? (
              <LoadingState label="Loading lead data..." showLabel />
            ) : variableEntries.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <CheckCircle className="w-12 h-12 mx-auto mb-3 text-green-500 dark:text-green-400" />
                <p className="font-medium">No variables to fill</p>
                <p className="text-sm mt-1">This template is ready to use as-is.</p>
              </div>
            ) : (
              <ScrollArea className="max-h-[400px]">
                <div className="space-y-3 pr-4">
                  {variableEntries.map((entry, idx) => (
                    <div key={entry.variable} className="space-y-1.5">
                      <Label className="text-sm flex items-center gap-2">
                        <span className="capitalize">{entry.label}</span>
                        <code className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                          {entry.variable}
                        </code>
                      </Label>
                      <Input
                        aria-label={entry.label}
                        value={entry.value}
                        onChange={(e) => handleVariableChange(idx, e.target.value)}
                        placeholder={`Enter ${entry.label.toLowerCase()}...`}
                        className="h-9"
                      />
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}

            <DialogFooter className="flex justify-between sm:justify-between">
              <Button
                variant="outline"
                size="sm"
                disabled={applyingTemplate}
                onClick={() => {
                  setStep(1);
                  setSelectedTemplate(null);
                  setVariableEntries([]);
                }}
              >
                <ArrowLeft className="w-4 h-4 mr-1" />
                Back
              </Button>
              <Button size="sm" onClick={handleApplyTemplate} disabled={applyingTemplate || loadingVariableData}>
                <CheckCircle className="w-4 h-4 mr-1" />
                Apply Template
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
