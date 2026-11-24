import { CheckCircle2, Plus, Star, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { EmailSender, ResendDomain } from "./types";

interface ActiveSendersProps {
  emailSenders: EmailSender[];
  domains: ResendDomain[];
  showAddSender: boolean;
  newSenderEmail: string;
  newSenderLabel: string;
  newSenderDisplayName: string;
  addingSender: boolean;
  selectedDomainId: number | null;
  settingDefaultId: number | null;
  deletingSenderId: number | null;
  onSetShowAddSender: (show: boolean) => void;
  onSetNewSenderEmail: (val: string) => void;
  onSetNewSenderLabel: (val: string) => void;
  onSetNewSenderDisplayName: (val: string) => void;
  onSetSelectedDomainId: (id: number | null) => void;
  onAddSender: () => void;
  onDeleteSender: (id: number) => void;
  onSetDefaultSender: (id: number) => void;
}

export function ActiveSenders({ emailSenders, domains, showAddSender, newSenderEmail, newSenderLabel, newSenderDisplayName, addingSender, selectedDomainId, settingDefaultId, deletingSenderId, onSetShowAddSender, onSetNewSenderEmail, onSetNewSenderLabel, onSetNewSenderDisplayName, onSetSelectedDomainId, onAddSender, onDeleteSender, onSetDefaultSender }: ActiveSendersProps) {
  const verifiedDomains = domains.filter(domain => domain.status === "verified");
  const canAdd = verifiedDomains.length > 0;
  const senderReady = (sender: EmailSender) => sender.isVerified && (sender.type === "gmail"
    ? sender.connectionActive === true
    : verifiedDomains.some(domain => sender.email.toLowerCase().endsWith(`@${domain.name.toLowerCase()}`)));

  return <section aria-labelledby="senders-heading" className="overflow-hidden rounded-2xl border bg-card shadow-sm">
    <div className="flex flex-col gap-4 border-b p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div className="flex min-w-0 items-start gap-4"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"><UserRound className="h-5 w-5" /></span><div><h2 id="senders-heading" className="text-lg font-semibold tracking-tight">Sender addresses</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Choose the name and address customers see in their inbox.</p></div></div>
      <Dialog open={showAddSender} onOpenChange={onSetShowAddSender}>
        <DialogTrigger asChild><Button className="self-start rounded-full px-5 sm:self-auto" disabled={!canAdd}><Plus className="mr-2 h-4 w-4" />Add sender</Button></DialogTrigger>
        <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>Add a sender address</DialogTitle><DialogDescription>Create an address on a verified sending domain. You can set it as the default after adding it.</DialogDescription></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2"><Label htmlFor="sender-label">Sender label</Label><Input id="sender-label" value={newSenderLabel} onChange={event => onSetNewSenderLabel(event.target.value)} placeholder="Sales team" /><p className="text-xs text-muted-foreground">This label helps your team recognize the sender.</p></div>
            <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="sender-mailbox">Mailbox name</Label><Input id="sender-mailbox" value={newSenderEmail} onChange={event => onSetNewSenderEmail(event.target.value)} placeholder="hello" autoCapitalize="none" /></div><div className="space-y-2"><Label htmlFor="sender-domain">Verified domain</Label><Select value={selectedDomainId?.toString()} onValueChange={value => onSetSelectedDomainId(Number(value))}><SelectTrigger id="sender-domain"><SelectValue placeholder="Choose a domain" /></SelectTrigger><SelectContent>{verifiedDomains.map(domain => <SelectItem key={domain.id} value={domain.id.toString()}>{domain.name}</SelectItem>)}</SelectContent></Select></div></div>
            <div className="space-y-2"><Label htmlFor="sender-display-name">Display name <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="sender-display-name" value={newSenderDisplayName} onChange={event => onSetNewSenderDisplayName(event.target.value)} placeholder="Orchid Sales" /></div>
            <Button className="w-full" onClick={onAddSender} loading={addingSender} disabled={!selectedDomainId || !newSenderEmail.trim() || !newSenderLabel.trim()}>Add sender</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>

    {!canAdd && <div className="border-b bg-amber-500/5 px-5 py-4 text-sm text-muted-foreground sm:px-6">Verify a sending domain above before adding a new sender address.</div>}
    {emailSenders.length === 0 ? <div className="px-6 py-10 text-center"><UserRound className="mx-auto h-8 w-8 text-muted-foreground/50" /><p className="mt-3 font-medium">No sender addresses yet</p><p className="mt-1 text-sm text-muted-foreground">Connected Gmail addresses and verified domain senders will appear here.</p></div> : <div className="divide-y">{emailSenders.map(sender => <div key={sender.id} className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div className="flex min-w-0 items-center gap-3"><span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white ${sender.type === "gmail" ? "bg-rose-500" : "bg-indigo-600"}`}>{sender.email.charAt(0).toUpperCase()}</span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold">{sender.label}</p>{sender.isDefault && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Default</span>}</div><p className="mt-1 break-all text-sm text-muted-foreground">{sender.email}</p><p className="mt-1 text-xs text-muted-foreground">{sender.type === "gmail" ? "Gmail" : "Sending domain"} · {senderReady(sender) ? "Ready to send" : sender.type === "gmail" && sender.isVerified ? "Reconnect Gmail to send" : "Awaiting domain verification"}</p></div></div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">{senderReady(sender) && <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-label="Ready to send" />}{!sender.isDefault && <Button variant="outline" size="sm" className="rounded-full" onClick={() => onSetDefaultSender(sender.id)} loading={settingDefaultId === sender.id} loadingText="Make default" disabled={!senderReady(sender)}><Star className="mr-2 h-4 w-4" />Make default</Button>}
        <AlertDialog><AlertDialogTrigger asChild><Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" aria-label={`Delete sender ${sender.email}`} loading={deletingSenderId === sender.id}><Trash2 className="h-4 w-4" /></Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove {sender.email}?</AlertDialogTitle><AlertDialogDescription>This address will no longer be available for outgoing email. Existing messages remain in your history.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => onDeleteSender(sender.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Remove sender</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      </div>
    </div>)}</div>}
  </section>;
}
