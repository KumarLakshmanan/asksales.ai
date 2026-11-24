"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatLeadStatus, getLeadStatusOptions } from '../../../../shared/leadStatus';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface LeadFormValues {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  whatsapp: string;
  location: string;
  website: string;
  company: string;
  role: string;
  headline: string;
  industry: string;
  companySize: string;
  companyDomain: string;
  companyDescription: string;
  linkedinUrl: string;
  linkedinUsername: string;
  instagramHandle: string;
  instagramUrl: string;
  facebookUrl: string;
  twitterHandle: string;
  twitterUrl: string;
  score: number;
  fitScore: number | null;
  relevanceScore: number | null;
  leadStatus: string;
  source: string;
  notes: string;
}

export const EMPTY_LEAD_FORM: LeadFormValues = {
  name: "",
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  whatsapp: "",
  location: "",
  website: "",
  company: "",
  role: "",
  headline: "",
  industry: "",
  companySize: "",
  companyDomain: "",
  companyDescription: "",
  linkedinUrl: "",
  linkedinUsername: "",
  instagramHandle: "",
  instagramUrl: "",
  facebookUrl: "",
  twitterHandle: "",
  twitterUrl: "",
  score: 0,
  fitScore: null,
  relevanceScore: null,
  leadStatus: "new",
  source: "manual",
  notes: "",
};

const STANDARD_SOURCES = new Set(["manual", "linkedin", "twitter", "instagram", "facebook", "google-maps", "referral", "website", "other"]);

interface LeadFormProps {
  value: LeadFormValues;
  onChange: (field: keyof LeadFormValues, value: string | number | null) => void;
  disabled?: boolean;
  errors?: Partial<Record<keyof LeadFormValues, string>>;
}

const textFields = {
  identity: [
    ["firstName", "First name", "Ada"],
    ["lastName", "Last name", "Lovelace"],
    ["name", "Display name", "Ada Lovelace"],
    ["email", "Email", "ada@example.com"],
    ["phone", "Phone", "+1 415 555 0123"],
    ["whatsapp", "WhatsApp", "+1 415 555 0123"],
    ["location", "Location", "London, United Kingdom"],
    ["website", "Website", "https://example.com"],
  ],
  company: [
    ["company", "Company", "Analytical Engines Ltd"],
    ["role", "Role / job title", "Head of Growth"],
    ["headline", "Professional headline", "B2B growth and partnerships"],
    ["industry", "Industry", "Technology"],
    ["companySize", "Company size", "51–200 employees"],
    ["companyDomain", "Company domain", "example.com"],
  ],
  social: [
    ["linkedinUrl", "LinkedIn profile URL", "https://linkedin.com/in/username"],
    ["linkedinUsername", "LinkedIn username", "username"],
    ["instagramHandle", "Instagram handle", "@username"],
    ["instagramUrl", "Instagram profile URL", "https://instagram.com/username"],
    ["facebookUrl", "Facebook profile URL", "https://facebook.com/username"],
    ["twitterHandle", "X / Twitter handle", "@username"],
    ["twitterUrl", "X / Twitter profile URL", "https://x.com/username"],
  ],
} satisfies Record<string, ReadonlyArray<readonly [keyof LeadFormValues, string, string]>>;

