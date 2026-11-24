"use client";
import styles from "@/components/proposals/proposals.module.css";
import { useState } from "react";
import { ProposalDocument } from "@/components/proposals/ProposalDocument";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  buildProposalTemplatePreview,
  TEMPLATE_PREVIEW_FIELDS,
} from "@/lib/proposalTemplatePreview";
import {
  getProposalTemplateFields,
  type ProposalTemplateDraft,
} from "../../../../shared/proposalTemplateRules";

export function TemplateCustomerPreview({
  template,
  compact = false,
}: {
  template: ProposalTemplateDraft;
  compact?: boolean;
}) {
  const [mobile, setMobile] = useState(false);
  const [fields, setFields] = useState(TEMPLATE_PREVIEW_FIELDS);
  const customFields = [
    ...new Set([
      ...(template.templateContent?.requiredFields || []),
      ...getProposalTemplateFields(template),
    ]),
  ].filter((field) => !(field in TEMPLATE_PREVIEW_FIELDS));
  return (
    <div className={`${styles.preview} space-y-3`}>
      <div className={styles.previewHeader}>
        <div>
          <div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold">Customer preview</h3><span className={styles.previewLabel}>SAMPLE DATA</span></div>
          <p className="mt-1 text-xs text-muted-foreground">
            Sample customer, copy, prices and dates. Preview values are never
            saved.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-10"
          aria-pressed={mobile}
          onClick={() => setMobile(!mobile)}
        >
          {mobile ? "Desktop width" : "Mobile width"}
        </Button>
      </div>
      {!!customFields.length && (
        <details className="rounded-lg border bg-background p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Try required field values ({customFields.length})
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {customFields.map((field) => (
              <label key={field} className="space-y-1 text-xs">
                {field}
                <Input
                  value={fields[field] || ""}
                  placeholder={`Sample ${field.replace(/_/g, " ")}`}
                  onChange={(event) =>
                    setFields({ ...fields, [field]: event.target.value })
                  }
                />
              </label>
            ))}
          </div>
        </details>
      )}
      <div className={styles.previewPaper}>
        <div className={mobile ? "mx-auto max-w-[375px]" : ""}>
          <ProposalDocument
            compact={compact || mobile}
            proposal={buildProposalTemplatePreview(template, fields)}
            brand={{
              companyName: fields.company_name || "Northstar Studio",
              primaryColor: "#2563eb",
            }}
          />
        </div>
      </div>
    </div>
  );
}

export function TemplateThumbnail({
  template,
}: {
  template: ProposalTemplateDraft;
}) {
  const preview = buildProposalTemplatePreview(template);
  return (
    <div
      aria-hidden="true"
      className="relative h-56 overflow-hidden border-b bg-muted/40 px-5 pt-5"
    >
      <div className="mx-auto min-h-60 max-w-[300px] border border-slate-200 bg-white px-5 py-4 text-slate-900 shadow-sm">
        <div className="flex items-center justify-between border-b-2 border-blue-600 pb-2 text-[9px]">
          <strong>NORTHSTAR STUDIO</strong>
          <span>PROPOSAL</span>
        </div>
        <p className="mt-4 text-[15px] font-semibold leading-tight">
          {template.name}
        </p>
        <p className="mt-1 text-[9px] text-slate-500">
          Prepared for Alex Morgan · Acme Co.
        </p>
        {preview.metadata?.generatedSections
          ?.slice(0, 2)
          .map((section, index) => (
            <div key={index} className="mt-3">
              <p className="text-[10px] font-semibold">{section.title}</p>
              <p className="mt-1 line-clamp-2 text-[9px] leading-relaxed text-slate-500">
                {section.body.replace(/[|#*-]/g, "")}
              </p>
            </div>
          ))}
      </div>
      <div className="absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-muted/80 to-transparent" />
    </div>
  );
}
