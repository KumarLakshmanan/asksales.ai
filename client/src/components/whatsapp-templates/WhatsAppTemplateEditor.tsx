"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Image as ImageIcon,
  Loader2,
  MessageSquareText,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import api, { ApiError } from "@/lib/api";
import { BRAND_URL } from "@/lib/brand";
import { whatsappTemplateControls } from "@/lib/whatsapp-template-controls";
import { WHATSAPP_MAX_VARIABLE_EXAMPLES, whatsappButtonErrors } from "@/lib/whatsapp-template-validation";
import { useToast } from "@/hooks/use-toast";
import { LoadingState } from "@/components/ui/loading-state";
import { curatedWhatsAppTemplates, type WhatsAppButtonType, type WhatsAppDraftButton, type WhatsAppHeaderType, type WhatsAppTemplateButton, type WhatsAppTemplateCategory, type WhatsAppAuthConfig } from "@/components/whatsapp-templates/templateData";
import { WhatsAppPreview } from "@/components/whatsapp-templates/WhatsAppPreview";
import { WhatsAppButtonsEditor, WhatsAppEditorSection, WhatsAppTemplateBuilder, whatsappCategoryOptions } from "@/components/whatsapp-templates/WhatsAppTemplateBuilder";
import { useWhatsAppDraftRecovery } from "./useWhatsAppDraftRecovery";
import { defaultWhatsAppAuth, whatsappAuthErrors, WhatsAppAuthenticationEditor, WhatsAppOptionalSection, WhatsAppCreationChoices, WhatsAppChecklist, WhatsAppReadiness, WhatsAppAICandidate } from "./WhatsAppTemplateTools";
import { WhatsAppTemplateHistory, type TemplateSnapshot } from "./WhatsAppTemplateHistory";
import { WhatsAppTemplateTextEditor } from "@/components/whatsapp-templates/WhatsAppTemplateTextEditor";
import {
  normalizeWhatsAppExamples,
  whatsappExampleKey,
  whatsappVariableError,
  whatsappVariableIndexes,
} from "@/lib/whatsapp-template-variables";

type ButtonType = WhatsAppButtonType;
type DraftButton = WhatsAppDraftButton;
type HeaderType = WhatsAppHeaderType;
type MediaHeaderType = Extract<HeaderType, "IMAGE" | "VIDEO" | "DOCUMENT">;
type MediaDraft = { url: string; file: File | null; preview: string | null };

function isMediaHeader(type: HeaderType | null | undefined): type is MediaHeaderType {
  return type === "IMAGE" || type === "VIDEO" || type === "DOCUMENT";
}

export function normalizeWhatsAppTemplateVariables(value: string): string {
  const placeholders = Array.from(value.matchAll(/{{\s*([^{}]+?)\s*}}/g));
  const hasNamedVariable = placeholders.some((match) => !/^\d+$/.test(match[1].trim()));

  if (!hasNamedVariable) {
    return value.replace(/{{\s*(\d+)\s*}}/g, (_placeholder, rawIndex: string) => `{{${Number(rawIndex)}}}`);
  }

  let nextIndex = 1;
  const variableIndexes = new Map<string, number>();

  return value.replace(/{{\s*([^{}]+?)\s*}}/g, (_placeholder, rawName: string) => {
    const name = rawName.trim();
    const key = /^\d+$/.test(name) ? `numeric:${Number(name)}` : `named:${name.toLowerCase()}`;
    if (!variableIndexes.has(key)) variableIndexes.set(key, nextIndex++);
    return `{{${variableIndexes.get(key)}}}`;
  });
}

const formatOptions = [
  { value: "default", label: "Default", description: "Send messages with media and customized buttons to engage your customers.", icon: MessageSquareText },
];

const fieldClassName = "w-full rounded-[10px] border border-input bg-card px-3 text-sm text-foreground shadow-inner outline-none placeholder:text-muted-foreground/80 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground";
const compactFieldClassName = "rounded-[10px] border border-input bg-card px-3 text-sm text-foreground shadow-inner outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/20";
const mediaLimits: Record<MediaHeaderType, { bytes: number; label: string; types: string[] }> = {
  IMAGE: { bytes: 5 * 1024 * 1024, label: "5 MB", types: ["image/jpeg", "image/png"] },
  VIDEO: { bytes: 16 * 1024 * 1024, label: "16 MB", types: ["video/mp4"] },
  DOCUMENT: { bytes: 100 * 1024 * 1024, label: "100 MB", types: ["application/pdf"] },
};

function validMediaReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8192 || /\s/.test(trimmed)) return false;
  if (trimmed.startsWith("/api/") || trimmed.startsWith("/uploads/")) return true;
  try { return new URL(trimmed).protocol === "https:"; } catch { return /^(?:\d+:){1,2}:?[^\s]+$/.test(trimmed); }
}

interface SavedTemplate {
  id: number;
  name: string;
  language: string;
  category: WhatsAppTemplateCategory;
  status: string;
  wabaTemplateId?: string | null;
  metaStatus?: string | null;
  submissionStatus?: string;
  hasLocalChanges?: boolean;
  header?: string | null;
  headerType?: HeaderType | null;
  headerMediaUrl?: string | null;
  body: string;
  footer?: string | null;
  buttons?: WhatsAppTemplateButton[] | null;
  examples?: Record<string, string> | null;
  variableLabels?: Record<string, string> | null;
  authConfig?: WhatsAppAuthConfig | null;
  updatedAt?: string;
  revision?: string;
  approvedSnapshot?: TemplateSnapshot | null;
}

