"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { normalizeUploadUrl } from "@/lib/utils";
import { ArrowLeft, BatteryFull, Copy, ExternalLink, FileText, Image as ImageIcon, MoreVertical, Phone, Reply, Signal, UserRound, Video } from "lucide-react";
import { applyWhatsAppExamples, type WhatsAppTemplateExamples } from "@/lib/whatsapp-template-variables";
import type { WhatsAppAuthConfig } from "./templateData";
import { WhatsAppFormattedText } from "./WhatsAppFormattedText";

interface PreviewButton {
  type: string;
  text: string;
}

export function WhatsAppPreview({
  title,
  body,
  footer,
  buttons = [],
  showMedia = false,
  mediaType,
  mediaUrl,
  examples,
  compact = false,
  variant = "card",
  bottomBoundary,
  showControls = false,
  authConfig,
  variableLabels,
}: {
  title?: string;
  body: string;
  footer?: string;
  buttons?: PreviewButton[];
  showMedia?: boolean;
  mediaType?: "IMAGE" | "VIDEO" | "DOCUMENT" | string | null;
  mediaUrl?: string | null;
  examples?: WhatsAppTemplateExamples | null;
  showControls?: boolean;
  authConfig?: WhatsAppAuthConfig | null;
  variableLabels?: Record<string, string> | null;
  compact?: boolean;
  variant?: "card" | "phone";
  bottomBoundary?: RefObject<HTMLElement | null>;
}) {
  const [sampleValues, setSampleValues] = useState(true);
  const previewControls = showControls && <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs"><span className="text-muted-foreground">{sampleValues ? 'Sample values · no customer data' : 'Numbered placeholders'}</span><button type="button" aria-label="Show sample values in preview" aria-pressed={sampleValues} onClick={() => setSampleValues(value => !value)} className="min-h-8 rounded-lg border bg-card px-2 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{sampleValues ? 'Show placeholders' : 'Show sample values'}</button></div>;
  const effectiveExamples = sampleValues ? examples : null;
  const effectiveBody = authConfig ? `Your verification code is {{1}}.${authConfig.addSecurityRecommendation ? ' For your security, do not share this code.' : ''}` : body;
  const effectiveFooter = authConfig ? `This code expires in ${authConfig.codeExpirationMinutes} minutes.` : footer;
  const effectiveButtons = authConfig ? [{type:'OTP',text:authConfig.otpType === 'ONE_TAP' ? authConfig.autofillText || authConfig.buttonText : authConfig.buttonText}] : buttons;
  const phoneSpaceRef = useRef<HTMLDivElement | null>(null);
  const cardSpaceRef = useRef<HTMLDivElement | null>(null);
  const variableLabelsRef = useRef<HTMLParagraphElement | null>(null);
  const [phoneScale, setPhoneScale] = useState(1);
  const [cardMaxHeight, setCardMaxHeight] = useState<number>();
  useLayoutEffect(() => {
    if (variant !== "phone" && !bottomBoundary) return;
    let frame = 0;
    const measure = () => {
      const space = variant === "phone" ? phoneSpaceRef.current : cardSpaceRef.current;
      if (!space) return;
      const bounds = space.getBoundingClientRect();
      if (!bounds.width) return; // The mobile editor hides this panel until Preview is selected.
      const viewport = window.visualViewport;
      const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      const bottom = Math.min(bottomBoundary?.current?.getBoundingClientRect().top ?? visibleBottom, visibleBottom);
      const labelsHeight = variableLabelsRef.current ? variableLabelsRef.current.offsetHeight + 8 : 0;
      const availableHeight = bottom - bounds.top - labelsHeight - 12;
      // Scale the complete 320 × 640 device, including its chrome. Changing only
      // the conversation height flattens the phone as the action bar gets closer.
      if (variant === 'phone') {
        const scale = Math.min(1, bounds.width / 320, bottomBoundary && availableHeight > 0 ? availableHeight / 640 : 1);
        setPhoneScale(current => Math.abs(current - scale) < 0.001 ? current : scale);
      } else {
        // Keep long copy scrollable above the sticky save/review controls.
        const height = Math.max(96, Math.min(544, Math.floor(availableHeight)));
        setCardMaxHeight(current => current === height ? current : height);
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (phoneSpaceRef.current) observer?.observe(phoneSpaceRef.current);
    if (cardSpaceRef.current) observer?.observe(cardSpaceRef.current);
    if (variableLabelsRef.current) observer?.observe(variableLabelsRef.current);
    if (bottomBoundary?.current) observer?.observe(bottomBoundary.current);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    measure();
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [bottomBoundary, variant, showControls, variableLabels]);
  const previewTitle = title ? applyWhatsAppExamples(title, effectiveExamples, "header") : undefined;
  const previewBody = applyWhatsAppExamples(effectiveBody, effectiveExamples, "body");
  const previewMediaUrl = normalizeUploadUrl(mediaUrl);
  const hasRenderableMediaUrl = Boolean(previewMediaUrl && /^(?:https?:|blob:|data:|\/)/i.test(previewMediaUrl));
  const resolvedMediaType = String(mediaType || (showMedia ? "IMAGE" : "NONE")).toUpperCase();
  const renderMedia = showMedia || ["IMAGE", "VIDEO", "DOCUMENT"].includes(resolvedMediaType);

  const message = <div className="wa-preview-message mx-auto w-full max-w-[360px] shrink-0 overflow-hidden rounded-lg bg-white shadow-[0_1px_2px_rgba(0,0,0,.18)] dark:bg-[#202c33] dark:shadow-[0_1px_3px_rgba(0,0,0,.55)]">
        {renderMedia && <div className="flex h-32 items-center justify-center overflow-hidden bg-[#e9edef] text-[#667781] dark:bg-[#111b21] dark:text-[#aebac1]">
          {resolvedMediaType === "IMAGE" && hasRenderableMediaUrl ? <img src={previewMediaUrl} alt="WhatsApp template header" className="h-full w-full object-cover" />
            : resolvedMediaType === "VIDEO" && hasRenderableMediaUrl ? <video src={previewMediaUrl} controls preload="metadata" className="h-full w-full bg-black object-contain" aria-label="WhatsApp template header video" />
              : resolvedMediaType === "DOCUMENT" ? <div className="flex flex-col items-center gap-2 px-4 text-center"><FileText className="h-8 w-8" /><span className="max-w-full truncate text-xs">{mediaUrl ? "Document attached" : "Document preview"}</span></div>
                : <div className="flex flex-col items-center gap-2 text-xs"><ImageIcon className="h-8 w-8" /><span>{resolvedMediaType === "VIDEO" ? "Video preview" : "Image preview"}</span></div>}
        </div>}
        <div className="px-3.5 pb-2.5 pt-3 text-[#1f2925] dark:text-[#e9edef]">
          {previewTitle && <p className="mb-1.5 break-words text-sm font-semibold leading-5 [overflow-wrap:anywhere]">{previewTitle}</p>}
          <p className="whitespace-pre-wrap break-words text-[13px] leading-[1.42] [overflow-wrap:anywhere]"><WhatsAppFormattedText>{previewBody || "Your message will appear here."}</WhatsAppFormattedText></p>
          <div className="mt-1.5 flex items-end justify-between gap-2">
            <span className="min-w-0 break-words text-[11px] leading-4 text-[#777] [overflow-wrap:anywhere] dark:text-[#aebac1]">{effectiveFooter}</span>
          </div>
        </div>
        {effectiveButtons.map((button, index) => (
          <div key={`${button.text}-${index}`} className="flex min-h-9 items-center justify-center gap-2 border-t border-[#e8e8e8] px-3 text-[13px] font-medium text-primary dark:border-[#2f3b43] dark:text-[#53bdeb]">
            {button.type === "OTP" ? <Copy className="h-3.5 w-3.5" /> : button.type === "PHONE_NUMBER" ? <Phone className="h-3.5 w-3.5" /> : button.type === "QUICK_REPLY" ? <Reply className="h-3.5 w-3.5" /> : <ExternalLink className="h-3.5 w-3.5" />}
            <span className="break-words text-center">{button.text}</span>
          </div>
        ))}
      </div>;

  if (variant === "phone") return <div>{previewControls}<div ref={phoneSpaceRef} className="mx-auto w-full max-w-[320px]">
    <div role="region" aria-label="WhatsApp phone preview" className="relative mx-auto" style={{ width: 320 * phoneScale, height: 640 * phoneScale }}>
      <div className="absolute left-0 top-0 h-[640px] w-[320px] origin-top-left overflow-hidden rounded-[40px] border-[8px] border-[#252a2d] bg-[#252a2d] shadow-md" style={{ transform: `scale(${phoneScale})` }}>
    <div className="flex h-full flex-col overflow-hidden rounded-[32px]">
      <div className="relative shrink-0 bg-[#075e54] px-4 pb-3 pt-2 text-white dark:bg-[#202c33]">
        <div aria-hidden="true" className="flex h-7 items-center justify-between text-[11px] font-semibold"><span>9:41</span><span className="absolute left-1/2 top-2 h-5 w-20 -translate-x-1/2 rounded-full bg-black" /><span className="flex gap-1"><Signal className="h-3.5 w-3.5" /><BatteryFull className="h-4 w-4" /></span></div>
        <div className="mt-3 flex items-center gap-2">
          <ArrowLeft aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15"><UserRound className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1"><p className="text-[13px] font-semibold leading-4">Template preview</p><p className="mt-1 text-[11px] text-white/70">WhatsApp message</p></div>
          <Video aria-hidden="true" className="h-4 w-4 shrink-0 text-white/80" /><MoreVertical aria-hidden="true" className="h-4 w-4 shrink-0 text-white/80" />
        </div>
      </div>
      <div tabIndex={0} role="region" aria-label="Preview conversation" className="wa-preview-pattern min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary dark:bg-[#0b141a]"><div className="flex min-h-full flex-col justify-end p-3 pt-6">{message}</div></div>
      <div aria-hidden="true" className="flex h-5 shrink-0 items-center justify-center bg-[#efeae2] dark:bg-[#0b141a]"><span className="h-1 w-24 rounded-full bg-[#252a2d] dark:bg-white/50" /></div>
    </div>
  </div></div></div>{showControls && variableLabels && Object.values(variableLabels).filter(Boolean).length > 0 && <p ref={variableLabelsRef} className="mt-2 text-xs text-muted-foreground">Variables: {Object.values(variableLabels).filter(Boolean).join(", ")}</p>}</div>;

  return <div>{previewControls}<div ref={cardSpaceRef} role={showControls ? 'region' : undefined} aria-label={showControls ? 'Preview conversation' : undefined} tabIndex={showControls ? 0 : undefined} style={cardMaxHeight === undefined ? undefined : { maxHeight: cardMaxHeight, overflowY: 'auto' }} className={`wa-preview-pattern rounded-[10px] border border-border outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary dark:bg-[#0b141a] ${compact ? "p-4" : "p-5"}`}>{message}</div>{showControls && variableLabels && Object.values(variableLabels).filter(Boolean).length > 0 && <p ref={variableLabelsRef} className="px-4 py-2 text-xs text-muted-foreground">Variables: {Object.values(variableLabels).filter(Boolean).join(', ')}</p>}</div>;
}
