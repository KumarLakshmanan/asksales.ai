"use client";
import { useCallback, useEffect, useState } from "react";
import { Eye, History, Plus, RotateCcw } from "lucide-react";
import { useAdminAuth } from "@/contexts/AdminAuthContext";
import { api } from "@/lib/admin-api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  TemplateEditor,
  type EditableTemplate,
} from "@/components/proposals/TemplateEditor";
import {
  TemplateCustomerPreview,
  TemplateThumbnail,
} from "@/components/proposals/TemplateCustomerPreview";
import { useToast } from "@/hooks/use-toast";

type AdminTemplate = EditableTemplate & { id: number; version: number };
type HistoryEntry = {
  id: number;
  adminId: number | null;
  action: string;
  createdAt: string;
  snapshot: AdminTemplate;
};
const historyAction = (action: string) =>
  action.startsWith("rolled_back_to_v")
    ? `Restored version ${action.split("_v")[1]}`
    : {
        created: "Created",
        updated: "Updated",
        replaced: "Unpublished for a replacement",
        version_baseline: "Previous version",
        before_instruction_migration: "Before writing guidance was separated",
        instruction_migration: "Separated writing guidance",
      }[action] || action.replace(/_/g, " ");
function changedFields(current: AdminTemplate, target: AdminTemplate) {
  const fields: string[] = [];
  if (current.name !== target.name) fields.push("name");
  if (current.description !== target.description) fields.push("description");
  if (current.coverNote !== target.coverNote) fields.push('cover note');
  if (current.termsAndConditions !== target.termsAndConditions) fields.push('commercial terms');
  if (JSON.stringify(current.lineItems) !== JSON.stringify(target.lineItems)) fields.push('pricing');
  if ((current.category || "General") !== (target.category || "General"))
    fields.push("category");
  if (current.published !== target.published) fields.push("publication status");
  if (
    JSON.stringify(current.templateContent?.sections) !==
    JSON.stringify(target.templateContent?.sections)
  )
    fields.push("document sections");
  if (
    JSON.stringify(current.templateContent?.requiredFields) !==
    JSON.stringify(target.templateContent?.requiredFields)
  )
    fields.push("required fields");
  if (
    current.includeBusinessProfile !== target.includeBusinessProfile ||
    current.includeKnowledgeBase !== target.includeKnowledgeBase
  )
    fields.push("generation sources");
  return fields;
}

