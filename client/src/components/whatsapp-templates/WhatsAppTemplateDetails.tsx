"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  CalendarClock,
  Edit3,
  Languages,
  Loader2,
  MessageCircle,
  Tag,
  Trash2,
  RefreshCw,
  MoreHorizontal,
  Copy,
} from "lucide-react";
import api from "@/lib/api";
import { whatsappTemplateControls } from "@/lib/whatsapp-template-controls";
import { useToast } from "@/hooks/use-toast";
import { WhatsAppPreview } from "@/components/whatsapp-templates/WhatsAppPreview";
import type {
  WhatsAppAuthConfig,
  WhatsAppTemplateCategory,
} from "@/components/whatsapp-templates/templateData";
import { readWhatsAppExample } from "@/lib/whatsapp-template-variables";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { StatusBadge } from "@/components/ui/status-badge";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  WhatsAppTemplateHistory,
  type TemplateActivity,
  type TemplateSnapshot,
} from "./WhatsAppTemplateHistory";

interface TemplateRecord {
  id: number;
  name: string;
  language: string;
  category: WhatsAppTemplateCategory;
  status: string;
  header?: string | null;
  headerType?: string | null;
  headerMediaUrl?: string | null;
  body: string;
  footer?: string | null;
  buttons?: Array<{
    type: string;
    text: string;
    url?: string;
    phone_number?: string;
  }> | null;
  examples?: Record<string, string> | null;
  wabaTemplateId?: string | null;
  metaStatus?: string | null;
  submissionStatus?: string;
  metaRejectionReason?: string | null;
  hasLocalChanges?: boolean;
  lastSyncedAt?: string | null;
  authConfig?: WhatsAppAuthConfig | null;
  variableLabels?: Record<string, string> | null;
  activityHistory?: TemplateActivity[];
  approvedSnapshot?: TemplateSnapshot | null;
  createdAt: string;
  updatedAt: string;
}

const categoryLabel: Record<WhatsAppTemplateCategory, string> = {
  MARKETING: "Marketing",
  UTILITY: "Utility",
  AUTHENTICATION: "Authentication",
};

