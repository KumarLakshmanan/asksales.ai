"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Check,
  ChevronRight,
  FileUp,
  ImageIcon,
} from "lucide-react";
import api from "@/lib/api";
import {
  forgetTemplateMedia,
  imagePreviewDataUrl,
  recallTemplateMedia,
  rememberTemplateMedia,
} from "@/lib/whatsappTemplateMediaMemory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  outreachTemplateFields,
  type OutreachTemplate,
} from "../../../../../shared/outreachCompose";

interface Props {
  templates: OutreachTemplate[];
  templateId: string;
  values: Record<string, string>;
  onTemplateChange: (id: string) => void;
  onValuesChange: (values: Record<string, string>) => void;
  providerAccountId?: string | null;
  prefix?: string;
  loading?: boolean;
  showSummary?: boolean;
}

export function WhatsAppTemplateEditor(props: Props) {
  return (
    <TemplateDrawer key={props.providerAccountId || "no-account"} {...props} />
  );
}

function TemplateDrawer({
  templates,
  templateId,
  values,
  onTemplateChange,
  onValuesChange,
  providerAccountId,
  prefix = "message",
  loading = false,
  showSummary = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draftId, setDraftId] = useState(templateId);
  const [draft, setDraft] = useState(values);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const previews = useRef(new Set<string>());
  useEffect(
    () => () => {
      request.current?.abort();
      previews.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );
  const selected = templates.find((item) => item.id === templateId);
  const template = templates.find((item) => item.id === draftId);
  const fields = template ? outreachTemplateFields(template) : [];
  const kind = template?.headerType?.toLowerCase();
  const needsMedia = ["image", "video", "document"].includes(kind || "");
  const canApply =
    !!template &&
    !uploading &&
    fields.every((field) => draft[field.key]?.trim()) &&
    (!needsMedia ||
      (!!draft.mediaId && draft.mediaAccountId === providerAccountId));
  const mediaName = kind === "image" ? "an image" : kind === "video" ? "a video" : "a PDF";
  /** Why "Use template" is disabled, so the button never looks broken. */
  const applyHint = !template
    ? "Choose a template to continue."
    : uploading
      ? `Uploading ${mediaName}…`
      : needsMedia && !(draft.mediaId && draft.mediaAccountId === providerAccountId)
        ? `This template needs ${mediaName}. Upload one to use it.`
        : !fields.every((field) => draft[field.key]?.trim())
          ? "Fill in every template field to continue."
          : "";
  const filtered = templates.filter((item) =>
    `${item.name} ${item.language} ${item.body}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  // The header last uploaded for this template and number, so it is not asked for again.
  const withRememberedMedia = (id: string, base: Record<string, string>) => {
    if (!id || base.mediaId || !providerAccountId) return base;
    const remembered = recallTemplateMedia(providerAccountId, id);
    return remembered
      ? {
          ...base,
          mediaId: remembered.mediaId,
          mediaAccountId: providerAccountId,
          mediaName: remembered.mediaName,
          mediaPreview: remembered.mediaPreview || "",
        }
      : base;
  };
  const changeOpen = (next: boolean) => {
    request.current?.abort();
    request.current = null;
    setUploading(false);
    setError("");
    if (next) {
      setDraftId(templateId);
      setDraft(withRememberedMedia(templateId, { ...values }));
      setSearch("");
    }
    setOpen(next);
  };
  const upload = async (file?: File) => {
    if (!file || !kind || !providerAccountId) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError("");
    setDraft((previous) => ({
      ...previous,
      mediaId: "",
      mediaPreview: "",
      mediaName: "",
      media: "",
    }));
    if (draftId) forgetTemplateMedia(providerAccountId, draftId);
    const accepted =
      kind === "image"
        ? ["image/jpeg", "image/png"]
        : kind === "video"
          ? ["video/mp4"]
          : ["application/pdf"];
    const limit = (kind === "image" ? 5 : 10) * 1024 * 1024;
    if (!accepted.includes(file.type) || file.size > limit || file.size === 0) {
      setError(
        `Choose ${kind === "image" ? "a JPG or PNG under 5 MB" : kind === "video" ? "an MP4 under 10 MB" : "a PDF under 10 MB"}.`,
      );
      return;
    }
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("providerAccountId", providerAccountId);
    form.append("mediaType", kind);
    try {
      const result = await api.upload<{ mediaId: string }>(
        "/api/outreach-conversations/compose/template-media",
        form,
        { signal: controller.signal },
      );
      if (request.current !== controller || controller.signal.aborted) return;
      const preview = URL.createObjectURL(file);
      previews.current.add(preview);
      setDraft((previous) => ({
        ...previous,
        mediaId: result.mediaId,
        mediaAccountId: providerAccountId,
        mediaName: file.name,
        mediaPreview: preview,
      }));
      // Offer this upload next time the template is chosen for this number.
      if (draftId) {
        const templateForUpload = draftId;
        void imagePreviewDataUrl(file).then((thumbnail) =>
          rememberTemplateMedia(providerAccountId, templateForUpload, {
            mediaId: result.mediaId,
            mediaName: file.name,
            mediaPreview: thumbnail,
          }),
        );
      }
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller)
        setError(
          cause instanceof Error ? cause.message : "Upload failed. Try again.",
        );
    } finally {
      if (request.current === controller) {
        setUploading(false);
        request.current = null;
      }
    }
  };
  const render = (text: string) =>
    text.replace(
      /{{\s*([^}]+?)\s*}}/g,
      (raw, token: string) => draft[`body:${token}`] || raw,
    );
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Label>Approved WhatsApp template</Label>
        <Link
          href="/dashboard/integrations/whatsapp/templates"
          className="text-xs text-primary hover:underline"
        >
          Manage templates
        </Link>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={() => changeOpen(true)}
        disabled={!providerAccountId}
        className="h-auto min-h-16 w-full justify-between gap-3 whitespace-normal px-4 py-3 text-left"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="rounded-lg bg-primary/10 p-2 text-primary">
            <ImageIcon className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block font-medium">
              {selected ? selected.name : "Choose a template"}
            </span>
              <span className="block break-all text-xs font-normal text-muted-foreground">
              {selected
                ? `${selected.language} · ${values.mediaName || "Approved template"}`
                : "Browse approved messages and upload media"}
            </span>
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0" />
      </Button>
      {selected ? <div className="flex flex-wrap items-center gap-2 text-xs"><span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 font-medium text-emerald-700 dark:text-emerald-300"><Check className="h-3 w-3" />Meta approved</span>{['IMAGE','VIDEO','DOCUMENT'].includes(selected.headerType || '') && <span className="rounded-full bg-primary/10 px-2 py-1 font-medium text-primary">{values.mediaId && values.mediaAccountId === providerAccountId ? 'Media ready' : 'Media required'}</span>}<span className="text-muted-foreground">Approval and message readiness are checked separately.</span></div> : null}
      {selected && showSummary && <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{selected.body}</p>}
      <Sheet open={open} onOpenChange={changeOpen}>
        <SheetContent className="outreach-workspace workspace-template-drawer flex h-full w-full flex-col gap-0 p-0 sm:max-w-2xl">
          <header className="shrink-0 border-b px-6 py-5 pr-12">
            <SheetTitle>Choose a WhatsApp template</SheetTitle>
            <SheetDescription className="mt-1">
              Select an approved message, add your media, and preview before
              applying.
            </SheetDescription>
          </header>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
            <section className="space-y-3" aria-label="Approved templates">
              <Label htmlFor={`${prefix}-template-search`}>
                Search templates
              </Label>
              <SearchInput
                id={`${prefix}-template-search`}
                aria-label="Search templates"
                value={search}
                onValueChange={setSearch}
                placeholder="Search by name or message…"
              />
              {loading ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading approved templates…
                </p>
              ) : null}
              {!loading && !filtered.length ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  {templates.length
                    ? "No templates match your search."
                    : "No approved templates are available for this account."}
                </p>
              ) : null}
              <div className="grid gap-2 sm:grid-cols-2">
                {filtered.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={draftId === item.id}
                    onClick={() => {
                      request.current?.abort();
                      request.current = null;
                      setUploading(false);
                      setError("");
                      setDraftId(item.id);
                      setDraft(
                        withRememberedMedia(
                          item.id,
                          item.id === templateId ? { ...values } : {},
                        ),
                      );
                    }}
                    className={`rounded-xl border p-3 text-left transition-colors hover:bg-muted/50 ${draftId === item.id ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border"}`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium">{item.name}</span>
                      {draftId === item.id ? (
                        <Check className="h-4 w-4 text-primary" />
                      ) : null}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {item.language} · {templateHeaderLabel(item.headerType)}
                    </span>
                    <span className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {item.body}
                    </span>
                  </button>
                ))}
              </div>
            </section>
            {template ? (
              <>
                {needsMedia ? (
                  <section className="space-y-3 rounded-xl border p-4">
                    <div>
                      <h3 className="text-sm font-medium">Template {kind}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {kind === "image"
                          ? "JPG or PNG, up to 5 MB"
                          : kind === "video"
                            ? "MP4, up to 10 MB"
                            : "PDF, up to 10 MB"}
                        . Uploaded securely to the selected WhatsApp account.
                      </p>
                    </div>
                    <div className="relative rounded-lg focus-within:ring-2 focus-within:ring-ring">
                      <Label
                        htmlFor={`${prefix}-template-file`}
                        className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/30 p-5 text-primary"
                      >
                        <FileUp className="h-5 w-5" />
                        {draft.mediaName ? "Replace file" : `Upload ${kind}`}
                      </Label>
                      <input
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-wait"
                        id={`${prefix}-template-file`}
                        type="file"
                        aria-label={`Upload template ${kind}`}
                        accept={
                          kind === "image"
                            ? "image/jpeg,image/png"
                            : kind === "video"
                              ? "video/mp4"
                              : "application/pdf"
                        }
                        disabled={uploading}
                        onChange={(event) => {
                          void upload(event.target.files?.[0]);
                          event.target.value = "";
                        }}
                      />
                    </div>
                    {uploading ? (
                      <p
                        role="status"
                        className="flex items-center gap-2 text-sm"
                      >
                        <Spinner size="sm" label={null} />
                        Uploading to WhatsApp…
                      </p>
                    ) : null}
                    {draft.mediaName ? (
                      <p
                        role="status"
                        className="break-all text-xs text-emerald-700"
                      >
                        Ready · {draft.mediaName}
                      </p>
                    ) : null}
                    {error ? (
                      <p role="alert" className="text-sm text-destructive">
                        {error}
                      </p>
                    ) : null}
                  </section>
                ) : null}
                {fields.length ? (
                  <section className="space-y-4">
                    <h3 className="text-sm font-medium">Personalize message</h3>
                    {fields.map((field) => (
                      <div key={field.key} className="space-y-2">
                        <Label htmlFor={`${prefix}-${field.key}`}>
                          {field.section === "button"
                            ? `${field.token} URL suffix`
                            : `${field.section === "header" ? "Header" : "Body"} variable ${field.token}`}
                        </Label>
                        <Input
                          id={`${prefix}-${field.key}`}
                          value={draft[field.key] || ""}
                          onChange={(event) =>
                            setDraft((previous) => ({
                              ...previous,
                              [field.key]: event.target.value,
                            }))
                          }
                          placeholder="A value or {{first_name}}"
                        />
                      </div>
                    ))}
                  </section>
                ) : null}
                <section className="space-y-3">
                  <h3 className="text-sm font-medium">Message preview</h3>
                  <p className="text-xs text-muted-foreground">Preview only · no message sent</p>
                  <div className="wa-preview-pattern rounded-lg border p-4 text-sm leading-6">
                    {kind === "image" && draft.mediaPreview ? (
                      <img
                        src={draft.mediaPreview}
                        alt="Template image preview"
                        className="mb-4 max-h-64 w-full rounded-lg object-contain"
                      />
                    ) : null}
                    {kind === "video" && draft.mediaPreview ? (
                      <video
                        src={draft.mediaPreview}
                        controls
                        className="mb-4 max-h-64 w-full rounded-lg"
                      />
                    ) : null}
                    {template.headerType === "TEXT" && template.header ? (
                      <p className="mb-2 font-medium">
                        {template.header.replace(
                          /{{\s*([^}]+?)\s*}}/g,
                          (raw, token: string) =>
                            draft[`header:${token}`] || raw,
                        )}
                      </p>
                    ) : null}
                    <p className="whitespace-pre-wrap">
                      {render(template.body)}
                    </p>
                    {template.footer ? (
                      <p className="mt-3 text-xs text-muted-foreground">
                        {template.footer}
                      </p>
                    ) : null}
                    {template.buttons?.length ? (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {template.buttons.map((button, index) => (
                          <span
                            key={index}
                            className="rounded-md border bg-background px-3 py-1 text-xs text-primary"
                          >
                            {button.text}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </section>
              </>
            ) : null}
          </div>
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t bg-background px-6 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            {applyHint ? (
              <p role="status" className="ml-auto text-right text-xs text-muted-foreground">
                {applyHint}
              </p>
            ) : null}
            <Button
              type="button"
              disabled={!canApply}
              onClick={() => {
                onTemplateChange(draftId);
                onValuesChange({ ...draft });
              // The composer retains this preview through its review screen.
              previews.current.delete(draft.mediaPreview);
                changeOpen(false);
              }}
            >
              Use template
            </Button>
          </footer>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** What a template needs before it can be sent, in plain words. */
function templateHeaderLabel(headerType?: string) {
  switch (headerType) {
    case "IMAGE": return "Needs an image";
    case "VIDEO": return "Needs a video";
    case "DOCUMENT": return "Needs a PDF";
    default: return "Text only";
  }
}
