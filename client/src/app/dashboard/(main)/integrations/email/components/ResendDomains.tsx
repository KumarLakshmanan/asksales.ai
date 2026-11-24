import { Check, CheckCircle2, ChevronDown, Clock3, Copy, Globe2, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import type { ResendDomain } from "./types";

interface ResendDomainsProps {
  domains: ResendDomain[];
  domainName: string;
  addingDomain: boolean;
  verifyingId: string | null;
  deletingId: string | null;
  sendingTest: boolean;
  testEmail: string;
  copiedValue: string | null;
  expandedDomainId: string | null;
  onAddDomain: () => void;
  onDeleteDomain: (id: string) => void;
  onVerifyDomain: (id: string) => void;
  onSendTest: (id: number) => void;
  onSetDomainName: (val: string) => void;
  onSetTestEmail: (val: string) => void;
  onSetExpandedDomainId: (id: string | null) => void;
  onRefreshDns: (id: string) => void;
  refreshingDnsId: string | null;
  refreshDnsError?: { id: string; message: string } | null;
  copyToClipboard: (text: string) => void;
}

export function ResendDomains({ domains, domainName, addingDomain, verifyingId, deletingId, sendingTest, testEmail, copiedValue, expandedDomainId, onAddDomain, onDeleteDomain, onVerifyDomain, onSendTest, onSetDomainName, onSetTestEmail, onSetExpandedDomainId, onRefreshDns, refreshingDnsId, refreshDnsError, copyToClipboard }: ResendDomainsProps) {
  const verifiedCount = domains.filter(domain => domain.status === "verified").length;

  return <section aria-labelledby="domains-heading" className="overflow-hidden rounded-2xl border bg-card shadow-sm">
    <div className="flex flex-col gap-4 border-b p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div className="flex min-w-0 items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"><Globe2 className="h-5 w-5" /></span>
        <div><h2 id="domains-heading" className="text-lg font-semibold tracking-tight">Sending domains</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Use your own business domain: add it, verify the DNS records, then create a sender address.</p></div>
      </div>
      <span className="text-xs font-medium text-muted-foreground">{verifiedCount} of {domains.length} verified</span>
    </div>

    <form className="flex flex-col gap-3 border-b p-5 sm:flex-row sm:items-end sm:p-6" onSubmit={event => { event.preventDefault(); onAddDomain(); }}>
      <div className="min-w-0 flex-1 space-y-2"><Label htmlFor="sending-domain-name">Domain name</Label><Input id="sending-domain-name" value={domainName} onChange={event => onSetDomainName(event.target.value)} placeholder="mail.example.com" autoComplete="off" className="h-10" /><p className="text-xs text-muted-foreground">Add the DNS records shown after you create the domain.</p></div>
      <Button type="submit" className="h-10 shrink-0 rounded-full px-5" loading={addingDomain} loadingText="Add domain" disabled={!domainName.trim()}><Plus className="mr-2 h-4 w-4" />Add domain</Button>
    </form>

    {domains.length === 0 ? <div className="px-6 py-10 text-center"><Globe2 className="mx-auto h-8 w-8 text-muted-foreground/50" /><p className="mt-3 font-medium">No sending domains yet</p><p className="mt-1 text-sm text-muted-foreground">Add your domain above to see the DNS records needed for verification.</p></div> : <div className="divide-y">
      {domains.map(domain => {
        const expanded = expandedDomainId === domain.resendDomainId;
        const verified = domain.status === "verified";
        const refreshError = refreshDnsError?.id === domain.resendDomainId ? refreshDnsError.message : null;
        const refreshErrorId = `domain-refresh-error-${domain.id}`;
        return <div key={domain.resendDomainId}>
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div className="flex min-w-0 items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted"><Globe2 className="h-5 w-5 text-muted-foreground" /></span><div className="min-w-0"><p className="break-all text-sm font-semibold">{domain.name}</p><p className="mt-1 text-xs text-muted-foreground">{verified ? "Ready for sender addresses" : "Add the DNS records below, then check verification"}</p></div></div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end"><StatusBadge status={verified ? "verified" : "pending"} label={verified ? "Verified" : "Pending DNS"} /><Button variant="outline" size="sm" className="rounded-full" aria-expanded={expanded} aria-controls={`domain-records-${domain.id}`} onClick={() => onSetExpandedDomainId(expanded ? null : domain.resendDomainId)}>DNS records<ChevronDown className={`ml-2 h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} /></Button>
              <AlertDialog><AlertDialogTrigger asChild><Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" aria-label={`Delete domain ${domain.name}`} loading={deletingId === domain.resendDomainId}><Trash2 className="h-4 w-4" /></Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete {domain.name}?</AlertDialogTitle><AlertDialogDescription>Sender addresses using this domain may stop sending. This removes its connection from AskSales.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => onDeleteDomain(domain.resendDomainId)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete domain</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
            </div>
          </div>
          {expanded && <div id={`domain-records-${domain.id}`} className="space-y-5 border-t bg-muted/20 p-5 sm:p-6">
            <div><h4 className="text-sm font-semibold">DNS records for {domain.name}</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">Copy these values into your DNS provider. DNS changes can take time to appear.</p></div>
            {refreshError && <div className="space-y-3">
              <p id={refreshErrorId} role="alert" className="text-sm leading-6 text-foreground">{refreshError} Showing the last known DNS records for {domain.name}; they may be out of date.</p>
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => onRefreshDns(domain.resendDomainId)} disabled={refreshingDnsId === domain.resendDomainId} aria-label={`Retry DNS records for ${domain.name}`} aria-describedby={refreshErrorId}>Retry DNS records</Button>
            </div>}
            {domain.dnsRecords.length ? <div className="grid gap-3">{domain.dnsRecords.map((record, index) => <div key={`${record.record}-${record.name}-${index}`} className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-center">
              <div><span className="text-xs text-muted-foreground">Record</span><p className="mt-1 text-sm font-medium">{record.record} <span className="text-muted-foreground">· {record.type}</span></p></div>
              <div className="min-w-0"><span className="text-xs text-muted-foreground">Host</span><div className="mt-1 flex items-center gap-1"><code className="min-w-0 truncate text-xs">{record.name || "@"}</code><Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => copyToClipboard(record.name || "@")} aria-label={`Copy host for ${record.record}`}>{copiedValue === (record.name || "@") ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}</Button></div></div>
              <div className="min-w-0"><span className="text-xs text-muted-foreground">Value</span><div className="mt-1 flex items-center gap-1"><code className="min-w-0 truncate text-xs" title={record.value}>{record.value}</code><Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => copyToClipboard(record.value)} aria-label={`Copy value for ${record.record}`}>{copiedValue === record.value ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}</Button></div></div>
              <span className={`inline-flex items-center gap-1 text-xs font-medium ${record.status === "verified" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}>{record.status === "verified" ? <CheckCircle2 className="h-4 w-4" /> : <Clock3 className="h-4 w-4" />}{record.status === "verified" ? "Verified" : "Pending"}</span>
            </div>)}</div> : <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">DNS records are not available yet. Refresh this domain to try again.</p>}
            <div className="flex flex-wrap gap-2"><Button size="sm" className="rounded-full" onClick={() => onVerifyDomain(domain.resendDomainId)} loading={verifyingId === domain.resendDomainId} loadingText={verified ? "Verified" : "Check verification"} disabled={verified}><CheckCircle2 className="mr-2 h-4 w-4" />{verified ? "Verified" : "Check verification"}</Button><Button variant="outline" size="sm" className="rounded-full" onClick={() => onRefreshDns(domain.resendDomainId)} loading={refreshingDnsId === domain.resendDomainId} loadingText="Refresh records" aria-describedby={refreshError ? refreshErrorId : undefined}><RefreshCw className="mr-2 h-4 w-4" />Refresh records</Button>
              {verified && <Dialog><DialogTrigger asChild><Button variant="outline" size="sm" className="rounded-full"><Send className="mr-2 h-4 w-4" />Send test</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Send a test email</DialogTitle><DialogDescription>Check that email from {domain.name} reaches an address you control.</DialogDescription></DialogHeader><div className="space-y-3"><Label htmlFor={`test-email-${domain.id}`}>Recipient email</Label><Input id={`test-email-${domain.id}`} type="email" value={testEmail} onChange={event => onSetTestEmail(event.target.value)} placeholder="you@example.com" /><Button className="w-full" onClick={() => onSendTest(domain.id)} loading={sendingTest} disabled={!testEmail.trim()}>Send test email</Button></div></DialogContent></Dialog>}
            </div>
          </div>}
        </div>;
      })}
    </div>}
  </section>;
}