export default function WhatsAppTemplateDetails() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const templatesPath = "/dashboard/integrations/whatsapp/templates";
  const requestedReturn = searchParams.get("returnTo");
  const returnTo =
    requestedReturn === templatesPath ||
    requestedReturn?.startsWith(`${templatesPath}?`)
      ? requestedReturn
      : templatesPath;
  const navigate = (path: string, extras = "") =>
    router.push(
      `${path}?${extras ? `${extras}&` : ""}returnTo=${encodeURIComponent(returnTo)}`,
    );
  const { toast } = useToast();
  const [template, setTemplate] = useState<TemplateRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadTemplate = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await api.get<{
        success: boolean;
        template: TemplateRecord;
      }>(`/api/whatsapp/templates/${params.id}`);
      setTemplate(response.template);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Template could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    void loadTemplate();
  }, [loadTemplate]);

  const deleteTemplate = async () => {
    if (!template) return;
    setActionError(null);
    try {
      setDeleting(true);
      await api.delete(`/api/whatsapp/templates/${template.id}`);
      toast({
        title: "Template deleted",
        description: `${template.name} was removed.`,
      });
      router.push(returnTo);
    } catch (deleteError) {
      toast({
        title: "Could not delete template",
        description:
          deleteError instanceof Error
            ? deleteError.message
            : "Please try again.",
        variant: "destructive",
      });
      setActionError(
        deleteError instanceof Error
          ? deleteError.message
          : "Could not delete this template. Try again.",
      );
      setDeleting(false);
    }
  };
  const refreshStatus = async () => {
    if (!template) return;
    setRefreshing(true);
    setActionError(null);
    try {
      const response = await api.post<{
        success: boolean;
        template: TemplateRecord;
      }>(`/api/whatsapp/templates/${template.id}/refresh`, {});
      setTemplate(response.template);
      toast({
        title: "Status refreshed",
        description: "Your saved edits were preserved.",
      });
    } catch (refreshError) {
      const message =
        refreshError instanceof Error
          ? refreshError.message
          : "Approval status could not be refreshed. Try again.";
      setActionError(message);
      toast({
        title: "Could not refresh status",
        description: message,
        variant: "destructive",
      });
    } finally {
      setRefreshing(false);
    }
  };

  if (loading)
    return (
      <LoadingState
        size="page"
        className="min-h-[70vh] bg-background"
        label="Loading template…"
        showLabel
      />
    );
  if (error || !template)
    return (
      <div className="flex min-h-[70vh] items-center justify-center bg-background px-4">
        <div className="max-w-md rounded-[14px] border border-card-border bg-card p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold">Template not available</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {error || "This template does not exist."}
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <button
              onClick={() => router.push(returnTo)}
              className="rounded-[10px] border px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              Back to templates
            </button>
            <button
              onClick={() => void loadTemplate()}
              className="rounded-[10px] bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );

  const controls = whatsappTemplateControls(template);
  return (
    <div className="outreach-workspace wa-template-details min-h-full bg-background px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1180px]">
        <button
          type="button"
          onClick={() => router.push(returnTo)}
          className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to templates
        </button>
        <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-[#11866f]" />
              <span className="text-sm font-medium text-[#26795e]">
                WhatsApp template
              </span>
            </div>
            <h1 className="mt-1 break-words text-2xl font-semibold tracking-tight">
              {template.name}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Review the exact message and metadata saved in your workspace.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              disabled={!controls.canEdit}
              onClick={() => navigate(`${templatesPath}/${template.id}/edit`)}
              className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <Edit3 className="h-4 w-4" /> Edit
            </button>
            {controls.canSubmit && (
              <button
                onClick={() =>
                  navigate(
                    `${templatesPath}/${template.id}/edit`,
                    "step=review",
                  )
                }
                className="inline-flex h-10 items-center gap-2 rounded-[10px] border bg-card px-4 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                Review before submission
              </button>
            )}
            {(template.wabaTemplateId ||
              [
                "submitting",
                "submission_uncertain",
                "identity_conflict",
              ].includes(template.submissionStatus || "")) && (
              <button
                onClick={() => void refreshStatus()}
                disabled={refreshing}
                className="inline-flex h-10 items-center gap-2 rounded-[10px] border px-4 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                {refreshing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Refresh status
              </button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="inline-flex h-10 items-center gap-2 rounded-[10px] border px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring">
                  <MoreHorizontal className="h-4 w-4" />
                  More actions
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() =>
                    navigate(
                      `${templatesPath}/create`,
                      `cloneFrom=${template.id}`,
                    )
                  }
                >
                  <Copy />
                  Clone as new draft
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    navigate(
                      `${templatesPath}/create`,
                      `cloneFrom=${template.id}&variant=language`,
                    )
                  }
                >
                  <Languages />
                  Create language variant
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={
                    deleting ||
                    ["submitting", "submission_uncertain"].includes(
                      template.submissionStatus || "",
                    )
                  }
                  onSelect={() => {
                    setActionError(null);
                    setConfirmDelete(true);
                  }}
                  className="text-red-700 dark:text-red-300"
                >
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <section
          aria-label="Approval status"
          className="mb-5 rounded-[14px] border bg-card p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">
                {["submitting", "submission_uncertain"].includes(
                  template.submissionStatus || "",
                )
                  ? "Submission needs a status check"
                  : template.wabaTemplateId
                    ? template.hasLocalChanges &&
                      (template.metaStatus || template.status) === "APPROVED"
                      ? "Approved message · newer local edits"
                      : `Meta ${(template.metaStatus || template.status).toLowerCase()}`
                    : "Local draft · not submitted"}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {!template.wabaTemplateId
                  ? "Save your draft freely. Complete the submission checklist in the editor before sending to Meta."
                  : template.hasLocalChanges
                    ? "Your saved edits are separate from the last Meta version and need review before use."
                    : "The saved message is linked to your WhatsApp Business account."}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              {template.lastSyncedAt
                ? `Last checked ${new Date(template.lastSyncedAt).toLocaleString()}`
                : "Status has not been checked yet"}
            </p>
          </div>
          {controls.feedbackReason && (
            <Callout tone="danger" className="mt-3">
              <strong>Meta feedback: </strong>
              {controls.feedbackReason} Edit this message to address the
              feedback before submitting again.
            </Callout>
          )}
          {controls.notice && (
            <p
              role="status"
              className="mt-3 rounded-md bg-muted/40 p-3 text-sm"
            >
              {controls.notice}
            </p>
          )}
        </section>
        {actionError && !confirmDelete && (
          <Callout tone="danger" className="mb-4">
            {actionError}
          </Callout>
        )}
        <AlertDialog
          open={confirmDelete}
          onOpenChange={(open) => {
            if (!deleting) setConfirmDelete(open);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{template.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the template from your workspace. This action
                cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {actionError && (
              <p role="alert" className="text-sm text-red-700">
                {actionError}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
              <button
                disabled={deleting}
                onClick={() => void deleteTemplate()}
                className="inline-flex items-center justify-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-60"
              >
                {deleting && <Loader2 className="h-4 w-4 animate-spin" />}Delete
                template
              </button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="overflow-hidden rounded-[14px] border border-card-border bg-card shadow-sm">
            <div className="border-b px-5 py-4">
              <h2 className="font-semibold">Message content</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Variables remain numbered until recipient data is supplied.
              </p>
            </div>
            <dl className="divide-y">
              <div className="px-5 py-4">
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Header · {template.headerType || "None"}
                </dt>
                <dd className="mt-2 whitespace-pre-wrap text-sm">
                  {template.headerType === "TEXT" ? (
                    template.header || "No text header"
                  ) : template.headerMediaUrl ? (
                    <span className="break-all font-mono text-xs">
                      {template.headerMediaUrl}
                    </span>
                  ) : ["IMAGE", "VIDEO", "DOCUMENT"].includes(
                      template.headerType || "",
                    ) ? (
                    "No media reference"
                  ) : (
                    "No header"
                  )}
                </dd>
              </div>
              <div className="px-5 py-4">
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Body
                </dt>
                <dd className="mt-2 whitespace-pre-wrap text-sm leading-6">
                  {template.body}
                </dd>
              </div>
              <div className="px-5 py-4">
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Variable examples
                </dt>
                <dd className="mt-2">
                  {template.examples &&
                  Object.keys(template.examples).length ? (
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(template.examples)
                        .sort(([left], [right]) =>
                          left.localeCompare(right, undefined, {
                            numeric: true,
                          }),
                        )
                        .map(([key, value]) => {
                          const [rawComponent, rawIndex] = key.includes(":")
                            ? key.split(":")
                            : ["body", key];
                          const component =
                            rawComponent === "header" ? "header" : "body";
                          const index = rawIndex || key;
                          return (
                            <span
                              key={key}
                              className="rounded-md border bg-muted/20 px-2.5 py-1.5 text-xs"
                            >
                              <span className="capitalize">
                                {template.variableLabels?.[
                                  `${component}:${index}`
                                ] || component}
                              </span>{" "}
                              <span className="font-mono">{`{{${index}}}`}</span>{" "}
                              ={" "}
                              {readWhatsAppExample(
                                template.examples,
                                component,
                                index,
                              ) || value}
                            </span>
                          );
                        })}
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      No variable examples
                    </span>
                  )}
                </dd>
              </div>
              <div className="px-5 py-4">
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Footer
                </dt>
                <dd className="mt-2 text-sm">
                  {template.footer || "No footer"}
                </dd>
              </div>
              {template.authConfig ? (
                <div className="px-5 py-4">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Verification code
                  </dt>
                  <dd className="mt-2 space-y-2 text-sm">
                    <p>
                      {template.authConfig.otpType === "COPY_CODE"
                        ? "Copy code"
                        : "One-tap autofill"}{" "}
                      · {template.authConfig.buttonText}
                    </p>
                    <p className="text-muted-foreground">
                      Expires after {template.authConfig.codeExpirationMinutes}{" "}
                      minutes ·{" "}
                      {template.authConfig.addSecurityRecommendation
                        ? "Security reminder included"
                        : "No security reminder"}
                    </p>
                    {template.authConfig.packageName && (
                      <p className="break-all text-xs text-muted-foreground">
                        Android app: {template.authConfig.packageName}
                      </p>
                    )}
                  </dd>
                </div>
              ) : (
                <div className="px-5 py-4">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Buttons
                  </dt>
                  <dd className="mt-2">
                    {template.buttons?.length ? (
                      <div className="space-y-2">
                        {template.buttons.map((button, index) => (
                          <div
                            key={`${button.text}-${index}`}
                            className="rounded-md border bg-muted/20 px-3 py-2 text-sm"
                          >
                            <span className="font-medium">{button.text}</span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              {button.type.replaceAll("_", " ")}
                              {button.url
                                ? ` · ${button.url}`
                                : button.phone_number
                                  ? ` · ${button.phone_number}`
                                  : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        No buttons
                      </span>
                    )}
                  </dd>
                </div>
              )}
            </dl>
          </section>

          <aside className="space-y-4 lg:sticky lg:top-4">
            <div className="rounded-[14px] border border-card-border bg-card p-4 shadow-sm">
              <h2 className="mb-3 font-semibold">Template Preview</h2>
              <WhatsAppPreview
                title={
                  template.headerType === "TEXT"
                    ? template.header || undefined
                    : undefined
                }
                body={template.body}
                footer={template.footer || undefined}
                buttons={template.buttons || []}
                authConfig={template.authConfig}
                showControls
                mediaType={template.headerType}
                mediaUrl={template.headerMediaUrl}
                examples={template.examples}
              />
            </div>
            <div className="rounded-[14px] border border-card-border bg-card p-4 shadow-sm">
              <h2 className="font-semibold">Template details</h2>
              <dl className="mt-3 space-y-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <dt className="flex items-center gap-2 text-muted-foreground">
                    <Tag className="h-4 w-4" /> Category
                  </dt>
                  <dd className="font-medium">
                    {categoryLabel[template.category] || template.category}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="flex items-center gap-2 text-muted-foreground">
                    <Languages className="h-4 w-4" /> Language
                  </dt>
                  <dd className="font-medium">
                    {template.language.replace("_", "-")}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="flex items-center gap-2 text-muted-foreground">
                    <CalendarClock className="h-4 w-4" /> Updated
                  </dt>
                  <dd className="text-right font-medium">
                    {new Date(template.updatedAt).toLocaleDateString()}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 space-y-2 border-t pt-4 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">AskSales copy</span>
                  <span className="rounded-full bg-primary/10 px-2.5 py-1 font-semibold text-primary">
                    {template.hasLocalChanges ? "Local changes" : "Synced copy"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Meta connection</span>
                  <span className="rounded-full bg-muted px-2.5 py-1 font-semibold text-muted-foreground">
                    {template.wabaTemplateId ? "Linked" : "Local only"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">
                    {template.hasLocalChanges
                      ? "Previous Meta version"
                      : "Meta approval"}
                  </span>
                  <StatusBadge
                    tone={(template.metaStatus || template.status) === "APPROVED" ? "success" : (template.metaStatus || template.status) === "REJECTED" ? "danger" : "warning"}
                    label={template.wabaTemplateId
                      ? template.metaStatus || template.status
                      : "Not submitted"}
                  />
                </div>
                {template.wabaTemplateId && (
                  <p className="break-all font-mono text-[11px] text-muted-foreground">
                    Meta ID: {template.wabaTemplateId}
                  </p>
                )}
              </div>
            </div>
          </aside>
        </div>
        <WhatsAppTemplateHistory
          current={template}
          approvedSnapshot={template.approvedSnapshot}
          history={template.activityHistory}
        />
      </div>
    </div>
  );
}
