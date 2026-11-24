'use client';

import Link from 'next/link';
import { getAuthHeaders } from '@/lib/authHeaders';
import { fetchSavedReportPdf } from '@/lib/savedReportPdf';

import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { useToast } from '@/hooks/use-toast';
import { aiVisibilityApi, type AiVisibilityProject } from '@/lib/ai-visibility';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ReportLibrary } from './ReportLibrary';
import { useMeasurement } from './workspace-context';
import { Empty, InlineError, Loading, statusBadge } from './workspace-ui';
import { fetchWithReadRetry } from "@/lib/api-client";
export function WorkspaceSharingDialog({ project }: { project: AiVisibilityProject }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [tagline, setTagline] = useState('');
  const [primaryColor, setPrimaryColor] = useState('');
  const [accentColor, setAccentColor] = useState('');
  const { can } = useMeasurement();
  const workspaces = useQuery({
    queryKey: ['ai-visibility-workspaces', project.businessProfileId],
    queryFn: aiVisibilityApi.listWorkspaces,
    enabled: open && can.edit,
  });
  const current = workspaces.data?.workspaces.find(item => item.workspace.id === project.workspaceId);
  useEffect(() => {
    if (!current) return;
    setDisplayName(current.workspace.whiteLabelDefaults.displayName || '');
    setTagline(current.workspace.whiteLabelDefaults.tagline || '');
    setPrimaryColor(current.workspace.whiteLabelDefaults.primaryColor || '');
    setAccentColor(current.workspace.whiteLabelDefaults.accentColor || '');
  }, [current]);
  const save = useMutation({
    mutationFn: () => aiVisibilityApi.updateWorkspace(project.workspaceId, { whiteLabelDefaults: { displayName, tagline, primaryColor, accentColor } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ai-visibility-workspaces'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-visibility-projects'] });
      toast({ title: 'Report branding updated' });
    },
    onError: error => toast({ title: 'Report branding could not be saved', description: error instanceof Error ? error.message : 'Try again.', variant: 'destructive' }),
  });
  return <>
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Staff & report branding</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Staff & report branding</DialogTitle><DialogDescription>This website belongs to your selected business profile and uses the same staff access.</DialogDescription></DialogHeader>
      <section className="rounded-xl border border-primary/20 bg-primary/5 p-4"><h3 className="text-sm font-semibold">Business staff</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">The business owner invites staff from one place. Their access applies to this website and the business’s other tools.</p><Button variant="outline" className="mt-3" asChild><Link href="/dashboard/settings/team">{can.members ? 'Manage staff' : 'View staff'}</Link></Button></section>
      {can.edit && (workspaces.isLoading ? <Loading /> : workspaces.isError || !current ? <InlineError message="Report branding could not be loaded." onRetry={() => void workspaces.refetch()} /> : <form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(); }}><div><h3 className="font-medium">PDF report branding</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Optional report branding overrides the Brand Toolkit for these reports. Methodology disclosures always remain.</p></div><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="report-display-name">Display name</Label><Input id="report-display-name" value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder={project.name} /></div><div className="space-y-1.5"><Label htmlFor="report-tagline">Tagline</Label><Input id="report-tagline" value={tagline} onChange={event => setTagline(event.target.value)} /></div><div className="space-y-1.5"><Label htmlFor="report-primary-color">Primary color</Label><Input id="report-primary-color" value={primaryColor} onChange={event => setPrimaryColor(event.target.value)} placeholder="#6d4aff" pattern="#[0-9A-Fa-f]{6}" /></div><div className="space-y-1.5"><Label htmlFor="report-accent-color">Accent color</Label><Input id="report-accent-color" value={accentColor} onChange={event => setAccentColor(event.target.value)} placeholder="#172033" pattern="#[0-9A-Fa-f]{6}" /></div></div><Button loading={save.isPending}>Save report branding</Button></form>)}
      <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Close</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}

