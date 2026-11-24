"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BriefcaseBusiness,
  Building2,
  Check,
  ClipboardList,
  Facebook,
  Globe,
  Headphones,
  Instagram,
  Loader2,
  Mail,
  Megaphone,
  MessageCircle,
  PenLine,
  Phone,
  Star,
  Target,
  Users,
  UserRound,
  Youtube,
} from "lucide-react";
import { SetupField } from "./SetupFields";
import { WorkspaceSetupFrame } from "./WorkspaceSetupFrame";
import {
  APPLICATION_USES,
  CHANNELS,
  countryNames,
  FOCUS_AREAS,
  profileStepError,
  suggestedChannels,
  TEAM_SIZES,
  WORKSPACE_TYPES,
  type WorkspaceProfileData,
} from "@/lib/workspace-profile";

const TYPE_ICONS = [UserRound, Star, BriefcaseBusiness, Users];
const USE_ICONS = [
  Headphones,
  Target,
  PenLine,
  Megaphone,
  BarChart3,
  ClipboardList,
];
const CHANNEL_ICONS = [
  Mail,
  Phone,
  Instagram,
  Facebook,
  Youtube,
  MessageCircle,
  Globe,
  Megaphone,
];
const CHANNEL_COLORS = [
  "#7c3aed",
  "#16a34a",
  "#e43b84",
  "#1877f2",
  "#e32626",
  "#7c3aed",
  "#4285f4",
  "#1877f2",
];
const TITLES = [
  "Let's set up your workspace",
  "Tell us about your work",
  "What will you use AskSales for?",
  "Which channels do you need?",
];
const HELPERS = [
  "A space for your work, brand, or business.",
  "Give AskSales the context to help you and your customers.",
  "Choose one or more. We'll tailor your workspace around them.",
  "Choose your channels now. Connect accounts after setup.",
];

