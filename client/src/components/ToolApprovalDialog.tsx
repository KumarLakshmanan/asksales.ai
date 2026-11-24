"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Check, X, Loader2, Zap, Instagram, Facebook, Youtube, Users, Mail, MessageSquare, Megaphone, Calendar, Send, FileText, ExternalLink } from "lucide-react";
import { useOrganicPublishingAccounts } from '@/hooks/useOrganicPublishingAccounts';

export interface ApprovalData {
  toolName: string;
  toolDescription?: string;
  parameters?: Record<string, unknown>;
  agentType?: string;
  requestId?: string;
  message?: string;
  // Extra preview data passed from agents
  previewImageUrl?: string;
  previewVideoUrl?: string;
  previewCaption?: string;
  assetTitle?: string;
}

interface ToolApprovalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  approvalData: ApprovalData | null;
  isApproving: boolean;
  onApproval: (approved: boolean, overrides?: Record<string, unknown>) => void;
}

// ─── Platform icon helper ───────────────────────────────────────────────────

function PlatformIcon({ platform }: { platform: string }) {
  switch (platform?.toLowerCase()) {
    case 'instagram': return <Instagram className="w-5 h-5 text-pink-500" />;
    case 'facebook': return <Facebook className="w-5 h-5 text-blue-600" />;
    case 'youtube': return <Youtube className="w-5 h-5 text-red-600" />;
    default: return <Send className="w-5 h-5 text-muted-foreground" />;
  }
}

function platformLabel(platform: string): string {
  switch (platform?.toLowerCase()) {
    case 'instagram': return 'Instagram';
    case 'facebook': return 'Facebook';
    case 'youtube': return 'YouTube';
    default: return platform ?? 'Social';
  }
}

// ─── Publish social post panel ─────────────────────────────────────────────