export function ReportsView({ project }: { project: AiVisibilityProject }) {
  const { can } = useMeasurement();
  const projectId = project.id;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [emailAuditId, setEmailAuditId] = useState<number | null>(null);
  const [emailIntentKey, setEmailIntentKey] = useState<string | null>(null);
  const [recipientEmail, setRecipientEmail] = useState('');
  const query = useQuery({
    queryKey: ['ai-visibility-reports', projectId],
    queryFn: () => aiVisibilityApi.reports(projectId),
  });
  const sharesQuery = useQuery({
    queryKey: ['ai-visibility-report-shares', projectId],
    queryFn: () => aiVisibilityApi.reportShares(projectId),
  });
  const deliveriesQuery = useQuery({
    queryKey: ['ai-visibility-report-deliveries', projectId],
    queryFn: () => aiVisibilityApi.reportDeliveries(projectId),
  });
  useEffect(() => {
    setCreatedLink(null);
    setEmailAuditId(null);
    setEmailIntentKey(null);
    setRecipientEmail('');
  }, [projectId]);
  const createShare = useMutation({
    mutationFn: (auditId: number) => aiVisibilityApi.createReportShare(auditId, 7),
    onSuccess: ({ token }) => {
      setCreatedLink(aiVisibilityApi.sharedReportUrl(token));
      queryClient.invalidateQueries({
        queryKey: ['ai-visibility-report-shares', projectId],
      });
      toast({
        title: '7-day report link created',
        description: 'Copy it now. The secret link is shown only once.',
      });
    },
    onError: (error) =>
      toast({
        title: 'Share link could not be created',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });
  const revokeShare = useMutation({
    mutationFn: (shareId: number) => aiVisibilityApi.revokeReportShare(projectId, shareId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['ai-visibility-report-shares', projectId],
      });
      toast({ title: 'Share link revoked' });
    },
    onError: (error) =>
      toast({
        title: 'Share link could not be revoked',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });
  const sendEmail = useMutation({
    mutationFn: ({
      auditId,
      email,
      intentKey,
    }: {
      auditId: number;
      email: string;
      intentKey: string;
    }) => aiVisibilityApi.sendReportEmail(auditId, email, intentKey),
    onSuccess: ({ delivery }) => {
      queryClient.invalidateQueries({
        queryKey: ['ai-visibility-report-deliveries', projectId],
      });
      setEmailAuditId(null);
      setEmailIntentKey(null);
      setRecipientEmail('');
      toast({
        title: 'Report emailed',
        description: `The PDF was sent to ${delivery.recipientEmail}.`,
      });
    },
    onError: (error) => {
      queryClient.invalidateQueries({
        queryKey: ['ai-visibility-report-deliveries', projectId],
      });
      toast({
        title: 'Report email failed',
        description:
          error instanceof Error
            ? error.message
            : 'Check your connected Gmail or verified Resend sender.',
        variant: 'destructive',
      });
    },
  });
  const [downloading, setDownloading] = useState<string | null>(null);
  const download = async (auditId: number, format: 'pdf' | 'csv' | 'json') => {
    setDownloading(format.toUpperCase());
    try {
      let blob: Blob;
      if (format === 'pdf') {
        blob = await fetchSavedReportPdf(auditId);
      } else {
        const response = await fetchWithReadRetry(
          format === 'json'
            ? aiVisibilityApi.reportEvidenceUrl(auditId)
            : aiVisibilityApi.reportCsvUrl(auditId),
          { credentials: 'include', headers: getAuthHeaders() },
        );
        if (!response.ok) throw new Error(`${format.toUpperCase()} download failed.`);
        blob = await response.blob();
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `ai-visibility-audit-${auditId}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({
        title: `Could not download ${format.toUpperCase()}`,
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      });
    } finally {
      setDownloading(null);
    }
  };
  const activeShares = sharesQuery.data?.shares.filter((share) => share.active) || [];
  const deliveries = deliveriesQuery.data?.deliveries || [];
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Audit reports</CardTitle>
            <CardDescription className="mt-1.5">
              Download, email or share the report for any completed analysis.
            </CardDescription>
          </div>
          <WorkspaceSharingDialog project={project} />
        </CardHeader>
        <CardContent className="space-y-3">
          {createdLink && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
              <div className="font-medium">Copy this link now</div>
              <p className="mb-3 text-sm text-muted-foreground">
                For security, the complete secret link is shown only once. You can revoke it below.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  aria-label="New report share link"
                  readOnly
                  value={createdLink}
                  className="font-mono text-xs"
                />
                <CopyButton
                  value={createdLink}
                  label="Copy link"
                  size="default"
                  onError={() =>
                    toast({
                      title: 'Copy failed',
                      description: 'Select and copy the visible link manually.',
                      variant: 'destructive',
                    })
                  }
                />
              </div>
            </div>
          )}
          <ReportLibrary
            projectId={projectId}
            onDownload={download}
            downloading={downloading}
            onEmail={(auditId) => {
              setEmailAuditId(auditId);
              setEmailIntentKey(crypto.randomUUID());
            }}
            onShare={(auditId) => createShare.mutate(auditId)}
            sharing={createShare.isPending}
          />
        </CardContent>
      </Card>
      <details className="border-t pt-4">
        <summary className="cursor-pointer text-sm font-medium">Sharing & delivery history</summary>
        <div className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Active report links</CardTitle>
              <CardDescription>
                Anyone with a secret link can view that PDF until it expires or you revoke it.
                Create a fresh link if the original was not copied.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {sharesQuery.isLoading ? (
                <Loading />
              ) : sharesQuery.isError ? (
                <InlineError
                  message="Report links could not be loaded."
                  onRetry={() => sharesQuery.refetch()}
                />
              ) : activeShares.length ? (
                activeShares.map((share) => (
                  <div
                    key={share.id}
                    className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <div className="font-medium">
                        Audit #{share.auditId} · link {share.tokenPrefix}…
                      </div>
                      <div className="text-sm text-muted-foreground">
                        Expires {new Date(share.expiresAt).toLocaleString()} · Opened{' '}
                        {share.accessCount} time
                        {share.accessCount === 1 ? '' : 's'}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!can.edit || revokeShare.isPending}
                      onClick={() => revokeShare.mutate(share.id)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Revoke
                    </Button>
                  </div>
                ))
              ) : (
                <Empty message="No active report links." />
              )}
            </CardContent>
          </Card>
          {deliveriesQuery.isLoading ? (
            <p role="status">Loading delivery history…</p>
          ) : deliveriesQuery.isError ? (
            <InlineError
              message="Delivery history could not be loaded."
              onRetry={() => deliveriesQuery.refetch()}
            />
          ) : !deliveries.length ? (
            <Empty message="No report emails have been sent." />
          ) : null}
          {deliveries.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Email history</CardTitle>
                <CardDescription>
                  Delivery receipts from your connected Gmail or verified Resend sender.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {deliveries.map((delivery) => (
                  <div
                    key={delivery.id}
                    className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <div className="font-medium">{delivery.recipientEmail}</div>
                      <div className="text-sm text-muted-foreground">
                        Audit #{delivery.auditId} ·{' '}
                        {new Date(delivery.sentAt || delivery.createdAt).toLocaleString()}
                      </div>
                      {delivery.error && (
                        <div className="mt-1 text-sm text-destructive">{delivery.error}</div>
                      )}
                    </div>
                    {statusBadge(delivery.status)}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </details>
      <Dialog
        open={emailAuditId !== null}
        onOpenChange={(open) => {
          if (!open && !sendEmail.isPending) {
            setEmailAuditId(null);
            setEmailIntentKey(null);
            setRecipientEmail('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Email PDF report</DialogTitle>
            <DialogDescription>
              The report will be attached using your connected Gmail or verified Resend sender. This
              does not use AI Visibility analysis credits.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (emailAuditId && emailIntentKey && recipientEmail.trim())
                sendEmail.mutate({
                  auditId: emailAuditId,
                  email: recipientEmail.trim(),
                  intentKey: emailIntentKey,
                });
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="report-recipient">Recipient email</Label>
              <Input
                id="report-recipient"
                type="email"
                autoComplete="email"
                required
                maxLength={320}
                value={recipientEmail}
                onChange={(event) => setRecipientEmail(event.target.value)}
                placeholder="client@example.com"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={sendEmail.isPending}
                onClick={() => {
                  setEmailAuditId(null);
                  setEmailIntentKey(null);
                  setRecipientEmail('');
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                loading={sendEmail.isPending}
                disabled={!can.edit || !emailIntentKey || !recipientEmail.trim()}
              >
                Send report
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