export default function WhatsAppTemplateEditor({
  templateId,
  templatesPath = "/dashboard/integrations/whatsapp/templates",
}: {
  templateId?: string;
  templatesPath?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const requestedReturn = searchParams.get('returnTo');
  const returnPath = requestedReturn?.startsWith(templatesPath) ? requestedReturn : templatesPath;
  const [authConfig, setAuthConfig] = useState<WhatsAppAuthConfig>(defaultWhatsAppAuth);
  const [variableLabels, setVariableLabels] = useState<Record<string, string>>({});
  const [candidate, setCandidate] = useState<{ body: string; header?: string } | null>(null);
  const [beforeAI, setBeforeAI] = useState<{ body: string; header: string; headerType: HeaderType; examples: Record<string,string> } | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [reattachFile, setReattachFile] = useState<string | null>(null);
  const [conflictingRecord, setConflictingRecord] = useState<SavedTemplate | null>(null);
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const [connection, setConnection] = useState<{ configured: boolean; config?: { wabaName?: string; verifiedName?: string; businessAccountId?: string; connectionStatus?: string; tokenStatus?: string } } | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionRetry, setConnectionRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setConnectionError(null);
    api.get<typeof connection>('/api/whatsapp/config').then(result => { if (active) setConnection(result); }).catch(() => { if (active) setConnectionError('The WhatsApp account could not be checked. Save a draft or retry before submitting.'); });
    return () => { active = false; };
  }, [connectionRetry]);
  const cloneFrom = !templateId ? searchParams.get('cloneFrom') : null;
  const languageVariant = Boolean(cloneFrom && searchParams.get('variant') === 'language');
  const [cloneSource, setCloneSource] = useState<SavedTemplate | null>(null);
  const supportPreset = !templateId && searchParams.get("preset") === "support_ticket_assignment";
  const preset = templateId ? undefined : curatedWhatsAppTemplates.find((item) => item.id === searchParams.get("preset"));
  const initialHeader = supportPreset ? "" : preset?.title || "";
  const initialBody = supportPreset
    ? "New support ticket {{1}} has been assigned to you.\n\nPriority: {{2}}\nSource: {{3}}\nSummary: {{4}}\nAction: {{5}}\nResponse target: {{6}}\nOpen ticket: {{7}}\nPlease review it in AskSales."
    : preset?.body || "";
  const [step, setStep] = useState(searchParams.get('step') === 'review' ? 2 : 0);
  const [editorMode, setEditorMode] = useState<"builder" | "guided">("builder");
  const [mobilePanel, setMobilePanel] = useState<"editor" | "preview">("editor");
  const [focusTarget, setFocusTarget] = useState<{ id: string } | null>(null);
  const [category, setCategory] = useState<WhatsAppTemplateCategory>(supportPreset ? "UTILITY" : preset?.category || "MARKETING");
  const [format, setFormat] = useState("default");
  const [name, setName] = useState(supportPreset ? "support_ticket_assignment_v1" : preset?.name || "");
  const [language, setLanguage] = useState("en_US");
  const [headerType, setHeaderType] = useState<HeaderType>(supportPreset ? "NONE" : preset ? "TEXT" : "NONE");
  const [header, setHeader] = useState(initialHeader);
  const [mediaDrafts, setMediaDrafts] = useState<Partial<Record<MediaHeaderType, MediaDraft>>>({});
  const mediaDraftsRef = useRef(mediaDrafts);
  const headerMediaInput = useRef<HTMLInputElement | null>(null);
  const actionBarRef = useRef<HTMLDivElement | null>(null);
  const [body, setBody] = useState(initialBody);
  const [footer, setFooter] = useState(supportPreset ? "" : preset?.footer || "");
  const [buttons, setButtons] = useState<DraftButton[]>(() => (supportPreset ? [] : preset?.buttons?.map((button) => ({ ...button, url: button.type === "URL" ? "https://example.com" : undefined })) || []).map((button, index) => ({ ...button, id: `initial-button-${index}` })));
  const nextButtonId = useRef(0);
  const [examples, setExamples] = useState<Record<string, string>>(() => supportPreset ? {
    "body:1": "TKT-EXAMPLE", "body:2": "URGENT", "body:3": "WhatsApp", "body:4": "Customer needs booking help",
    "body:5": "Review and reply", "body:6": "20 minutes", "body:7": `${BRAND_URL}/support/tickets/123`,
  } : normalizeWhatsAppExamples(null, initialHeader, initialBody));
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStage, setSaveStage] = useState('');
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const savedDraftId = useRef<number | null>(templateId ? Number(templateId) : null);
  const [recoveryDraftId, setRecoveryDraftId] = useState<number | null>(templateId ? Number(templateId) : null);
  const [checkingMedia, setCheckingMedia] = useState(false);
  const [mediaCheck, setMediaCheck] = useState<{ key: string; note: string; error?: boolean } | null>(null);
  const [loading, setLoading] = useState(Boolean(templateId || cloneFrom));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedRecord, setSavedRecord] = useState<SavedTemplate | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [aiBrief, setAiBrief] = useState("");
  const [generatingWithAI, setGeneratingWithAI] = useState(false);

  useLayoutEffect(() => {
    if (!focusTarget) return;
    const element = document.getElementById(focusTarget.id);
    let parent = element?.parentElement;
    while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
    element?.scrollIntoView?.({ block: "center", behavior: "instant" });
    element?.focus({ preventScroll: true });
  }, [focusTarget]);

  const focusEditorField = (id: string) => {
    if (editorMode === "guided" || step === 2) setStep(1);
    setMobilePanel("editor");
    setFocusTarget({ id });
  };
  const changeMobilePanel = (panel: "editor" | "preview") => {
    setMobilePanel(panel);
    requestAnimationFrame(() => document.getElementById("whatsapp-builder-panels")?.scrollIntoView?.({ block: "start", behavior: "instant" }));
  };

  useEffect(() => { mediaDraftsRef.current = mediaDrafts; }, [mediaDrafts]);
  useEffect(() => () => {
    Object.values(mediaDraftsRef.current).forEach((draft) => {
      if (draft?.preview?.startsWith("blob:")) URL.revokeObjectURL(draft.preview);
    });
  }, []);

  useEffect(() => {
    const sourceId = templateId || cloneFrom;
    if (!sourceId) return;
    if (!Number.isSafeInteger(Number(sourceId)) || Number(sourceId) <= 0) { setLoadError('Invalid source template. Return to the template library and select it again.'); setLoading(false); return; }
    let active = true;
    setLoading(true);
    setLoadError(null);
    api.get<{ success: boolean; template: SavedTemplate }>(`/api/whatsapp/templates/${sourceId}`)
      .then((response) => {
        if (!active) return;
        const template = response.template;
        setSavedRecord(cloneFrom ? null : template);
        setCloneSource(cloneFrom ? template : null);
        setCategory(template.category);
        setName(cloneFrom ? `${template.name.slice(0, 238)}${languageVariant ? '_language_copy' : '_copy'}` : template.name);
        setLanguage(template.language);
        setHeaderType(template.headerType || "NONE");
        setHeader(template.header || "");
        setMediaDrafts(isMediaHeader(template.headerType) ? {
          [template.headerType]: { url: cloneFrom ? '' : template.headerMediaUrl || "", file: null, preview: null },
        } : {});
        setBody(template.body);
        setFooter(template.footer || "");
        setButtons((template.buttons || []).map((button, index) => ({ ...button, id: `loaded-button-${index}` })));
        setExamples({...normalizeWhatsAppExamples(template.examples, template.header || "", template.body), ...(template.examples || {})});
        setVariableLabels(template.variableLabels || {});
        setAuthConfig(template.authConfig || defaultWhatsAppAuth);
        setBaseline(null);
      })
      .catch((error) => {
        if (active) setLoadError(error instanceof Error ? error.message : "Template could not be loaded.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reloadKey, templateId, cloneFrom, languageVariant]);

  const controls = whatsappTemplateControls(savedRecord || {});
  const editingDisabled = saving || generatingWithAI || !controls.canEdit;
  const canSubmitAfterSave = whatsappTemplateControls({ ...savedRecord, hasLocalChanges: true }).canSubmit;
  const headerVariableIndexes = useMemo(() => headerType === "TEXT" ? whatsappVariableIndexes(header) : [], [header, headerType]);
  const bodyVariableIndexes = useMemo(() => whatsappVariableIndexes(body), [body]);
  const variableFields = useMemo(() => [
    ...headerVariableIndexes.map((index) => ({ component: "header" as const, index, key: whatsappExampleKey("header", index) })),
    ...bodyVariableIndexes.map((index) => ({ component: "body" as const, index, key: whatsappExampleKey("body", index) })),
  ], [bodyVariableIndexes, headerVariableIndexes]);
  const currentMedia = isMediaHeader(headerType) ? mediaDrafts[headerType] : undefined;
  const headerVariableValidation = headerType === "TEXT" ? whatsappVariableError(header, "Header") : null;
  const bodyVariableValidation = whatsappVariableError(body, "Body");
  const validExamples = variableFields.length <= WHATSAPP_MAX_VARIABLE_EXAMPLES && variableFields.every((field) => examples[field.key]?.trim());
  const validMedia = !isMediaHeader(headerType) || Boolean(currentMedia?.file || validMediaReference(currentMedia?.url || ""));
  const validHeader = headerType !== "TEXT" || Boolean(header.trim());
  const validButtons = buttons.length <= 3 && buttons.every((button) => Object.keys(whatsappButtonErrors(button)).length === 0);
  const validDetails = name.trim().length > 0 && name.length <= 255 && /^[a-z0-9_]+$/.test(name) && body.trim().length > 0 && body.length <= 1024 && footer.length <= 60 && (headerType !== "TEXT" || header.length <= 60) && validButtons && validExamples && validMedia && validHeader && !headerVariableValidation && !bodyVariableValidation && (!languageVariant || language !== cloneSource?.language);
  const requirements: { label: string; field: string }[] = [];
  if (!name.trim()) requirements.push({ label: "Add a template name", field: "whatsapp-template-name" });
  else if (!/^[a-z0-9_]+$/.test(name) || name.length > 255) requirements.push({ label: "Fix the template name", field: "whatsapp-template-name" });
  if (!body.trim()) requirements.push({ label: "Add a message body", field: "whatsapp-body" });
  else if (body.length > 1024 || bodyVariableValidation) requirements.push({ label: "Fix the message body", field: "whatsapp-body" });
  if (headerType === "TEXT" && (!validHeader || header.length > 60 || headerVariableValidation)) requirements.push({ label: "Complete the text header", field: "whatsapp-header-text" });
  if (!validMedia) requirements.push({ label: "Add header media", field: "whatsapp-upload-button" });
  if (footer.length > 60) requirements.push({ label: "Shorten the footer", field: "whatsapp-footer" });
  const missingExample = variableFields.find((field) => !examples[field.key]?.trim());
  if (missingExample) requirements.push({ label: "Add the missing variable examples", field: `whatsapp-example-${missingExample.key}` });
  if (variableFields.length > WHATSAPP_MAX_VARIABLE_EXAMPLES) requirements.push({ label: "Use up to 20 variable examples", field: "whatsapp-body" });
  buttons.forEach((button, index) => {
    const errors = whatsappButtonErrors(button);
    const field = Object.keys(errors)[0];
    if (field) requirements.push({ label: `Complete button ${index + 1}`, field: `whatsapp-button-${button.id}-${field}` });
  });
  if (buttons.length > 3) requirements.push({ label: "Keep up to three buttons", field: `whatsapp-button-${buttons[3].id}-text` });
  if (languageVariant && language === cloneSource?.language) requirements.push({ label: "Choose a different language", field: "whatsapp-language" });
  const authErrors = category === "AUTHENTICATION" ? whatsappAuthErrors(authConfig) : [];
  authErrors.forEach(label => requirements.push({ label, field: label.includes('expiration') ? 'whatsapp-auth-expiration' : label.includes('autofill') ? 'whatsapp-auth-autofill' : label.includes('package') ? 'whatsapp-auth-package' : label.includes('signature') ? 'whatsapp-auth-signature' : 'whatsapp-auth-button' }));
  const messageComplete = validDetails && authErrors.length === 0;
  const connectionReady = connection?.configured === true && Boolean(connection.config?.businessAccountId) && ['ready','limited'].includes(connection.config?.connectionStatus || '') && !['expired','invalid'].includes(connection.config?.tokenStatus || '');
  const canSaveDraft = variableFields.length <= WHATSAPP_MAX_VARIABLE_EXAMPLES && (!name.trim() || /^[a-z0-9_]+$/.test(name)) && name.length <= 255 && body.length <= 1024 && header.length <= 60 && footer.length <= 60;
  const snapshot = useMemo(() => ({ name, language, category, body, headerType, header, footer, buttons, examples, variableLabels, authConfig,
    mediaReferences: Object.fromEntries(Object.entries(mediaDrafts).map(([type, draft]) => [type, draft?.url || ''])),
    missingFileName: currentMedia?.file?.name || reattachFile || '' }), [name, language, category, body, headerType, header, footer, buttons, examples, variableLabels, authConfig, mediaDrafts, currentMedia?.file?.name, reattachFile]);
  type Snapshot = typeof snapshot;
  const serialized = JSON.stringify(snapshot);
  useEffect(() => { if (!loading && !loadError && baseline === null) setBaseline(serialized); }, [loading, loadError, baseline, serialized]);
  const dirty = baseline !== null && baseline !== serialized;
  const recovery = useWhatsAppDraftRecovery<Snapshot>({ scope: templateId ? `edit:${templateId}` : `create:${cloneFrom || preset?.id || 'blank'}:${languageVariant}`, value: snapshot, dirty,
    revision: savedRecord?.revision || savedRecord?.updatedAt || null, ready: !loading && !loadError,
    isDraft: (value): value is Snapshot => {
      if (!value || typeof value !== 'object') return false;
      const draft = value as Snapshot;
      const strings = (record: unknown) => Boolean(record && typeof record === 'object' && !Array.isArray(record) && Object.values(record).every(item => typeof item === 'string'));
      const auth = draft.authConfig;
      if (!auth || !['COPY_CODE','ONE_TAP'].includes(auth.otpType) || typeof auth.buttonText !== 'string' || !Number.isFinite(auth.codeExpirationMinutes) || typeof auth.addSecurityRecommendation !== 'boolean' || (auth.autofillText !== undefined && typeof auth.autofillText !== 'string') || (auth.packageName !== undefined && typeof auth.packageName !== 'string') || (auth.signatureHash !== undefined && typeof auth.signatureHash !== 'string')) return false;
      if (!strings(draft.examples) || !strings(draft.variableLabels) || !strings(draft.mediaReferences)) return false;
      return ['name','language','body','header','footer','missingFileName'].every(key => typeof draft[key as keyof Snapshot] === 'string') && ['MARKETING','UTILITY','AUTHENTICATION'].includes(draft.category) && ['NONE','TEXT','IMAGE','VIDEO','DOCUMENT'].includes(draft.headerType) && Array.isArray(draft.buttons) && draft.buttons.length <= 3 && draft.buttons.every(button => typeof button.id === 'string' && typeof button.text === 'string' && (button.url === undefined || typeof button.url === 'string') && (button.phone_number === undefined || typeof button.phone_number === 'string') && ['URL','PHONE_NUMBER','QUICK_REPLY'].includes(button.type)) && !!draft.examples && !!draft.variableLabels && !!draft.authConfig && !!draft.mediaReferences;
    },
    onRestore: draft => {
      setName(draft.name); setLanguage(draft.language); setCategory(draft.category); setBody(draft.body); setHeaderType(draft.headerType); setHeader(draft.header); setFooter(draft.footer); setButtons(draft.buttons); setExamples(draft.examples); setVariableLabels(draft.variableLabels); setAuthConfig(draft.authConfig);
      setMediaDrafts(Object.fromEntries(Object.entries(draft.mediaReferences).map(([type,url]) => [type, {url,file:null,preview:null}]))); setReattachFile(draft.missingFileName || null);
    } });
  const leaveEditor = (path: string, discard = false) => {
    if (dirty && !window.confirm(discard ? 'Discard the changes in this editor?' : 'Leave this editor? Your unfinished text is recoverable in this tab. Files that have not uploaded must be selected again.')) return;
    if (discard) recovery.clear(); else recovery.flush();
    router.push(path);
  };
  const changeCategory = (next: WhatsAppTemplateCategory) => {
    if (editingDisabled || controls.categoryLocked) return;
    if (next === 'AUTHENTICATION') {
      if (body.trim() && category !== 'AUTHENTICATION' && !window.confirm('Use a verification-code template? The current message will be replaced with the required code format.')) return;
      setBody('Your verification code is {{1}}.'); setExamples({'body:1':'123456'}); setHeaderType('NONE'); setHeader(''); setFooter(''); setButtons([]);
    }
    setCategory(next);
  };
  useEffect(() => { if (preset?.authConfig) { setAuthConfig(preset.authConfig); setHeaderType('NONE'); setHeader(''); setFooter(''); setButtons([]); setExamples({'body:1':'123456'}); } }, [preset]);
  const activeFormat = formatOptions.find((item) => item.value === format) || formatOptions[0];
  const previewNotes = useMemo(() => category === "MARKETING" ? {
    goodFor: "Welcome messages, promotions, offers, coupons, newsletters, announcements",
    areas: "Media, header, body, footer, button",
  } : category === "UTILITY" ? {
    goodFor: "Order updates, account alerts, appointments, payments and customer service",
    areas: "Header, body, footer, button",
  } : {
    goodFor: "One-time passwords, account verification and login security",
    areas: "Header, body, footer, button",
  }, [category]);

  const addButton = (type: ButtonType = "QUICK_REPLY") => {
    if (editingDisabled || buttons.length >= 3) return;
    const id = `new-button-${nextButtonId.current++}`;
    setButtons((current) => current.length >= 3 ? current : [...current, { id, type, text: type === "QUICK_REPLY" ? "Reply" : type === "URL" ? "Visit website" : "Call us", ...(type === "URL" ? { url: "" } : type === "PHONE_NUMBER" ? { phone_number: "" } : {}) }]);
    focusEditorField(`whatsapp-button-${id}-text`);
  };

  const updateButton = (id: string, patch: Partial<WhatsAppTemplateButton>) => {
    if (editingDisabled) return;
    setButtons((current) => current.map((button) => {
      if (button.id !== id) return button;
      const updated = { ...button, ...patch };
      if (updated.type !== "URL") delete updated.url;
      if (updated.type !== "PHONE_NUMBER") delete updated.phone_number;
      return updated;
    }));
  };
  const removeButton = (id: string) => {
    if (!editingDisabled) setButtons((current) => current.filter((button) => button.id !== id));
  };
  const moveButton = (from: string, to: string) => {
    if (editingDisabled) return;
    setButtons((current) => {
      const fromIndex = current.findIndex((button) => button.id === from);
      const toIndex = current.findIndex((button) => button.id === to);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return current;
      const reordered = [...current];
      reordered.splice(toIndex, 0, reordered.splice(fromIndex, 1)[0]);
      return reordered;
    });
  };
  const addVariableExample = (component: "header" | "body", index: number) => {
    const key = whatsappExampleKey(component, String(index));
    const existingIndexes = component === "header" ? headerVariableIndexes : bodyVariableIndexes;
    setExamples((current) => ({ ...current, [key]: existingIndexes.includes(String(index)) ? current[key] || "" : "" }));
  };

  const selectHeaderMedia = (file: File | null) => {
    if (editingDisabled || !isMediaHeader(headerType)) return;
    if (file) {
      const rule = mediaLimits[headerType];
      if (!rule.types.includes(file.type)) {
        setMediaError(`${headerType === "IMAGE" ? "Images must be JPEG or PNG" : headerType === "VIDEO" ? "Videos must be MP4" : "Documents must be PDF"}.`);
        return;
      }
      if (file.size > rule.bytes) {
        setMediaError(`${headerType[0]}${headerType.slice(1).toLowerCase()} files must be ${rule.label} or smaller.`);
        return;
      }
    }
    setMediaError(null); setReattachFile(null);
    setMediaDrafts((drafts) => {
      const existing = drafts[headerType];
      if (existing?.preview?.startsWith("blob:")) URL.revokeObjectURL(existing.preview);
      return { ...drafts, [headerType]: { url: existing?.url || "", file, preview: file ? URL.createObjectURL(file) : null } };
    });
  };

  const changeHeaderType = (nextType: HeaderType, focus = false) => {
    if (editingDisabled) return;
    setMediaError(null);
    setHeaderType(nextType);
    if (focus) focusEditorField(nextType === "TEXT" ? "whatsapp-header-text" : "whatsapp-upload-button");
  };

  const generateWithAI = async () => {
    if (editingDisabled || generatingWithAI) return;
    if (category === "AUTHENTICATION") return;
    if (!aiBrief.trim()) {
      toast({ title: "Describe the WhatsApp message", description: "Add the offer, update, or customer action you want the template to cover.", variant: "destructive" });
      return;
    }
    setGeneratingWithAI(true);
    try {
      const response = await api.post<{ success: boolean; message?: string; content?: string; subject?: string; error?: string }>(
        "/api/content/studio/social-message",
        {
          prompt: `Create a reusable WhatsApp ${category.toLowerCase()} template. ${aiBrief.trim()} Use numbered Meta variables such as {{1}} and {{2}} where personalization is needed.`,
          platform: "whatsapp",
          persist: false,
        },
      );
      const generatedBody = response.message || response.content;
      if (!response.success || !generatedBody) throw new Error(response.error || "AI did not return template copy");
      setCandidate({ body: normalizeWhatsAppTemplateVariables(generatedBody), header: response.subject?.trim() ? normalizeWhatsAppTemplateVariables(response.subject.trim()) : undefined });
      toast({ title: "Generated copy is ready", description: "Review the suggestion before applying it to your message." });
    } catch (error) {
      toast({ title: "Could not generate WhatsApp copy", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setGeneratingWithAI(false);
    }
  };

  const checkMediaUrl = async () => {
    const url = currentMedia?.url.trim() || '';
    if (editingDisabled || !isMediaHeader(headerType) || !url.startsWith('https://') || checkingMedia) return;
    const key = `${headerType}:${url}`;
    setCheckingMedia(true); setMediaError(null); setMediaCheck(null);
    try {
      const result = await api.post<{ mimeType: string; sizeBytes: number; note: string }>('/api/whatsapp/templates/media-preflight', { url, headerType });
      setMediaCheck({ key, note: `${result.mimeType} · ${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB. ${result.note}` });
    } catch (error) { setMediaCheck({ key, error: true, note: error instanceof Error ? error.message : 'Media could not be checked. Upload a file instead.' }); }
    finally { setCheckingMedia(false); }
  };

  const saveTemplate = async (submitToMeta = false) => {
    if (!canSaveDraft || editingDisabled || conflictingRecord || savingRef.current || (submitToMeta && (!messageComplete || !canSubmitAfterSave || !connectionReady))) return;
    savingRef.current = true;
    let failureStage: "draft" | "media" | "submission" = "draft";
    let savedMediaUrl = currentMedia?.url || "";
    try {
      setSaving(true); setSaveError(null); setSaveStage('Saving draft'); setUploadProgress(null);
      const payload = {
        name: name.trim() || `untitled_${crypto.randomUUID().slice(0, 8)}`,
        draftOnly: true,
        clientRevision: savedRecord?.revision || savedRecord?.updatedAt,
        authConfig: category === 'AUTHENTICATION' ? authConfig : null,
        variableLabels: Object.fromEntries(variableFields.map(field => [field.key, variableLabels[field.key] || ''])) ,
        language,
        category,
        body: body.trim(),
        header: headerType === "TEXT" ? header.trim() : null,
        headerType,
        headerMediaUrl: isMediaHeader(headerType) ? currentMedia?.url.trim() || null : null,
        footer: footer.trim() || null,
        buttons: buttons.map((button) => ({ type: button.type, text: button.text, ...(button.type === "URL" ? { url: button.url } : button.type === "PHONE_NUMBER" ? { phone_number: button.phone_number } : {}) })),
        examples: Object.fromEntries(variableFields.map((field) => [field.key, (examples[field.key] || "").trim()])),
      };
      const saved = savedDraftId.current
        ? await api.put<{ success: boolean; template: SavedTemplate }>(`/api/whatsapp/templates/${savedDraftId.current}`, payload)
        : await api.post<{ success: boolean; template: SavedTemplate }>("/api/whatsapp/templates", payload);
      const savedTemplateId = saved.template?.id || Number(templateId);
      if (!Number.isSafeInteger(savedTemplateId) || savedTemplateId <= 0) throw new Error('The save response did not identify the draft. Check My templates before retrying.');
      savedDraftId.current = savedTemplateId;
      setRecoveryDraftId(savedTemplateId);
      setSavedRecord(saved.template);
      setName(saved.template.name || payload.name);
      if (currentMedia?.file && savedTemplateId) {
          failureStage = "media";
          setSaveStage('Uploading header media'); setUploadProgress(0);
          const mediaData = new FormData();
          mediaData.append("file", currentMedia.file);
          const uploaded = await api.postForm<{ url: string; template?: SavedTemplate }>(`/api/whatsapp/templates/${savedTemplateId}/media`, mediaData, { onUploadProgress: setUploadProgress });
          savedMediaUrl = uploaded.url; setReattachFile(null);
          if (isMediaHeader(headerType)) setMediaDrafts(drafts => {
            if (drafts[headerType]?.preview?.startsWith('blob:')) URL.revokeObjectURL(drafts[headerType]!.preview!);
            return { ...drafts, [headerType]: { url: uploaded.url, file: null, preview: null } };
          });
          if (uploaded.template) setSavedRecord(uploaded.template);
          setSaveStage('Header media saved');
      }
      recovery.clear(); setBaseline(JSON.stringify({ ...snapshot, name: saved.template.name || payload.name, mediaReferences: isMediaHeader(headerType) ? { ...snapshot.mediaReferences, [headerType]: savedMediaUrl } : snapshot.mediaReferences, missingFileName: '' }));
      if (submitToMeta && savedTemplateId) {
        failureStage = "submission";
        setSaveStage('Submitting to Meta');
        await api.post(`/api/whatsapp/templates/${savedTemplateId}/submit`, {});
        toast({ title: "Template submitted to Meta", description: "Approval status will update when templates are synchronized." });
        router.push(returnPath);
        return;
      }
      toast({ title: templateId ? "WhatsApp template updated" : "WhatsApp template saved", description: templateId ? "Your changes have been saved." : "Your template is now available in My templates as a draft." });
      router.push(templateId ? `${templatesPath}/${templateId}?returnTo=${encodeURIComponent(returnPath)}` : returnPath);
    } catch (error) {
      if (savedDraftId.current) {
        try {
          const latest = await api.get<{ template: SavedTemplate }>(`/api/whatsapp/templates/${savedDraftId.current}`);
          // Preserve the original revision after a failed write. Retrying must not silently overwrite another editor's save.
          if (failureStage === 'draft' && error instanceof ApiError && error.status === 409) setConflictingRecord(latest.template);
          else if (failureStage !== 'draft') setSavedRecord(latest.template);
        } catch { /* Keep the recovery link visible when status cannot be checked. */ }
      }
      const recovery = failureStage === "media" ? ' Your draft is saved and your selected file is still here. Use Save draft to retry the upload.'
        : failureStage === "submission" ? ' Your local draft is saved; check its latest status before submitting again.'
          : savedDraftId.current ? ' Your edits are still here. Use Save draft to retry.' : '';
      setSaveError(`${error instanceof Error ? error.message : 'Please try again.'}${recovery}`);
      toast({ title: failureStage === "media" ? "Draft saved; upload needs a retry" : failureStage === "submission" ? "Draft saved; Meta submission needs attention" : "Could not save template", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setSaving(false); savingRef.current = false;
    }
  };

  if (loading) return <LoadingState size="page" className="min-h-[70vh] bg-background" label="Loading template…" showLabel />;
  if (loadError) return <div className="flex min-h-[70vh] items-center justify-center bg-background px-4"><div className="max-w-md rounded-[14px] border border-card-border bg-card p-6 text-center shadow-sm"><h1 className="text-lg font-semibold">Template could not be loaded</h1><p className="mt-2 text-sm text-muted-foreground">{loadError}</p><div className="mt-5 flex justify-center gap-2"><button onClick={() => router.push(templatesPath)} className="rounded-[10px] border px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">Back to templates</button><button onClick={() => setReloadKey((value) => value + 1)} className="rounded-[10px] bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">Try again</button></div></div></div>;

  const generalSection = <WhatsAppEditorSection title="Template setup">
    <div className="mb-3 flex flex-wrap gap-2" aria-label="Template category">{whatsappCategoryOptions.map(option => <button key={option.value} type="button" aria-pressed={category === option.value} disabled={controls.categoryLocked || editingDisabled} onClick={() => changeCategory(option.value)} className={`min-h-9 rounded-lg border px-3 text-xs font-medium ${category === option.value ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'}`}>{option.label}</button>)}</div>
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
      <label className="block"><span className="text-sm font-semibold">Template name</span><input id="whatsapp-template-name" aria-invalid={Boolean(name && !/^[a-z0-9_]+$/.test(name))} aria-describedby="whatsapp-template-name-hint" disabled={controls.linked || editingDisabled} value={name} onChange={(event) => setName(event.target.value.toLowerCase().replace(/\s+/g, "_"))} maxLength={255} placeholder="e.g. summer_offer" className={`${fieldClassName} mt-1.5 min-h-11 ${name && !/^[a-z0-9_]+$/.test(name) ? "border-destructive" : ""}`} /><span id="whatsapp-template-name-hint" className={`mt-1 block text-xs ${name && !/^[a-z0-9_]+$/.test(name) ? "text-destructive" : "text-muted-foreground"}`}>Lowercase letters, numbers and underscores only.</span></label>
      <label className="block"><span className="text-sm font-semibold">Language</span><select id="whatsapp-language" aria-label="Language" disabled={controls.linked || editingDisabled} value={language} onChange={(event) => setLanguage(event.target.value)} className={`${fieldClassName} mt-1.5 min-h-11`}><option value="en_US">English (US)</option><option value="en_GB">English (UK)</option><option value="hi">Hindi</option><option value="ta">Tamil</option>{!['en_US', 'en_GB', 'hi', 'ta'].includes(language) && <option value={language}>{language}</option>}</select>{languageVariant && language === cloneSource?.language && <span className="mt-1 block text-xs text-destructive">Choose a language different from the original.</span>}</label>
    </div>
  </WhatsAppEditorSection>;

  const headerSection = <WhatsAppEditorSection title={headerType === "NONE" ? "Header" : `Header — ${headerType[0]}${headerType.slice(1).toLowerCase()}`} note="Optional" actions={<>
    <select aria-label="Header type" disabled={editingDisabled} value={headerType} onChange={(event) => changeHeaderType(event.target.value as HeaderType)} className={`${compactFieldClassName} min-h-11`}><option value="NONE">None</option><option value="TEXT">Text</option><option value="IMAGE">Image</option><option value="VIDEO">Video</option><option value="DOCUMENT">Document</option></select>
    {headerType !== "NONE" && <button type="button" aria-label="Remove header" disabled={editingDisabled} onClick={() => changeHeaderType("NONE")} className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><Trash2 className="h-4 w-4" /></button>}
  </>}>
    {headerType === "NONE" && <p className="rounded-[10px] border border-dashed p-5 text-center text-sm text-muted-foreground">Add a text or media header using the header type selector{editorMode === "builder" ? " or the component sidebar" : ""}.</p>}
    {headerType === "TEXT" && <WhatsAppTemplateTextEditor component="header" value={header} onChange={setHeader} onVariableAdded={(index) => addVariableExample("header", index)} disabled={editingDisabled} error={headerVariableValidation || (!validHeader ? "Add header text or choose None." : null)} />}
    {isMediaHeader(headerType) && <div className="space-y-3">
      <div onDragOver={event => { if (!editingDisabled) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (!editingDisabled) selectHeaderMedia(event.dataTransfer.files[0] || null); }} aria-label="Drop header file here" className="flex min-h-24 items-center justify-center overflow-hidden rounded-[10px] border border-dashed bg-muted/30 px-3 text-sm text-muted-foreground">
        {currentMedia?.preview && headerType === "IMAGE" ? <img src={currentMedia.preview} alt="WhatsApp header preview" className="max-h-40 w-full object-contain" /> : currentMedia?.preview && headerType === "VIDEO" ? <video src={currentMedia.preview} controls className="max-h-40 w-full" /> : <span className="flex min-w-0 items-center gap-2"><ImageIcon className="h-4 w-4 shrink-0" /><span className="break-all">{currentMedia?.file?.name || currentMedia?.url || `${headerType.toLowerCase()} media preview`}</span></span>}
      </div>
      {reattachFile && !currentMedia?.file && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">Reattach {reattachFile}. Browser recovery saved your text, but this file had not finished uploading.</p>}
      {currentMedia?.file && <p className="break-words text-xs text-muted-foreground">{currentMedia.file.name} · {(currentMedia.file.size / 1024 / 1024).toFixed(2)} MB</p>}
      <input key={headerType} ref={headerMediaInput} id="whatsapp-header-media" aria-hidden="true" aria-label={currentMedia?.file ? "Replace file" : "Upload file"} tabIndex={-1} type="file" disabled={editingDisabled} accept={headerType === "IMAGE" ? "image/jpeg,image/png" : headerType === "VIDEO" ? "video/mp4" : "application/pdf"} onChange={(event) => { selectHeaderMedia(event.target.files?.[0] || null); event.target.value = ""; }} className="sr-only" />
      <div className="flex flex-wrap gap-2">
        <button id="whatsapp-upload-button" type="button" disabled={editingDisabled} onClick={() => headerMediaInput.current?.click()} className="inline-flex min-h-11 items-center gap-2 rounded-lg border bg-card px-3 text-xs font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"><Upload className="h-3.5 w-3.5" />{currentMedia?.file ? "Replace file" : "Upload file"}</button>
        {currentMedia?.file && <button type="button" disabled={editingDisabled} onClick={() => selectHeaderMedia(null)} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-xs font-medium text-destructive hover:bg-destructive/10"><Trash2 className="h-3.5 w-3.5" />Remove file</button>}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />or provide a public HTTPS URL<span className="h-px flex-1 bg-border" /></div>
      <input id="whatsapp-header-url" aria-label="WhatsApp header media URL" value={currentMedia?.url || ""} onChange={(event) => { setMediaError(null); setMediaDrafts((drafts) => ({ ...drafts, [headerType]: { file: drafts[headerType]?.file || null, preview: drafts[headerType]?.preview || null, url: event.target.value } })); }} disabled={editingDisabled || Boolean(currentMedia?.file)} className={`${fieldClassName} min-h-11 ${!currentMedia?.file && currentMedia?.url && !validMediaReference(currentMedia.url) ? "border-destructive" : ""}`} placeholder="https://your-business.com/header.jpg" />
      <p className="text-xs leading-5 text-muted-foreground">{headerType === "IMAGE" ? "JPEG or PNG, up to 5 MB." : headerType === "VIDEO" ? "MP4, up to 16 MB." : "PDF, up to 100 MB."} Drag a file here or use Upload file. Existing provider handles stay available for saved templates.</p>
      {!currentMedia?.file && currentMedia?.url.trim().startsWith('https://') && <button type="button" onClick={() => void checkMediaUrl()} disabled={editingDisabled || checkingMedia} className="min-h-11 rounded-lg border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-60">{checkingMedia ? 'Checking media…' : 'Check public media URL'}</button>}
      {mediaCheck?.key === `${headerType}:${currentMedia?.url.trim()}` && <p role={mediaCheck.error ? 'alert' : 'status'} className={`text-xs ${mediaCheck.error ? 'text-destructive' : 'text-muted-foreground'}`}>{mediaCheck.note}</p>}
      {(mediaError || !validMedia) && <p role="alert" className="text-xs text-destructive">{mediaError || `Add a valid ${headerType.toLowerCase()} file, HTTPS URL, or Meta media handle.`}</p>}
    </div>}
  </WhatsAppEditorSection>;

  const bodySection = <WhatsAppEditorSection title="Body" note="Required"><WhatsAppTemplateTextEditor component="body" value={body} onChange={setBody} onVariableAdded={(index) => addVariableExample("body", index)} disabled={editingDisabled} error={bodyVariableValidation || (!body.trim() ? "Add the message body." : body.length > 1024 ? "Use 1,024 characters or fewer." : null)} /></WhatsAppEditorSection>;
  const examplesSection = variableFields.length > 0 && <WhatsAppEditorSection title="Variable examples" note="Required for variables">
    <p className="mb-3 text-xs leading-5 text-muted-foreground">Header and body variables are numbered independently. Add a realistic example for each one.</p>
    <div className="grid gap-3">{variableFields.map((field) => <label key={field.key} className="block"><span className="text-xs font-medium capitalize">{field.component} {`{{${field.index}}}`}</span><input aria-label={`Label for ${field.component} {{${field.index}}}`} value={variableLabels[field.key] || ''} maxLength={80} disabled={editingDisabled} onChange={event => setVariableLabels(current => ({...current,[field.key]:event.target.value}))} placeholder="Label, such as Customer name" className={`${fieldClassName} mt-1 min-h-11`} /><span className="mt-2 block text-xs text-muted-foreground">Sample value for the preview and approval review</span><input id={`whatsapp-example-${field.key}`} aria-label={`Example for ${field.component} {{${field.index}}}`} disabled={editingDisabled} value={examples[field.key] || ""} onChange={(event) => setExamples((current) => ({ ...current, [field.key]: event.target.value }))} maxLength={1024} className={`${fieldClassName} mt-1 min-h-11`} placeholder={`Example ${field.index}`} /></label>)}</div>
    {variableFields.length > WHATSAPP_MAX_VARIABLE_EXAMPLES ? <p className="mt-2 text-xs text-destructive">Up to 20 variable examples are supported. Remove extra variables before saving.</p> : !validExamples && <p className="mt-2 text-xs text-destructive">Add an example for every header and body variable.</p>}
  </WhatsAppEditorSection>;
  const footerSection = <WhatsAppEditorSection title="Footer" note="Optional"><input id="whatsapp-footer" aria-label="Footer" aria-invalid={footer.length > 60} disabled={editingDisabled} value={footer} onChange={(event) => setFooter(event.target.value)} maxLength={60} className={`${fieldClassName} min-h-11`} placeholder="Footer text" /><span className="mt-2 block text-right font-mono text-xs tabular-nums text-muted-foreground">{footer.length}/60</span></WhatsAppEditorSection>;
  const buttonEditor = <WhatsAppButtonsEditor buttons={buttons} disabled={editingDisabled} valid={validButtons} sortable={editorMode === "builder"} onAdd={() => addButton()} onUpdate={updateButton} onRemove={removeButton} onMove={moveButton} />;
  const aiSection = <WhatsAppEditorSection id="whatsapp-ai" title="Generate copy with AI" actions={<Sparkles className="h-4 w-4 text-primary" />}>
    <p className="text-xs leading-5 text-muted-foreground">Describe the message goal and offer. Review the generated copy and examples before saving.</p>
    <textarea id="whatsapp-ai-brief" aria-label="WhatsApp AI brief" disabled={editingDisabled || generatingWithAI} value={aiBrief} onChange={(event) => setAiBrief(event.target.value)} rows={3} className={`${fieldClassName} mt-3 resize-y p-3`} placeholder="Example: An appointment reminder sent one day before the booking, with the customer name and appointment time." />
    <button type="button" onClick={() => void generateWithAI()} disabled={editingDisabled || generatingWithAI || !aiBrief.trim()} className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-primary/30 px-4 text-xs font-semibold text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{generatingWithAI ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}{generatingWithAI ? "Generating copy…" : "Generate copy"}</button>
    {candidate && <WhatsAppAICandidate {...candidate} error={candidate.body.length > 1024 || (candidate.header?.length || 0) > 60 ? 'The suggestion exceeds the message limits. Regenerate with a shorter brief; your existing copy is unchanged.' : undefined} onApply={() => { setBeforeAI({body,header,headerType,examples}); setBody(candidate.body); if (candidate.header && (headerType === 'NONE' || headerType === 'TEXT')) { setHeaderType('TEXT'); setHeader(candidate.header); } setExamples(normalizeWhatsAppExamples(examples,candidate.header || header,candidate.body)); setCandidate(null); }} onDiscard={() => setCandidate(null)} onRegenerate={() => void generateWithAI()} />}
    {beforeAI && <button type="button" className="mt-3 text-sm text-primary underline" disabled={editingDisabled} onClick={() => { setBody(beforeAI.body); setHeader(beforeAI.header); setHeaderType(beforeAI.headerType); setExamples(beforeAI.examples); setBeforeAI(null); }}>Undo applied AI copy</button>}
  </WhatsAppEditorSection>;
  const authSection = <WhatsAppAuthenticationEditor value={authConfig} onChange={setAuthConfig} disabled={editingDisabled} />;
  const editableBody = category === 'AUTHENTICATION' ? authSection : bodySection;
  const optionalHeader = category !== 'AUTHENTICATION' && (editorMode === 'builder' ? headerSection : <WhatsAppOptionalSection title="Header" expanded={headerType !== 'NONE'}>{headerSection}</WhatsAppOptionalSection>);
  const optionalFooter = category !== 'AUTHENTICATION' && (editorMode === 'builder' ? footerSection : <WhatsAppOptionalSection title="Footer" expanded={Boolean(footer)}>{footerSection}</WhatsAppOptionalSection>);
  const optionalButtons = category !== 'AUTHENTICATION' && (editorMode === 'builder' ? buttonEditor : <WhatsAppOptionalSection title="Buttons" expanded={buttons.length > 0}>{buttonEditor}</WhatsAppOptionalSection>);
  const optionalAI = category !== 'AUTHENTICATION' && <WhatsAppOptionalSection title="Generate copy with AI" expanded={Boolean(candidate || beforeAI)}>{aiSection}</WhatsAppOptionalSection>;
  const preview = <WhatsAppPreview title={headerType === "TEXT" ? header : undefined} body={body} footer={footer} buttons={buttons} showMedia={isMediaHeader(headerType)} mediaType={headerType} mediaUrl={currentMedia?.preview || currentMedia?.url} examples={examples} variableLabels={variableLabels} authConfig={category === "AUTHENTICATION" ? authConfig : undefined} showControls bottomBoundary={editorMode === 'builder' && step !== 2 ? actionBarRef : undefined} />;
  const readiness = <WhatsAppReadiness requirements={requirements} complete={messageComplete} variableCount={variableFields.length} onFocus={focusEditorField} />;
  const backLabel = step === 2 ? editorMode === "builder" ? "Back to builder" : "Back" : editorMode === "builder" || step === 0 ? templateId ? "Cancel" : "Discard" : "Back";

  return <div className="outreach-workspace wa-template-editor flex min-h-full flex-col bg-background">
    <div className="mx-auto w-full max-w-[1460px] flex-1 px-4 py-5 sm:px-6 lg:px-8">
      <div className="mb-5 flex flex-col gap-4 border-b border-border pb-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <button type="button" disabled={saving} onClick={() => leaveEditor(returnPath)} className="mb-2 inline-flex min-h-8 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" />Back to templates</button>
          <h1 className="text-2xl font-semibold tracking-tight">{templateId ? "Edit template" : "Create template"}</h1>
          <p className="mt-1 max-w-lg text-sm text-muted-foreground">Build your message, check the preview, then save a draft or review it for Meta.</p>
        </div>
        <div className="flex flex-col items-start gap-3 xl:items-end">
          <div role="group" aria-label="Editor view" className="inline-flex rounded-[10px] border bg-muted/40 p-1">
            {(["builder", "guided"] as const).map((mode) => <button key={mode} type="button" disabled={saving} aria-pressed={editorMode === mode} onClick={() => { if (editorMode !== mode) { setEditorMode(mode); setMobilePanel("editor"); if (step === 2) setStep(1); } }} className={`min-h-11 rounded-md px-5 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${editorMode === mode ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{mode === "builder" ? "Builder" : "Guided"}</button>)}
          </div>
          {editorMode === "guided" && <ol className="flex flex-wrap items-center gap-1 text-xs font-medium">
            {["Setup", "Write message", "Review"].map((label, index) => <li key={label} className="flex items-center"><button type="button" onClick={() => index < step && setStep(index)} disabled={saving || index > step} className={`flex min-h-8 items-center gap-2 ${index <= step ? "text-foreground" : "text-muted-foreground/60"}`}><span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${index <= step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{index < step ? <Check className="h-3 w-3" /> : index + 1}</span>{label}</button>{index < 2 && <span className="mx-2 h-px w-3 bg-border" />}</li>)}
          </ol>}
        </div>
      </div>
      {recovery.banner}
      {conflictingRecord && <div role="alert" className="mb-4 rounded-xl border border-amber-400 bg-amber-50 p-4 dark:bg-amber-950/30"><h2 className="font-semibold">This template was changed in another editor</h2><p className="mt-1 text-sm">Your text is still here. Compare the saved message before reloading the latest version.</p><details className="mt-3"><summary className="cursor-pointer text-sm font-medium">Compare messages</summary><div className="mt-2 grid gap-3 sm:grid-cols-2"><div><h3 className="text-xs font-semibold">Latest saved message</h3><p className="whitespace-pre-wrap text-sm">{conflictingRecord.body}</p></div><div><h3 className="text-xs font-semibold">Your unsaved message</h3><p className="whitespace-pre-wrap text-sm">{body}</p></div></div></details><button type="button" className="mt-3 rounded-lg border px-3 py-2 text-sm" onClick={() => { if (!window.confirm('Reload the latest saved version? Your current editor changes will be discarded.')) return; recovery.clear(); setConflictingRecord(null); setSaveError(null); setReloadKey(value => value + 1); }}>Reload latest saved version</button></div>}
      {!templateId && !cloneFrom && !preset && <WhatsAppCreationChoices disabled={editingDisabled} onBlank={() => { if (dirty && !window.confirm('Start a blank message and discard current edits?')) return; recovery.clear(); setName(''); setLanguage('en_US'); setCategory('MARKETING'); setAuthConfig(defaultWhatsAppAuth); setBody(''); setHeader(''); setHeaderType('NONE'); setFooter(''); setButtons([]); setExamples({}); setVariableLabels({}); setCandidate(null); setBeforeAI(null); setReattachFile(null); setMediaDrafts(drafts => { Object.values(drafts).forEach(draft => { if (draft?.preview?.startsWith('blob:')) URL.revokeObjectURL(draft.preview); }); return {}; }); }} onPattern={() => leaveEditor(`${templatesPath}?view=library`)} onAI={() => focusEditorField('whatsapp-ai-brief')} />}
      <p role="status" className={`mb-3 rounded-lg border px-3 py-2 text-xs ${dirty ? 'border-amber-300/60 bg-amber-500/5 text-amber-800 dark:text-amber-200' : 'border-border bg-muted/20 text-muted-foreground'}`}>{dirty ? recovery.status : savedRecord ? 'Saved draft loaded' : 'Start writing your message. Unfinished text is recovered in this tab.'}</p>
      {cloneSource && <div role="note" className="mb-4 rounded-[10px] border border-primary/25 bg-primary/5 p-3 text-sm"><p className="font-medium">{languageVariant ? 'Create a language variant' : 'Clone as a new draft'} of {cloneSource.name}</p><p className="mt-1 text-muted-foreground">The original and its Meta approval stay unchanged. Choose a unique name.{languageVariant ? ' Choose a different language, then translate the message, button labels and examples before saving. Text is not automatically translated.' : ''}{isMediaHeader(cloneSource.headerType) ? ' Add a new header file or URL; private uploads and provider handles are not shared between drafts.' : ''}</p></div>}
      {controls.notice && <p role="status" className="mb-4 rounded-[10px] border bg-muted/40 p-3 text-sm">{controls.notice} {recoveryDraftId && <button type="button" disabled={refreshingStatus} className="underline disabled:opacity-50" onClick={async () => { setRefreshingStatus(true); try { const result = await api.post<{template:SavedTemplate}>(`/api/whatsapp/templates/${savedDraftId.current}/refresh`, {}); setSavedRecord(result.template); } catch (error) { toast({title:'Status could not be refreshed', description:error instanceof Error ? error.message : 'Please try again.',variant:'destructive'}); } finally { setRefreshingStatus(false); } }}>{refreshingStatus ? 'Checking status…' : 'Refresh status'}</button>}</p>}
      <div inert={saving}>
        {editorMode === "builder" && step !== 2 ? <WhatsAppTemplateBuilder category={category} onCategoryChange={changeCategory} categoryLocked={controls.categoryLocked} headerType={headerType} onHeaderTypeChange={(type) => changeHeaderType(type, true)} buttons={buttons} onAddButton={addButton} onMoveButton={moveButton} disabled={editingDisabled} general={generalSection} header={optionalHeader} body={editableBody} examples={examplesSection} footer={optionalFooter} buttonEditor={optionalButtons} ai={optionalAI} preview={preview} readiness={readiness} mobileTab={mobilePanel} onMobileTabChange={changeMobilePanel} />
          : <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0">
              {step === 0 && <WhatsAppEditorSection title="Set up your template">
                <p className="text-sm text-muted-foreground">Choose the category that best describes your message, then select the template type.</p>
                <div className="mt-4 grid overflow-hidden rounded-[10px] border border-card-border sm:grid-cols-3">{whatsappCategoryOptions.map(({ value, label, icon: Icon }) => <button key={value} type="button" disabled={controls.categoryLocked || editingDisabled} onClick={() => changeCategory(value)} aria-pressed={category === value} className={`flex min-h-11 items-center justify-center gap-2 border-b text-sm font-medium last:border-b-0 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed sm:border-b-0 sm:border-r sm:last:border-r-0 ${category === value ? "bg-primary/10 text-primary" : "bg-card hover:bg-muted"}`}><Icon className="h-4 w-4" />{label}</button>)}</div>
                <div className="mt-3 overflow-hidden rounded-[10px] border border-card-border">{formatOptions.map(({ value, label, description, icon: Icon }) => <label key={value} className={`flex cursor-pointer items-start gap-3 px-3 py-3 ${format === value ? "bg-primary/10" : "hover:bg-muted/50"}`}><input type="radio" disabled={editingDisabled} name="wa-format" checked={format === value} onChange={() => setFormat(value)} className="mt-1 h-4 w-4 accent-primary" /><Icon className="mt-0.5 h-4 w-4 text-muted-foreground" /><span><span className="block text-sm font-medium">{label}</span><span className="mt-0.5 block text-xs text-muted-foreground">{description}</span></span></label>)}</div>
              </WhatsAppEditorSection>}
              {step === 1 && <div className="space-y-4">{generalSection}{editableBody}{examplesSection}{optionalHeader}{optionalFooter}{optionalButtons}{optionalAI}</div>}
              {step === 2 && <WhatsAppEditorSection id="whatsapp-review" title="Review your template">
                <p className="text-sm text-muted-foreground">Confirm the details and message preview before saving or submitting for approval.</p>
                <dl className="mt-5 divide-y overflow-hidden rounded-[10px] border border-card-border">{[['Template name', name], ['Language', language.replace('_', '-')], ['Category', category], ['Template type', activeFormat.label], ['Header', headerType], ['Media', isMediaHeader(headerType) ? currentMedia?.file?.name || currentMedia?.url || 'Missing' : 'None'], ['Variables', variableFields.length ? variableFields.map((field) => `${field.component} {{${field.index}}} = ${examples[field.key]}`).join(', ') : 'None'], ['Buttons', category === 'AUTHENTICATION' ? authConfig.buttonText : buttons.length ? buttons.map((button) => `${button.text}${button.url ? ` → ${button.url}` : button.phone_number ? ` → ${button.phone_number}` : ''}`).join(', ') : 'None']].map(([term, description]) => <div key={term} className="grid gap-1 px-4 py-3 sm:grid-cols-[160px_minmax(0,1fr)]"><dt className="text-sm font-medium text-muted-foreground">{term}</dt><dd className="break-words text-sm font-medium [overflow-wrap:anywhere]">{description}</dd></div>)}</dl>
                {category === 'AUTHENTICATION' && <dl className="mt-4 grid gap-2 rounded-xl border p-4 text-sm"><div><dt className="font-semibold">Code delivery</dt><dd>{authConfig.otpType === 'ONE_TAP' ? 'Android one-tap autofill with copy-code fallback' : 'Copy verification code'}</dd></div><div><dt className="font-semibold">Expiration</dt><dd>{authConfig.codeExpirationMinutes} minutes</dd></div>{authConfig.otpType === 'ONE_TAP' && <div><dt className="font-semibold">Android app</dt><dd className="break-all">{authConfig.packageName || 'Package name missing'} · {authConfig.signatureHash || 'Signature hash missing'}</dd></div>}</dl>}
                <div className="mt-4 whitespace-pre-wrap rounded-xl border bg-muted/20 p-4"><h3 className="mb-2 text-sm font-semibold">Complete message</h3><p className="break-words text-sm">{body || 'No message body yet'}</p></div>
                <div id="whatsapp-connection" className="mt-4 rounded-xl border p-4"><h3 className="text-sm font-semibold">Approval account</h3><p className="mt-1 text-sm">{connectionReady ? `${connection?.config?.wabaName || connection?.config?.verifiedName || 'Connected WhatsApp Business'}${connection?.config?.businessAccountId ? ` · ${connection.config.businessAccountId}` : ''}` : connectionError || 'Connect a WhatsApp Business Account before submitting. Your draft can still be saved.'}</p><button type="button" onClick={() => setConnectionRetry(value => value + 1)} className="mt-2 text-xs text-primary underline">Check connected account</button>{!connectionReady && <button type="button" onClick={() => leaveEditor('/dashboard/integrations/whatsapp')} className="ml-3 text-xs text-primary underline">Open WhatsApp connection</button>}</div>
                <WhatsAppChecklist requirements={requirements} onFocus={focusEditorField} />
                <button type="button" onClick={() => focusEditorField('whatsapp-body')} className="mt-2 text-sm text-primary underline">Edit message fields</button>
                {savedRecord?.approvedSnapshot && <WhatsAppTemplateHistory approvedSnapshot={savedRecord.approvedSnapshot} current={{name,language,category,body,headerType,header,footer,buttons,examples,variableLabels,authConfig:category === 'AUTHENTICATION' ? authConfig : null,headerMediaUrl:currentMedia?.url || null}} />}
                <div className="mt-4 rounded-[10px] border border-primary/25 bg-primary/5 p-4 text-sm"><p className="font-semibold text-primary">{messageComplete ? "Ready for approval review" : "Complete the checklist before submitting"}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Save a local draft, or submit the reviewed template to the connected Meta Business Account for approval.</p></div>
              </WhatsAppEditorSection>}
            </div>
            <aside className="min-w-0 rounded-[14px] border border-card-border bg-card p-4 xl:sticky xl:top-4"><h2 className="mb-3 font-semibold">Template preview</h2>{preview}<div className="mt-4"><p className="text-sm font-semibold">This template is good for</p><p className="mt-2 text-sm leading-5 text-muted-foreground">{previewNotes.goodFor}</p></div><div className="mt-5"><p className="text-sm font-semibold">Template areas you can customize</p><p className="mt-2 text-sm leading-5 text-muted-foreground">{previewNotes.areas}</p></div></aside>
          </div>}
      </div>
    </div>
    <div ref={actionBarRef} data-testid="template-editor-actions" className="workspace-action-bar sticky bottom-0 z-10 border-t border-border bg-card px-4 py-3 sm:px-6 lg:px-8">
      {saving && <div role="status" className="mx-auto mb-3 max-w-[1460px] text-sm"><p>{saveStage}{uploadProgress !== null && saveStage === 'Uploading header media' ? uploadProgress === 100 ? ' · Upload transferred; validating and saving…' : ` · ${uploadProgress}%` : '…'}</p>{uploadProgress !== null && saveStage === 'Uploading header media' && <progress aria-label="Header media upload progress" value={uploadProgress} max={100} className="mt-1 h-2 w-full" />}</div>}
      {saveError && <p role="alert" className="mx-auto mb-3 max-w-[1460px] text-sm text-destructive">{saveError}{recoveryDraftId && <button type="button" className="ml-2 underline" onClick={() => router.push(`${templatesPath}/${recoveryDraftId}`)}>Open saved draft</button>}</p>}
      {!saving && (editorMode === "builder" || step > 0) && <p aria-live="polite" className="mx-auto mb-2 max-w-[1460px] text-xs leading-5 text-muted-foreground">{generatingWithAI ? "Generating copy… Editing resumes when the copy is ready." : controls.canEdit && requirements.length > 0 ? <>Before submission: <button type="button" onClick={() => focusEditorField(requirements[0].field)} className="rounded-sm font-medium text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{requirements[0].label}</button>{requirements.length > 1 && ` · ${requirements.length - 1} more ${requirements.length === 2 ? "item" : "items"} to complete`}</> : controls.canEdit ? "Save a local draft, or review it before submitting to Meta." : "This template is locked until its Meta status is synchronized."}</p>}
      <div className="mx-auto flex w-full max-w-[1460px] items-center justify-between gap-3">
        <button type="button" aria-label={backLabel} title={backLabel} disabled={saving} onClick={() => { if (step === 2) { setStep(1); setMobilePanel("editor"); setFocusTarget({ id: "whatsapp-body" }); } else if (editorMode === "builder" || step === 0) leaveEditor(templateId ? `${templatesPath}/${templateId}?returnTo=${encodeURIComponent(returnPath)}` : returnPath, !templateId); else setStep(step - 1); }} className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-[10px] border px-3 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:px-4"><ArrowLeft className="h-4 w-4" /><span className="hidden sm:inline">{backLabel}</span></button>
        {editorMode === "guided" && step < 2 ? <div className="flex gap-2"><button type="button" aria-label={templateId ? "Save WhatsApp template changes" : "Save new WhatsApp template"} onClick={() => void saveTemplate(false)} disabled={editingDisabled || Boolean(conflictingRecord) || !canSaveDraft} className="min-h-11 rounded-lg border px-3 text-sm disabled:opacity-50">Save draft</button><button type="button" onClick={() => setStep(step + 1)} disabled={editingDisabled} className="inline-flex min-h-11 items-center gap-2 rounded-[10px] bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">Next<ChevronRight className="h-4 w-4" /></button></div>
          : <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 sm:flex sm:flex-none">
            <button type="button" aria-label={templateId ? "Save WhatsApp template changes" : "Save new WhatsApp template"} onClick={() => void saveTemplate(false)} disabled={editingDisabled || Boolean(conflictingRecord) || !canSaveDraft} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border bg-card px-3 text-xs font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:px-4 sm:text-sm">Save draft</button>
            {step === 2 ? <button type="button" onClick={() => void saveTemplate(true)} disabled={editingDisabled || !messageComplete || !canSubmitAfterSave || !connectionReady || Boolean(conflictingRecord)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:px-4 sm:text-sm">{saving ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Check className="h-4 w-4 shrink-0" />}Submit to Meta</button>
              : <button type="button" onClick={() => { setStep(2); setFocusTarget({ id: "whatsapp-review-title" }); }} disabled={editingDisabled} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:px-4 sm:text-sm">Review template<ChevronRight className="h-4 w-4 shrink-0" /></button>}
          </div>}
      </div>
    </div>
  </div>;
}
