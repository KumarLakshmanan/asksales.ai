"use client";
import styles from "@/components/proposals/proposals.module.css";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { TemplateCustomerPreview } from "./TemplateCustomerPreview";
import {
  PROPOSAL_TEMPLATE_CATEGORIES,
  getProposalTemplateFields,
  templateFieldName,
  validateProposalTemplate,
} from "../../../../shared/proposalTemplateRules";
import {
  isProposalAuthoringInstruction,
  type ProposalSection,
  type ProposalLineItem,
} from "../../../../shared/proposals";

export type TemplateSection = ProposalSection;
export type EditableTemplate = {
  id?: number;
  version?: number;
  name: string;
  category?: string;
  description?: string | null;
  published?: boolean;
  replaceTemplateId?: number;
  coverNote?: string | null;
  termsAndConditions?: string | null;
  isDefault?: boolean;
  lineItems?: ProposalLineItem[] | null;
  includeKnowledgeBase?: boolean | null;
  includeBusinessProfile?: boolean | null;
  templateContent?: {
    sections: TemplateSection[];
    placeholders: string[];
    warnings: string[];
    requiredFields?: string[];
  } | null;
};

export function TemplateEditor({
  initial,
  admin = false,
  publishedTemplates = [],
  onSave,
  onCancel,
}: {
  initial?: EditableTemplate;
  admin?: boolean;
  publishedTemplates?: { id: number; name: string }[];
  onSave: (data: EditableTemplate) => Promise<void>;
  onCancel: () => void;
}) {
  const prefix = useId();
  const [form, setForm] = useState<EditableTemplate>(
    initial || {
      name: "",
      category: "General",
      description: "",
      published: false,
      includeKnowledgeBase: true,
      includeBusinessProfile: true,
      templateContent: {
        sections: [{ title: "Executive summary", body: "", kind: "cover" }],
        placeholders: [],
        warnings: [],
        requiredFields: [],
      },
    },
  );
  const [requiredText, setRequiredText] = useState(
    initial?.templateContent?.requiredFields?.join(", ") || "",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [attempted, setAttempted] = useState(false),
    [preview, setPreview] = useState(admin);
  const sections = form.templateContent?.sections || [];
  const current = {
    ...form,
    templateContent: {
      sections,
      placeholders: form.templateContent?.placeholders || [],
      warnings: form.templateContent?.warnings || [],
      requiredFields: requiredText
        .split(",")
        .map(templateFieldName)
        .filter(Boolean),
    },
  };
  const validation = validateProposalTemplate(
    current,
    admin && !!form.published,
  );
  const needsSlot =
    admin &&
    form.published &&
    !initial?.published &&
    publishedTemplates.length >= 10;
  if (needsSlot && !form.replaceTemplateId)
    validation.push("Choose one of the 10 published templates to replace.");
  if (!admin && form.isDefault && !form.termsAndConditions?.trim())
    validation.push("Add approved terms before choosing this default template.");
  const updateSections = (value: TemplateSection[]) =>
    setForm({
      ...form,
      templateContent: { ...current.templateContent, sections: value },
    });
  const updateSection = (index: number, data: Partial<TemplateSection>) =>
    updateSections(
      sections.map((section, i) =>
        i === index ? { ...section, ...data } : section,
      ),
    );
  const move = (index: number, direction: -1 | 1) => {
    const next = [...sections];
    [next[index], next[index + direction]] = [
      next[index + direction],
      next[index],
    ];
    updateSections(next);
  };
  return (
    <form
      className={`${styles.templateEditor} space-y-5`}
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        setAttempted(true);
        setError("");
        if (validation.length) return;
        setBusy(true);
        try {
          await onSave({
            ...current,
            name: form.name.trim(),
            category: form.category?.trim() || "General",
            description: form.description || "",
            templateContent: {
              ...current.templateContent,
              placeholders: getProposalTemplateFields(current),
            },
          });
        } catch (cause) {
          setError(
            cause instanceof Error ? cause.message : "Unable to save template",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">
            {initial?.id ? "Edit template" : "Create a reusable template"}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Customer copy becomes the document. Writing guidance helps the
            seller and AI complete it.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-10"
          aria-pressed={preview}
          onClick={() => setPreview(!preview)}
        >
          {preview ? "Hide preview" : "Show customer preview"}
        </Button>
      </div>
      <div className={preview ? styles.templateEditorGrid : ""}>
        <div className="min-w-0 space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-name`}>Name</Label>
              <Input
                id={`${prefix}-name`}
                maxLength={255}
                required
                aria-invalid={attempted && !form.name.trim()}
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-category`}>Category</Label>
              <Input
                id={`${prefix}-category`}
                list={`${prefix}-categories`}
                maxLength={100}
                value={form.category || "General"}
                onChange={(event) =>
                  setForm({ ...form, category: event.target.value })
                }
              />
              <datalist id={`${prefix}-categories`}>
                {PROPOSAL_TEMPLATE_CATEGORIES.map((category) => (
                  <option key={category} value={category} />
                ))}
              </datalist>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${prefix}-description`}>Description</Label>
            <Input
              id={`${prefix}-description`}
              maxLength={2000}
              value={form.description || ""}
              onChange={(event) =>
                setForm({ ...form, description: event.target.value })
              }
            />
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-3 text-sm">
            <label className="flex min-h-10 items-center gap-2">
              <Checkbox
                checked={form.includeKnowledgeBase !== false}
                onCheckedChange={(checked) =>
                  setForm({ ...form, includeKnowledgeBase: checked === true })
                }
              />
              Use knowledge base
            </label>
            <label className="flex min-h-10 items-center gap-2">
              <Checkbox
                checked={form.includeBusinessProfile !== false}
                onCheckedChange={(checked) =>
                  setForm({ ...form, includeBusinessProfile: checked === true })
                }
              />
              Use business profile
            </label>
          </div>
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <Label htmlFor={`${prefix}-required`}>Required fields</Label>
            <Input
              id={`${prefix}-required`}
              value={requiredText}
              onChange={(event) => setRequiredText(event.target.value)}
              placeholder="client_name, company_name, project_deadline"
              aria-describedby={`${prefix}-required-help`}
            />
            <p
              id={`${prefix}-required-help`}
              className="text-xs text-muted-foreground"
            >
              Separate fields with commas. Known customer and company values
              fill automatically. Any remaining required fields must be
              completed before sending.
            </p>
            <p className="text-xs text-muted-foreground">
              Use {"{{client_name}}"} in customer copy. Custom placeholders must
              appear in required fields before publishing.
            </p>
          </div>
          {sections.map((section, index) => (
            <fieldset key={index} className="space-y-3 rounded-lg border p-4">
              <legend className="px-1 text-xs font-medium">
                Section {index + 1}
              </legend>
              <div className="grid gap-2 sm:grid-cols-[1fr_120px]">
                <Input
                  aria-label={`Section ${index + 1} title`}
                  required
                  maxLength={500}
                  value={section.title}
                  onChange={(event) =>
                    updateSection(index, { title: event.target.value })
                  }
                />
                <select
                  aria-label={`Section ${index + 1} type`}
                  className="h-10 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={section.kind}
                  onChange={(event) =>
                    updateSection(index, {
                      kind: event.target.value as TemplateSection["kind"],
                    })
                  }
                >
                  {["cover", "content", "terms", "closing"].map((kind) => (
                    <option key={kind} value={kind}>
                      {kind === "cover"
                        ? "Summary"
                        : kind === "content"
                          ? "Scope"
                          : kind === "terms"
                            ? "Terms"
                            : "Next steps"}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-body-${index}`}>Customer copy</Label>
                <Textarea
                  id={`${prefix}-body-${index}`}
                  rows={4}
                  value={section.body}
                  maxLength={100000}
                  placeholder="Reusable wording for the customer, or leave blank for the seller to complete."
                  onChange={(event) =>
                    updateSection(index, { body: event.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Markdown supports headings, lists, tables and images.
                </p>
              </div>
              {isProposalAuthoringInstruction(section.body) && (
                <Button
                  variant="outline"
                  type="button"
                  size="sm"
                  className="min-h-10"
                  onClick={() =>
                    updateSection(index, {
                      instruction: [section.instruction, section.body]
                        .filter(Boolean)
                        .join("\n"),
                      body: "",
                    })
                  }
                >
                  Move writing prompt to guidance
                </Button>
              )}
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-guidance-${index}`}>
                  Writing guidance{" "}
                  <span className="font-normal text-muted-foreground">
                    · seller and AI only
                  </span>
                </Label>
                <Textarea
                  id={`${prefix}-guidance-${index}`}
                  rows={2}
                  value={section.instruction || ""}
                  maxLength={10000}
                  placeholder="Explain the requirements for completing this section."
                  onChange={(event) =>
                    updateSection(index, { instruction: event.target.value })
                  }
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-10"
                  aria-label={`Move section ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  Move up
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-10"
                  aria-label={`Move section ${index + 1} down`}
                  disabled={index === sections.length - 1}
                  onClick={() => move(index, 1)}
                >
                  Move down
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-10"
                  aria-label={`Remove section ${index + 1}`}
                  disabled={sections.length === 1}
                  onClick={() =>
                    updateSections(sections.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </Button>
              </div>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={sections.length >= 200}
            onClick={() =>
              updateSections([
                ...sections,
                { title: "New section", body: "", kind: "content" },
              ])
            }
          >
            Add section
          </Button>
          {!admin && <fieldset className="space-y-3 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">Default terms</legend>
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-terms`}>Terms and conditions</Label>
              <Textarea id={`${prefix}-terms`} rows={4} value={form.termsAndConditions || ""} onChange={event => setForm({ ...form, termsAndConditions: event.target.value })} />
            </div>
            <label className="flex min-h-10 items-center gap-2 text-sm font-medium">
              <Checkbox checked={!!form.isDefault} onCheckedChange={checked => setForm({ ...form, isDefault: checked === true })} />
              Use as default template
            </label>
            <p className="text-xs text-muted-foreground">Choose terms your business has approved. Automatic offers must match these terms and current approved catalog pricing; all other sending checks still apply. Selecting this template replaces the current default for this business.</p>
          </fieldset>}
          {admin && (
            <div className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/40 p-4">
              <label className="flex min-h-10 items-center gap-2 text-sm font-medium">
                <Checkbox
                  checked={!!form.published}
                  onCheckedChange={(checked) =>
                    setForm({
                      ...form,
                      published: checked === true,
                      replaceTemplateId: undefined,
                    })
                  }
                />
                Publish to standard templates
              </label>
              <p className="text-xs text-muted-foreground">
                Publishing or restoring changes the template for proposals
                created afterward. Existing drafts, sent proposals and saved
                copies keep their current content.
              </p>
              {needsSlot && (
                <div className="space-y-2">
                  <Label htmlFor={`${prefix}-replacement`}>
                    Replace a published template
                  </Label>
                  <select
                    id={`${prefix}-replacement`}
                    className="min-h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={form.replaceTemplateId || ""}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        replaceTemplateId:
                          Number(event.target.value) || undefined,
                      })
                    }
                  >
                    <option value="">
                      Choose one of the 10 occupied slots
                    </option>
                    {publishedTemplates
                      .filter((template) => template.id !== initial?.id)
                      .map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                        </option>
                      ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    The selected template becomes an unpublished draft as this
                    one is published. Its history remains available.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
        {preview && (
          <aside className="min-w-0 xl:sticky xl:top-4">
            <TemplateCustomerPreview template={current} compact />
          </aside>
        )}
      </div>
      {attempted && !!validation.length && (
        <Callout tone="danger" title="Complete these fields before saving">
          <ul className="list-disc space-y-1 pl-5">
            {validation.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Callout>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="sticky bottom-0 z-10 flex flex-wrap justify-between gap-3 border-t bg-card py-4">
        <Button disabled={busy || !sections.length} type="submit">
          {busy
            ? "Saving…"
            : admin && form.published
              ? "Save and publish"
              : "Save template"}
        </Button>
        <Button
          disabled={busy}
          type="button"
          variant="ghost"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