function TextField({
  field,
  label,
  placeholder,
  value,
  onChange,
  disabled,
  type = "text",
  error,
}: {
  field: keyof LeadFormValues;
  label: string;
  placeholder: string;
  value: string;
  onChange: LeadFormProps["onChange"];
  disabled?: boolean;
  type?: string;
  error?: string;
}) {
  const id = `lead-${field}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(field, event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        autoComplete={field === "email" ? "email" : field === "phone" ? "tel" : "off"}
      />
      {error && <p id={`${id}-error`} className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function FormCard({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">{children}</CardContent>
    </Card>
  );
}

export function LeadForm({ value, onChange, disabled = false, errors = {} }: LeadFormProps) {
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <FormCard title="Contact information">
        {textFields.identity.map(([field, label, placeholder]) => (
          <TextField
            key={field}
            field={field}
            label={label}
            placeholder={placeholder}
            value={String(value[field] ?? "")}
            onChange={onChange}
            disabled={disabled}
            error={errors[field]}
            type={field === "email" ? "email" : field === "website" ? "url" : field === "phone" || field === "whatsapp" ? "tel" : "text"}
          />
        ))}
      </FormCard>

      <FormCard title="Professional information">
        {textFields.company.map(([field, label, placeholder]) => (
          <TextField key={field} field={field} label={label} placeholder={placeholder} value={String(value[field] ?? "")} onChange={onChange} disabled={disabled} />
        ))}
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="lead-companyDescription">Company description</Label>
          <Textarea
            id="lead-companyDescription"
            value={value.companyDescription}
            onChange={(event) => onChange("companyDescription", event.target.value)}
            placeholder="What the company does, its market, and useful account context…"
            rows={5}
            disabled={disabled}
          />
        </div>
      </FormCard>

      <FormCard title="Social profiles">
        {textFields.social.map(([field, label, placeholder]) => (
          <TextField key={field} field={field} label={label} placeholder={placeholder} value={String(value[field] ?? "")} onChange={onChange} disabled={disabled} type={field.toLowerCase().includes("url") ? "url" : "text"} />
        ))}
      </FormCard>

      <FormCard title="Qualification and ownership">
        {(["score", "fitScore", "relevanceScore"] as const).map((field) => {
          const labels = { score: "Lead score", fitScore: "Fit score", relevanceScore: "Relevance score" };
          return (
            <div className="space-y-2" key={field}>
              <Label htmlFor={`lead-${field}`}>{labels[field]} (0–100)</Label>
              <Input
                id={`lead-${field}`}
                type="number"
                min={0}
                max={100}
                value={value[field] ?? ""}
                onChange={(event) => onChange(field, event.target.value === "" ? (field === "score" ? 0 : null) : Math.min(100, Math.max(0, Number(event.target.value))))}
                disabled={disabled}
              />
            </div>
          );
        })}

        <div className="space-y-2">
          <Label htmlFor="lead-status">Pipeline status</Label>
          <Select value={value.leadStatus} onValueChange={(next) => onChange("leadStatus", next)} disabled={disabled}>
            <SelectTrigger id="lead-status"><SelectValue /></SelectTrigger>
            <SelectContent>
              {getLeadStatusOptions([value.leadStatus]).map(status => (
                <SelectItem key={status} value={status}>{formatLeadStatus(status)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="lead-source">Source</Label>
          <Select value={value.source} onValueChange={(next) => onChange("source", next)} disabled={disabled}>
            <SelectTrigger id="lead-source"><SelectValue /></SelectTrigger>
            <SelectContent>
              {!STANDARD_SOURCES.has(value.source) && value.source && (
                <SelectItem value={value.source}>{value.source.replace(/[_-]/g, " ")}</SelectItem>
              )}
              <SelectItem value="manual">Manual entry</SelectItem>
              <SelectItem value="linkedin">LinkedIn</SelectItem>
              <SelectItem value="twitter">X / Twitter</SelectItem>
              <SelectItem value="instagram">Instagram</SelectItem>
              <SelectItem value="facebook">Facebook</SelectItem>
              <SelectItem value="google-maps">Google Maps</SelectItem>
              <SelectItem value="referral">Referral</SelectItem>
              <SelectItem value="website">Website</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="lead-notes">Notes</Label>
          <Textarea id="lead-notes" value={value.notes} onChange={(event) => onChange("notes", event.target.value)} placeholder="Qualification notes, buying signals, or follow-up context…" rows={5} disabled={disabled} />
        </div>
      </FormCard>
    </div>
  );
}
