"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Save, UserPlus, X } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { EMPTY_LEAD_FORM, LeadForm, type LeadFormValues } from "@/components/leads/LeadForm";
import { useToast } from "@/hooks/use-toast";
import { useOutreachDraftScope } from "@/hooks/use-outreach-draft-scope";
import { clearFormDraft, readFormDraft, saveFormDraft } from "@/lib/form-draft-store";

const nullableFields = new Set<keyof LeadFormValues>([
  "firstName", "lastName", "email", "phone", "whatsapp", "location", "website",
  "company", "role", "headline", "industry", "companySize", "companyDomain",
  "companyDescription", "linkedinUrl", "linkedinUsername", "instagramHandle",
  "instagramUrl", "facebookUrl", "twitterHandle", "twitterUrl", "notes",
]);

function positiveId(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const FIRST_NAME_INPUT_PATTERN = /^[\p{L}\p{M} '’-]*$/u;

export default function LeadNewPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const threadId = positiveId(searchParams.get("threadId"));
  const campaignId = positiveId(searchParams.get("campaignId"));
  const requestedReturn = searchParams.get("returnTo");
  const returnTo = requestedReturn?.startsWith("/dashboard/") ? requestedReturn : "/dashboard/leads";

  // Unsaved input survives browser Back and returning to this page (same user, business and context).
  const scope = useOutreachDraftScope();
  const [draftScope] = useState(scope);
  const draftForm = `lead-new:${threadId ?? ""}:${campaignId ?? ""}`;
  const [restored] = useState(() => readFormDraft<LeadFormValues>(scope, draftForm));
  const [formData, setFormData] = useState<LeadFormValues>(() => ({ ...EMPTY_LEAD_FORM, ...restored }));
  const [isSaving, setIsSaving] = useState(false);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const isDirty = useMemo(() => JSON.stringify(formData) !== JSON.stringify(EMPTY_LEAD_FORM), [formData]);
  useEffect(() => {
    // Never carry one business's lead into another after a workspace switch.
    if (scope === draftScope) saveFormDraft(draftScope, draftForm, formData, !isDirty);
  }, [scope, draftScope, draftForm, formData, isDirty]);
  const discardDraft = () => { clearFormDraft(draftScope, draftForm); router.push(returnTo); };
  const composedName = `${formData.firstName.trim()} ${formData.lastName.trim()}`.trim();
  const displayName = formData.name.trim() || composedName || formData.company.trim() || formData.email.trim() || formData.phone.trim() || formData.instagramHandle.trim() || formData.linkedinUsername.trim();
  const hasContactPath = Boolean(formData.email.trim() || formData.phone.trim() || formData.whatsapp.trim() || formData.website.trim() || formData.linkedinUrl.trim() || formData.instagramHandle.trim() || formData.facebookUrl.trim() || formData.twitterHandle.trim());
  const errors = hasSubmitted ? {
    ...(!displayName && { name: "Add a name, company, or contact identifier so this lead can be recognized." }),
    ...(!hasContactPath && { email: "Add at least one contact method: email, phone, WhatsApp, website, or social profile." }),
  } : {};

  const handleChange = (field: keyof LeadFormValues, value: string | number | null) => {
    if (field === "firstName" && typeof value === "string" && !FIRST_NAME_INPUT_PATTERN.test(value)) {
      return;
    }
    setFormData((previous) => ({ ...previous, [field]: value } as LeadFormValues));
  };

  const handleSave = async () => {
    setHasSubmitted(true);
    if (!displayName || !hasContactPath) {
      document.getElementById(!displayName ? "lead-name" : "lead-email")?.focus();
      return;
    }

    try {
      setIsSaving(true);
      const leadData: Record<string, unknown> = { ...formData, name: displayName };
      for (const field of nullableFields) {
        const current = leadData[field];
        if (typeof current === "string") leadData[field] = current.trim() || null;
      }
      if (threadId) leadData.threadId = threadId;
      if (campaignId) leadData.campaignId = campaignId;

      const newLead = await api.post<{ id: number }>("/api/leads", leadData);
      clearFormDraft(draftScope, draftForm);
      toast({ title: "Lead created", description: `${displayName} is ready for qualification and outreach.` });
      router.push(`/dashboard/leads/view/${newLead.id}`);
    } catch (error) {
      toast({ title: "Lead not created", description: error instanceof Error ? error.message : "Please review the details and try again.", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (isDirty) setShowDiscardDialog(true);
    else router.push(returnTo);
  };

  const subtitle = threadId
    ? `This lead will be linked to conversation #${threadId}.`
    : campaignId
      ? `This lead will be linked to campaign #${campaignId}.`
      : "Add a prospect or customer with at least one usable contact channel.";

  return (
    <PageShell>
      <PageHeader
        icon={UserPlus}
        title="Create lead"
        subtitle={subtitle}
        actions={(
          <>
            <Button variant="outline" onClick={handleCancel} disabled={isSaving}>
              <X className="mr-2 h-4 w-4" /> Cancel
            </Button>
            <Button onClick={() => { void handleSave(); }} loading={isSaving} loadingText="Creating…">
              <Save className="mr-2 h-4 w-4" />
              Create lead
            </Button>
          </>
        )}
      />

      <Button variant="ghost" className="-ml-3 w-fit" onClick={handleCancel} disabled={isSaving}>
        <ArrowLeft className="mr-2 h-4 w-4" /> {returnTo === "/dashboard/crm/contacts" ? "Back to contacts" : "Back to leads"}
      </Button>

      {(threadId || campaignId) && (
        <Card className="border-primary/25 bg-primary/5">
          <CardContent className="py-4 text-sm text-foreground">
            The saved lead will retain its {threadId ? `conversation #${threadId}` : `campaign #${campaignId}`} context for downstream outreach and reporting.
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Include a name, company, or contact identifier, plus at least one contact method.</p>
        {restored && <Callout tone="info">Your unsaved lead details were restored.</Callout>}
        {Object.keys(errors).length > 0 && (
          <Callout tone="danger">
            Review the highlighted contact information before creating this lead.
          </Callout>
        )}
        <LeadForm value={formData} onChange={handleChange} disabled={isSaving} errors={errors} />
      </div>

      <div className="sticky bottom-4 z-10 flex flex-wrap justify-end gap-2 rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Button variant="outline" onClick={handleCancel} disabled={isSaving}>Cancel</Button>
        <Button onClick={() => { void handleSave(); }} loading={isSaving} loadingText="Creating…">
          <Save className="mr-2 h-4 w-4" />
          Create lead
        </Button>
      </div>

      <ConfirmDialog
        open={showDiscardDialog}
        onOpenChange={setShowDiscardDialog}
        onConfirm={discardDraft}
        title="Discard lead?"
        description="The information entered on this page will be lost."
        confirmText="Discard"
        cancelText="Keep editing"
        variant="destructive"
      />
    </PageShell>
  );
}
