"use client";
import { EmailDesignPicker } from '../EmailDesignPicker';
import { OutreachBrandSelect } from '../OutreachBrandSelect';
import { clearOutreachComposerDraft, outreachDraftHandoffKey, readOutreachComposerDraft, saveOutreachComposerDraft } from '@/lib/outreach-composer-draft-store';
import type { EmailDesignId } from '../../../../../shared/emailDesigns';
import { customerDeliveryFailure } from '@/lib/customer-delivery-readiness';

import { useCallback, useEffect, useId, useRef, useState, type SetStateAction } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Facebook,
  Inbox,
  Instagram,
  Mail,
  MessageCircle,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  UsersRound,
  X,
} from "lucide-react";
import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { WhatsAppCostPreview } from "./WhatsAppCostPreview";
import { Spinner } from "@/components/ui/spinner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/ui/page-header";
import { EmailMessageContent } from "@/components/outreach/EmailMessageContent";
import {
  prepareBulkLaunch,
  type BulkLaunchAttempt,
  type BulkOutreachResult,
} from "@/components/outreach/bulk-launch";
import { useLibraryCampaignHandoff } from "@/hooks/use-library-campaign-handoff";
import { resolveCampaignTemplate } from "@/lib/reusableTemplates";
import { readLibraryDraft } from "@/lib/libraryDraft";
import { loadReusableTemplates } from "@/lib/contentTemplateLibrary";
import { disambiguateOptionLabels } from '@/lib/selectOptionLabels';
import { ChannelMessageEditor } from "../ChannelMessageEditor";
import type { RichTextEditorHandle } from "@/components/RichTextEditor";
import { plainTextToHtml } from "@/lib/messageFormatting";
import { OutreachFollowUpEditor } from "./OutreachFollowUpEditor";
import { renderLocalFollowUps, type OutreachLocalFollowUps } from "../../../../../shared/outreachLocalFollowUps";
import { CampaignManualSequencePanel, useCampaignManualSequence } from "./CampaignManualSequence";
import type { ManualReview } from "../../../../../shared/campaignManualFollowUps";
import { followUpRecoveryHistoryState } from '@/lib/follow-up-save-recovery';
import { useOutreachDraftScope } from '@/hooks/use-outreach-draft-scope';
import { calculateSmsMetrics } from "@/lib/smsMetrics";
import {
  INBOX_CHANNELS,
  type InboxChannel,
} from "../../../../../shared/outreachInbox";
import {
  buildOutreachTemplate,
  OUTREACH_VARIABLES,
  personalizeOutreach,
  type OutreachCreationOptions,
  type OutreachFollowUp,
  type OutreachRecipient,
  type OutreachTemplate,
} from "../../../../../shared/outreachCompose";
import { WhatsAppTemplateEditor } from "./WhatsAppTemplateEditor";
import { WhatsAppMediaPreview } from "./WhatsAppMediaPreview";
import { WhatsAppFormattedText } from "@/components/whatsapp-templates/WhatsAppFormattedText";
import { AssistantDeliveryNotice } from '../AssistantDeliveryNotice';
import { RecipientImportFilter, type RecipientSource } from './RecipientImportFilter';
import { channelAccountPhrase, sharedRecipientBlockReason } from './composerCopy';
import type { OutreachImportSources } from '../../../../../shared/outreachImportSources';
import { deviceTimeZone } from '../../../../../shared/timeZones';

const CHANNELS = {
  email: {
    label: "Email",
    icon: Mail,
    description: "Send personalized emails from a verified sending account.",
  },
  whatsapp: {
    label: "WhatsApp",
    icon: MessageCircle,
    description: "Start outreach with an approved WhatsApp template.",
  },
  instagram: {
    label: "Instagram",
    icon: Instagram,
    description:
      "Message customers who have contacted your connected professional account.",
  },
  facebook: {
    label: "Messenger",
    icon: Facebook,
    description: "Message customers through your connected Facebook Page.",
  },
  sms: {
    label: "SMS",
    icon: MessageSquare,
    description: "Send personalized SMS through your verified MSG91 sender and template.",
  },
};

function SmsSegmentEstimate({ text, personalized = false }: { text: string; personalized?: boolean }) {
  const metrics = calculateSmsMetrics(text);
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p aria-label={personalized ? "Personalized SMS length" : "SMS draft length"}>
        {metrics.characters} characters · {metrics.encoding} · {metrics.segments} {metrics.segments === 1 ? "segment" : "segments"} (estimated)
      </p>
      <p>{personalized ? "The approved MSG91 template can change the final segment count." : "Review each personalized message to check its SMS length."}</p>
    </div>
  );
}
interface EmailTemplate {
  id: string;
  name: string;
  sourceLabel: string;
  sourceId: number;
  subject: string;
  body: string;
  html: boolean;
  isApproved: boolean;
  sourceTemplateId?: number;
}
interface Attachment {
  id: string;
  fileName: string;
  originalName?: string;
  size: number;
}
type DeliveryMessage = Record<string, unknown> & {
  leadId: number;
  message: string;
  followUps: OutreachFollowUp[];
};

function plainEmail(body: string) {
  if (typeof document === "undefined")
    return body.replace(/<[^>]*>/g, " ").trim();
  const node = document.createElement("div");
  node.innerHTML = body
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n");
  return node.textContent?.trim() || "";
}
function presetIds(value: string | null): number[] {
  return [
    ...new Set(
      (value || "")
        .split(",")
        .map(Number)
        .filter((id) => Number.isSafeInteger(id) && id > 0),
    ),
  ];
}

export interface OutreachComposerDraft {
  emailDesignId?: EmailDesignId; channel?: InboxChannel; leadIds?: number[]; threadId?: number; body?: string; subject?: string;
  accountId?: string; providerAccountId?: string; sourceTemplateId?: number; htmlMode?: boolean; templateId?: string; templateValues?: Record<string, string>;
  whatsappMode?: 'template' | 'reply'; optInConfirmed?: boolean; attachments?: Attachment[];
  sendWhen?: 'now' | 'later'; schedule?: string; followUps?: Partial<Record<InboxChannel, OutreachLocalFollowUps>>;
}
export interface EmbeddedOutreachComposer {
  initial: OutreachComposerDraft;
  onChange?: (draft: OutreachComposerDraft, review: Record<string, unknown> | null) => void;
  standalone?:boolean;
  reviewOnLoad?:boolean;
  preparedOutreachId?:string;
}
export function OutreachCreationPage({ embedded }: { embedded?: EmbeddedOutreachComposer } = {}) {
  const scope = useOutreachDraftScope();
  const identified = !scope.endsWith(':unselected') && !scope.startsWith('anonymous:');
  const [queryActor] = useState(scope.split(':')[0]);
  const [queryOwner, setQueryOwner] = useState<string | null>(identified ? scope : null);
  const [queryHandoffAllowed, setQueryHandoffAllowed] = useState(true);
  useEffect(() => {
    if (queryOwner === null && identified && (queryActor === 'anonymous' || scope.startsWith(`${queryActor}:`))) setQueryOwner(scope);
    else if (queryOwner !== null && scope !== queryOwner) setQueryHandoffAllowed(false);
  }, [identified, queryActor, scope, queryOwner]);
  return <OutreachCreationForm key={`${scope}:${queryOwner ?? 'awaiting-scope'}`} ownerScope={scope} allowQueryHandoff={queryHandoffAllowed && scope === queryOwner} embedded={embedded} />;
}

