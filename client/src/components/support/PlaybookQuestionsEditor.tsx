"use client";

import { useState } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import type {
  PlaybookGraph,
  PlaybookFieldDefinition,
  PlaybookFieldType,
} from "./PlaybookGraphEditor";

const TYPES: Record<PlaybookFieldType, string> = {
  text: "Written answer",
  integer: "Whole number",
  money: "Amount",
  date: "Date",
  datetime: "Date and time",
  email: "Email address",
  phone: "Phone number",
  boolean: "Yes or no",
  single_select: "One choice",
  multi_select: "Multiple choices",
};
const GROUPS: Record<string, string> = {
  journey: "Welcome",
  stay: "Stays & bookings",
  alternative: "Alternative stays",
  corporate: "Corporate events",
  celebration: "Celebrations",
  resort: "Resort information",
  dining: "Dining",
  spa: "Spa",
  outing: "Day outings",
  activities: "Activities",
  location: "Location",
  service: "Service requests",
  information: "Follow-up questions",
  inquiry: "Enquiries",
  contact: "Contact details",
  callback: "Callbacks",
};
export function fieldTitle(key: string) {
  const labels: Record<string, string> = {
    "journey.type": "Enquiry type",
    "stay.checkIn": "Check-in date",
    "stay.checkOut": "Check-out date",
    "alternative.checkIn": "Alternative check-in date",
    "alternative.checkOut": "Alternative check-out date",
    "stay.confirmed": "Booking confirmation",
    "stay.unavailableNextStep": "Alternative stay options",
    "contact.fullName": "Customer name",
    "callback.consent": "Permission to contact",
  };
  if (labels[key]) return labels[key];
  return (
    key
      .split(".")
      .at(-1)
      ?.replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]/g, " ")
      .replace(/^./, (c) => c.toUpperCase()) || "Untitled question"
  );
}

