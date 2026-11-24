"use client";

import {validContactEmail} from '@/lib/crm-contact-input';

import { useState, type FormEvent, type RefObject } from "react";
import { Mail, UserPlus } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useControlledDialogReturnFocus } from "@/hooks/use-controlled-dialog-return-focus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

const emptyForm = { firstName: "", lastName: "", email: "", phone: "", company: "", role: "" };

interface CreateContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  chatThreadId?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function CreateContactDialog({ open, onOpenChange, onCreated, chatThreadId, returnFocusRef }: CreateContactDialogProps) {
  const { toast } = useToast();
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const returnFocus = useControlledDialogReturnFocus(open, returnFocusRef);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim()])) as typeof form;
    if (!values.firstName && !values.lastName && !values.email && !values.phone) {
      toast({ title: "Contact details required", description: "Add a name, email address, or phone number.", variant: "destructive" });
      return;
    }
    if (!validContactEmail(values.email)) {
      toast({ title: "Invalid email address", description: "Check the email format or leave it blank.", variant: "destructive" });
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      await api.post("/api/crm/contacts", { ...values, ...(chatThreadId ? { chatThreadId: Number(chatThreadId) } : {}) });
      toast({ title: "Contact created" });
      setForm(emptyForm);
      onOpenChange(false);
      onCreated?.();
    } catch (error) {
      toast({ title: "Contact not created", description: error instanceof Error ? error.message : "Review the details and try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!saving) onOpenChange(nextOpen); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto border-border p-6 shadow-lg sm:max-w-md"
        {...returnFocus}>
        <DialogHeader className="mb-4">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <UserPlus className="h-4 w-4 text-primary" /> Add Contact
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {chatThreadId ? "Add a person to CRM and link them to this campaign workspace." : "Add a person to CRM to track conversations and pipeline activity."}
          </DialogDescription>
        </DialogHeader>
        <form id="create-contact-form" onSubmit={(event) => void handleSubmit(event)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="contact-firstName">First name</Label>
            <Input id="contact-firstName" autoComplete="given-name" value={form.firstName}
              onChange={(event) => setForm((current) => ({ ...current, firstName: event.target.value }))} placeholder="First name" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact-lastName">Last name</Label>
            <Input id="contact-lastName" autoComplete="family-name" value={form.lastName}
              onChange={(event) => setForm((current) => ({ ...current, lastName: event.target.value }))} placeholder="Last name" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="contact-email">Email</Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="contact-email" type="email" autoComplete="email" value={form.email}
                onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                className="pl-9" placeholder="name@company.com" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact-phone">Phone</Label>
            <Input id="contact-phone" type="tel" autoComplete="tel" value={form.phone}
              onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} placeholder="Phone number" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact-company">Company</Label>
            <Input id="contact-company" autoComplete="organization" value={form.company}
              onChange={(event) => setForm((current) => ({ ...current, company: event.target.value }))} placeholder="Company name" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="contact-role">Job role</Label>
            <Input id="contact-role" autoComplete="organization-title" value={form.role}
              onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))} placeholder="Job role" />
          </div>
        </form>
        <DialogFooter className="mt-5 gap-2">
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="create-contact-form" disabled={saving}>{saving ? "Adding…" : "Add Contact"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