export default function AdminProposalTemplates() {
  const [items, setItems] = useState<AdminTemplate[]>([]),
    [editing, setEditing] = useState<EditableTemplate | null>(null),
    [creating, setCreating] = useState(false);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [preview, setPreview] = useState<AdminTemplate | null>(null);
  const [historyTemplate, setHistoryTemplate] = useState<AdminTemplate | null>(
      null,
    ),
    [history, setHistory] = useState<HistoryEntry[]>([]),
    [selectedHistory, setSelectedHistory] = useState<HistoryEntry | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false),
    [historyError, setHistoryError] = useState(""),
    [restoring, setRestoring] = useState(false),
    [replacementId, setReplacementId] = useState<number | undefined>();
  const { toast } = useToast(),
    { admin } = useAdminAuth();
  const canEdit = admin?.role === "super_admin";
  const published = items.filter((template) => template.published);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.get<AdminTemplate[]>("/api/admin/proposal-templates"));
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to load templates",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const close = () => {
    setEditing(null);
    setCreating(false);
  };
  const openHistory = async (template: AdminTemplate) => {
    setHistoryTemplate(template);
    setHistory([]);
    setSelectedHistory(null);
    setHistoryError("");
    setReplacementId(undefined);
    setHistoryLoading(true);
    try {
      setHistory(
        await api.get<HistoryEntry[]>(
          `/api/admin/proposal-templates/${template.id}/history`,
        ),
      );
    } catch (cause) {
      setHistoryError(
        cause instanceof Error
          ? cause.message
          : "Unable to load template history",
      );
    } finally {
      setHistoryLoading(false);
    }
  };
  const restoreNeedsSlot =
    !!selectedHistory?.snapshot.published &&
    !historyTemplate?.published &&
    published.length >= 10;
  const restore = async () => {
    if (!historyTemplate || !selectedHistory) return;
    setRestoring(true);
    setHistoryError("");
    try {
      await api.post(
        `/api/admin/proposal-templates/${historyTemplate.id}/rollback`,
        {
          historyId: selectedHistory.id,
          expectedVersion: historyTemplate.version,
          ...(restoreNeedsSlot ? { replaceTemplateId: replacementId } : {}),
        },
      );
      setHistoryTemplate(null);
      await load();
      toast({
        title: "Template version restored",
        description:
          "The restored content is saved as a new version. Existing proposals retain their content.",
      });
    } catch (cause) {
      setHistoryError(
        cause instanceof Error
          ? cause.message
          : "Unable to restore this version",
      );
    } finally {
      setRestoring(false);
    }
  };
  return (
    <div className="mx-auto max-w-screen-2xl space-y-6 p-4 [&_button]:min-h-10 [&_button]:min-w-10 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Standard proposal library
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Publish a focused collection of up to 10 templates for every sales
            workspace.
          </p>
        </div>
        <Button
          disabled={!canEdit}
          title={
            !canEdit
              ? "A super admin can create and publish templates."
              : undefined
          }
          onClick={() => {
            setEditing(null);
            setCreating(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          Create template
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-card p-4">
        <div className="flex items-baseline gap-2">
          <strong className="text-2xl tabular-nums">
            {published.length}
            <span className="text-base font-normal text-muted-foreground">
              {" "}
              / 10
            </span>
          </strong>
          <span className="text-sm">published slots</span>
        </div>
        <div className="flex gap-1" aria-hidden="true">
          {Array.from({ length: 10 }, (_, index) => (
            <span
              key={index}
              className={`h-6 w-3 rounded-sm ${index < published.length ? "bg-primary" : "bg-muted"}`}
            />
          ))}
        </div>
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Changes apply when a proposal is created from the template. Existing
          drafts, sent proposals and customized copies keep their content. A
          full library can be replaced one slot at a time.
        </p>
      </div>
      {!canEdit && (
        <p className="text-sm text-muted-foreground">
          You can preview templates and inspect history. A super admin can save,
          publish, or restore a version.
        </p>
      )}
      {error && (
        <Callout
          tone="danger"
          actions={
            <Button variant="outline" onClick={() => void load()}>
              Reload library
            </Button>
          }
        >
          {error}
        </Callout>
      )}
      {loading ? (
        <p
          role="status"
          className="flex items-center gap-2 py-10 text-sm text-muted-foreground"
        >
          <Spinner size="sm" label={null} />
          Loading templates…
        </p>
      ) : creating || editing ? (
        <div className="rounded-xl border bg-card p-4 sm:p-5">
          <TemplateEditor
            key={editing?.id || "new"}
            admin
            initial={editing || undefined}
            publishedTemplates={published}
            onCancel={close}
            onSave={async (data) => {
              const payload = {
                name: data.name,
                category: data.category,
                description: data.description || "",
                published: !!data.published,
                includeKnowledgeBase: data.includeKnowledgeBase !== false,
                includeBusinessProfile: data.includeBusinessProfile !== false,
                templateContent: data.templateContent,
                templateType: "document",
                coverNote: data.coverNote || '',
                termsAndConditions: data.termsAndConditions || '',
                lineItems: data.lineItems || [],
                ...(data.replaceTemplateId
                  ? { replaceTemplateId: data.replaceTemplateId }
                  : {}),
                ...(editing?.version
                  ? { expectedVersion: editing.version }
                  : {}),
              };
              if (editing?.id)
                await api.put(
                  `/api/admin/proposal-templates/${editing.id}`,
                  payload,
                );
              else await api.post("/api/admin/proposal-templates", payload);
              close();
              await load();
              toast({
                title: data.published ? "Template published" : "Template saved",
              });
            }}
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {items.map((template) => (
            <article
              key={template.id}
              className="overflow-hidden rounded-xl border bg-card"
            >
              <button
                type="button"
                className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                aria-label={`Preview ${template.name}`}
                onClick={() => setPreview(template)}
              >
                <TemplateThumbnail template={template} />
              </button>
              <div className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={template.published ? "default" : "secondary"}>
                    {template.published ? "Published" : "Draft"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    v{template.version} · {template.category || "General"}
                  </span>
                </div>
                <h2 className="font-semibold">{template.name}</h2>
                <p className="min-h-10 text-xs leading-relaxed text-muted-foreground">
                  {template.description}
                </p>
                <p className="text-xs text-muted-foreground">
                  {template.templateContent?.sections.length || 0} sections ·{" "}
                  {template.templateContent?.requiredFields?.length || 0}{" "}
                  required fields
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-10"
                    disabled={!canEdit}
                    onClick={() => setEditing(template)}
                  >
                    Edit template
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-10"
                    onClick={() => void openHistory(template)}
                  >
                    <History className="mr-1.5 h-4 w-4" />
                    History
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10"
                    aria-label={`Customer preview of ${template.name}`}
                    onClick={() => setPreview(template)}
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{preview?.name}</DialogTitle>
            <DialogDescription>
              See the customer document using sample details.
            </DialogDescription>
          </DialogHeader>
          {preview && <TemplateCustomerPreview template={preview} />}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!historyTemplate}
        onOpenChange={(open) => {
          if (!open && !restoring) setHistoryTemplate(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>History · {historyTemplate?.name}</DialogTitle>
            <DialogDescription>
              Restoring creates a new version. All previous versions and their
              audit records remain available.
            </DialogDescription>
          </DialogHeader>
          {historyLoading ? (
            <p role="status">Loading versions…</p>
          ) : (
            <div className="grid items-start gap-5 md:grid-cols-[240px_1fr]">
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  CURRENT VERSION {historyTemplate?.version}
                </p>
                {!history.length && (
                  <p className="py-3 text-sm text-muted-foreground">
                    No recorded changes yet. The current version is preserved
                    when the next edit is saved.
                  </p>
                )}
                {history.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`w-full rounded-lg border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedHistory?.id === entry.id ? "border-primary bg-primary/5" : "bg-background"}`}
                    aria-pressed={selectedHistory?.id === entry.id}
                    onClick={() => {
                      setSelectedHistory(entry);
                      setReplacementId(undefined);
                      setHistoryError("");
                    }}
                  >
                    <p className="text-sm font-medium">
                      Version {entry.snapshot.version}
                      {entry.snapshot.version === historyTemplate?.version
                        ? " · Current"
                        : ""}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {historyAction(entry.action)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleString()} ·{" "}
                      {entry.adminId ? `Admin ${entry.adminId}` : "System"}
                    </p>
                  </button>
                ))}
              </div>
              <div className="min-w-0 space-y-4">
                {selectedHistory && historyTemplate ? (
                  <>
                    <div className="rounded-lg border p-4">
                      <p className="text-sm font-medium">
                        {selectedHistory.snapshot.name} ·{" "}
                        {selectedHistory.snapshot.published
                          ? "Published"
                          : "Draft"}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {changedFields(
                          historyTemplate,
                          selectedHistory.snapshot,
                        ).length
                          ? `Restores ${changedFields(historyTemplate, selectedHistory.snapshot).join(", ")}.`
                          : "This version has the same editable content."}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Existing customer proposals retain their content. New
                        proposals will use the restored content if this template
                        is published.
                      </p>
                      {restoreNeedsSlot && (
                        <div className="mt-3 space-y-2">
                          <Label htmlFor="rollback-replacement">
                            Replace a published template
                          </Label>
                          <select
                            id="rollback-replacement"
                            className="min-h-10 w-full rounded-md border bg-background px-3 text-sm"
                            value={replacementId || ""}
                            onChange={(event) =>
                              setReplacementId(
                                Number(event.target.value) || undefined,
                              )
                            }
                          >
                            <option value="">Choose an occupied slot</option>
                            {published
                              .filter(
                                (template) =>
                                  template.id !== historyTemplate.id,
                              )
                              .map((template) => (
                                <option key={template.id} value={template.id}>
                                  {template.name}
                                </option>
                              ))}
                          </select>
                          <p className="text-xs text-muted-foreground">
                            That template becomes a draft in the same operation.
                          </p>
                        </div>
                      )}
                      <Button
                        className="mt-4"
                        disabled={
                          !canEdit ||
                          restoring ||
                          selectedHistory.snapshot.version ===
                            historyTemplate.version ||
                          (restoreNeedsSlot && !replacementId)
                        }
                        onClick={() => void restore()}
                      >
                        <RotateCcw className="mr-2 h-4 w-4" />
                        {restoring
                          ? "Restoring…"
                          : `Restore as version ${historyTemplate.version + 1}`}
                      </Button>
                      {selectedHistory.snapshot.version ===
                        historyTemplate.version && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Select an earlier version to restore.
                        </p>
                      )}
                      {restoreNeedsSlot && !replacementId && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Choose a template to replace before restoring a
                          published version.
                        </p>
                      )}
                    </div>
                    <TemplateCustomerPreview
                      key={selectedHistory.id}
                      template={selectedHistory.snapshot}
                      compact
                    />
                  </>
                ) : (
                  <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                    Select a version to compare its settings and preview its
                    customer document.
                  </p>
                )}
              </div>
            </div>
          )}
          {historyError && (
            <Callout
              tone="danger"
              actions={
                historyTemplate && !selectedHistory ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-10"
                    onClick={() => void openHistory(historyTemplate)}
                  >
                    Try again
                  </Button>
                ) : undefined
              }
            >
              {historyError}
            </Callout>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