export function PlaybookQuestionsEditor({
  graph,
  onChange,
  readOnly = false,
}: {
  graph: PlaybookGraph;
  onChange: (graph: PlaybookGraph) => void;
  readOnly?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const fields = graph.fields || [];
  const matches = fields
    .map((field, index) => ({ field, index }))
    .filter(({ field }) =>
      `${field.key} ${fieldTitle(field.key)} ${field.prompt} ${GROUPS[field.key.split(".")[0]] || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  const index = matches.some((item) => item.index === selectedIndex)
    ? selectedIndex
    : matches[0]?.index;
  const field = index === undefined ? undefined : fields[index];
  const update = (patch: Partial<PlaybookFieldDefinition>) => {
    if (!readOnly)
      onChange({
        ...graph,
        schemaVersion: 2,
        fields: fields.map((item, i) =>
          i === index ? { ...item, ...patch } : item,
        ),
      });
  };
  const add = () => {
    let sequence = fields.length + 1;
    while (fields.some((item) => item.key === `field.${sequence}`)) sequence++;
    onChange({
      ...graph,
      schemaVersion: 2,
      fields: [
        ...fields,
        {
          key: `field.${sequence}`,
          type: "text",
          required: true,
          pii: "none",
          prompt: "What would you like to ask?",
        },
      ],
    });
    setQuery("");
    setSelectedIndex(fields.length);
  };
  const uses = field
    ? graph.nodes.filter(
        (node) =>
          Array.isArray(node.data.fieldKeys) &&
          node.data.fieldKeys.includes(field.key),
      )
    : [];
  return (
    <section aria-label="Customer questions" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">
            Questions for your customers
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a question to edit its wording and answer options.
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={readOnly} onClick={add}>
          <Plus className="mr-2 h-4 w-4" />
          Add question
        </Button>
      </div>
      <div className="grid min-w-0 overflow-hidden rounded-xl border bg-background xl:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.5fr)]">
        <div className="min-w-0 border-b xl:border-b-0 xl:border-r">
          <SearchInput
            aria-label="Search questions"
            placeholder="Find a question…"
            value={query}
            onValueChange={setQuery}
            wrapperClassName="m-3 w-auto"
          />
          <nav
            aria-label="Question list"
            className="max-h-64 space-y-1 overflow-y-auto p-2 pt-0 xl:max-h-[580px]"
          >
            {matches.map(({ field: item, index: i }) => (
              <button
                type="button"
                key={i}
                aria-current={index === i ? "true" : undefined}
                onClick={() => setSelectedIndex(i)}
                className={`flex w-full items-center gap-3 rounded-lg border-l-2 p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${index === i ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted"}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {fieldTitle(item.key)}
                  </span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {GROUPS[item.key.split(".")[0]] || item.key.split(".")[0]} ·{" "}
                    {TYPES[item.type]}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
            {!matches.length && (
              <p className="p-4 text-sm text-muted-foreground">
                {fields.length
                  ? "No questions match your search."
                  : "Add your first question, then include it in a conversation step."}
              </p>
            )}
          </nav>
        </div>
        {field ? (
          <div key={index} className="min-w-0 space-y-5 p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-medium">
                  {fieldTitle(field.key)}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {uses.length
                    ? `Used in ${uses.map((node) => String(node.data.label || fieldTitle(node.id))).join(", ")}`
                    : "Not yet used in a conversation step"}
                </p>
              </div>
              <Badge variant="secondary">
                {field.required ? "Required" : "Optional"}
              </Badge>
            </div>
            <label className="block space-y-2 text-sm font-medium">
              Question shown to the customer
              <Textarea
                rows={3}
                value={field.prompt}
                disabled={readOnly}
                onChange={(e) => update({ prompt: e.target.value })}
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm font-medium">
                Answer format
                <select
                  aria-label="Answer format"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
                  value={field.type}
                  disabled={readOnly}
                  onChange={(e) =>
                    update({ type: e.target.value as PlaybookFieldType })
                  }
                >
                  {Object.entries(TYPES).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center justify-between gap-3 self-end rounded-md border p-3 text-sm">
                <span>Answer required</span>
                <Switch
                  checked={field.required}
                  disabled={readOnly}
                  onCheckedChange={(required) => update({ required })}
                />
              </label>
            </div>
            {(field.type === "single_select" ||
              field.type === "multi_select") && (
              <section className="space-y-3" aria-label="Answer choices">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-medium">Answer choices</h4>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={readOnly}
                    onClick={() => {
                      let n = (field.options || []).length + 1;
                      while (
                        field.options?.some((o) => o.value === `option_${n}`)
                      )
                        n++;
                      update({
                        options: [
                          ...(field.options || []),
                          {
                            value: `option_${n}`,
                            label: "New choice",
                            aliases: [],
                          },
                        ],
                      });
                    }}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add choice
                  </Button>
                </div>
                {(field.options || []).map((option, optionIndex) => {
                  const updateOption = (patch: Partial<typeof option>) =>
                    update({
                      options: field.options?.map((item, i) =>
                        i === optionIndex ? { ...item, ...patch } : item,
                      ),
                    });
                  return (
                    <div
                      key={optionIndex}
                      className="space-y-2 rounded-lg border p-3"
                    >
                      <div className="flex items-end gap-2">
                        <label className="min-w-0 flex-1 space-y-1 text-xs">
                          Customer label
                          <Input
                            value={option.label}
                            disabled={readOnly}
                            onChange={(e) =>
                              updateOption({ label: e.target.value })
                            }
                          />
                        </label>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="shrink-0 text-destructive"
                          disabled={readOnly}
                          aria-label={`Delete choice ${option.label}`}
                          onClick={() =>
                            update({
                              options: field.options?.filter(
                                (_, i) => i !== optionIndex,
                              ),
                            })
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <details>
                        <summary className="cursor-pointer py-1 text-xs text-muted-foreground">
                          Button text & accepted replies
                        </summary>
                        <div className="mt-2 grid gap-3">
                          <label className="space-y-1 text-xs">
                            Short button label
                            <Input
                              value={option.shortLabel || ""}
                              disabled={readOnly}
                              placeholder="Use the customer label"
                              onChange={(e) =>
                                updateOption({
                                  shortLabel: e.target.value || undefined,
                                })
                              }
                            />
                          </label>
                          <label className="space-y-1 text-xs">
                            Other ways customers say this
                            <Input
                              value={(option.aliases || []).join(", ")}
                              disabled={readOnly}
                              placeholder="Separate alternatives with commas"
                              onChange={(e) =>
                                updateOption({
                                  aliases: e.target.value
                                    .split(",")
                                    .map((v) => v.trim())
                                    .filter(Boolean),
                                })
                              }
                            />
                          </label>
                          <label className="space-y-1 text-xs">
                            Choice ID
                            <Input
                              value={option.value}
                              disabled={readOnly}
                              onChange={(e) =>
                                updateOption({ value: e.target.value })
                              }
                            />
                          </label>
                          <p className="text-xs text-muted-foreground">
                            If you change an ID, update any conversation
                            branches that use it.
                          </p>
                        </div>
                      </details>
                    </div>
                  );
                })}
                {!field.options?.length && (
                  <p className="text-sm text-muted-foreground">
                    Add the answers customers can choose from.
                  </p>
                )}
              </section>
            )}
            <div className="rounded-lg bg-primary/5 p-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Customer wording preview
              </p>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {field.prompt || "Your question will appear here."}
              </p>
              {field.options?.length &&
              ["single_select", "multi_select"].includes(field.type) ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {field.options.map((o, i) => (
                    <span
                      key={i}
                      className="max-w-full break-words rounded-md border bg-background px-3 py-2 text-xs"
                    >
                      {o.shortLabel || o.label}
                    </span>
                  ))}
                </div>
              ) : null}
              <p className="mt-3 text-xs text-muted-foreground">
                Wording only. Channel limits and AI wording settings may affect
                the delivered message.
              </p>
            </div>
            <details className="border-t pt-3">
              <summary className="cursor-pointer py-2 text-sm font-medium">
                Advanced: data & privacy
              </summary>
              <div className="mt-3 space-y-4">
                <label className="block space-y-1 text-xs">
                  Internal field name
                  <Input
                    value={field.key}
                    disabled={readOnly}
                    onChange={(e) => update({ key: e.target.value })}
                  />
                  <span className="block text-muted-foreground">
                    Used by steps and actions. Update their references if you
                    rename this field.
                  </span>
                </label>
                <label className="block space-y-1 text-xs">
                  Privacy classification
                  <select
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={field.pii}
                    disabled={readOnly}
                    onChange={(e) =>
                      update({
                        pii: e.target.value as PlaybookFieldDefinition["pii"],
                      })
                    }
                  >
                    <option value="none">Not personal information</option>
                    <option value="contact">Contact information</option>
                    <option value="sensitive">Sensitive information</option>
                  </select>
                </label>
                <label className="block space-y-1 text-xs">
                  Reuse a saved contact detail
                  <select
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={field.profileBinding?.attribute || "none"}
                    disabled={readOnly}
                    onChange={(e) =>
                      update({
                        profileBinding:
                          e.target.value === "none"
                            ? undefined
                            : {
                                attribute: e.target.value as NonNullable<
                                  PlaybookFieldDefinition["profileBinding"]
                                >["attribute"],
                                read: true,
                                minimumTrust: "provider",
                                writeBack: "fill_missing_or_verify_correction",
                              },
                      })
                    }
                  >
                    <option value="none">Do not link to the CRM</option>
                    {[
                      "fullName",
                      "firstName",
                      "lastName",
                      "email",
                      "phone",
                      "company",
                    ].map((key) => (
                      <option key={key} value={key}>
                        {fieldTitle(key)}
                      </option>
                    ))}
                  </select>
                </label>
                {field.profileBinding && (
                  <>
                    <label className="flex items-center justify-between gap-3 text-sm">
                      Reuse known value
                      <Switch
                        checked={field.profileBinding.read}
                        disabled={readOnly}
                        onCheckedChange={(read) =>
                          update({
                            profileBinding: { ...field.profileBinding!, read },
                          })
                        }
                      />
                    </label>
                    <label className="block space-y-1 text-xs">
                      Minimum verification
                      <select
                        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                        value={field.profileBinding.minimumTrust}
                        disabled={readOnly}
                        onChange={(e) =>
                          update({
                            profileBinding: {
                              ...field.profileBinding!,
                              minimumTrust: e.target.value as NonNullable<
                                PlaybookFieldDefinition["profileBinding"]
                              >["minimumTrust"],
                            },
                          })
                        }
                      >
                        <option value="provider">
                          From the channel provider
                        </option>
                        <option value="customer_verified">
                          Verified by the customer
                        </option>
                        <option value="owner_verified">
                          Verified by your team
                        </option>
                      </select>
                    </label>
                    <label className="block space-y-1 text-xs">
                      Update the contact record
                      <select
                        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                        value={field.profileBinding.writeBack}
                        disabled={readOnly}
                        onChange={(e) =>
                          update({
                            profileBinding: {
                              ...field.profileBinding!,
                              writeBack: e.target.value as NonNullable<
                                PlaybookFieldDefinition["profileBinding"]
                              >["writeBack"],
                            },
                          })
                        }
                      >
                        <option value="fill_missing_or_verify_correction">
                          Fill missing details; verify corrections
                        </option>
                        <option value="never">Never update the CRM</option>
                      </select>
                    </label>
                  </>
                )}
                <details>
                  <summary className="cursor-pointer py-2 text-xs">
                    Developer choice shorthand
                  </summary>
                  <Textarea
                    aria-label="Developer choice shorthand"
                    className="font-mono text-xs"
                    value={(field.options || [])
                      .map(
                        (o) =>
                          `${o.value}=${o.label}${o.shortLabel ? `::${o.shortLabel}` : ""}${o.aliases?.length ? `|${o.aliases.join(",")}` : ""}`,
                      )
                      .join("\n")}
                    disabled={readOnly}
                    onChange={(e) =>
                      update({
                        options: e.target.value
                          .split("\n")
                          .map((l) => l.trim())
                          .filter(Boolean)
                          .map((line) => {
                            const [valueLabel, aliasText = ""] =
                              line.split("|");
                            const [value, text = value] = valueLabel
                              .split("=")
                              .map((v) => v.trim());
                            const [label, shortLabel] = text
                              .split("::")
                              .map((v) => v.trim());
                            return {
                              value,
                              label,
                              ...(shortLabel ? { shortLabel } : {}),
                              aliases: aliasText
                                .split(",")
                                .map((v) => v.trim())
                                .filter(Boolean),
                            };
                          }),
                      })
                    }
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    ID=Customer label::Button label|alternative reply,another
                    reply
                  </p>
                </details>
                <Button
                  variant="outline"
                  className="text-destructive"
                  disabled={readOnly}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove this question?${uses.length ? " Steps using it must be updated before publishing." : ""}`,
                      )
                    ) {
                      onChange({
                        ...graph,
                        fields: fields.filter((_, i) => i !== index),
                      });
                      setSelectedIndex(0);
                    }
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Remove question
                </Button>
              </div>
            </details>
          </div>
        ) : (
          <div className="flex min-h-48 items-center justify-center p-6 text-sm text-muted-foreground">
            Select a question to begin.
          </div>
        )}
      </div>
    </section>
  );
}
