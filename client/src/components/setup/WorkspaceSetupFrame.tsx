"use client";

import { useEffect, useRef } from "react";
import { Check, LifeBuoy, Sparkles } from "lucide-react";
import { BRAND_NAME, SUPPORT_EMAIL } from "@/lib/brand";
import { useKeyboardViewport } from "@/hooks/use-keyboard-viewport";
import "./workspace-setup.css";

const STEPS = [
  { title: "Profile", subtitle: "Your workspace" },
  { title: "About", subtitle: "Your details" },
  { title: "Uses", subtitle: "What you'll do" },
  { title: "Channels", subtitle: "Where you'll work" },
];

export function WorkspaceSetupFrame({
  step = 0,
  onStep,
  editing = false,
  children,
  footer,
}: {
  step?: number;
  onStep?: (step: number) => void;
  editing?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const keyboardOpen = useKeyboardViewport();
  const frameRef = useRef<HTMLDivElement>(null);
  const previousStep = useRef<number | null>(null);
  useEffect(() => {
    if (
      previousStep.current !== step &&
      (!editing || previousStep.current !== null)
    ) {
      frameRef.current?.scrollIntoView?.({
        block: "start",
        behavior: "instant",
      });
    }
    if (previousStep.current !== null && previousStep.current !== step) {
      const heading = frameRef.current?.querySelector<HTMLHeadingElement>("h1");
      heading?.setAttribute("tabindex", "-1");
      heading?.focus({ preventScroll: true });
    }
    previousStep.current = step;
  }, [step, editing]);
  return (
    <div ref={frameRef} data-keyboard-open={keyboardOpen} className={`ws-setup ${editing ? "ws-edit" : ""}`}>
      {!editing && (
        <header className="ws-header">
          <span className="ws-wordmark">
            <Sparkles aria-hidden="true" size={22} />
            {BRAND_NAME}
          </span>
          <a className="ws-help" href={`mailto:${SUPPORT_EMAIL}`}>
            <LifeBuoy aria-hidden="true" size={17} />
            <span>Need help?</span>
          </a>
        </header>
      )}
      <div className="ws-body">
        {step > 0 && (
          <nav aria-label="Workspace profile steps" className="ws-stepper">
            <ol>
              {STEPS.map((item, index) => (
                <li
                  key={item.title}
                  className={`${index + 1 === step ? "is-active" : ""} ${index + 1 < step ? "is-complete" : ""}`}
                >
                  <button
                    type="button"
                    aria-label={item.title}
                    aria-current={index + 1 === step ? "step" : undefined}
                    onClick={() => onStep?.(index + 1)}
                    disabled={!onStep || (!editing && index + 1 > step)}
                  >
                    <span className="ws-step-number">
                      {index + 1 < step ? (
                        <Check aria-hidden="true" size={17} />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.subtitle}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        )}
        {children}
      </div>
      {footer && (
        <footer className="ws-footer">
          <div>{footer}</div>
        </footer>
      )}
    </div>
  );
}
