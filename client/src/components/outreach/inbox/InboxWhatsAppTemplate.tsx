"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { WhatsAppTemplateEditor } from "../create/WhatsAppTemplateEditor";
import {
  buildOutreachTemplate,
  type OutreachRecipient,
  type OutreachTemplate,
} from "../../../../../shared/outreachCompose";

export interface InboxTemplatePayload {
  content: string;
  templateName: string;
  templateLanguage: string;
  templateComponents: Record<string, unknown>[];
}
const emptyRecipient: OutreachRecipient = {
  id: 0,
  name: "",
  firstName: "",
  lastName: "",
  company: "",
  email: "",
  phone: "",
  eligible: true,
  reason: null,
  recipient: "",
};
interface Props {
  onChange: (payload: InboxTemplatePayload | null) => void;
  providerAccountId: string | null;
}
export function InboxWhatsAppTemplate(props: Props) {
  return (
    <AccountTemplate key={props.providerAccountId || "no-account"} {...props} />
  );
}
function AccountTemplate({ onChange, providerAccountId }: Props) {
  const [templates, setTemplates] = useState<OutreachTemplate[]>([]);
  const [selected, setSelected] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const preview = values.mediaPreview;
    return () => { if (preview?.startsWith('blob:')) URL.revokeObjectURL(preview); };
  }, [values.mediaPreview]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      if (!providerAccountId)
        throw new Error(
          "The sending account is unavailable. Refresh this conversation.",
        );
      const response = await api.get<{
        templates: Array<
          Omit<OutreachTemplate, "id"> & { id: string | number }
        >;
      }>(
        `/api/outreach-conversations/compose/templates?providerAccountId=${encodeURIComponent(providerAccountId)}`,
      );
      if (request === generation.current)
        setTemplates(
          response.templates.map((template) => ({
            ...template,
            id: String(template.id),
          })),
        );
    } catch (cause) {
      if (request === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Approved templates could not be loaded.",
        );
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [providerAccountId]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const payload = useMemo(() => {
    const template = templates.find((item) => item.id === selected);
    if (!template || loading || error) return null;
    const built = buildOutreachTemplate(template, values, emptyRecipient);
    return built.missing.length
      ? null
      : {
          content: built.content,
          templateName: built.templateName,
          templateLanguage: built.templateLanguage,
          templateComponents: built.templateComponents,
        };
  }, [templates, selected, values, loading, error]);
  useEffect(() => {
    onChange(payload);
  }, [payload, onChange]);
  return (
    <div className="space-y-3 p-4">
      {error ? (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{error}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
          >
            Try again
          </Button>
        </div>
      ) : null}
      <WhatsAppTemplateEditor
        templates={templates}
        templateId={selected}
        values={values}
        onTemplateChange={(id) => {
          setSelected(id);
          setValues({});
        }}
        onValuesChange={setValues}
        providerAccountId={providerAccountId}
        loading={loading}
        prefix="inbox"
      />
    </div>
  );
}