function PublishSocialPostPanel({ 
  data, 
  onApproval, 
  isApproving 
}: { 
  data: ApprovalData; 
  onApproval: (approved: boolean, overrides?: Record<string, unknown>) => void;
  isApproving: boolean;
}) {
  const params = data.parameters || {};
  const platform = (params.platform as string) || '';
  const assetId = params.content_asset_id;
  const scheduledFor = params.scheduled_for as string | undefined;

  const [caption, setCaption] = useState<string>((params.caption as string) || data.previewCaption || '');
  const initialPostType = (params.post_type as string) === 'shorts'
    ? 'short'
    : (params.post_type as string) || (platform === 'youtube' ? 'video' : 'post');
  const [postType, setPostType] = useState<string>(initialPostType);
  const [youtubeTitle, setYoutubeTitle] = useState<string>((params.title as string) || data.assetTitle || '');
  const [privacyStatus, setPrivacyStatus] = useState<string>((params.privacy_status as string) || 'private');
  const [credentialId, setCredentialId] = useState<number>(Number(params.credential_id) || 0);
  const { accounts: publishingAccounts, loading: publishingAccountsLoading } = useOrganicPublishingAccounts();
  const organicPlatform = platform === 'instagram' || platform === 'facebook' || platform === 'youtube' ? platform : null;
  const accounts = organicPlatform
    ? publishingAccounts.filter(account => account.platform === organicPlatform)
    : [];

  useEffect(() => {
    if (credentialId || !organicPlatform) return;
    const matchingAccounts = publishingAccounts.filter(account => account.platform === organicPlatform);
    const preferred = matchingAccounts.find((account) => account.isSelected) || (matchingAccounts.length === 1 ? matchingAccounts[0] : undefined);
    if (preferred) setCredentialId(preferred.credentialId);
  }, [credentialId, organicPlatform, publishingAccounts]);

  const platformBg: Record<string, string> = {
    instagram: 'bg-gradient-to-r from-purple-500 to-pink-500',
    facebook: 'bg-blue-600',
    youtube: 'bg-red-600',
  };

  const handleApprove = () => {
    const overrides: Record<string, unknown> = {};
    overrides.caption = caption;
    if (postType && postType !== (params.post_type as string)) overrides.post_type = postType;
    if (platform === 'youtube' && youtubeTitle) overrides.title = youtubeTitle;
    if (platform === 'youtube') overrides.privacy_status = privacyStatus;
    if (organicPlatform && credentialId) overrides.credential_id = credentialId;
    onApproval(true, overrides);
  };

  return (
    <div className="space-y-4">
      {/* Platform badge */}
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-xl ${platformBg[platform] || 'bg-muted'} flex items-center justify-center flex-shrink-0`}>
          <PlatformIcon platform={platform} />
        </div>
        <div>
          <p className="font-semibold text-sm">Publish to {platformLabel(platform)}</p>
          <p className="text-xs text-muted-foreground">
            {scheduledFor 
              ? `Scheduled for ${new Date(scheduledFor).toLocaleString()}`
              : 'Will post immediately upon approval'}
          </p>
        </div>
        {typeof assetId === 'number' && (
          <Badge variant="outline" className="ml-auto text-xs">
            Asset #{assetId}
          </Badge>
        )}
      </div>

      {organicPlatform && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Publishing account</Label>
          <Select value={credentialId ? String(credentialId) : undefined} onValueChange={(value) => setCredentialId(Number(value))}>
            <SelectTrigger className="text-sm h-9"><SelectValue placeholder={`Select ${platformLabel(platform)} account`} /></SelectTrigger>
            <SelectContent>
              {accounts.map((account) => (
                <SelectItem key={account.credentialId} value={String(account.credentialId)}>{account.accountName}{account.isSelected ? ' · Default' : ''}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!publishingAccountsLoading && accounts.length === 0 && <p className="text-xs text-destructive">Connect an active account before publishing.</p>}
        </div>
      )}

      {/* Preview image if available */}
      {data.previewImageUrl && (
        <div className="rounded-lg overflow-hidden border border-border aspect-square max-h-40 w-full">
          <img src={data.previewImageUrl} alt="Content preview" className="w-full h-full object-cover" />
        </div>
      )}

      {/* YouTube title */}
      {platform === 'youtube' && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Video Title <span className="text-red-500">*</span></Label>
            <Input
              value={youtubeTitle}
              onChange={(e) => setYoutubeTitle(e.target.value)}
              placeholder="Enter YouTube video title..."
              maxLength={100}
              className="text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Format</Label>
              <Select value={postType} onValueChange={setPostType}>
                <SelectTrigger className="text-sm h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="video">Video</SelectItem>
                  <SelectItem value="short">Short</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Visibility</Label>
              <Select value={privacyStatus} onValueChange={setPrivacyStatus}>
                <SelectTrigger className="text-sm h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Private</SelectItem>
                  <SelectItem value="unlisted">Unlisted</SelectItem>
                  <SelectItem value="public">Public</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )}

      {/* Post type (Instagram only) */}
      {platform === 'instagram' && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Post Type</Label>
          <Select value={postType} onValueChange={setPostType}>
            <SelectTrigger className="text-sm h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="post">Feed Post</SelectItem>
              <SelectItem value="reel">Reel</SelectItem>
              <SelectItem value="story">Story</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Caption editor */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">
          {platform === 'youtube' ? 'Description' : 'Caption'}
          <span className="text-muted-foreground ml-1">(optional — edit before posting)</span>
        </Label>
        <Textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder={`Add your ${platform === 'youtube' ? 'description' : 'caption'}...`}
          rows={3}
          className="text-sm resize-none"
        />
      </div>

      {/* Scheduled info banner */}
      {scheduledFor && (
        <Callout tone="info" size="sm" icon={Calendar}>
          Scheduled: <strong>{new Date(scheduledFor).toLocaleString()}</strong>
        </Callout>
      )}

      {/* Footer */}
      <div className="flex gap-2 pt-1">
        <Button
          variant="outline"
          onClick={() => onApproval(false)}
          disabled={isApproving}
          className="flex-1 text-destructive hover:text-destructive"
        >
          <X className="w-4 h-4 mr-1.5" />
          Cancel
        </Button>
        <Button
          onClick={handleApprove}
          disabled={isApproving || (platform === 'youtube' && !youtubeTitle.trim()) || Boolean(organicPlatform && !credentialId)}
          className={`flex-1 ${platformBg[platform] || ''} text-white border-0 hover:opacity-90`}
        >
          {isApproving 
            ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            : <Send className="w-4 h-4 mr-1.5" />
          }
          {scheduledFor ? 'Schedule Post' : `Post to ${platformLabel(platform)}`}
        </Button>
      </div>
    </div>
  );
}

// ─── Meta ads panel ─────────────────────────────────────────────────────────

function PublishMetaAdsPanel({ 
  data, 
  onApproval, 
  isApproving 
}: { 
  data: ApprovalData; 
  onApproval: (approved: boolean) => void; 
  isApproving: boolean;
}) {
  const params = data.parameters || {};

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-blue-100 dark:bg-blue-950 flex items-center justify-center flex-shrink-0">
          <Megaphone className="w-5 h-5 text-blue-600" />
        </div>
        <div>
          <p className="font-semibold text-sm">{(params.campaign_name as string) || 'Meta Ad Campaign'}</p>
          <p className="text-xs text-muted-foreground capitalize">
            {(params.objective as string) || 'Campaign'} · {(params.platform as string) === 'both' ? 'Facebook + Instagram' : platformLabel(params.platform as string)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        {typeof params.budget === 'number' && (
          <div className="p-2.5 rounded-lg bg-muted space-y-0.5">
            <p className="text-xs text-muted-foreground">Budget</p>
            <p className="font-semibold">${(params.budget / 100).toFixed(2)}/{params.budget_type === 'lifetime' ? 'total' : 'day'}</p>
          </div>
        )}
        {typeof params.ad_format === 'string' && (
          <div className="p-2.5 rounded-lg bg-muted space-y-0.5">
            <p className="text-xs text-muted-foreground">Format</p>
            <p className="font-semibold capitalize">{params.ad_format.replace('_', ' ')}</p>
          </div>
        )}
        {typeof params.headline === 'string' && (
          <div className="col-span-2 p-2.5 rounded-lg bg-muted space-y-0.5">
            <p className="text-xs text-muted-foreground">Headline</p>
            <p className="font-medium leading-snug">{params.headline}</p>
          </div>
        )}
        {typeof params.body_text === 'string' && (
          <div className="col-span-2 p-2.5 rounded-lg bg-muted space-y-0.5">
            <p className="text-xs text-muted-foreground">Ad Copy</p>
            <p className="text-sm leading-snug line-clamp-3">{params.body_text}</p>
          </div>
        )}
        {typeof params.cta_type === 'string' && (
          <div className="p-2.5 rounded-lg bg-muted space-y-0.5">
            <p className="text-xs text-muted-foreground">Call to Action</p>
            <p className="font-medium capitalize">{params.cta_type.replace('_', ' ')}</p>
          </div>
        )}
        {Array.isArray(params.asset_ids) && params.asset_ids.length > 0 && (
          <div className="p-2.5 rounded-lg bg-muted space-y-0.5">
            <p className="text-xs text-muted-foreground">Ad Creatives</p>
            <p className="font-medium">{params.asset_ids.length} asset(s) ready</p>
          </div>
        )}
      </div>

      <div className="flex gap-2 pt-1">
        <Button variant="outline" onClick={() => onApproval(false)} disabled={isApproving} className="flex-1 text-destructive hover:text-destructive">
          <X className="w-4 h-4 mr-1.5" /> Cancel
        </Button>
        <Button onClick={() => onApproval(true)} disabled={isApproving} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white border-0">
          {isApproving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Megaphone className="w-4 h-4 mr-1.5" />}
          Launch Campaign
        </Button>
      </div>
    </div>
  );
}

// ─── Outreach panel ─────────────────────────────────────────────────────────

function SendOutreachPanel({ 
  data, 
  onApproval, 
  isApproving 
}: { 
  data: ApprovalData; 
  onApproval: (approved: boolean) => void; 
  isApproving: boolean;
}) {
  const params = data.parameters || {};
  const channel = (params.channel as string) || 'email';
  const count = (params.lead_ids as number[] | undefined)?.length ?? (params.recipient_count as number) ?? 0;

  const channelIcon = channel === 'email' 
    ? <Mail className="w-5 h-5 text-green-600" />
    : channel === 'sms' 
    ? <MessageSquare className="w-5 h-5 text-amber-600" />
    : <Instagram className="w-5 h-5 text-pink-500" />;

  const channelBg = channel === 'email' ? 'bg-green-100 dark:bg-green-950' 
    : channel === 'sms' ? 'bg-amber-100 dark:bg-amber-950'
    : 'bg-pink-100 dark:bg-pink-950';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-xl ${channelBg} flex items-center justify-center flex-shrink-0`}>
          {channelIcon}
        </div>
        <div>
          <p className="font-semibold text-sm capitalize">{channel} Outreach</p>
          <p className="text-xs text-muted-foreground">
            {count > 0 ? `${count} recipient${count !== 1 ? 's' : ''}` : 'Multiple recipients'} will be contacted
          </p>
        </div>
      </div>

      {typeof params.subject === 'string' && (
        <div className="p-2.5 rounded-lg bg-muted">
          <p className="text-xs text-muted-foreground mb-0.5">Subject</p>
          <p className="text-sm font-medium">{params.subject}</p>
        </div>
      )}

      {data.message && (
        <p className="text-sm text-muted-foreground">{data.message}</p>
      )}

      <div className="flex gap-2 pt-1">
        <Button variant="outline" onClick={() => onApproval(false)} disabled={isApproving} className="flex-1 text-destructive hover:text-destructive">
          <X className="w-4 h-4 mr-1.5" /> Cancel
        </Button>
        <Button onClick={() => onApproval(true)} disabled={isApproving} className="flex-1">
          {isApproving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Send className="w-4 h-4 mr-1.5" />}
          Send Messages
        </Button>
      </div>
    </div>
  );
}

