"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Edit3, Save, X } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FormSkeleton } from "@/components/skeletons";
import { LeadForm, type LeadFormValues } from "@/components/leads/LeadForm";
import { PageErrorState } from "@/components/ui/page-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { useToast } from "@/hooks/use-toast";
import { formatLeadLocation } from '../../../../../../../../shared/leadDisplayValues';

type LeadRecord = Omit<Partial<LeadFormValues>, "location"> & {
  id: number;
  status?: string | null;
  linkedin?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  twitter?: string | null;
  location?: string | Record<string, string> | null;
};

function locationText(location: LeadRecord["location"]): string {
  return formatLeadLocation(location);
}

function toFormValues(lead: LeadRecord): LeadFormValues {
  return {
    name: lead.name || "",
    firstName: lead.firstName || "",
    lastName: lead.lastName || "",
    email: lead.email || "",
    phone: lead.phone || "",
    whatsapp: lead.whatsapp || "",
    location: locationText(lead.location),
    website: lead.website || "",
    company: lead.company || "",
    role: lead.role || "",
    headline: lead.headline || "",
    industry: lead.industry || "",
    companySize: lead.companySize || "",
    companyDomain: lead.companyDomain || "",
    companyDescription: lead.companyDescription || "",
    linkedinUrl: lead.linkedinUrl || lead.linkedin || "",
    linkedinUsername: lead.linkedinUsername || "",
    instagramHandle: lead.instagramHandle || "",
    instagramUrl: lead.instagramUrl || lead.instagram || "",
    facebookUrl: lead.facebookUrl || lead.facebook || "",
    twitterHandle: lead.twitterHandle || "",
    twitterUrl: lead.twitterUrl || lead.twitter || "",
    score: lead.score ?? 0,
    fitScore: lead.fitScore ?? null,
    relevanceScore: lead.relevanceScore ?? null,
    leadStatus: lead.leadStatus || lead.status || "new",
    source: lead.source || "manual",
    notes: lead.notes || "",
  };
}

export default function LeadEditPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const [initialValues, setInitialValues] = useState<LeadFormValues | null>(null);
  const [formData, setFormData] = useState<LeadFormValues | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const hasChanges = useMemo(() => Boolean(formData && initialValues && JSON.stringify(formData) !== JSON.stringify(initialValues)), [formData, initialValues]);

  const requestVersion = useRef(0);
  const fetchLead = useCallback(async () => {
    if (!id) return;
    const request = ++requestVersion.current;
    try {
      setIsLoading(true);
      setLoadError(null);
      const data = await api.get<LeadRecord>(`/api/leads/${id}`);
      if (request !== requestVersion.current) return;
      const values = toFormValues(data);
      setInitialValues(values);
      setFormData(values);
    } catch (error) {
      if (request !== requestVersion.current) return;
      setLoadError(error instanceof Error ? error.message : "The lead could not be loaded.");
    } finally {
      if (request === requestVersion.current) setIsLoading(false);
    }
  }, [id]);

  useEffect(() => { void fetchLead(); return () => { requestVersion.current += 1; }; }, [fetchLead]);

  const handleChange = (field: keyof LeadFormValues, value: string | number | null) => {
    setFormData((previous) => previous ? ({ ...previous, [field]: value } as LeadFormValues) : previous);
  };

  const handleSave = async () => {
    if (!formData || !initialValues) return;
    const composedName = `${formData.firstName.trim()} ${formData.lastName.trim()}`.trim();
    const displayName = formData.name.trim() || composedName || formData.company.trim() || formData.email.trim() || formData.phone.trim() || formData.instagramHandle.trim() || formData.linkedinUsername.trim();
    const hasContactPath = Boolean(formData.email.trim() || formData.phone.trim() || formData.whatsapp.trim() || formData.website.trim() || formData.linkedinUrl.trim() || formData.instagramHandle.trim() || formData.facebookUrl.trim() || formData.twitterHandle.trim());
    if (!displayName || !hasContactPath) {
      toast({ title: "Lead details incomplete", description: "Keep a recognizable name and at least one usable contact method.", variant: "destructive" });
      return;
    }

    const nextValues = { ...formData, name: displayName };
    const updateData: Record<string, unknown> = {};
    for (const field of Object.keys(nextValues) as Array<keyof LeadFormValues>) {
      if (nextValues[field] !== initialValues[field]) {
        const value = nextValues[field];
        updateData[field] = typeof value === "string" ? value.trim() || null : value;
      }
    }
    if (Object.keys(updateData).length === 0) {
      toast({ title: "No changes to save" });
      return;
    }

    try {
      setIsSaving(true);
      const updated = await api.patch<LeadRecord>(`/api/leads/${id}`, updateData);
      const values = toFormValues(updated);
      setInitialValues(values);
      setFormData(values);
      toast({ title: "Lead updated", description: "The latest details are available across outreach and enrichment." });
    } catch (error) {
      toast({ title: "Changes not saved", description: error instanceof Error ? error.message : "Please review the details and try again.", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (hasChanges) setShowDiscardDialog(true);
    else router.push(`/dashboard/leads/view/${id}`);
  };

  if (isLoading) return <PageShell maxWidth="xl"><FormSkeleton fields={14} /></PageShell>;
  if (loadError || !formData) return <PageErrorState title="Lead unavailable" description={loadError || "This lead no longer exists."} reset={() => { void fetchLead(); }} />;

  return (
    <PageShell>
      <PageHeader
        icon={Edit3}
        title="Edit lead"
        subtitle={formData.name || `${formData.firstName} ${formData.lastName}`.trim() || formData.email || "Update contact and qualification details."}
        actions={(
          <>
            <Button variant="outline" onClick={handleCancel} disabled={isSaving}><X className="mr-2 h-4 w-4" /> Cancel</Button>
            <Button onClick={() => { void handleSave(); }} disabled={!hasChanges} loading={isSaving} loadingText="Saving…">
              <Save className="mr-2 h-4 w-4" />
              Save changes
            </Button>
          </>
        )}
      />

      <Button variant="ghost" className="-ml-3 w-fit" onClick={handleCancel} disabled={isSaving}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to lead
      </Button>

      <LeadForm value={formData} onChange={handleChange} disabled={isSaving} />

      {hasChanges && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-background/95 p-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <p className="text-sm text-muted-foreground">You have unsaved changes.</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleCancel} disabled={isSaving}>Discard</Button>
            <Button onClick={() => { void handleSave(); }} loading={isSaving} loadingText="Saving…">
              <Save className="mr-2 h-4 w-4" />
              Save changes
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={showDiscardDialog}
        onOpenChange={setShowDiscardDialog}
        onConfirm={() => router.push(`/dashboard/leads/view/${id}`)}
        title="Discard changes?"
        description="Any unsaved changes to this lead will be lost."
        confirmText="Discard"
        cancelText="Keep editing"
        variant="destructive"
      />
    </PageShell>
  );
}
