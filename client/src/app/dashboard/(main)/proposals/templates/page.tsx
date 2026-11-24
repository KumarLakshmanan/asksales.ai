"use client";
import { useCallback, useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Eye,
  FileText,
  Plus,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  TemplateEditor,
  type EditableTemplate,
} from "@/components/proposals/TemplateEditor";
import {
  TemplateCustomerPreview,
  TemplateThumbnail,
} from "@/components/proposals/TemplateCustomerPreview";

import { useDialogReturnFocus } from "@/hooks/use-dialog-return-focus";
import { ProposalPageHeader } from "@/components/proposals/ProposalPageHeader";
import styles from "@/components/proposals/proposals.module.css";

type LibraryTemplate = EditableTemplate & {
  id: number;
  userId: number | null;
  templateType: string;
  sourceFileName?: string | null;
  createdAt: string;
  updatedAt: string;
};
type LibraryView = "standard" | "mine" | "favorites";
const blankImport = {
  name: "",
  description: "",
  includeKnowledgeBase: true,
  includeBusinessProfile: true,
};

export default function ProposalTemplatesPage() {
  const { capture: capturePreviewFocus, restore: restorePreviewFocus, fallback: previewFocusFallback } = useDialogReturnFocus();
  const previewTitleRef = useRef<HTMLHeadingElement>(null);
  const router = useRouter(),
    { toast } = useToast();
  const [templates, setTemplates] = useState<LibraryTemplate[]>([]),
    [favorites, setFavorites] = useState<number[]>([]);
  const [favoritesReady, setFavoritesReady] = useState(false),
    [favoriteBusy, setFavoriteBusy] = useState<number[]>([]);
  const [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState("");
  const [view, setView] = useState<LibraryView>("standard"),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState("all");
  const [editor, setEditor] = useState<EditableTemplate | null>(null),
    [creating, setCreating] = useState(false);
  const [selectedTemplate, setSelectedTemplate] =
      useState<LibraryTemplate | null>(null),
    [deleting, setDeleting] = useState<LibraryTemplate | null>(null);
  const [importOpen, setImportOpen] = useState(false),
    [uploading, setUploading] = useState(false),
    [importError, setImportError] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null),
    [form, setForm] = useState(blankImport);
  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const [library, starred] = await Promise.allSettled([
      api.get<LibraryTemplate[]>("/api/proposals/templates"),
      api.get<number[]>("/api/proposals/templates/favorites"),
    ]);
    if (library.status === "fulfilled")
      setTemplates(Array.isArray(library.value) ? library.value : []);
    else
      setLoadError(
        library.reason instanceof Error
          ? library.reason.message
          : "Templates could not be loaded.",
      );
    if (starred.status === "fulfilled") {
      setFavorites(Array.isArray(starred.value) ? starred.value : []);
      setFavoritesReady(true);
    } else {
      setFavoritesReady(false);
      toast({
        title: "Favorites unavailable",
        description: "Reload the library to try again.",
        variant: "destructive",
      });
    }
    setLoading(false);
  }, [toast]);
  useEffect(() => {
    void fetchTemplates();
  }, [fetchTemplates]);
  const toggleFavorite = async (template: LibraryTemplate) => {
    const favorite = !favorites.includes(template.id);
    setFavoriteBusy((current) => [...current, template.id]);
    try {
      await api.put(`/api/proposals/templates/${template.id}/favorite`, {
        favorite,
      });
      setFavorites((current) =>
        favorite
          ? [...current, template.id]
          : current.filter((id) => id !== template.id),
      );
    } catch (error) {
      toast({
        title: "Favorite could not be saved",
        description: error instanceof Error ? error.message : "Try again.",
        variant: "destructive",
      });
    } finally {
      setFavoriteBusy((current) => current.filter((id) => id !== template.id));
    }
  };
  const importTemplate = async () => {
    setImportError("");
    if (!selectedFile?.name.toLowerCase().endsWith(".docx")) {
      setImportError("Choose a DOCX file to import.");
      return;
    }
    if (selectedFile.size > 15 * 1024 * 1024) {
      setImportError("Choose a DOCX file that is 15 MB or smaller.");
      return;
    }
    const body = new FormData();
    body.append("file", selectedFile);
    Object.entries(form).forEach(([key, value]) =>
      body.append(key, String(value)),
    );
    setUploading(true);
    try {
      const created = await api.upload<LibraryTemplate>(
        "/api/proposals/templates/import",
        body,
      );
      setTemplates((current) => [created, ...current]);
      setSelectedFile(null);
      setForm(blankImport);
      setImportOpen(false);
      setView("mine");
      setCategory("all");
      setSearch("");
      toast({
        title: "Template imported",
        description: "Review the imported sections before using this template.",
      });
    } catch (error) {
      setImportError(
        error instanceof Error
          ? error.message
          : "The template could not be imported.",
      );
    } finally {
      setUploading(false);
    }
  };
  const library = templates.filter(
    (template) => template.templateType === "document",
  );
  const counts = {
    standard: library.filter((template) => template.userId === null).length,
    mine: library.filter((template) => template.userId !== null).length,
    favorites: library.filter((template) => favorites.includes(template.id))
      .length,
  };
  const inView = library.filter((template) =>
    view === "standard"
      ? template.userId === null
      : view === "mine"
        ? template.userId !== null
        : favorites.includes(template.id),
  );
  const categories = [
    ...new Set(inView.map((template) => template.category || "General")),
  ].sort();
  const visible = inView.filter(
    (template) =>
      (category === "all" || (template.category || "General") === category) &&
      (!search ||
        [template.name, template.description, template.category]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
  const closeEditor = () => {
    setEditor(null);
    setCreating(false);
  };
  return (
    <div className={`page-shell ${styles.workspace} [&_button]:min-h-10 [&_button]:min-w-10`}>
      <ProposalPageHeader back title="Proposal templates" description="Start with a proven structure, then shape the scope for your customer." actions={<>
        <Button variant="outline" onClick={()=>{setImportError("");setImportOpen(true);}}><Upload aria-hidden="true"/>Import DOCX</Button>
        <Button onClick={()=>{setEditor(null);setCreating(true);}}><Plus aria-hidden="true"/>Create template</Button>
      </>}/>
      {creating || editor ? (
        <div className={styles.panel}>
          <TemplateEditor
            key={editor?.id || "new"}
            initial={editor || undefined}
            onCancel={closeEditor}
            onSave={async (data) => {
              const payload = {
                name: data.name,
                category: data.category,
                description: data.description || "",
                templateType: "document",
                coverNote: data.coverNote || '',
                termsAndConditions: data.termsAndConditions || '',
                isDefault: data.isDefault === true,
                lineItems: data.lineItems || [],
                includeKnowledgeBase: data.includeKnowledgeBase !== false,
                includeBusinessProfile: data.includeBusinessProfile !== false,
                templateContent: data.templateContent,
              };
              if (editor?.id)
                await api.put(`/api/proposals/templates/${editor.id}`, payload);
              else await api.post("/api/proposals/templates", payload);
              closeEditor();
              setView("mine");
              setCategory("all");
              setSearch("");
              await fetchTemplates();
              toast({ title: "Template saved" });
            }}
          />
        </div>
      ) : (
        <>
          <div className={`${styles.libraryTabs} flex flex-wrap items-center justify-between gap-3`}>
            <Tabs
              value={view}
              onValueChange={(value) => {
                setView(value as LibraryView);
                setCategory("all");
              }}
            >
              <TabsList className="h-auto min-h-10 flex-wrap">
                <TabsTrigger value="standard">
                  Standard templates{" "}
                  <span className="ml-2 text-xs opacity-60">
                    {counts.standard}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="mine">
                  My templates{" "}
                  <span className="ml-2 text-xs opacity-60">{counts.mine}</span>
                </TabsTrigger>
                <TabsTrigger value="favorites">
                  <Star className="mr-1.5 h-3.5 w-3.5" />
                  Favorites{" "}
                  <span className="ml-2 text-xs opacity-60">
                    {counts.favorites}
                  </span>
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <p className="text-xs text-muted-foreground">
              {view === "standard"
                ? "Published templates available to your workspace"
                : view === "mine"
                  ? "Your saved and customized templates"
                  : "Your starred templates across both libraries"}
            </p>
          </div>
          <div className={styles.filters}>
            <SearchInput
              ref={previewFocusFallback}
              aria-label="Search templates"
              wrapperClassName={styles.search}
              placeholder="Search by name or service…"
              value={search}
              onValueChange={setSearch}
            />
            <select
              aria-label="Template category"
              className="h-10 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="all">All categories</option>
              {categories.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <span
              role="status"
              className="self-center text-xs text-muted-foreground"
            >
              {visible.length} templates
            </span>
          </div>
          <div className={styles.notice}><FileText aria-hidden="true"/><p><strong className="font-semibold text-foreground">Use template</strong> opens a new proposal with this structure. Customize a standard copy or edit a personal template to save it in My templates.<span className="mt-1 block text-xs">Previews use sample customer details, copy, prices and dates. Preview values are never saved.</span></p></div>
          {loading ? (
            <LoadingState className="py-20" label="Loading templates…" showLabel />
          ) : loadError ? (
            <Callout
              tone="danger"
              actions={
                <Button variant="outline" onClick={() => void fetchTemplates()}>
                  Reload library
                </Button>
              }
            >
              {loadError}
            </Callout>
          ) : !visible.length ? (
            <div className="rounded-xl border border-dashed px-6 py-16 text-center">
              <FileText className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
              <p className="font-medium">
                {search || category !== "all"
                  ? "No templates match these filters"
                  : view === "favorites"
                    ? "Keep your go-to templates here"
                    : view === "mine"
                      ? "Build your own template collection"
                      : "No standard templates are published yet"}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {view === "favorites"
                  ? "Select the star on a template to find it here."
                  : view === "mine"
                    ? "Create a template or customize a standard one for your business."
                    : "Try another category or explore your own templates."}
              </p>
              {(search || category !== "all") && (
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => {
                    setSearch("");
                    setCategory("all");
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <div className={styles.templateGrid}>
              {visible.map((template) => (
                <article
                  key={template.id}
                  className={styles.templateCard}
                >
                  <button
                    type="button"
                    className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                    aria-label={`Preview ${template.name}`}
                    onClick={(event) => { capturePreviewFocus(event.currentTarget); setSelectedTemplate(template); }}
                  >
                    <TemplateThumbnail template={template} />
                  </button>
                  <div className={styles.cardBody}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Badge variant="secondary" className="mb-2 text-[11px]">
                          {template.category || "General"}
                        </Badge>
                        {template.isDefault && <Badge variant="outline" className="mb-2 ml-1 text-[11px]">Default terms</Badge>}
                        <h2 className="text-sm font-semibold">
                          {template.name}
                        </h2>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-10 w-10 shrink-0"
                        disabled={
                          !favoritesReady || favoriteBusy.includes(template.id)
                        }
                        title={
                          !favoritesReady
                            ? "Reload the library to load favorites"
                            : undefined
                        }
                        aria-label={`${favorites.includes(template.id) ? "Remove" : "Add"} ${template.name} ${favorites.includes(template.id) ? "from" : "to"} favorites`}
                        aria-pressed={favorites.includes(template.id)}
                        onClick={() => void toggleFavorite(template)}
                      >
                        <Star
                          className={`h-4 w-4 ${favorites.includes(template.id) ? "fill-amber-400 text-amber-500" : ""}`}
                        />
                      </Button>
                    </div>
                    <p className="min-h-12 text-sm leading-6 text-muted-foreground">
                      {template.description ||
                        "Reusable document sections for your next customer proposal."}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {template.templateContent?.sections.length || 0} sections
                      · {template.templateContent?.requiredFields?.length || 0}{" "}
                      required fields
                    </p>
                    <div className={styles.cardActions}>
                      <Button
                        size="sm"
                        className="min-h-10"
                        onClick={() =>
                          router.push(
                            `/dashboard/proposals/new?templateId=${template.id}`,
                          )
                        }
                      >
                        Use template
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-10"
                        onClick={() => {
                          setCreating(template.userId === null);
                          setEditor({
                            ...template,
                            id:
                              template.userId === null
                                ? undefined
                                : template.id,
                            name:
                              template.userId === null
                                ? `${template.name} (custom)`
                                : template.name,
                          });
                        }}
                      >
                        {template.userId === null ? "Customize copy" : "Edit"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-10 gap-1.5 px-2"
                        aria-label={`Customer preview of ${template.name}`}
                        onClick={(event) => { capturePreviewFocus(event.currentTarget); setSelectedTemplate(template); }}
                      >
                        <Eye aria-hidden="true" className="h-4 w-4" /><span className="text-xs">Preview</span>
                      </Button>
                      {template.userId !== null && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-10 w-10 text-muted-foreground hover:text-destructive"
                          aria-label={`Delete ${template.name}`}
                          onClick={() => setDeleting(template)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          if (!uploading) setImportOpen(open);
        }}
      >
        <DialogContent className={`${styles.dialog} sm:max-w-xl`}>
          <DialogHeader>
            <DialogTitle>Import a DOCX template</DialogTitle>
            <DialogDescription>
              Headings and wording become reusable sections in My templates.
              Review placeholders and writing guidance after import.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="template-import-file">
                DOCX file · up to 15 MB
              </Label>
              <Input
                id="template-import-file"
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(event) =>
                  setSelectedFile(event.target.files?.[0] || null)
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="template-import-name">Template name</Label>
              <Input
                id="template-import-name"
                value={form.name}
                maxLength={255}
                aria-describedby="template-import-name-help"
                placeholder="Use the file name if blank"
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
              />
              <p id="template-import-name-help" className="text-xs text-muted-foreground">Optional · up to 255 characters</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="template-import-description">Description</Label>
              <Textarea
                id="template-import-description"
                value={form.description}
                maxLength={2000}
                aria-describedby="template-import-description-help"
                rows={3}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
              />
              <p id="template-import-description-help" className="text-xs text-muted-foreground">Optional · up to 2,000 characters</p>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex min-h-10 items-center gap-2">
                <Checkbox
                  checked={form.includeKnowledgeBase}
                  onCheckedChange={(value) =>
                    setForm({ ...form, includeKnowledgeBase: value === true })
                  }
                />
                Use knowledge base
              </label>
              <label className="flex min-h-10 items-center gap-2">
                <Checkbox
                  checked={form.includeBusinessProfile}
                  onCheckedChange={(value) =>
                    setForm({ ...form, includeBusinessProfile: value === true })
                  }
                />
                Use business profile
              </label>
            </div>
            {importError && (
              <p role="alert" className="text-sm text-destructive">
                {importError}
              </p>
            )}
            <div className="flex justify-end border-t pt-4"><Button disabled={uploading} aria-busy={uploading} onClick={() => void importTemplate()}>
              {uploading ? "Importing…" : "Import template"}
            </Button></div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!selectedTemplate}
        onOpenChange={(open) => {
          if (!open) setSelectedTemplate(null);
        }}
      >
        <DialogContent className={`${styles.dialog} max-w-4xl`} onCloseAutoFocus={restorePreviewFocus} onOpenAutoFocus={(event) => { event.preventDefault(); previewTitleRef.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle ref={previewTitleRef} tabIndex={-1}>{selectedTemplate?.name}</DialogTitle>
            <DialogDescription>
              {selectedTemplate?.description ||
                "See how this template will look with customer details."}
            </DialogDescription>
          </DialogHeader>
          {selectedTemplate && (
            <>
              <TemplateCustomerPreview template={selectedTemplate} />
              {!!selectedTemplate.templateContent?.warnings?.length && (
                <Callout tone="warning" title="Import details to review">
                  <ul className="list-disc pl-5">
                    {selectedTemplate.templateContent.warnings.map(
                      (warning) => (
                        <li key={warning}>{warning}</li>
                      ),
                    )}
                  </ul>
                </Callout>
              )}
              <Button
                onClick={() =>
                  router.push(
                    `/dashboard/proposals/new?templateId=${selectedTemplate.id}`,
                  )
                }
              >
                Use this template
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete proposal template?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleting?.name}” will be removed from My templates. Existing
              proposals keep their current content.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!deleting) return;
                try {
                  await api.delete(`/api/proposals/templates/${deleting.id}`);
                  setTemplates((current) =>
                    current.filter((template) => template.id !== deleting.id),
                  );
                  setDeleting(null);
                  toast({ title: "Template deleted" });
                } catch (error) {
                  toast({
                    title: "Template could not be deleted",
                    description:
                      error instanceof Error ? error.message : "Try again.",
                    variant: "destructive",
                  });
                }
              }}
            >
              Delete template
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