function SendProposalPanel({
  data,
  onApproval,
  isApproving,
}: {
  data: ApprovalData;
  onApproval: (approved: boolean) => void;
  isApproving: boolean;
}) {
  const params = data.parameters || {};
  const title = String(params.proposalTitle || `Proposal #${params.proposalId || ''}`);
  const proposalNumber = String(params.proposalNumber || '').trim();
  const channel = String(params.channel || 'email');
  const recipient = String(params.resolvedRecipient || params.recipientEmail || params.recipientName || 'Unresolved recipient');
  const subject = typeof params.subject === 'string' ? params.subject : '';
  const message = typeof params.message === 'string' ? params.message : '';
  const currency = typeof params.currency === 'string' ? params.currency : 'USD';
  const total = Number(params.total || 0);
  const reviewUrl = typeof params.reviewUrl === 'string' ? params.reviewUrl : '';
  const formattedTotal = (() => {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(total); }
    catch { return `${currency} ${total.toFixed(2)}`; }
  })();

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
          <FileText className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{title}</p>
          <p className="text-xs text-muted-foreground">{proposalNumber || `Proposal ${params.proposalId}`} · revision {String(params.expectedRevision || '')}</p>
        </div>
        <Badge variant="outline" className="capitalize">{channel}</Badge>
      </div>

      <dl className="grid gap-3 rounded-xl border bg-muted/30 p-3 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">Customer</dt><dd className="mt-1 break-words font-medium">{recipient}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Proposal total</dt><dd className="mt-1 font-semibold tabular-nums">{formattedTotal}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Provider account</dt><dd className="mt-1 break-words">{String(params.providerAccountId || 'Not resolved')}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Email provider</dt><dd className="mt-1 capitalize">{String(params.providerVariant || (channel === 'email' ? 'Default' : 'Not applicable'))}</dd></div>
      </dl>

      {subject && <div className="rounded-lg bg-muted p-2.5"><p className="mb-0.5 text-xs text-muted-foreground">Subject</p><p className="text-sm font-medium">{subject}</p></div>}
      {message && <div><p className="mb-1 text-xs font-medium text-muted-foreground">Delivery message</p><p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg border p-3 text-sm">{message}</p></div>}
      {reviewUrl && <a href={reviewUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-4">Open full proposal <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a>}

      <Callout tone="warning" size="sm">
        Approval is bound to this exact proposal revision, recipient, provider account, subject, and message. If team review is required, approval records your review and holds delivery until every assigned reviewer approves.
      </Callout>

      <div className="flex gap-2 pt-1">
        <Button variant="outline" onClick={() => onApproval(false)} disabled={isApproving} className="flex-1 text-destructive hover:text-destructive">
          <X className="mr-1.5 h-4 w-4" /> Cancel
        </Button>
        <Button onClick={() => onApproval(true)} disabled={isApproving} className="flex-1">
          {isApproving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}
          Approve delivery
        </Button>
      </div>
    </div>
  );
}

// ─── Lead workflow panel ─────────────────────────────────────────────────────

function ExecuteLeadWorkflowPanel({ 
  data, 
  onApproval, 
  isApproving 
}: { 
  data: ApprovalData; 
  onApproval: (approved: boolean) => void; 
  isApproving: boolean;
}) {
  const params = data.parameters || {};
  const platforms = ((params.platforms as string[]) || []).join(', ');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-green-100 dark:bg-green-950 flex items-center justify-center flex-shrink-0">
          <Users className="w-5 h-5 text-green-600" />
        </div>
        <div>
          <p className="font-semibold text-sm">Start Lead Generation</p>
          <p className="text-xs text-muted-foreground">
            {platforms ? `Finding leads on: ${platforms}` : 'Scraping leads from configured platforms'}
          </p>
        </div>
      </div>

      {data.message && (
        <p className="text-sm text-muted-foreground">{data.message}</p>
      )}

      <Callout tone="warning" size="sm">
        This will use credits to scrape leads from external platforms.
      </Callout>

      <div className="flex gap-2 pt-1">
        <Button variant="outline" onClick={() => onApproval(false)} disabled={isApproving} className="flex-1 text-destructive hover:text-destructive">
          <X className="w-4 h-4 mr-1.5" /> Cancel
        </Button>
        <Button onClick={() => onApproval(true)} disabled={isApproving} className="flex-1 bg-green-600 hover:bg-green-700 text-white border-0">
          {isApproving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Users className="w-4 h-4 mr-1.5" />}
          Start Scraping
        </Button>
      </div>
    </div>
  );
}

