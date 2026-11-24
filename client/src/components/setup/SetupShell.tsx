"use client";

import { useEffect } from "react";
import { Check, LogOut, ArrowUpRight } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { BRAND_NAME } from "@/lib/brand";
import "./setup.css";

export function SetupShell({
  area,
  profileOnly = false,
  accountReview = true,
  workspaceType = "business",
  title,
  description,
  sections,
  step,
  onStep,
  children,
}: {
  area: "Business profile" | "Brand toolkit" | "Account review";
  profileOnly?: boolean;
  accountReview?: boolean;
  workspaceType?: string;
  title: string;
  description: string;
  sections: string[];
  step: number;
  onStep?: (step: number) => void;
  children: React.ReactNode;
}) {
  const { user, logout } = useAuth();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [step, area]);
  const stages = profileOnly ? ["Business profile"] : ["Business profile", "Brand toolkit", ...(accountReview ? ["Account review"] : [])];
  const active = stages.indexOf(area);
  const personalWorkspace = workspaceType === "individual" || workspaceType === "creator";
  return (
    <div className="setup-studio">
      <header className="setup-header">
        <span className="setup-wordmark">
          {BRAND_NAME}<span> / workspace setup</span>
        </span>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-muted-foreground sm:block">
            {user?.name}
          </span>
          <Button variant="ghost" size="sm" onClick={logout}>
            <LogOut className="h-4 w-4" /> Log out
          </Button>
        </div>
      </header>
      <div className="setup-layout">
        <aside className="setup-sidebar">
          <p className="setup-eyebrow">{personalWorkspace ? "Make it your own" : "Make it your business"}</p>
          <h2>
            Your next chapter
            <br />
            starts here.
          </h2>
          <p className="setup-sidebar-copy">
            {personalWorkspace ? `Give ${BRAND_NAME} the context for your work and the voice of your brand.` : profileOnly
              ? `Give ${BRAND_NAME} the context to find customers for this business.`
              : `Give ${BRAND_NAME} the context to find your customers and sound like your brand.`}
          </p>
          <ol className="setup-stages">
            {stages.map((stage, i) => (
              <li
                key={stage}
                aria-current={i === active ? "step" : undefined}
                className={i === active ? "is-current" : ""}
              >
                <span className="setup-stage-number">
                  {i < active ? <Check size={16} /> : `0${i + 1}`}
                </span>
                <div>
                  <strong>{stage}</strong>
                  <small>
                    {i < active
                      ? "Saved"
                      : i === active
                        ? "In progress"
                        : "Up next"}
                  </small>
                </div>
              </li>
            ))}
          </ol>
          <div className="setup-note">
            <ArrowUpRight size={20} />
            <p>
              <strong>{personalWorkspace ? "A consistent identity for your work." : "A foundation for every campaign."}</strong>
              <br />
              {personalWorkspace ? "Your profile describes your work. Your toolkit keeps its voice and visuals consistent." : profileOnly
                ? "This profile guides targeting for its campaigns."
                : "Your profile guides targeting. Your toolkit keeps content consistent."}
            </p>
          </div>
        </aside>
        <main id="main-content" className="setup-main">
          <div className="setup-page-heading">
            <p className="setup-eyebrow">
              {area}{" "}
              <span>
                {" "}
                / {step > 0 ? `${step} of ${sections.length}` : "Get started"}
              </span>
            </p>
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
          {step > 0 && (
            <nav className="setup-sections" aria-label={`${area} sections`}>
              {sections.map((section, i) => (
                <button
                  key={section}
                  type="button"
                  aria-current={step === i + 1 ? "step" : undefined}
                  disabled={i + 1 > step || !onStep}
                  onClick={() => onStep?.(i + 1)}
                >
                  <span>{i + 1 < step ? <Check size={13} /> : i + 1}</span>
                  {section}
                </button>
              ))}
            </nav>
          )}
          <div className="setup-form">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function SetupReview({
  values,
}: {
  values: Record<string, string | undefined>;
}) {
  return (
    <dl className="setup-review">
      {Object.entries(values).map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value || "Not added"}</dd>
        </div>
      ))}
    </dl>
  );
}