function OutreachCreationForm({ allowQueryHandoff, ownerScope, embedded }: { allowQueryHandoff: boolean; ownerScope: string; embedded?: EmbeddedOutreachComposer }) {
  const routeParams = useSearchParams();
  // A standalone composer keeps its unsent draft while the user visits another page and comes back.
  const [draftHandoffKey] = useState(() => outreachDraftHandoffKey(routeParams));
  const [restoredDraft] = useState(() => embedded ? undefined : readOutreachComposerDraft(ownerScope, routeParams));
  const initial = allowQueryHandoff ? embedded ? embedded.initial : restoredDraft : undefined;
  const compactEmbedded=Boolean(embedded && !embedded.standalone);
  const [emailDesignId, setEmailDesignId] = useState<EmailDesignId | undefined>(initial?.emailDesignId);
  // Brand saved on this outreach (and kept by its follow-ups); starts from the chat thread's brand or the default.
  const [brandToolkitId, setBrandToolkitId] = useState<number | undefined>();
  const [embeddedParams] = useState(() => new URLSearchParams({ channel: initial?.channel || 'email', leadIds: (initial?.leadIds || []).join(','), ...(initial?.threadId ? {threadId: String(initial.threadId)} : {}) }));
  const params = embedded ? embeddedParams : routeParams;
  const pathname = usePathname();
  const fieldPrefix = useId();
  const initialChannel = INBOX_CHANNELS.includes(
    params.get("channel") as InboxChannel,
  )
    ? (params.get("channel") as InboxChannel)
    : "email";
  const [channel, setChannel] = useState<InboxChannel>(initialChannel);
  const [options, setOptions] = useState<OutreachCreationOptions | null>(null);
  const [accountId, setAccountId] = useState(initial?.accountId || "");
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [accountError, setAccountError] = useState("");
  const [accountSelectionNotice,setAccountSelectionNotice]=useState('');
  const [recipients, setRecipients] = useState<OutreachRecipient[]>([]);
  const [loadedRecipientScope, setLoadedRecipientScope] = useState<string | null>(null);
  const [loadedRecipientFilter, setLoadedRecipientFilter] = useState<string | null>(null);
  const [selectedReadiness, setSelectedReadiness] = useState<{ scope: string; recipients: Record<number, OutreachRecipient> } | null>(null);
  const [selectedRecipientFailure, setSelectedRecipientFailure] = useState<{ scope: string; message: string } | null>(null);
  const [selectedRecipientRetry, setSelectedRecipientRetry] = useState(0);
  const [knownRecipients, setKnownRecipients] = useState<
    Record<number, OutreachRecipient>
  >({});
  const [selectedIds, setSelectedIds] = useState<number[]>(() => {
    const ids = presetIds(params.get("leadIds") || params.get("leadId"));
    return ids.length ? ids : initial?.leadIds || [];
  });
  const [search, setSearch] = useState("");
  const [recipientSource, setRecipientSource] = useState<RecipientSource>(params.get('threadId') || initial?.threadId ? 'current' : 'all');
  const [sourceCampaign, setSourceCampaign] = useState('all');
  const [sourceUpload, setSourceUpload] = useState('all');
  const [importSources, setImportSources] = useState<OutreachImportSources | null>(null);
  const [importSourcesError, setImportSourcesError] = useState('');
  const [importSourcesRetry, setImportSourcesRetry] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [recipientError, setRecipientError] = useState("");
  const [contactError, setContactError] = useState("");
  const [preparingContact, setPreparingContact] = useState(false);
  const [subject, updateSubject] = useState(initial?.subject || "");
  const [body, updateBody] = useState(initial?.body || (allowQueryHandoff ? params.get("message") || "" : ""));
  const [sourceTemplateId, setSourceTemplateId] = useState<number | undefined>(initial?.sourceTemplateId);
  const [resolvedTemplates, setResolvedTemplates] = useState<Awaited<ReturnType<typeof resolveCampaignTemplate>>>({});
  const reviewGeneration = useRef(0);
  const setBody = (value: SetStateAction<string>) => { ++reviewGeneration.current; updateBody(value); setSourceTemplateId(undefined); setResolvedTemplates({}); };
  const setSubject = (value: SetStateAction<string>) => { ++reviewGeneration.current; updateSubject(value); setSourceTemplateId(undefined); setResolvedTemplates({}); };
  const [htmlMode, setHtmlMode] = useState(initial?.htmlMode || false);
  const [emailSourceMode, setEmailSourceMode] = useState(false);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([]);
  const emailTemplateLabels = disambiguateOptionLabels(emailTemplates,
    item => `${item.name}${!item.isApproved ? ' · Needs approval' : ''}`,
    item => `${item.name} · ${item.sourceLabel} #${item.sourceId}${!item.isApproved ? ' · Needs approval' : ''}`);
  const [templates, setTemplates] = useState<OutreachTemplate[]>([]);
  const [templateId, setTemplateId] = useState(initial?.templateId || "");
  const [templateValues, setTemplateValues] = useState<Record<string, string>>(
    initial?.templateValues || {},
  );
  useEffect(() => {
    const preview = templateValues.mediaPreview;
    return () => { if (preview?.startsWith('blob:')) URL.revokeObjectURL(preview); };
  }, [templateValues.mediaPreview]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templateError, setTemplateError] = useState("");
  const [whatsappMode, setWhatsappMode] = useState<"template" | "reply">(
    initial?.whatsappMode || "template",
  );
  const [optInConfirmed, setOptInConfirmed] = useState(initial?.optInConfirmed || false);
  const [attachments, setAttachments] = useState<Attachment[]>(initial?.attachments || []);
  const [attachmentSourceMessageId, setAttachmentSourceMessageId] =
    useState<number>();
  const [uploading, setUploading] = useState(false);
  const [sendWhen, setSendWhen] = useState<"now" | "later">(initial?.sendWhen || "now");
  const [outreachName, setOutreachName] = useState(restoredDraft?.outreachName || "");
  const [schedule, setSchedule] = useState(initial?.schedule || "");
  const [localFollowUpsByChannel, setLocalFollowUpsByChannel] = useState<Partial<Record<InboxChannel, OutreachLocalFollowUps>>>(initial?.followUps || {});
  const localFollowUps = localFollowUpsByChannel[channel] || { enabled: false, steps: [] };
  const [openedFromThreadId] = useState(() => {
    const value = Number(params.get("threadId") ?? initial?.threadId);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });
  const manualSequence = useCampaignManualSequence(channel, ownerScope, undefined,
    openedFromThreadId ? { kind: "chat_thread", id: openedFromThreadId } : undefined);
  const [manualReview, setManualReview] = useState<ManualReview | null>(null);
  const [mode, setMode] = useState<"edit" | "review" | "result">("edit");
  const currentFollowUpFingerprint = manualSequence.enabled ? manualSequence.fingerprint : JSON.stringify(localFollowUps);
  const getReviewFingerprint = () => currentFollowUpFingerprint;
  const reviewedFollowUps = useRef<string | null>(null);
  const [reviewedFollowUpFingerprint, setReviewedFollowUpFingerprint] = useState<string | null>(null);
  const followUpSaveBlocked = () => manualSequence.enabled && !manualSequence.ready;
  const updateLocalFollowUps = (value: SetStateAction<OutreachLocalFollowUps>) => {
    ++reviewGeneration.current;
    reviewedFollowUps.current = null;
    setReviewedFollowUpFingerprint(null);
    setMode('edit');
    setLocalFollowUpsByChannel(previous => ({ ...previous, [channel]: typeof value === 'function' ? value(previous[channel] || { enabled: false, steps: [] }) : value }));
  };
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [deliveryFailure, setDeliveryFailure] = useState<ReturnType<typeof customerDeliveryFailure>>();
  const [inProgress, setInProgress] = useState(false);
  const [result, setResult] = useState<BulkOutreachResult | null>(null);
  const [previewId, setPreviewId] = useState("");
  const [selectedPage,setSelectedPage]=useState(0);
  const [resultPage,setResultPage]=useState(0);
  const [previewSearch,setPreviewSearch]=useState('');
  const [reload, setReload] = useState(0);
  const account = options?.channel === channel ? options.accounts.find((item) => item.id === accountId) : undefined;
  const channelDeliveryBlock = options?.channel === channel ? options.deliveryBlock : undefined;
  const deliveryReadiness = deliveryFailure || channelDeliveryBlock || account?.assistant;
  const globalDeliveryBlock = deliveryReadiness?.ready === false && ['runtime_disabled', 'unsupported_channel'].includes(deliveryReadiness.reason || '')
    ? deliveryReadiness : undefined;
  const isGlobalDeliveryMessage = (message?: string | null) => Boolean(globalDeliveryBlock?.error && message === globalDeliveryBlock.error);
  const accountBlockReason = !account?.ready ? account?.reason || 'Choose a ready sending account.' : null;
  const hasDistinctAccountBlock = Boolean(accountBlockReason && !isGlobalDeliveryMessage(accountBlockReason));
  useEffect(() => setDeliveryFailure(undefined), [accountId, channel, reload]);
  const attempt = useRef<BulkLaunchAttempt | null>(null);
  const reviewScope = JSON.stringify({ emailDesignId, channel, selectedIds, sourceTemplateId, body, subject, accountId, followUps: currentFollowUpFingerprint });
  const activeReviewScope = useRef(reviewScope);
  activeReviewScope.current = reviewScope;
  const sendLock = useRef(false);
  const automaticReviewAttempted=useRef(false);
  const listRequest = useRef(0);
  const templateRequest = useRef(0);
  const preparedCrmLead = useRef<number | null>(
    Number(params.get("leadId")) || null,
  );
  const channelDrafts = useRef<
    Partial<
      Record<
        InboxChannel,
        {
          body: string;
          subject: string;
          htmlMode: boolean;
          attachments: Attachment[];
          accountId: string;
        }
      >
    >
  >({});
  const fileInput = useRef<HTMLInputElement>(null);
  const subjectInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const bodyEditor = useRef<RichTextEditorHandle>(null);
  const lastVariableTarget = useRef<"subject" | "body">("body");
  const [threadId, setThreadId] = useState(params.get("threadId") ?? (initial?.threadId ? String(initial.threadId) : null));

  useLibraryCampaignHandoff(channel === "sms" ? "sms" : "email", (draft) => {
    if (channel === "email" || channel === "sms") {
      setSubject(channel === "email" ? draft.subject : "");
      setBody(draft.body);
      setHtmlMode(channel === "email" && /<[a-z][\s\S]*>/i.test(draft.body));
      setSourceTemplateId(draft.sourceTemplateId);
    }
  }, !embedded && allowQueryHandoff);

  // Consume private query text before a workspace layout can remount this page.
  useEffect(() => {
    if (embedded || !allowQueryHandoff || !params.has('message')) return;
    const next = new URLSearchParams(params.toString()); next.delete('message');
    window.history.replaceState(followUpRecoveryHistoryState(), '', `${pathname}${next.size ? `?${next}` : ''}`);
  }, [allowQueryHandoff, params, pathname, embedded]);

  useEffect(() => {
    if (embedded) return;
    const storedThreadId = sessionStorage.getItem("outreach_thread_id");
    if (
      !params.get("threadId") &&
      storedThreadId &&
      /^\d+$/.test(storedThreadId)
    )
      { setThreadId(storedThreadId); setRecipientSource('current'); }
    sessionStorage.removeItem("outreach_thread_id");
    const stored = sessionStorage.getItem("outreach_selected_leads");
    if (stored) {
      try {
        const ids: unknown = JSON.parse(stored);
        if (Array.isArray(ids))
          setSelectedIds((previous) =>
            [
              ...new Set([
                ...previous,
                ...(ids.filter(
                  (id) => Number.isSafeInteger(id) && id > 0,
                ) as number[]),
              ]),
            ],
          );
      } catch {
        /* Ignore an expired handoff. */
      }
      sessionStorage.removeItem("outreach_selected_leads");
    }
    const contactId = Number(params.get("contactId"));
    if (!Number.isSafeInteger(contactId) || contactId <= 0 || !account?.ready)
      return;
    setPreparingContact(true);
    setContactError("");
    let active = true;
    void api
      .post<{ leadId: number }>("/api/outreach-conversations/compose/contact", {
        contactId,
        channel,
        providerAccountId: account.providerAccountId,
        ...(account.senderId ? { senderId: account.senderId } : {}),
      })
      .then((response) => {
        if (!response.leadId)
          throw new Error(
            "This contact could not be prepared for outreach. Check its contact details in CRM.",
          );
        if (active) {
          const previousLeadId = preparedCrmLead.current;
          preparedCrmLead.current = response.leadId;
          setSelectedIds((previous) => [
            ...new Set([
              ...previous.filter((id) => id !== previousLeadId),
              response.leadId,
            ]),
          ]);
        }
      })
      .catch((error) => {
        if (active)
          setContactError(
            error instanceof Error
              ? error.message
              : "This contact could not be loaded.",
          );
      })
      .finally(() => {
        if (active) setPreparingContact(false);
      });
    return () => {
      active = false;
    };
  }, [params, account, channel, embedded]);

  useEffect(() => {
    let active = true;
    setLoadingAccounts(true);
    setAccountError("");
    setAccountSelectionNotice('');
    setOptions(null);
    setAccountId("");
    void (async () => {
      if (channel === "email") await api.post("/api/email-senders/sync");
      const response = await api.get<OutreachCreationOptions>(
        `/api/outreach-conversations/compose/options?channel=${channel}`,
      );
      if (!active) return;
      setOptions(response);
      const previousAccount = channelDrafts.current[channel]?.accountId || (initial?.channel === channel ? initial.accountId : undefined);
      const requestedProvider=initial?.channel===channel ? initial.providerAccountId : undefined;
      if(previousAccount || requestedProvider) {
        const exact=response.accounts.find(item=>(!previousAccount || item.id===previousAccount) && (!requestedProvider || item.providerAccountId===requestedProvider));
        setAccountId(exact?.id || '');
        if(!exact)setAccountSelectionNotice('The selected sending account is unavailable. Choose a connected account before reviewing.');
        return;
      }
      setAccountId(
        (
          response.accounts.find((item) => item.id === previousAccount) ||
          (initial?.channel === channel && initial.providerAccountId ? response.accounts.find(item => item.providerAccountId === initial.providerAccountId) : undefined) ||
          response.accounts.find((item) => item.ready && item.isDefault) ||
          (response.accounts.filter((item) => item.ready).length === 1
            ? response.accounts.find((item) => item.ready)
            : undefined) ||
          response.accounts.find((item) => item.isDefault) ||
          (response.accounts.length === 1 ? response.accounts[0] : undefined)
        )?.id || "",
      );
    })()
      .catch((error) => {
        if (active)
          setAccountError(
            error instanceof Error
              ? error.message
              : "Sending accounts could not be loaded.",
          );
      })
      .finally(() => {
        if (active) setLoadingAccounts(false);
      });
    return () => {
      active = false;
    };
  }, [channel, reload]);

  useEffect(() => {
    let active = true;
    setImportSourcesError('');
    void api.get<OutreachImportSources>('/api/outreach-conversations/compose/import-sources')
      .then(result => {
        if (!result || !Array.isArray(result.campaigns) || !Array.isArray(result.crmImports)) throw new Error('Import filters could not be loaded.');
        if (active) setImportSources(result);
      })
      .catch(error => { if (active) setImportSourcesError(error instanceof Error ? error.message : 'Import filters could not be loaded.'); });
    return () => { active = false; };
  }, [importSourcesRetry]);

  const recipientUrl = useCallback(
    (extra: Record<string, string> = {}) => {
      const query = new URLSearchParams({ channel, ...extra });
      if (account?.senderId) query.set("senderId", String(account.senderId));
      if (channel !== "email" && account?.providerAccountId)
        query.set("providerAccountId", account.providerAccountId);
      if (!extra.ids) {
        if (recipientSource === 'current' && threadId) query.set('threadId', threadId);
        if (recipientSource === 'crm' || recipientSource === 'campaign') {
          query.set('importSource', recipientSource === 'campaign' && sourceUpload === 'legacy' ? 'campaign_legacy' : recipientSource);
          if (recipientSource === 'campaign' && sourceCampaign !== 'all') query.set('campaignId', sourceCampaign);
          if (sourceUpload !== 'all' && sourceUpload !== 'legacy') query.set('importId', sourceUpload);
        }
      }
      return `/api/outreach-conversations/compose/recipients?${query}`;
    },
    [account, channel, threadId, recipientSource, sourceCampaign, sourceUpload],
  );
  const fetchSelectedRecipients=useCallback(async(ids:number[],isCurrent:()=>boolean=()=>true)=>{
    if(ids.length>200) {
      if(!isCurrent())return {recipients:[]};
      return api.post<{recipients:OutreachRecipient[]}>('/api/outreach-conversations/compose/recipients/review',{
        channel,ids,...(account?.senderId ? {senderId:account.senderId} : {}),
        ...(channel!=='email' && account?.providerAccountId ? {providerAccountId:account.providerAccountId} : {}),
      });
    }
    const recipients:OutreachRecipient[]=[];
    for(let offset=0;offset<ids.length;offset+=200) {
      if(!isCurrent())return {recipients:[]};
      const response=await api.get<{recipients:OutreachRecipient[]}>(recipientUrl({ids:ids.slice(offset,offset+200).join(',')}));
      recipients.push(...response.recipients);
    }
    return {recipients};
  },[recipientUrl,channel,account?.senderId,account?.providerAccountId]);
  const recipientScope = JSON.stringify([recipientUrl({ search }), reload]);
  const recipientFilterKey = JSON.stringify([recipientSource, sourceCampaign, sourceUpload, search, recipientSource === 'current' ? threadId : null]);
  const recipientScopeCurrent = loadedRecipientScope === recipientScope && !loadingAccounts && options?.channel === channel;
  const selectedRecipientUrl = recipientUrl({ ids: selectedIds.join(',') });
  const selectedRecipientScope = JSON.stringify([selectedRecipientUrl, reload, selectedRecipientRetry]);
  const selectedReadinessCurrent = !selectedIds.length || selectedReadiness?.scope === selectedRecipientScope;
  const selectedRecipientError = selectedRecipientFailure?.scope === selectedRecipientScope ? selectedRecipientFailure.message : '';
  const recipientReadinessCurrent = recipientScopeCurrent && !loadingRecipients && selectedReadinessCurrent;
  const checkingRecipients = loadingAccounts || loadingRecipients ||
    (!accountError && !recipientError && loadedRecipientScope !== recipientScope);
  const remember = (items: OutreachRecipient[]) =>
    setKnownRecipients((previous) => ({
      ...previous,
      ...Object.fromEntries(items.map((item) => [item.id, item])),
    }));
  const loadRecipients = useCallback(
    async (after?: number) => {
      const request = ++listRequest.current;
      setLoadingRecipients(true);
      setRecipientError("");
      try {
        const response = await api.get<{
          recipients: OutreachRecipient[];
          nextCursor: number | null;
        }>(
          recipientUrl({ search, ...(after ? { after: String(after) } : {}) }),
        );
        if (request !== listRequest.current) return;
        setRecipients((previous) =>
          after ? [...previous, ...response.recipients] : response.recipients,
        );
        remember(response.recipients);
        setLoadedRecipientScope(recipientScope);
        setLoadedRecipientFilter(recipientFilterKey);
        setCursor(response.nextCursor);
      } catch (error) {
        if (request === listRequest.current)
          setRecipientError(
            error instanceof Error
              ? error.message
              : "Recipients could not be loaded.",
          );
      } finally {
        if (request === listRequest.current) setLoadingRecipients(false);
      }
    },
    [recipientUrl, search, recipientScope, recipientFilterKey],
  );
  useEffect(() => {
    const requestRef = listRequest;
    const timer = setTimeout(() => void loadRecipients(), 200);
    return () => {
      clearTimeout(timer);
      requestRef.current++;
    };
  }, [loadRecipients, reload]);
  useEffect(() => {
    setSelectedReadiness(null);
    setSelectedRecipientFailure(null);
    if (!selectedIds.length || loadingAccounts) return;
    let active = true;
    void fetchSelectedRecipients(selectedIds,()=>active)
      .then((response) => {
        if (!active) return;
        const returned = new Set(response.recipients.map((item) => item.id));
        const checkedRecipients = [
          ...response.recipients,
          ...selectedIds
            .filter((id) => !returned.has(id))
            .map((id) => ({
              id,
              name: "Unavailable contact",
              firstName: "",
              lastName: "",
              company: "",
              email: "",
              phone: "",
              recipient: "",
              eligible: false,
              reason: "This contact is no longer available.",
            })),
        ];
        remember(checkedRecipients);
        setSelectedReadiness({ scope: selectedRecipientScope, recipients: Object.fromEntries(checkedRecipients.map(item => [item.id, item])) });
      })
      .catch((error) => {
        if (active)
          setSelectedRecipientFailure({ scope: selectedRecipientScope, message: error instanceof Error
              ? error.message
              : "Selected recipients could not be checked." });
      });
    return () => {
      active = false;
    };
  }, [selectedIds, fetchSelectedRecipients, reload, selectedRecipientUrl, selectedRecipientScope, loadingAccounts]);

  const loadTemplates = useCallback(async () => {
    const request = ++templateRequest.current;
    setTemplateError("");
    setLoadingTemplates(true);
    try {
      if (channel === "whatsapp" && account?.ready) {
        const response = await api.get<{ templates: OutreachTemplate[] }>(
          `/api/outreach-conversations/compose/templates?providerAccountId=${encodeURIComponent(account.providerAccountId)}`,
        );
        if (request !== templateRequest.current) return;
        setTemplates(response.templates);
      } else if (channel !== "whatsapp") {
        const type = channel === "email" || channel === "sms" ? channel : "social_message";
        const assetType = channel === "email" ? "email_template" : channel === "sms" ? "sms_template" : "social_dm";
        interface LibraryItem {
          id: number;
          name?: string;
          title?: string;
          subject?: string;
          content: string;
          htmlContent?: string;
          isApproved?: boolean;
          channel?: string;
          category?: string;
        }
        const responses = await Promise.allSettled([
          api.get<LibraryItem[]>(`/api/content/assets?type=${assetType}${type === "social_message" ? `&channel=${channel}` : ""}`),
          loadReusableTemplates<LibraryItem>(type),
          api.get<LibraryItem[]>(`/api/content/templates/predefined?type=${type}`),
        ]);
        if (request !== templateRequest.current) return;
        const loaded: EmailTemplate[] = [];
        responses.forEach((response, source) => {
          if (response.status !== "fulfilled") return;
          response.value.forEach((item) => {
            const parsed = readLibraryDraft(item.content || "");
            const platform = item.channel || item.category || parsed.fields.platform;
            if (type === "social_message" && typeof platform === "string"
              && ["instagram", "facebook", "twitter", "linkedin"].includes(platform)
              && platform !== channel) return;
            const content = channel === "email" ? item.htmlContent || parsed.html || parsed.body : parsed.body;
            loaded.push({
              id: `${source}:${item.id}`,
              name: item.name || item.title || `Template ${item.id}`,
              sourceLabel: source === 0 ? 'Saved content' : source === 1 ? 'Saved template' : 'Predefined template',
              sourceId: item.id,
              subject: item.subject || parsed.subject,
              body: content,
              html: channel === "email" && /<[a-z][\s\S]*>/i.test(content),
              isApproved: item.isApproved !== false,
              ...(source > 0 ? { sourceTemplateId: item.id } : {}),
            });
          });
        });
        setEmailTemplates(loaded);
        if (responses.some((response) => response.status === "rejected"))
          setTemplateError("Some saved templates could not be loaded. You can write a message or retry.");
      }
    } catch (error) {
      if (request === templateRequest.current)
        setTemplateError(
          error instanceof Error
            ? error.message
            : "Templates could not be loaded.",
        );
    } finally {
      if (request === templateRequest.current) setLoadingTemplates(false);
    }
  }, [channel, account]);
  useEffect(() => {
    const requestRef = templateRequest;
    setTemplates([]);
    setEmailTemplates([]);
    setTemplateId("");
    setTemplateValues({});
    setTemplateError("");
    if (channel !== "whatsapp" || account?.ready) void loadTemplates();
    else setLoadingTemplates(false);
    return () => {
      requestRef.current++;
    };
  }, [loadTemplates, channel, account?.ready]);

  const restoredTemplate = useRef(false);
  useEffect(() => {
    if (restoredTemplate.current || !initial?.templateId || loadingTemplates || !account || !templates.length) return;
    restoredTemplate.current = true;
    if (channel === initial.channel && account.id === initial.accountId && templates.some(item => item.id === initial.templateId)) {
      setTemplateId(initial.templateId); setTemplateValues(initial.templateValues || {});
    }
  }, [initial, loadingTemplates, account, channel, templates]);
  const followUpAccount = useRef(initial?.accountId);
  useEffect(() => {
    if (channel !== 'whatsapp' || !accountId) return;
    if (followUpAccount.current && followUpAccount.current !== accountId) {
      setLocalFollowUpsByChannel(previous => previous.whatsapp ? { ...previous, whatsapp: { ...previous.whatsapp,
        steps: previous.whatsapp.steps.map(step => ({ ...step, templateId: '', templateValues: {} })) } } : previous);
      setOptInConfirmed(false);
    }
    followUpAccount.current = accountId;
  }, [channel, accountId]);

  const selected = selectedIds
    .map((id) => selectedReadinessCurrent ? selectedReadiness?.recipients[id] : knownRecipients[id])
    .filter((item): item is OutreachRecipient => Boolean(item));
  const checkedSelected = selectedReadinessCurrent ? selected : [];
  const eligible = checkedSelected.filter((item) => item.eligible);
  const blocked = checkedSelected.filter((item) => !item.eligible);
  const recipientSpecificBlocks = recipientScopeCurrent ? blocked.filter((item) => !isGlobalDeliveryMessage(item.reason)) : [];
  const sharedRecipientReason = recipientScopeCurrent && loadedRecipientFilter === recipientFilterKey ? sharedRecipientBlockReason(recipients) : null;
  const template = templates.find((item) => item.id === templateId);
  const scheduledAt =
    sendWhen === "later" &&
    schedule &&
    Number.isFinite(new Date(schedule).getTime())
      ? new Date(schedule).toISOString()
      : undefined;
  const deliveryFor = useCallback(
    (
      recipient: OutreachRecipient,
    ): { message: DeliveryMessage; errors: string[] } => {
      const followUps = renderLocalFollowUps(manualSequence.enabled ? { enabled: false, steps: [] } : localFollowUps, channel, recipient, templates);
      const errors: string[] = [...followUps.errors];
      const resolvedTemplate = sourceTemplateId ? resolvedTemplates[recipient.id] : undefined;
      if (mode === 'review' && sourceTemplateId && !resolvedTemplate) errors.push('Review the approved template for this recipient before sending.');
      if (resolvedTemplate && !resolvedTemplate.content.trim()) errors.push('Write a message.');
      if (resolvedTemplate && channel === 'email' && !resolvedTemplate.subject.trim()) errors.push('Complete the subject.');
      if (resolvedTemplate) return {
        errors,
        message: {
          leadId: recipient.id, expectedRecipient: recipient.recipient,
          message: resolvedTemplate.content, followUps: followUps.steps,
          sourceTemplateId: resolvedTemplate.sourceTemplateId,
          sourceTemplateVersion: resolvedTemplate.sourceTemplateVersion,
          ...(resolvedTemplate.templateRenderContext ? { templateRenderContext: resolvedTemplate.templateRenderContext } : {}),
          ...(channel === 'email' ? { subject: resolvedTemplate.subject, htmlContent: resolvedTemplate.htmlContent, emailDesignId, senderId: account?.senderId } : {}),
        },
      };
      let message = personalizeOutreach(body, recipient);
      let htmlContent: string | undefined;
      let templatePayload: ReturnType<typeof buildOutreachTemplate> | undefined;
      if (channel === "email" && htmlMode) {
        htmlContent = personalizeOutreach(body, recipient, true);
        message = plainEmail(htmlContent);
      }
      if (channel === "whatsapp" && whatsappMode === "template") {
        if (!template) errors.push("Choose an approved WhatsApp template.");
        else {
          templatePayload = buildOutreachTemplate(
            template,
            templateValues,
            recipient,
          );
          message = templatePayload.content;
          if (templatePayload.missing.length)
            errors.push("Fill every template variable and media link.");
        }
      }
      if (!message.trim()) errors.push("Write a message.");
      if (
        /{{.*?}}/.test(message) ||
        (htmlContent && /{{.*?}}/.test(htmlContent))
      )
        errors.push("Complete the missing personalization values.");
      const renderedSubject = personalizeOutreach(subject, recipient);
      if (
        channel === "email" &&
        (!renderedSubject.trim() || /{{.*?}}/.test(renderedSubject))
      )
        errors.push("Complete the subject and its personalization.");
      if (
        channel === "whatsapp" &&
        whatsappMode === "reply" &&
        recipient.requiresTemplate
      )
        errors.push("This recipient requires an approved template.");
      return {
        errors: [...new Set(errors)],
        message: {
          leadId: recipient.id,
          expectedRecipient: recipient.recipient,
          message,
          followUps: followUps.steps,
          ...(channel === "email"
            ? {
                subject: renderedSubject,
                emailDesignId,
                htmlContent,
                senderId: account?.senderId,
              }
            : {}),
          ...(templatePayload
            ? {
                templateName: templatePayload.templateName,
                templateLanguage: templatePayload.templateLanguage,
                templateComponents: templatePayload.templateComponents,
              }
            : {}),
        },
      };
    },
    [
      body,
      channel,
      localFollowUps,
      manualSequence.enabled,
      templates,
      mode,
      sourceTemplateId,
      resolvedTemplates,
      htmlMode,
      whatsappMode,
      template,
      templateValues,
      subject,
      account?.senderId,
      emailDesignId,
    ],
  );
  const deliveries = eligible.map((recipient) => ({
    recipient,
    ...deliveryFor(recipient),
  }));
  const invalidDeliveries = deliveries.filter((item) => item.errors.length);
  const preview =
    checkedSelected.find((item) => String(item.id) === previewId) ||
    eligible[0] ||
    checkedSelected[0];
  const previewDelivery = preview ? deliveryFor(preview) : null;
  const selectedPageStart=Math.min(selectedPage,Math.max(0,Math.ceil(selectedIds.length/50)-1))*50;
  const previewMatches=selected.filter(item=>!previewSearch.trim() || [item.name,item.email,item.phone].some(value=>value.toLowerCase().includes(previewSearch.trim().toLowerCase())));
  const previewChoices=previewMatches.slice(0,100);
  if(preview && !previewChoices.some(item=>item.id===preview.id))previewChoices.push(preview);
  const timingError =
    sendWhen === "later" &&
    (!scheduledAt ||
      new Date(scheduledAt).getTime() < Date.now() + 60_000 ||
      new Date(scheduledAt).getTime() > Date.now() + 90 * 86400000)
      ? "Choose a send time between one minute and 90 days from now."
      : "";
  const canSend = Boolean(
    recipientReadinessCurrent &&
    account?.ready &&
    account.assistant?.ready !== false &&
    !globalDeliveryBlock &&
    !deliveryFailure &&
    !preparingContact &&
    !contactError &&
    (!manualSequence.enabled || manualSequence.ready) &&
    eligible.length &&
    selected.length === selectedIds.length &&
    !invalidDeliveries.length &&
    !timingError &&
    (channel !== "whatsapp" || optInConfirmed),
  );
  const preflightIssues = [
    ...(!account?.ready ? [account?.reason || (accountError || "Choose a ready sending account.")] : []),
    ...(selectedReadinessCurrent && !eligible.length && selectedIds.length ? ["No selected recipients are ready to receive this message."] : []),
    ...(selectedReadinessCurrent && selected.length !== selectedIds.length ? ["Some selected recipients could not be loaded. Review them again."] : []),
    ...invalidDeliveries.flatMap((item) => item.errors.map((error) => `${item.recipient.name}: ${error}`)),
    ...(timingError ? [timingError] : []),
    ...(manualSequence.enabled && !manualSequence.ready ? [manualSequence.error || "Choose a campaign and save its sequence before review."] : []),
    ...(mode === 'review' && reviewedFollowUpFingerprint !== currentFollowUpFingerprint ? ['Follow-up settings changed. Edit outreach and review the current settings again.'] : []),
    ...(channel === "whatsapp" && !optInConfirmed ? ["Confirm recipient consent before sending."] : []),
  ];
  const visiblePreflightIssues = preflightIssues.filter((issue) => !isGlobalDeliveryMessage(issue) && issue!==accountError);
  // The Review button can be disabled by the account's assistant or the campaign
  // sequence; say which, next to the button, instead of leaving it silently grey.
  const reviewBlockReason: { text: string; href?: string; action?: string } | null =
    account?.assistant?.ready === false ? {
      text: account.assistant.error || 'assign a published assistant to this sending account.',
      href: account.assistant.setupUrl || '/dashboard/settings/outreach', action: 'Set up the assistant',
    } : deliveryFailure ? { text: deliveryFailure.error || 'this sending account cannot deliver right now.' }
    : manualSequence.enabled && !manualSequence.ready ? {
      text: manualSequence.error || (manualSequence.campaign
        ? 'save the campaign sequence first, or turn off “Use a campaign manual sequence”.'
        : 'choose a campaign for the manual sequence, or turn off “Use a campaign manual sequence”.'),
    } : contactError ? { text: contactError } : null;

  const insertVariable = (token: string) => {
    const inSubject = channel === "email" && lastVariableTarget.current === "subject";
    if (channel === "email" && !inSubject && !emailSourceMode) {
      bodyEditor.current?.insertText(`{{${token}}}`);
      return;
    }
    const input = inSubject ? subjectInput.current : bodyInput.current;
    const current = inSubject ? subject : body;
    const start = input?.selectionStart ?? current.length;
    const end = input?.selectionEnd ?? current.length;
    const variable = `{{${token}}}`;
    const update = (previous: string) => `${previous.slice(0, start)}${variable}${previous.slice(end)}`;
    if (inSubject) setSubject(update);
    else setBody(update);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + variable.length, start + variable.length);
    });
  };

  const switchChannel = (next: InboxChannel) => {
    if (next === channel) return;
    channelDrafts.current[channel] = {
      body,
      subject,
      htmlMode,
      attachments,
      accountId,
    };
    const draft = channelDrafts.current[next];
    setChannel(next);
    setLoadedRecipientScope(null);
    setMode("edit");
    setBody(draft?.body || "");
    setSubject(draft?.subject || "");
    setHtmlMode(draft?.htmlMode || false);
    setAttachments(draft?.attachments || []);
    setSendError("");
    setWhatsappMode("template");
    setOptInConfirmed(false);
    attempt.current = null;
  };
  const review = async () => {
    if (!recipientReadinessCurrent || account?.assistant?.ready === false || deliveryFailure || globalDeliveryBlock) return;
    if (followUpSaveBlocked()) { setSendError('Confirm the saved follow-up settings before reviewing outreach.'); return; }
    const fingerprint = getReviewFingerprint();
    const generation = ++reviewGeneration.current;
    setReviewing(true);
    setSendError("");
    try {
      const response=await fetchSelectedRecipients(selectedIds,()=>generation===reviewGeneration.current && activeReviewScope.current===reviewScope);
      if (response.recipients.length !== selectedIds.length)
        throw new Error(
          "A selected contact is no longer available. Remove it before sending.",
        );
      let reviewedTemplates = resolvedTemplates;
      if (sourceTemplateId) {
        const rendered = await resolveCampaignTemplate(sourceTemplateId, response.recipients.filter(item => item.eligible), channel);
        if (generation !== reviewGeneration.current || activeReviewScope.current !== reviewScope) return;
        setResolvedTemplates(rendered);
        reviewedTemplates = rendered;
      }
      if (generation !== reviewGeneration.current || activeReviewScope.current !== reviewScope) return;
      if (followUpSaveBlocked() || fingerprint !== getReviewFingerprint()) return;
      if (manualSequence.enabled) {
        if (!manualSequence.campaign || !manualSequence.sequence) throw new Error('Choose and save a campaign sequence first.');
        const reviewed = await api.post<ManualReview>('/api/outreach/manual-follow-ups/preview', {
          campaign:{kind:manualSequence.campaign.kind,id:manualSequence.campaign.id},channel,
          expectedVersion:manualSequence.sequence.version,
          recipients:response.recipients.filter(item=>item.eligible).map(item=>({leadId:item.id,recipient:item.recipient,subject:String(reviewedTemplates[item.id]?.subject || deliveryFor(item).message.subject || '')})),
        });
        if (generation !== reviewGeneration.current || activeReviewScope.current !== reviewScope) return;
        setManualReview(reviewed);
      } else setManualReview(null);
      reviewedFollowUps.current = fingerprint; setReviewedFollowUpFingerprint(fingerprint);
      remember(response.recipients);
      setSelectedReadiness({ scope: selectedRecipientScope, recipients: Object.fromEntries(response.recipients.map(item => [item.id, item])) });
      setPreviewId(
        String(
          response.recipients.find((item) => item.eligible)?.id ||
            response.recipients[0]?.id ||
            "",
        ),
      );
      setMode("review");
    } catch (error) {
      if(generation===reviewGeneration.current)setSendError(
        error instanceof Error
          ? error.message
          : "Recipients could not be verified.",
      );
    } finally {
      setReviewing(false);
    }
  };
  useEffect(()=>{
    if(!embedded?.reviewOnLoad || automaticReviewAttempted.current || mode!=='edit' || !initial || !selectedIds.length
      || !recipientReadinessCurrent || loadingTemplates || !account?.ready || globalDeliveryBlock || deliveryFailure
      || (channel==='whatsapp' && (!templateId || templateId!==initial.templateId)))return;
    automaticReviewAttempted.current=true;void review();
  },[embedded?.reviewOnLoad,mode,initial,selectedIds.length,recipientReadinessCurrent,loadingTemplates,account?.ready,globalDeliveryBlock,deliveryFailure,channel,templateId]);
  const prepareLaunch = () => {
    const launch = prepareBulkLaunch(
        channel,
        deliveries.map((item) => item.message),
        attempt.current,
        account?.providerAccountId,
        {
          creationVersion: 1,
          ...(outreachName.trim() ? { outreachName: outreachName.trim() } : {}),
          ...(embedded?.preparedOutreachId ? {preparedOutreachId:embedded.preparedOutreachId} : {}),
          ...(manualSequence.enabled ? {campaignManualReviewId:manualReview?.reviewId} : {followUpSource: 'outreach' as const}),
          ...(scheduledAt ? { scheduledAt } : {}),
          ...(channel === "email" && brandToolkitId ? { brandToolkitId } : {}),
          ...(channel === "whatsapp"
            ? { whatsappOptInConfirmed: optInConfirmed }
            : {}),
          ...(channel === "email" && attachments.length
            ? {
                attachments: attachments.map((item) => item.id),
                ...(attachmentSourceMessageId
                  ? { attachmentSourceMessageId }
                  : {}),
              }
            : {}),
        },
      );
    attempt.current = launch.attempt;
    return launch;
  };
  const embeddedChange = useRef(embedded?.onChange);
  embeddedChange.current = embedded?.onChange;
  const composerDraft: OutreachComposerDraft = { emailDesignId, channel, leadIds: selectedIds, ...(threadId ? { threadId: Number(threadId) } : {}),
    body, subject, accountId, providerAccountId: account?.providerAccountId, sourceTemplateId, htmlMode, templateId, templateValues, whatsappMode, optInConfirmed, attachments, sendWhen, schedule, followUps: localFollowUpsByChannel };
  const reviewedPayload = embedded?.onChange && mode === 'review' && canSend && reviewedFollowUpFingerprint === currentFollowUpFingerprint ? {
    creationVersion: 1, followUpSource: 'outreach', channel, providerAccountId: account?.providerAccountId,
    messages: deliveries.map(item => item.message), confirmation: { confirmed: true, channel, recipientCount: eligible.length },
    ...(scheduledAt ? { scheduledAt } : {}), ...(channel === 'email' && brandToolkitId ? { brandToolkitId } : {}), ...(channel === 'whatsapp' ? { whatsappOptInConfirmed: optInConfirmed } : {}),
    ...(channel === 'email' && attachments.length ? { attachments: attachments.map(item => item.id), ...(attachmentSourceMessageId ? { attachmentSourceMessageId } : {}) } : {}),
  } : null;
  const embeddedState = embedded?.onChange ? JSON.stringify({ draft: composerDraft, review: reviewedPayload }) : '';
  const keptDraft = embedded ? '' : JSON.stringify({ ...composerDraft, outreachName });
  const outreachLaunched = mode === 'result' || inProgress;
  useEffect(() => {
    if (embedded) return;
    // A launched outreach is finished; Back must not bring its message back for a second send.
    if (outreachLaunched) clearOutreachComposerDraft(ownerScope);
    else saveOutreachComposerDraft(ownerScope, JSON.parse(keptDraft), draftHandoffKey);
  }, [embedded, outreachLaunched, ownerScope, keptDraft, draftHandoffKey]);
  useEffect(() => {
    if (!embeddedChange.current) return;
    const state = JSON.parse(embeddedState);
    embeddedChange.current(state.draft, state.review);
  }, [embeddedState]);
  const send = async () => {
    if (sendLock.current) return;
    if (!canSend || followUpSaveBlocked() || (manualSequence.enabled && !manualReview) || reviewedFollowUps.current !== getReviewFingerprint()) {
      setSendError(preflightIssues[0] || "Review the sending account, recipients, and message before sending.");
      return;
    }
    sendLock.current = true;
    setSending(true);
    setSendError("");
    try {
      const launch = prepareLaunch();
      attempt.current = launch.attempt;
      const response = await api.post<BulkOutreachResult>(
        "/api/outreach-conversations/bulk",
        launch.payload,
      );
      if (response.inProgress) {
        setInProgress(true);
        return;
      }
      setResult(response);
      setResultPage(0);
      if (attachments.length)
        setAttachmentSourceMessageId(
          (previous) =>
            previous ||
            response.attachmentSourceMessageId ||
            response.results?.find((item) => item.status === "queued")
              ?.messageId,
        );
      setInProgress(false);
      setMode("result");
    } catch (error) {
      setDeliveryFailure(customerDeliveryFailure(error, { channel, accountId: account?.providerAccountId }));
      setSendError(
        error instanceof Error
          ? error.message
          : "Outreach could not be queued. Your message is still here.",
      );
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  };
  const upload = async (files: FileList | null) => {
    if (!files?.length || uploading) return;
    setUploading(true);
    setSendError("");
    try {
      const form = new FormData();
      Array.from(files).forEach((file) => form.append("files", file));
      const response = await api.postForm<{ attachments: Attachment[] }>(
        "/api/outreach/attachments",
        form,
      );
      if (attachmentSourceMessageId) {
        setAttachments(response.attachments);
        setAttachmentSourceMessageId(undefined);
      } else
        setAttachments((previous) => [...previous, ...response.attachments]);
    } catch (error) {
      setSendError(
        error instanceof Error
          ? error.message
          : "Attachments could not be uploaded.",
      );
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  const Icon = CHANNELS[channel].icon;
  const resultTitle = result?.uncertain
    ? "Queue confirmation needs review"
    : result?.queued
      ? scheduledAt ? "Outreach scheduled" : "Outreach queued"
      : "No messages were queued";
  const resultItems=result?.results || [];
  const resultPageStart=Math.min(resultPage,Math.max(0,Math.ceil(resultItems.length/50)-1))*50;

  return (
    <main className={cn("outreach-workspace outreach-composer", compactEmbedded ? "w-full min-w-0 space-y-3" : "mx-auto w-full max-w-[1460px] space-y-3 p-4 sm:p-5 lg:p-6")}>
      {!compactEmbedded && <PageHeader
        className="workspace-heading"
        eyebrow={`Outreach / ${CHANNELS[channel].label}`}
        icon={Send}
        title={
          mode === "review"
            ? "Review outreach"
            : mode === "result"
              ? resultTitle
              : "New outreach"
        }
        subtitle="Choose recipients, personalize a message, then review."
        actions={
          <Button variant="outline" asChild>
            <Link href="/dashboard/outreach/inbox">
              <Inbox className="mr-2 h-4 w-4" />
              Back to Inbox
            </Link>
          </Button>
        }
      />}
      {mode === "result" && result ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {resultTitle}
            </CardTitle>
            <CardDescription>
              {result.queued} accepted · {result.errors} could not be queued.
              {Boolean(result.uncertain) && ` ${result.uncertain} unconfirmed; saved messages may still send. Review their conversations before approving another send.`}
              {result.batchId ? " Track delivery, reads and failures on its tracking page." : " Delivery status will update in your Inbox."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {scheduledAt && (
              <p className="text-sm">
                Scheduled for {new Date(scheduledAt).toLocaleString()}.
              </p>
            )}
            <ul className="divide-y rounded-md border">
              {resultItems.slice(resultPageStart,resultPageStart+50).map((item) => (
                <li
                  key={item.leadId}
                  className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
                >
                  <span>
                    {knownRecipients[item.leadId]?.name ||
                      `Contact ${item.leadId}`}
                    <span
                      className={cn(
                        "ml-2 text-xs",
                        item.status === "error"
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {item.error || (scheduledAt ? "Scheduled" : "Queued")}
                    </span>
                  </span>
                  {item.conversationId > 0 && (
                    <Link
                      href={`/dashboard/outreach/inbox?thread=conversation:${item.conversationId}`}
                      className="text-primary hover:underline"
                    >
                      Open conversation
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            {resultItems.length>50 && <div className="flex flex-wrap items-center gap-2 text-xs">
              <p>Showing {resultPageStart+1}–{Math.min(resultPageStart+50,resultItems.length)} of {resultItems.length} receipt results</p>
              <Button type="button" size="sm" variant="outline" disabled={resultPageStart===0} onClick={()=>setResultPage(resultPageStart/50-1)}>Previous receipt results</Button>
              <Button type="button" size="sm" variant="outline" disabled={resultPageStart+50>=resultItems.length} onClick={()=>setResultPage(resultPageStart/50+1)}>Next receipt results</Button>
            </div>}
            <div className="flex flex-wrap gap-2">
              {result.batchId && <Button asChild><Link href={`/dashboard/outreach/tracking/${result.batchId}`}>Track this outreach</Link></Button>}
              {embedded?.preparedOutreachId && <Button asChild variant={result.batchId ? "outline" : "default"}><Link href={`/dashboard/outreach/reports?preparedOutreachId=${embedded.preparedOutreachId}`}>View campaign report</Link></Button>}
              <Button asChild variant={result.batchId ? "outline" : "default"}>
                <Link href="/dashboard/outreach/inbox">Open Inbox</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link
                  href={`/dashboard/outreach/follow-ups?channel=${channel}&tab=history`}
                >
                  View follow-ups
                </Link>
              </Button>
              {result.errors > 0 && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setSelectedIds(
                      result.results
                        ?.filter((item) => item.status === "error")
                        .map((item) => item.leadId) || selectedIds,
                    );
                    attempt.current = null;
                    setMode("edit");
                  }}
                >
                  Review failed recipients
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  setSelectedIds([]);
                  setBody("");
                  setSubject("");
                  setAttachments([]);
                  setAttachmentSourceMessageId(undefined);
                  attempt.current = null;
                  setResult(null);
                  setMode("edit");
                }}
              >
                Create another
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <div
            className="workspace-channels flex items-center gap-2 overflow-x-auto pb-1"
            aria-label="Outreach channel"
          >
            {INBOX_CHANNELS.map((value) => {
              const ChannelIcon = CHANNELS[value].icon;
              return (
                <Button
                  key={value}
                  type="button"
                  variant={channel === value ? "default" : "outline"}
                  aria-pressed={channel === value}
                  disabled={mode === "review" || sending}
                  className="shrink-0 gap-2"
                  onClick={() => switchChannel(value)}
                >
                  <ChannelIcon className="h-4 w-4" />
                  {CHANNELS[value].label}
                </Button>
              );
            })}
          </div>
          {globalDeliveryBlock && (
            <section aria-label="Customer delivery blocked" className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-4">
              <h2 className="text-sm font-semibold">Customer delivery blocked</h2>
              <AssistantDeliveryNotice readiness={globalDeliveryBlock} />
            </section>
          )}
          {sendError && !isGlobalDeliveryMessage(sendError) && (
            <Callout tone="danger">
              {sendError}
            </Callout>
          )}
          {mode === "edit" ? (
            <div className={compactEmbedded ? "grid gap-3" : "grid items-start gap-3 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]"}>
              <div className="min-w-0 space-y-3">
                <Card className="workspace-panel">
                  <CardHeader className="p-4 pb-3">
                    <CardTitle className="flex items-center gap-3 text-base"><span className={cn("workspace-section-icon", channel === "whatsapp" && "workspace-whatsapp-icon")}><Icon className="h-5 w-5" /></span>Sending account</CardTitle>
                    <CardDescription>
                      {CHANNELS[channel].description}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 px-4 pb-4">
                    {loadingAccounts ? (
                      <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Spinner size="sm" label={null} />
                        Checking sending accounts…
                      </p>
                    ) : accountError ? (
                      <div role="alert" className="space-y-2 text-sm">
                        <p className="text-destructive">{accountError}</p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setReload((value) => value + 1)}
                        >
                          Try again
                        </Button>
                      </div>
                    ) : options?.accounts.length ? (
                      <>
                        <Label htmlFor={`${fieldPrefix}-sending-account`}>Send from</Label>
                        <select
                          id={`${fieldPrefix}-sending-account`}
                          value={accountId}
                          onChange={(event) => {setAccountId(event.target.value);setAccountSelectionNotice('');}}
                          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                        >
                          <option value="">Choose a sending account</option>
                          {options.accounts.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.label}
                              {item.ready ? "" : " · Needs attention"}
                            </option>
                          ))}
                        </select>
                        {accountSelectionNotice && <p role="alert" className="text-sm text-destructive">{accountSelectionNotice}</p>}
                        {account && (!globalDeliveryBlock || hasDistinctAccountBlock) && (
                          <p
                            className={cn(
                              "flex items-center gap-2 text-xs",
                              account.ready
                                ? "text-muted-foreground"
                                : "text-destructive",
                            )}
                          >
                            {account.ready && account.assistant?.ready !== false && !deliveryFailure && (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            )}
                            {globalDeliveryBlock ? accountBlockReason : deliveryFailure?.error || (account.assistant?.ready === false ? account.assistant.error || 'Assistant setup required' : account.reason || "Ready to send")}
                          </p>
                        )}
                        {!globalDeliveryBlock && <AssistantDeliveryNotice readiness={deliveryReadiness} />}
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Connect {channelAccountPhrase(CHANNELS[channel].label)} to start
                        sending.
                      </p>
                    )}
                    <Link
                      href={channel === "email" ? "/dashboard/integrations/email" : channel === "sms" ? "/dashboard/integrations/msg91" : "/dashboard/integrations"}
                      className="inline-block text-xs text-primary hover:underline"
                    >
                      {channel === "email" ? "Manage Gmail and sending domains" : "Manage connections"}
                    </Link>
                  </CardContent>
                </Card>
                <Card className="workspace-panel">
                  <CardHeader className="p-4 pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <CardTitle className="flex items-center gap-3 text-base"><span className="workspace-section-icon"><UsersRound className="h-5 w-5" /></span>Recipients</CardTitle>
                        <CardDescription className="mt-1">
                          {selectedIds.length} selected
                          {recipientScopeCurrent && selectedReadinessCurrent && <> · {eligible.length} ready{blocked.length ? ` · ${blocked.length} blocked` : ""}</>}
                        </CardDescription>
                      </div>
                      {selectedIds.length > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSelectedIds([])}
                        >
                          Clear
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3 px-4 pb-4">
                    <RecipientImportFilter
                      source={recipientSource} campaign={sourceCampaign} upload={sourceUpload} threadId={threadId}
                      sources={importSources} error={importSourcesError}
                      onSource={value => { setRecipientSource(value); setSourceCampaign('all'); setSourceUpload('all'); }}
                      onCampaign={value => { setSourceCampaign(value); setSourceUpload('all'); }}
                      onUpload={setSourceUpload} onRetry={() => setImportSourcesRetry(value => value + 1)}
                    />
                    <Input
                      aria-label="Search recipients"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search contacts by name, email or company"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!recipientScopeCurrent || loadingRecipients || !recipients.length}
                      onClick={() => setSelectedIds(previous => [...new Set([...previous, ...recipients.map(recipient => recipient.id)])])}
                    >
                      Select shown contacts ({recipientScopeCurrent ? recipients.length : 0})
                    </Button>
                    {selectedIds.length > 0 && (
                      <><p className="text-xs text-muted-foreground">Selections are kept when filters change.</p><div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                        {selectedIds.slice(selectedPageStart,selectedPageStart+50).map((id) => (
                          <button
                            key={id}
                            type="button"
                            onClick={() =>
                              setSelectedIds((previous) =>
                                previous.filter((value) => value !== id),
                              )
                            }
                            className="flex max-w-full items-center gap-1 rounded-full border border-transparent bg-muted/60 px-2.5 py-1.5 text-xs hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={`Remove ${knownRecipients[id]?.name || "contact"} from recipients`}
                          >
                            <span className="truncate">
                              {knownRecipients[id]?.name || "Loading contact…"}
                            </span>
                            <X className="h-3 w-3 shrink-0" />
                          </button>
                        ))}
                      </div>{selectedIds.length>50 && <div className="flex flex-wrap items-center gap-2 text-xs">
                        <p>Showing {selectedPageStart+1}–{Math.min(selectedPageStart+50,selectedIds.length)} of {selectedIds.length} selected contacts</p>
                        <Button type="button" size="sm" variant="outline" disabled={selectedPageStart===0} onClick={()=>setSelectedPage(selectedPageStart/50-1)}>Previous selected contacts</Button>
                        <Button type="button" size="sm" variant="outline" disabled={selectedPageStart+50>=selectedIds.length} onClick={()=>setSelectedPage(selectedPageStart/50+1)}>Next selected contacts</Button>
                      </div>}</>
                    )}
                    {recipientSpecificBlocks.length > 0 && (
                      <Callout tone="danger" size="sm" title={`${recipientSpecificBlocks.length} selected ${recipientSpecificBlocks.length === 1 ? "recipient is" : "recipients are"} blocked and will be excluded`}>
                        <ul className="space-y-1">
                          {recipientSpecificBlocks.map((item) => <li key={item.id}>{item.name}: {item.reason || "Recipient is unavailable."}</li>)}
                        </ul>
                      </Callout>
                    )}
                    {preparingContact && (
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Spinner size="xs" label={null} />
                        Preparing CRM contact…
                      </p>
                    )}
                    {contactError && (
                      <div role="alert" className="text-sm text-destructive">
                        {contactError}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setReload((value) => value + 1)}
                        >
                          Try again
                        </Button>
                      </div>
                    )}
                    {recipientError && (
                      <div role="alert" className="text-sm text-destructive">
                        {recipientError}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void loadRecipients()}
                        >
                          Try again
                        </Button>
                      </div>
                    )}
                    {selectedIds.length > 0 && !selectedReadinessCurrent && !selectedRecipientError && (
                      <p role="status" className="text-xs text-muted-foreground">Checking selected recipients…</p>
                    )}
                    {selectedRecipientError && (
                      <div role="alert" className="text-sm text-destructive">
                        {selectedRecipientError}
                        <Button variant="ghost" size="sm" onClick={() => setSelectedRecipientRetry(value => value + 1)}>
                          Retry selected contacts
                        </Button>
                      </div>
                    )}
                    {sharedRecipientReason && !isGlobalDeliveryMessage(sharedRecipientReason) && (
                      <p role="note" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                        None of these contacts can be sent to yet: {sharedRecipientReason}
                      </p>
                    )}
                    <div className="workspace-recipient-list max-h-80 divide-y overflow-y-auto rounded-md border">
                      {loadedRecipientFilter === recipientFilterKey && recipients.map((recipient) => (
                        <label
                          key={recipient.id}
                          className="flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/30"
                        >
                          <Checkbox
                            aria-label={`Select ${recipient.name}`}
                            checked={selectedIds.includes(recipient.id)}
                                                        onCheckedChange={(checked) =>
                              setSelectedIds((previous) =>
                                checked
                                  ? [...new Set([...previous, recipient.id])]
                                  : previous.filter(
                                      (id) => id !== recipient.id,
                                    ),
                              )
                            }
                            className="mt-1"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                              {recipient.name}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {(channel === 'whatsapp' || channel === 'sms') && recipient.phone ? recipient.phone : recipient.company ||
                                recipient.email ||
                                recipient.phone ||
                                "CRM contact"}
                            </p>
                            {recipientScopeCurrent && !isGlobalDeliveryMessage(recipient.reason) && recipient.reason !== sharedRecipientReason && <p
                              className={cn(
                                "mt-1 text-xs",
                                recipient.eligible
                                  ? "text-muted-foreground"
                                  : "text-destructive",
                              )}
                            >
                              {recipient.reason ||
                                (recipient.requiresTemplate
                                  ? "Approved template required"
                                  : "Ready to send")}
                            </p>}
                          </div>
                        </label>
                      ))}
                      {!recipients.length && recipientReadinessCurrent && (
                        <p className="p-4 text-sm text-muted-foreground">
                          {search || recipientSource !== 'all'
                            ? "No contacts match these filters."
                            : "No contacts yet. Add or import contacts in CRM."}{" "}
                          <Link
                            className="text-primary hover:underline"
                            href="/dashboard/crm/contacts"
                          >
                            Open contacts
                          </Link>
                        </p>
                      )}
                      {checkingRecipients && (
                        <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                          <Spinner size="sm" label={null} />
                          Checking recipients…
                        </p>
                      )}
                    </div>
                    {cursor && recipientScopeCurrent && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={loadingRecipients}
                        onClick={() => void loadRecipients(cursor)}
                      >
                        Load more contacts
                      </Button>
                    )}
                    {(channel === "instagram" || channel === "facebook") && (
                      <p className="text-xs leading-5 text-muted-foreground">
                        Only contacts with an open 24-hour reply window for this
                        account can receive a message. A username or profile
                        link alone does not enable messaging.
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>
              <div className="min-w-0 space-y-4">
                <Card className="workspace-panel">
                  <CardHeader className="p-4 pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <span className={cn("workspace-section-icon", channel === "whatsapp" && "workspace-whatsapp-icon")}><Icon className="h-5 w-5" /></span>
                      Message
                    </CardTitle>
                    <CardDescription>
                      Personalize your message and preview it for each recipient
                      before sending.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4 px-4 pb-4">
                    {channel === "email" && <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                      <OutreachBrandSelect value={brandToolkitId} onChange={setBrandToolkitId} threadId={threadId} disabled={sending} />
                      <EmailDesignPicker value={emailDesignId} onChange={setEmailDesignId} brandToolkitId={brandToolkitId} body={htmlMode ? body : plainTextToHtml(body)} />
                    </div>}
                    {(channel === "instagram" || channel === "facebook" || channel === "sms") && (
                      <div className="space-y-2">
                        <Label htmlFor={`${fieldPrefix}-saved-message`}>Saved message</Label>
                        <select
                          id={`${fieldPrefix}-saved-message`}
                          key={channel}
                          defaultValue=""
                          onChange={(event) => {
                            const preset = emailTemplates.find(
                              (item) => item.id === event.target.value,
                            );
                            if (preset) { setBody(preset.body); setSourceTemplateId(preset.sourceTemplateId); }
                            else { setSourceTemplateId(undefined); setResolvedTemplates({}); }
                          }}
                          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                        >
                          <option value="">Write a new message</option>
                          {emailTemplates.map((item, index) => (
                            <option key={item.id} value={item.id} disabled={!item.isApproved}>
                              {emailTemplateLabels[index]}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {channel === "email" && (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor={`${fieldPrefix}-email-template`}>Saved template</Label>
                          <select
                            id={`${fieldPrefix}-email-template`}
                            defaultValue=""
                            onChange={(event) => {
                              const selectedTemplate = emailTemplates.find(
                                (item) => item.id === event.target.value,
                              );
                              if (selectedTemplate) {
                                setSubject(selectedTemplate.subject);
                                setBody(selectedTemplate.body);
                                setHtmlMode(selectedTemplate.html);
                                setSourceTemplateId(selectedTemplate.sourceTemplateId);
                              } else { setSourceTemplateId(undefined); setResolvedTemplates({}); }
                            }}
                            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                          >
                            <option value="">Write a new email</option>
                            {emailTemplates.map((item, index) => (
                            <option key={item.id} value={item.id} disabled={!item.isApproved}>
                                {emailTemplateLabels[index]}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor={`${fieldPrefix}-message-subject`}>Subject</Label>
                          <Input
                            id={`${fieldPrefix}-message-subject`}
                            ref={subjectInput}
                            value={subject}
                            onChange={(event) => setSubject(event.target.value)}
                            onFocus={() => { lastVariableTarget.current = "subject"; }}
                            maxLength={500}
                            placeholder="Your subject line"
                          />
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor={`${fieldPrefix}-message-body`}>Email body</Label>
                          <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Checkbox
                              checked={emailSourceMode}
                              onCheckedChange={(checked) => {
                                if (checked && !htmlMode) { setBody(plainTextToHtml(body)); setHtmlMode(true); }
                                setEmailSourceMode(checked === true);
                              }}
                            />
                            Edit HTML
                          </label>
                        </div>
                      </>
                    )}
                    {channel === "whatsapp" && (
                      <>
                        <div className="workspace-mode-switch flex flex-wrap gap-1" role="group" aria-label="WhatsApp message mode">
                          <Button
                            type="button"
                            size="sm"
                            variant={
                              whatsappMode === "template"
                                ? "default"
                                : "outline"
                            }
                            onClick={() => setWhatsappMode("template")}
                            aria-pressed={whatsappMode === "template"}
                          >
                            Approved template
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant={
                              whatsappMode === "reply" ? "default" : "outline"
                            }
                            onClick={() => setWhatsappMode("reply")}
                            aria-pressed={whatsappMode === "reply"}
                          >
                            Reply within 24 hours
                          </Button>
                        </div>
                        <p className="text-xs leading-5 text-muted-foreground">Replies need an open window from the customer’s last inbound message; eligibility is checked again at send time.</p>
                        {whatsappMode === "template" && (
                          <WhatsAppTemplateEditor
                            showSummary={false}
                            providerAccountId={account?.providerAccountId}
                            loading={loadingTemplates}
                            templates={templates}
                            templateId={templateId}
                            values={templateValues}
                            onTemplateChange={(id) => {
                              setTemplateId(id);
                              setTemplateValues({});
                            }}
                            onValuesChange={setTemplateValues}
                          />
                        )}
                        {whatsappMode === "reply" && (
                          <p className="text-xs leading-5 text-muted-foreground">
                            Free-form replies are available within 24 hours of
                            the customer’s last message to this number. Use a
                            template for new outreach.
                          </p>
                        )}
                      </>
                    )}
                    {loadingTemplates && (
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Spinner size="xs" label={null} />
                        Loading templates…
                      </p>
                    )}
                    {templateError && (
                      <div role="alert" className="text-xs text-destructive">
                        {templateError}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void loadTemplates()}
                        >
                          <RefreshCw className="mr-1 h-3 w-3" />
                          Retry
                        </Button>
                      </div>
                    )}
                    {channel !== "whatsapp" && emailTemplates.some((item) => !item.isApproved) && (
                      <p className="text-xs text-muted-foreground">Templates marked “Needs approval” can be reviewed in the <Link className="text-primary hover:underline" href={`/dashboard/saved-templates/${channel === "email" || channel === "sms" ? channel : "dm"}`}>template library</Link>.</p>
                    )}
                    {channel === "whatsapp" &&
                      account?.ready &&
                      whatsappMode === "template" &&
                      !loadingTemplates &&
                      !templates.length &&
                      !templateError && (
                        <p className="text-sm text-muted-foreground">
                          This account has no approved templates yet.{" "}
                          <Link
                            href="/dashboard/integrations/whatsapp/templates"
                            className="text-primary hover:underline"
                          >
                            Create and submit a template
                          </Link>
                        </p>
                      )}
                    {(channel !== "whatsapp" || whatsappMode === "reply") && (
                      <>
                        {channel === "email" && emailSourceMode ? <Textarea
                          id={`${fieldPrefix}-message-body`}
                          ref={bodyInput}
                          aria-label="Message body"
                          rows={9}
                          value={body}
                          onChange={(event) => setBody(event.target.value)}
                          onFocus={() => { lastVariableTarget.current = "body"; }}
                          maxLength={htmlMode ? 250000 : 50000}
                          placeholder={
                            channel === "email"
                              ? "Hi {{first_name}},\n\nWrite your email here…"
                              : "Hi {{first_name}}, write your message…"
                          }
                          className="font-mono text-xs"
                        /> : <ChannelMessageEditor channel={channel} id={`${fieldPrefix}-message-body`} label="Message body"
                          value={channel === "email" && htmlMode ? plainEmail(body) : body}
                          htmlContent={channel === "email" && htmlMode ? body : undefined}
                          onChange={setBody} onHtmlChange={channel === "email" ? (html) => { setBody(html); setHtmlMode(true); } : undefined}
                          textareaRef={bodyInput} richTextRef={bodyEditor} rows={9}
                          maxLength={channel === "whatsapp" ? 4096 : 50000}
                          onFocus={() => { lastVariableTarget.current = "body"; }}
                          placeholder={channel === "email" ? "Hi {{first_name}}, write your email here…" : "Hi {{first_name}}, write your message…"} />}
                        {channel === "sms" && <SmsSegmentEstimate text={body} />}
                        <div className="flex flex-wrap gap-1.5">
                          {OUTREACH_VARIABLES.map((variable) => (
                            <Button
                              key={variable.token}
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => insertVariable(variable.token)}
                            >
                              {variable.label} · {`{{${variable.token}}}`}
                            </Button>
                          ))}
                        </div>
                      </>
                    )}
                    {channel === "email" && (
                      <div className="space-y-2">
                        <input
                          ref={fileInput}
                          type="file"
                          multiple
                          className="hidden"
                          onChange={(event) => void upload(event.target.files)}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          loading={uploading}
                          onClick={() => fileInput.current?.click()}
                        >
                          <Plus className="mr-2 h-4 w-4" />
                          {attachmentSourceMessageId
                            ? "Replace attachments"
                            : "Add attachments"}
                        </Button>
                        {attachments.map((item) => (
                          <div
                            key={item.id}
                            className="flex items-center justify-between gap-2 rounded border p-2 text-xs"
                          >
                            <span className="truncate">
                              {item.originalName || item.fileName}
                            </span>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              aria-label={`Remove ${item.fileName}`}
                              onClick={() =>
                                setAttachments((previous) =>
                                  previous.filter(
                                    (file) => file.id !== item.id,
                                  ),
                                )
                              }
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                    {channel === "whatsapp" && template && whatsappMode === "template" && (
                      <section className="overflow-hidden rounded-lg border" aria-label="Recipient preview">
                        <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/20 px-3 py-2.5">
                          <div><h2 className="text-sm font-semibold">Recipient preview</h2><p className="text-xs text-muted-foreground">Preview only · no message sent</p></div>
                          {preview && <select aria-label="Preview recipient while composing" value={String(preview.id)} onChange={event => setPreviewId(event.target.value)} className="h-9 max-w-full rounded-md border bg-card px-2 text-xs">{previewChoices.map(item => <option key={item.id} value={item.id}>{item.name}{!item.eligible ? " · Blocked" : ""}</option>)}</select>}
                        </div>
                        {selected.length>100 && <div className="space-y-2 border-t p-3"><Label htmlFor={`${fieldPrefix}-compose-preview-search`}>Search recipient previews</Label><Input id={`${fieldPrefix}-compose-preview-search`} value={previewSearch} onChange={event=>setPreviewSearch(event.target.value)} placeholder="Search selected contacts by name, email or phone"/><p className="text-xs text-muted-foreground">Showing up to 100 matches. All {selected.length} selected contacts remain in the audience.</p></div>}
                        <div className="wa-preview-pattern p-4 sm:p-5">
                          <div className="mx-auto max-w-md overflow-hidden rounded-lg border bg-card shadow-sm">
                            <div className="p-3">
                              {previewDelivery && <WhatsAppMediaPreview uploadedPreview={templateValues.mediaPreview} components={previewDelivery.message.templateComponents} />}
                              <p className="whitespace-pre-wrap break-words text-sm leading-5"><WhatsAppFormattedText>{previewDelivery?.message.message || template.body}</WhatsAppFormattedText></p>
                            </div>
                            {template.buttons?.map((button, index) => <div key={index} className="border-t px-3 py-2 text-center text-sm font-medium text-primary">{button.text}</div>)}
                          </div>
                        </div>
                        {!preview && <p className="px-3 py-2 text-xs text-muted-foreground">Select a recipient to preview personalization.</p>}
                      </section>
                    )}
                    {channel === "whatsapp" && (
                      <label className="flex items-start gap-3 rounded-md border p-3 text-xs leading-5">
                        <Checkbox
                          className="mt-0.5"
                          checked={optInConfirmed}
                          onCheckedChange={(checked) =>
                            setOptInConfirmed(checked === true)
                          }
                        />
                        These recipients have agreed to receive WhatsApp
                        messages from this business.
                      </label>
                    )}
                  </CardContent>
                </Card>
                <Card className="workspace-panel">
                  <CardHeader className="p-4 pb-3">
                    <CardTitle className="text-base">
                      <span className="flex items-center gap-3"><span className="workspace-section-icon"><CalendarClock className="h-5 w-5" /></span>Timing &amp; follow-ups</span>
                    </CardTitle>
                    <CardDescription>
                      Choose when to send your initial message.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4 px-4 pb-4">
                    {!embedded?.preparedOutreachId && (
                      <div className="space-y-2">
                        <Label htmlFor={`${fieldPrefix}-outreach-name`}>Name this outreach <span className="font-normal text-muted-foreground">(optional)</span></Label>
                        <Input
                          id={`${fieldPrefix}-outreach-name`}
                          value={outreachName}
                          maxLength={200}
                          placeholder="For example: Diwali offer"
                          disabled={sending}
                          onChange={(event) => setOutreachName(event.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">The name you&apos;ll see in Message tracking. Recipients never see it.</p>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={sendWhen === "now" ? "default" : "outline"}
                        aria-pressed={sendWhen === "now"}
                        onClick={() => setSendWhen("now")}
                      >
                        Immediately
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={sendWhen === "later" ? "default" : "outline"}
                        aria-pressed={sendWhen === "later"}
                        onClick={() => setSendWhen("later")}
                      >
                        <CalendarClock className="mr-2 h-4 w-4" />
                        Schedule
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">Choose when to send, then review and confirm your outreach below.</p>
                    {sendWhen === "later" && (
                      <div className="space-y-2">
                        <Label htmlFor={`${fieldPrefix}-send-time`}>Send date and time</Label>
                        <Input
                          id={`${fieldPrefix}-send-time`}
                          type="datetime-local"
                          value={schedule}
                          onChange={(event) => setSchedule(event.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          Your local time zone:{" "}
                          {deviceTimeZone()}.
                        </p>
                        {timingError && (
                          <p className="text-xs text-destructive">
                            {timingError}
                          </p>
                        )}
                      </div>
                    )}
                    {!manualSequence.enabled && <OutreachFollowUpEditor channel={channel} value={localFollowUps} onChange={updateLocalFollowUps}
                      templates={templates} providerAccountId={account?.providerAccountId} loadingTemplates={loadingTemplates} />}
                    {(channel === "instagram" ||
                      channel === "facebook" ||
                      (channel === "whatsapp" && whatsappMode === "reply")) && (
                      <p className="text-xs leading-5 text-muted-foreground">
                        Scheduled messages recheck the reply window at send
                        time. Messages outside an allowed window will not be
                        sent.
                      </p>
                    )}
                  </CardContent>
                </Card>
                {selectedIds.length > 0 && visiblePreflightIssues.length > 0 && (
                  <Callout tone="danger" title="Resolve these before sending">
                    <ul className="list-disc space-y-1 pl-5">
                      {[...new Set(visiblePreflightIssues)].map((issue) => <li key={issue}>{issue}</li>)}
                    </ul>
                  </Callout>
                )}
              </div>
            </div>
          ) : (
            <div className={compactEmbedded ? "grid gap-4" : "grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]"}>
              <Card className="self-start">
                <CardHeader>
                  <CardTitle className="text-base">Sending summary</CardTitle>
                  <CardDescription>
                    Review the final account, recipients and timing.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">Your full audience will enter the outreach queue. Daily allowances and temporary provider limits can delay delivery for up to 30 days. Meta marketing-limit rejections retry every 4 hours without an attempt cap until the reviewed queue expires. A longer provider cooldown is respected. Recipient eligibility, template approval and messaging windows are checked again before sending. Accepted messages are not retried. Track sent, delivered and waiting messages in Message tracking. <Link href="/dashboard/outreach/tracking" className="underline">Open Message tracking</Link></p>
                  <dl className="space-y-3 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">Channel</dt>
                      <dd className="mt-1 font-medium">
                        {CHANNELS[channel].label}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        Sending account
                      </dt>
                      <dd className="mt-1 break-all">{account?.label}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        Recipients
                      </dt>
                      <dd className="mt-1">
                        {eligible.length} ready · {blocked.length} blocked
                      </dd>
                    </div>
                    {channel === "whatsapp" && (
                      <WhatsAppCostPreview
                        phoneNumberId={account?.providerAccountId}
                        items={deliveries.map(({ message }) => ({
                          recipient: typeof message.expectedRecipient === "string" ? message.expectedRecipient : undefined,
                          templateName: typeof message.templateName === "string" ? message.templateName : undefined,
                          templateLanguage: typeof message.templateLanguage === "string" ? message.templateLanguage : undefined,
                        }))}
                      />
                    )}
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        Send time
                      </dt>
                      <dd className="mt-1">
                        {scheduledAt
                          ? new Date(scheduledAt).toLocaleString()
                          : "Now"}
                      </dd>
                    </div>
                  </dl>
                  {!manualSequence.enabled && <p className="text-sm">{localFollowUps.enabled ? `${localFollowUps.steps.length} follow-ups for this outreach only.` : 'No automatic follow-ups for this outreach.'}</p>}
                  {hasDistinctAccountBlock && (
                    <Callout tone="danger" size="sm" title="Sending account needs attention">
                      <p>{accountBlockReason}</p>
                      <Link href={channel === "email" ? "/dashboard/integrations/email" : channel === "sms" ? "/dashboard/integrations/msg91" : "/dashboard/integrations"} className="mt-2 inline-block underline">
                        Manage connection
                      </Link>
                    </Callout>
                  )}
                  {!globalDeliveryBlock && <AssistantDeliveryNotice readiness={deliveryReadiness} />}
                  {recipientSpecificBlocks.length > 0 && (
                    <div className="rounded-md border bg-muted/30 p-3 text-xs leading-5">
                      <p className="font-medium">
                        These contacts will be excluded
                      </p>
                      <ul className="mt-2 space-y-2">
                        {recipientSpecificBlocks.map((item) => (
                          <li key={item.id}>
                            <span className="font-medium">{item.name}: </span>
                            {item.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {invalidDeliveries.length > 0 && (
                    <div
                      role="alert"
                      className="rounded-md border border-destructive/30 p-3 text-xs text-destructive"
                    >
                      <p className="font-medium">
                        Complete these messages before sending
                      </p>
                      <ul className="mt-2 space-y-2">
                        {invalidDeliveries.map((item) => (
                          <li key={item.recipient.id}>
                            {item.recipient.name}: {item.errors.join(" ")}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {timingError && (
                    <p role="alert" className="text-sm text-destructive">
                      {timingError}
                    </p>
                  )}
                  {channel==='whatsapp' && <label className="flex items-start gap-3 rounded-md border p-3 text-xs leading-5"><Checkbox className="mt-0.5" checked={optInConfirmed} disabled={sending || inProgress} onCheckedChange={checked=>setOptInConfirmed(checked===true)}/>These recipients have agreed to receive WhatsApp messages from this business.</label>}
                  {channel === "whatsapp" && !optInConfirmed && (
                    <p role="alert" className="text-sm text-destructive">
                      Confirm recipient consent before sending.
                    </p>
                  )}
                  {inProgress && (
                    <p role="status" className="rounded-md border p-3 text-sm">
                      This request is still processing. Check its status using
                      the same request below.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={sending || inProgress}
                      onClick={() => setMode("edit")}
                    >
                      <ArrowLeft className="mr-2 h-4 w-4" />
                      Edit outreach
                    </Button>
                    {!compactEmbedded && <Button
                      loading={sending}
                      disabled={!canSend || reviewedFollowUpFingerprint !== currentFollowUpFingerprint}
                      onClick={() => void send()}
                    >
                      <Send className="mr-2 h-4 w-4" />
                      {inProgress
                        ? "Check status"
                        : `${scheduledAt ? "Schedule" : "Send"} to ${eligible.length} ${eligible.length === 1 ? "recipient" : "recipients"}`}
                    </Button>}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Recipient preview</CardTitle>
                  <CardDescription>
                    Check how personalization appears for each contact.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {selected.length>100 && <div className="space-y-2"><Label htmlFor={`${fieldPrefix}-preview-search`}>Search recipient previews</Label><Input id={`${fieldPrefix}-preview-search`} value={previewSearch} onChange={event=>setPreviewSearch(event.target.value)} placeholder="Search selected contacts by name, email or phone"/><p className="text-xs text-muted-foreground">Showing up to 100 matches. All {selected.length} selected contacts remain in the audience.</p></div>}
                  <Label htmlFor={`${fieldPrefix}-preview-recipient`}>Preview for</Label>
                  <select
                    id={`${fieldPrefix}-preview-recipient`}
                    disabled={!selectedReadinessCurrent}
                    value={preview ? String(preview.id) : ""}
                    onChange={(event) => setPreviewId(event.target.value)}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    {previewChoices.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {selectedReadinessCurrent && !item.eligible ? " · Blocked" : ""}
                      </option>
                    ))}
                  </select>
                  {preview && previewDelivery && (
                    <>
                      <div className="rounded-md border p-4">
                        <p className="mb-3 text-xs text-muted-foreground">
                          To:{" "}
                          {preview.email && channel === "email"
                            ? preview.email
                            : preview.recipient || preview.name}
                        </p>
                        {channel === "email" && (
                          <p className="mb-3 text-sm font-medium">
                            {String(previewDelivery.message.subject || "")}
                          </p>
                        )}
                        {channel === "whatsapp" && (
                          <WhatsAppMediaPreview
                            uploadedPreview={templateValues.mediaPreview}
                            components={
                              previewDelivery.message.templateComponents
                            }
                          />
                        )}
                        <EmailMessageContent
                          content={previewDelivery.message.message}
                          htmlContent={
                            previewDelivery.message.htmlContent as
                              | string
                              | undefined
                          }
                        />
                        {!manualSequence.enabled && <div className="mt-4 space-y-3 border-t pt-3" aria-label="Reviewed outreach follow-ups">
                          <p className="text-sm font-medium">Follow-ups for this outreach only</p>
                          {previewDelivery.message.followUps.map((step, index) => <div key={index} className="rounded border p-3">
                            <p className="mb-2 text-xs">Follow-up {index + 1} · {step.delayMinutes} minutes after initial message</p>
                            {step.subject && <p className="mb-2 text-sm font-medium">{step.subject}</p>}
                            {channel === 'whatsapp' && <WhatsAppMediaPreview components={step.templateComponents} />}
                            <EmailMessageContent content={step.message} htmlContent={step.htmlContent} />
                          </div>)}
                          {!previewDelivery.message.followUps.length && <p className="text-xs">No automatic follow-ups.</p>}
                        </div>}
                        {manualSequence.enabled && manualReview && <div className="mt-4 space-y-3 border-t pt-3" aria-label="Reviewed campaign follow-up messages">
                          <p className="text-sm font-medium">{manualSequence.campaign?.name} · revision {manualReview.sequence.version}</p>
                          {manualReview.recipients[String(preview.id)]?.steps.map((step,index)=><div key={index} className="rounded border p-3">
                            <p className="mb-2 text-xs">Step {index+1} · {step.delayMinutes} minutes after initial message · template revision {step.sourceTemplateVersion}</p>
                            {step.subject&&<p className="mb-2 text-sm font-medium">{step.subject}</p>}
                            <EmailMessageContent content={step.message} htmlContent={step.htmlContent}/>
                          </div>)}
                          {!manualReview.sequence.steps.length&&<p>Manual follow-ups are off for this campaign.</p>}
                        </div>}
                        {channel === "sms" && (
                          <div className="mt-3 border-t pt-3">
                            <SmsSegmentEstimate text={previewDelivery.message.message} personalized />
                          </div>
                        )}
                        {attachments.length > 0 && channel === "email" && (
                          <p className="mt-3 text-xs text-muted-foreground">
                            Attachments:{" "}
                            {attachments
                              .map((item) => item.originalName || item.fileName)
                              .join(", ")}
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}
      {!embedded && mode !== "result" && <CampaignManualSequencePanel key="campaign-manual-sequence" model={manualSequence} readOnly={mode === "review"} />}
      {mode === "edit" && <div className="workspace-action-bar sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-xs text-muted-foreground">{recipientReadinessCurrent ? `${eligible.length} ready · ${blocked.length} excluded` : `${selectedIds.length} selected · checking readiness`}{channel === "whatsapp" && !optInConfirmed ? " · consent confirmation required" : ""}</p>
          {(globalDeliveryBlock || (!loadingAccounts && !accountError && options?.channel === channel && !options.accounts.length)) ? (
            <p className="text-xs font-medium text-destructive">
              {globalDeliveryBlock
                ? "Review is unavailable: customer delivery is blocked for this channel."
                : `Review is unavailable: connect ${channelAccountPhrase(CHANNELS[channel].label)} first.`}
            </p>
          ) : reviewBlockReason && (
            <p role="status" className="text-xs font-medium text-destructive">
              Review is unavailable: {reviewBlockReason.text}
              {reviewBlockReason.href && <> <Link className="underline" href={reviewBlockReason.href}>{reviewBlockReason.action}</Link></>}
            </p>
          )}
        </div>
        <Button loading={reviewing} disabled={
          account?.assistant?.ready === false || Boolean(deliveryFailure) || Boolean(globalDeliveryBlock) ||
          !selectedIds.length || uploading || preparingContact || Boolean(contactError) ||
          (manualSequence.enabled && !manualSequence.ready) || !recipientReadinessCurrent
        } onClick={() => void review()}>
          Review outreach<ChevronRight className="ml-2 h-4 w-4" />
        </Button>
      </div>}
    </main>
  );
}