// ─── Generic fallback panel ──────────────────────────────────────────────────

function GenericApprovalPanel({ 
  data, 
  onApproval, 
  isApproving 
}: { 
  data: ApprovalData; 
  onApproval: (approved: boolean) => void; 
  isApproving: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="p-4 bg-muted rounded-lg space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Tool</span>
          <Badge variant="secondary" className="flex items-center gap-1">
            <Zap className="w-3 h-3" />
            {data.toolName}
          </Badge>
        </div>

        {data.toolDescription && (
          <div>
            <span className="text-sm text-muted-foreground">Description</span>
            <p className="text-sm mt-1">{data.toolDescription}</p>
          </div>
        )}

        {data.message && (
          <p className="text-sm">{data.message}</p>
        )}

        {data.agentType && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Requested by</span>
            <Badge variant="outline">{data.agentType}</Badge>
          </div>
        )}

        {data.parameters && Object.keys(data.parameters).length > 0 && (
          <div>
            <span className="text-sm text-muted-foreground">Parameters</span>
            <pre className="text-xs mt-1 p-2 bg-background rounded overflow-auto max-h-32">
              {JSON.stringify(data.parameters, null, 2)}
            </pre>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <Button variant="destructive" onClick={() => onApproval(false)} disabled={isApproving} className="flex-1">
          {isApproving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <X className="w-4 h-4 mr-2" />}
          Reject
        </Button>
        <Button onClick={() => onApproval(true)} disabled={isApproving} className="flex-1">
          {isApproving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}
          Approve
        </Button>
      </div>
    </div>
  );
}

// ─── Main approval card ──────────────────────────────────────────────────────

const TOOL_TITLES: Record<string, { title: string; description: string }> = {
  publish_social_post: {
    title: 'Ready to Publish',
    description: 'Review and approve posting this content to social media.',
  },
  publish_meta_ads: {
    title: 'Launch Ad Campaign',
    description: 'Review your ad campaign details before launching on Meta.',
  },
  send_outreach_messages: {
    title: 'Send Outreach',
    description: 'Review before sending messages to your leads.',
  },
  send_proposal: {
    title: 'Send Proposal',
    description: 'Review the exact customer document and delivery target before approving.',
  },
  execute_lead_workflow: {
    title: 'Start Lead Generation',
    description: 'Confirm to begin scraping leads from the selected platforms.',
  },
};

export function ToolApprovalDialog({
  open,
  onOpenChange,
  approvalData,
  isApproving,
  onApproval,
}: ToolApprovalDialogProps) {
  const toolInfo = approvalData ? (TOOL_TITLES[approvalData.toolName] ?? null) : null;

  const handleApproval = (approved: boolean, overrides?: Record<string, unknown>) => {
    onApproval(approved, overrides);
  };

  if (!open) return null;

  return (
    <section
      role="region"
      aria-label="Approval required"
      className="fixed bottom-3 left-3 right-3 z-[var(--layer-floating)] max-h-[calc(100dvh-1.5rem)] overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-200 [&_button]:min-h-10 sm:bottom-5 sm:left-auto sm:right-5 sm:w-[28rem]"
    >
      <div className="flex items-start gap-3 border-b border-border/60 px-4 py-3.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-primary/15 bg-primary/10 text-primary">
          {toolInfo ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold leading-5 text-foreground">
            {toolInfo ? (
              toolInfo.title
            ) : (
              "Approval required"
            )}
          </h2>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
            {toolInfo?.description || approvalData?.toolDescription || "Review the agent action before it runs."}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onOpenChange(false)}
          aria-label="Dismiss approval"
          className="h-10 w-10 shrink-0 rounded-[10px] text-muted-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      <div className="max-h-[calc(100dvh-7rem)] overflow-y-auto p-4">
        {approvalData && (
          <>
            {approvalData.toolName === 'publish_social_post' ? (
              <PublishSocialPostPanel data={approvalData} onApproval={handleApproval} isApproving={isApproving} />
            ) : approvalData.toolName === 'publish_meta_ads' ? (
              <PublishMetaAdsPanel data={approvalData} onApproval={handleApproval} isApproving={isApproving} />
            ) : approvalData.toolName === 'send_outreach_messages' ? (
              <SendOutreachPanel data={approvalData} onApproval={handleApproval} isApproving={isApproving} />
            ) : approvalData.toolName === 'send_proposal' ? (
              <SendProposalPanel data={approvalData} onApproval={handleApproval} isApproving={isApproving} />
            ) : approvalData.toolName === 'execute_lead_workflow' ? (
              <ExecuteLeadWorkflowPanel data={approvalData} onApproval={handleApproval} isApproving={isApproving} />
            ) : (
              <GenericApprovalPanel data={approvalData} onApproval={handleApproval} isApproving={isApproving} />
            )}
          </>
        )}
      </div>
    </section>
  );
}