function SelectField({
  label,
  value,
  options,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const id = useId();
  return (
    <div className="setup-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="ws-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {[...new Set([...options, ...(value ? [value] : [])])].map((option) => (
          <option key={option} value={option}>
            {option.replaceAll("_", " ")}
          </option>
        ))}
      </select>
    </div>
  );
}

export function WorkspaceProfileForm({
  data,
  onChange,
  step,
  onStep,
  onSave,
  onBack,
  saving = false,
  editing = false,
  saveButtonLabel,
}: {
  data: WorkspaceProfileData;
  onChange: (data: WorkspaceProfileData) => void;
  step: number;
  onStep: (step: number) => void;
  onSave: (data: WorkspaceProfileData) => void;
  onBack: () => void;
  saving?: boolean;
  editing?: boolean;
  saveButtonLabel?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const errorId = useId();
  const errorField = error ? error.includes("who this workspace") ? "workspaceType" : error.includes("name") ? "name" : error.includes("time zone") ? "timezone" : error.includes("description") ? "description" : error.includes("URL") ? "website" : error.includes("email") ? "email" : "applicationUses" : null;
  useEffect(() => {
    const field = errorField ? formRef.current?.querySelector<HTMLElement>(`[data-profile-field="${errorField}"]`) : null;
    const control = field?.querySelector<HTMLElement>("input,textarea,select,button");
    if (!control) return;
    control.setAttribute("aria-invalid", "true");
    const previous = control.getAttribute("aria-describedby");
    control.setAttribute("aria-describedby", [previous, errorId].filter(Boolean).join(" "));
    control.focus();
    control.scrollIntoView?.({ block: "center", behavior: "smooth" });
    return () => { control.removeAttribute("aria-invalid"); if (previous) control.setAttribute("aria-describedby", previous); else control.removeAttribute("aria-describedby"); };
  }, [errorField, errorId, error, step]);
  const countries = useMemo(() => countryNames(), []);
  const timezones = useMemo(
    () => [
      "UTC",
      "Asia/Kolkata",
      "Asia/Kathmandu",
      "Europe/Kyiv",
      ...Intl.supportedValuesOf("timeZone"),
    ],
    [],
  );
  const suggested = suggestedChannels(data.applicationUses);
  const update = <K extends keyof WorkspaceProfileData>(
    key: K,
    value: WorkspaceProfileData[K],
  ) => {
    if (saving) return;
    setError(null);
    onChange({ ...data, [key]: value });
  };
  const toggle = (
    key: "applicationUses" | "preferredChannels",
    value: string,
  ) =>
    update(
      key,
      data[key].includes(value)
        ? data[key].filter((item) => item !== value)
        : [...data[key], value],
    );
  const changeStep = (next: number) => {
    setError(null);
    onStep(next);
  };
  const save = (value = data) => {
    for (const section of [1, 2, 3, 4]) {
      const invalid = profileStepError(value, section, !editing);
      if (invalid) {
        onStep(section);
        setError(invalid);
        return;
      }
    }
    onSave(value);
  };
  const footer = (
    <>
      <button
        className="ws-button"
        type="button"
        disabled={saving}
        onClick={() => (step > 1 ? changeStep(step - 1) : onBack())}
      >
        <ArrowLeft size={16} />
        {step > 1 || !editing ? "Back" : "Cancel"}
      </button>
      <div className="ws-actions">
        {step < 4 && <span className="ws-step-caption">Step {step} of 4</span>}
        {!editing && step === 4 && (
          <button
            type="button"
            className="ws-text-button"
            disabled={saving}
            onClick={() => save({ ...data, preferredChannels: [] })}
          >
            Skip for now
          </button>
        )}
        {editing && step < 4 && (
          <button
            type="button"
            className="ws-text-button"
            disabled={saving}
            onClick={() => changeStep(step + 1)}
          >
            Next section
          </button>
        )}
        <button
          type="submit"
          className="ws-button ws-primary"
          disabled={saving}
        >
          {saving ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Saving…
            </>
          ) : (
            <>
              {step < 4 && !editing
                ? "Continue"
                : saveButtonLabel ||
                  (editing ? "Save changes" : "Create workspace")}
              <ArrowRight size={16} />
            </>
          )}
        </button>
      </div>
    </>
  );
  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
        if (step === 4 || editing) {
          save();
          return;
        }
        const invalid = profileStepError(data, step, !editing);
        if (invalid) {
          setError(invalid);
          return;
        }
        changeStep(step + 1);
      }}
    >
      <WorkspaceSetupFrame
        step={step}
        onStep={saving ? undefined : changeStep}
        editing={editing}
        footer={footer}
      >
        <div className="ws-heading">
          <h1>
            {editing && step === 1
              ? "Your workspace profile"
              : TITLES[step - 1]}
          </h1>
          <p>
            {editing && step === 1
              ? "Update the details that help AskSales understand your work."
              : HELPERS[step - 1]}
          </p>
        </div>
        {error && (
          <p id={errorId} className="ws-error" role="alert">
            {error}
          </p>
        )}
        {step === 1 && (
          <div className="ws-fields">
            <fieldset data-profile-field="workspaceType">
              <legend className="ws-label">
                This workspace is for{!editing && " *"}
              </legend>
              <div className="ws-card-grid">
                {WORKSPACE_TYPES.map((type, index) => {
                  const Icon = TYPE_ICONS[index];
                  return (
                    <button
                      type="button"
                      key={type.value}
                      aria-label={type.label}
                      className="ws-choice-card"
                      aria-pressed={data.workspaceType === type.value}
                      onClick={() => update("workspaceType", type.value)}
                    >
                      <span className="ws-choice-icon">
                        <Icon size={23} aria-hidden="true" />
                      </span>
                      <span>
                        <strong>{type.label}</strong>
                        <small>{type.description}</small>
                      </span>
                      <span className="ws-choice-check">
                        <Check size={12} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <div data-profile-field="name"><SetupField
              label="Workspace name"
              value={data.name}
              onChange={(value) => update("name", value)}
              placeholder="e.g. Northstar Studio or your name"
              required
              maxLength={255}
            />
              {errorField === "name" && <p className="mt-1 text-xs text-destructive">{error}</p>}
            </div>
            <div className="ws-row">
              <SelectField
                label="Country"
                value={data.country}
                options={countries}
                onChange={(value) => update("country", value)}
                placeholder="Choose a country"
              />
              <div data-profile-field="timezone"><SelectField
                label="Time zone"
                value={data.timezone}
                options={timezones}
                onChange={(value) => update("timezone", value)}
                placeholder="Choose a time zone"
              />
              {errorField === "timezone" && <p className="mt-1 text-xs text-destructive">{error}</p>}
            </div>
            </div>
            <fieldset>
              <legend className="ws-label">Team size (optional)</legend>
              <div className="ws-size-options">
                {[
                  ...TEAM_SIZES,
                  ...(!TEAM_SIZES.some(
                    (item) => item.value === data.companySize,
                  ) && data.companySize
                    ? [{ value: data.companySize, label: data.companySize }]
                    : []),
                ].map((size) => (
                  <button
                    type="button"
                    key={size.value}
                    aria-pressed={data.companySize === size.value}
                    onClick={() =>
                      update(
                        "companySize",
                        data.companySize === size.value ? "" : size.value,
                      )
                    }
                  >
                    {size.label}
                  </button>
                ))}
              </div>
            </fieldset>
            <p className="ws-hint">These details can be changed later.</p>
          </div>
        )}
        {step === 2 && (
          <div className="ws-fields">
            <div data-profile-field="description"><SetupField
              label="Short description"
              value={data.description}
              onChange={(value) => update("description", value)}
              multiline
              required={!editing}
              placeholder="What do you do, and who do you help?"
              maxLength={1000}
            />
              {errorField === "description" && <p className="mt-1 text-xs text-destructive">{error}</p>}
            </div>
            <div className="ws-row">
              <SelectField
                label="Category / focus area (optional)"
                value={data.industry}
                options={FOCUS_AREAS}
                onChange={(value) => update("industry", value)}
                placeholder="Choose a focus area"
              />
              <div data-profile-field="website"><SetupField
                label="Website or public profile (optional)"
                value={data.website}
                onChange={(value) => update("website", value)}
                type="url"
                placeholder="https://yourwebsite.com"
              />
              {errorField === "website" && <p className="mt-1 text-xs text-destructive">{error}</p>}
            </div>
            </div>
            <div className="ws-row">
              <SetupField
                label="Who do you help? (optional)"
                value={data.customerType}
                onChange={(value) => update("customerType", value)}
                placeholder="Your audience or customers"
                maxLength={100}
              />
              <SetupField
                label="Markets / regions (optional)"
                value={data.targetRegions.join(",")}
                onChange={(value) => update("targetRegions", value.split(","))}
                placeholder="India, global clients"
                hint="Separate regions with commas."
              />
            </div>
            <div className="ws-row">
              <div data-profile-field="email"><SetupField
                label="Contact email (optional)"
                value={data.email}
                onChange={(value) => update("email", value)}
                type="email"
                placeholder="hello@example.com"
              />
              {errorField === "email" && <p className="mt-1 text-xs text-destructive">{error}</p>}
            </div>
              <SetupField
                label="Contact phone (optional)"
                value={data.phone}
                onChange={(value) => update("phone", value)}
                type="tel"
                placeholder="Include country code, e.g. +91"
                maxLength={50}
              />
            </div>
            <p className="ws-hint">Contact details belong to this workspace.</p>
          </div>
        )}
        {step === 3 && (
          <div className="ws-fields">
            <fieldset data-profile-field="applicationUses">
              <legend className="ws-label">
                How you plan to use AskSales{!editing && " *"}
              </legend>
              <div className="ws-card-grid">
                {APPLICATION_USES.map((use, index) => {
                  const Icon = USE_ICONS[index];
                  return (
                    <button
                      type="button"
                      key={use.value}
                      aria-label={use.label}
                      className="ws-choice-card"
                      aria-pressed={data.applicationUses.includes(use.value)}
                      onClick={() => toggle("applicationUses", use.value)}
                    >
                      <span className="ws-choice-icon">
                        <Icon aria-hidden="true" size={23} />
                      </span>
                      <span>
                        <strong>{use.label}</strong>
                        <small>{use.description}</small>
                      </span>
                      <span className="ws-choice-check">
                        <Check size={12} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <div className="ws-row">
              <SetupField
                label="First goal (optional)"
                value={data.setupGoal}
                onChange={(value) => update("setupGoal", value)}
                placeholder="What would you like to achieve first?"
                maxLength={1000}
              />
              <SetupField
                label="Current tools (optional)"
                value={data.currentTools}
                onChange={(value) => update("currentTools", value)}
                placeholder="e.g. Gmail, Instagram, Shopify"
                maxLength={1000}
              />
            </div>
            <p className="ws-hint">You can add more uses later.</p>
          </div>
        )}
        {step === 4 && (
          <div className="ws-fields">
            <fieldset>
              <legend className="ws-label">
                Channels you want to use (optional)
              </legend>
              <div className="ws-card-grid ws-channel-grid">
                {[
                  ...CHANNELS,
                  ...data.preferredChannels.filter(
                    (channel) => !CHANNELS.includes(channel),
                  ),
                ].map((channel, index) => {
                  const Icon = CHANNEL_ICONS[index] || Globe;
                  return (
                    <button
                      type="button"
                      key={channel}
                      aria-label={channel}
                      className="ws-choice-card"
                      aria-pressed={data.preferredChannels.includes(channel)}
                      onClick={() => toggle("preferredChannels", channel)}
                    >
                      <span
                        className="ws-choice-icon"
                        style={{ color: CHANNEL_COLORS[index] || undefined }}
                      >
                        <Icon size={24} aria-hidden="true" />
                      </span>
                      <span>
                        <strong>{channel}</strong>
                        {suggested.includes(channel) && (
                          <small>Suggested</small>
                        )}
                      </span>
                      <span className="ws-choice-check">
                        <Check size={12} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <p className="ws-hint">
              Selections guide your setup. Accounts are connected later.
            </p>
            <div className="ws-summary">
              <span className="ws-choice-icon">
                <Building2 size={22} />
              </span>
              <div>
                <strong>{data.name || "Your workspace"}</strong>
                <p>
                  Uses:{" "}
                  {data.applicationUses
                    .map(
                      (value) =>
                        APPLICATION_USES.find((use) => use.value === value)
                          ?.label || value,
                    )
                    .join(", ") || "Choose later"}
                </p>
                <p>
                  Channels:{" "}
                  {data.preferredChannels.join(", ") || "Choose later"}
                </p>
              </div>
            </div>
            {!editing && (
              <p className="ws-hint">
                Next: create your brand toolkit with colors, voice, and images.
              </p>
            )}
          </div>
        )}
      </WorkspaceSetupFrame>
    </form>
  );
}
